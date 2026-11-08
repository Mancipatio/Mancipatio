// SERVER-ONLY — investor relations (migration 0090): the data access,
// authorization and holder verification behind /api/issuer-updates.
//
// Authorization is read fresh from chain and fails closed (an RPC failure is
// a 503, never a grant):
//   - composing (save, attach, publish): the wallet is the authority of the
//     on-chain Issuer (lib/server/profile-read requireProfileOwner, the check
//     of every issuer profile route), the issuer's on-chain KYB is Verified,
//     and a named asset is the issuer's own registry account;
//   - taking down what the issuer wrote (discard, detach, withdraw), reading
//     its own list and recording its anchor: the authority alone, so a
//     suspended issuer can still remove its content;
//   - moderation: a platform admin withdraws any published update, lists
//     them and opens their documents;
//   - holders-only content: verifyHeldAssets below, at every request.
// Every query is scoped to this deployment's network; the tables are
// service-role only (0090 RLS default deny).

import "server-only";

import { createHash } from "node:crypto";
import { address, type Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
  fetchAllMaybeShareClass,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  findAssetPda,
  getAssetDiscriminatorBytes,
  getIssuerDiscriminatorBytes,
  getShareClassDiscriminatorBytes,
} from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import { detectNetwork } from "@/lib/network";
import {
  ISSUER_UPDATE_LIMITS,
  IssuerUpdateValidationError,
  issuerUpdateAnchorReference,
  issuerUpdateRecordText,
  type IssuerUpdateDocument,
  type IssuerUpdateKind,
  type IssuerUpdateRecord,
  type IssuerUpdateStatus,
  type IssuerUpdateVisibility,
  type PublicIssuerUpdate,
} from "@/lib/issuer-updates";
import { readArchivedSet } from "@/lib/server/archive";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";
import { getToken2022Balances } from "@/lib/server/token-holdings";
import { CONFIDENTIAL_BUCKET, CONFIDENTIAL_URL_TTL_S } from "@/app/api/storage/_lib";

export const UPDATES_TABLE = "issuer_updates";
export const DOCUMENTS_TABLE = "issuer_update_documents";

export const UPDATE_COLUMNS =
  "network,id,issuer_pda,asset_pda,kind,title,body,period_label,visibility,status,published_at,published_by," +
  "withdrawn_at,withdrawn_by,withdrawn_by_role,withdrawn_reason,anchor_tx,created_by,updated_by,created_at,updated_at";
const DOCUMENT_COLUMNS = "id,update_id,file_name,storage_path,sha256,size_bytes,content_type,created_at";

/** How the anchor route names the signer in a refusal (lib/document-anchor.ts signerRole). */
export const ISSUER_ANCHOR_SIGNER_ROLE = "the issuer authority wallet";

export type IssuerUpdateRow = {
  network: string;
  id: string;
  issuer_pda: string;
  asset_pda: string | null;
  kind: IssuerUpdateKind;
  title: string;
  body: string;
  period_label: string | null;
  visibility: IssuerUpdateVisibility;
  status: IssuerUpdateStatus;
  published_at: string | null;
  published_by: string | null;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  withdrawn_by_role: "issuer" | "admin" | null;
  withdrawn_reason: string | null;
  anchor_tx: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type IssuerUpdateDocumentRow = IssuerUpdateDocument & {
  update_id: string;
  storage_path: string;
  created_at: string;
};

// ── Parameters ──────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export function readUuid(value: unknown, what = "The update"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new SiwsError(400, `${what} id is invalid`);
  return value.toLowerCase();
}

export function readAddress(value: unknown, what: string): string {
  if (typeof value !== "string") throw new SiwsError(400, `${what} must be an on-chain address`);
  try {
    return address(value).toString();
  } catch {
    throw new SiwsError(400, `${what} must be an on-chain address`);
  }
}

/** The updated_at the editor last read: the compare-and-swap token of every draft write. */
export function readRevision(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !REVISION.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new SiwsError(400, "Reload the update before changing it");
  }
  return value;
}

/** Runs a browser-safe parser of lib/issuer-updates.ts; its refusal is a 400. */
export function parseOrRefuse<T>(parser: (input: unknown) => T, input: unknown): T {
  try {
    return parser(input);
  } catch (error) {
    if (error instanceof IssuerUpdateValidationError) throw new SiwsError(400, error.message);
    throw error;
  }
}

export function unavailable(): never {
  throw new SiwsError(503, "Issuer updates are unavailable — try again");
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** The update `id` on this network, or null. */
export async function loadUpdate(sb: SupabaseClient, id: string): Promise<IssuerUpdateRow | null> {
  const { data, error } = await sb.from(UPDATES_TABLE).select(UPDATE_COLUMNS)
    .eq("network", detectNetwork()).eq("id", id).maybeSingle();
  if (error) unavailable();
  return (data as unknown as IssuerUpdateRow | null) ?? null;
}

/** The documents of `updateIds` on this network, per update, oldest first. */
export async function loadDocuments(sb: SupabaseClient, updateIds: readonly string[]): Promise<Map<string, IssuerUpdateDocumentRow[]>> {
  const byUpdate = new Map<string, IssuerUpdateDocumentRow[]>();
  if (updateIds.length === 0) return byUpdate;
  const { data, error } = await sb.from(DOCUMENTS_TABLE).select(DOCUMENT_COLUMNS)
    .eq("network", detectNetwork()).in("update_id", [...new Set(updateIds)]);
  if (error) unavailable();
  const rows = ((data ?? []) as unknown as IssuerUpdateDocumentRow[])
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  for (const row of rows) byUpdate.set(row.update_id, [...(byUpdate.get(row.update_id) ?? []), row]);
  return byUpdate;
}

/** One document on this network, or null. */
export async function loadDocument(sb: SupabaseClient, id: string): Promise<IssuerUpdateDocumentRow | null> {
  const { data, error } = await sb.from(DOCUMENTS_TABLE).select(DOCUMENT_COLUMNS)
    .eq("network", detectNetwork()).eq("id", id).maybeSingle();
  if (error) unavailable();
  return (data as unknown as IssuerUpdateDocumentRow | null) ?? null;
}

function publicDocument(doc: IssuerUpdateDocumentRow): IssuerUpdateDocument {
  return { id: doc.id, file_name: doc.file_name, sha256: doc.sha256, size_bytes: doc.size_bytes, content_type: doc.content_type };
}

/**
 * The reader's projection of a PUBLISHED update: content, documents (never
 * their storage paths) and the anchor. Null for anything else: a caller can
 * never project a draft or a withdrawn update to a reader by mistake.
 */
export function toPublic(row: IssuerUpdateRow, docs: readonly IssuerUpdateDocumentRow[] = []): PublicIssuerUpdate | null {
  if (row.status !== "published" || !row.published_at) return null;
  return {
    id: row.id,
    issuer_pda: row.issuer_pda,
    asset_pda: row.asset_pda,
    kind: row.kind,
    title: row.title,
    body: row.body,
    period_label: row.period_label,
    visibility: row.visibility,
    published_at: row.published_at,
    anchor_tx: row.anchor_tx,
    documents: docs.map(publicDocument),
  };
}

/** SHA-256 (hex) of the update's canonical record (lib/issuer-updates.ts issuerUpdateRecordText). */
export function issuerUpdateDigest(row: IssuerUpdateRow, docs: readonly IssuerUpdateDocumentRow[]): string {
  if (!row.published_at) throw new Error("Only a published update has a record to anchor");
  const text = issuerUpdateRecordText({ ...row, published_at: row.published_at, documents: docs });
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The issuer's (and the admin's) view, with the memo to sign while a published update is unanchored. */
export function toRecord(row: IssuerUpdateRow, docs: readonly IssuerUpdateDocumentRow[] = []): IssuerUpdateRecord {
  // 0090 gives every published row its published_at; without one nothing is offered to anchor.
  const anchor = row.status === "published" && !row.anchor_tx && row.published_at
    ? { reference: issuerUpdateAnchorReference(row.id), sha256: issuerUpdateDigest(row, docs) }
    : null;
  return {
    id: row.id,
    issuer_pda: row.issuer_pda,
    asset_pda: row.asset_pda,
    kind: row.kind,
    title: row.title,
    body: row.body,
    period_label: row.period_label,
    visibility: row.visibility,
    status: row.status,
    published_at: row.published_at,
    published_by: row.published_by,
    withdrawn_at: row.withdrawn_at,
    withdrawn_by: row.withdrawn_by,
    withdrawn_by_role: row.withdrawn_by_role,
    withdrawn_reason: row.withdrawn_reason,
    anchor_tx: row.anchor_tx,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    documents: docs.map(publicDocument),
    anchor,
  };
}

/** The record of `id` after a write, read back with its documents (404 when it is gone). */
export async function recordOf(sb: SupabaseClient, id: string): Promise<IssuerUpdateRecord> {
  const row = await loadUpdate(sb, id);
  if (!row) throw new SiwsError(404, "Update not found");
  return toRecord(row, (await loadDocuments(sb, [id])).get(id) ?? []);
}

// ── Chain: the issuer and its assets ────────────────────────────────────────

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

/**
 * The composing gate: `wallet` is the authority of the Issuer at `issuerPda`
 * (requireProfileOwner: finalized registry account at its own PDA), that
 * issuer's on-chain KYB is Verified, and `assetPda`, when given, is a
 * registry Asset at its own PDA whose issuer is `issuerPda`. 403 / 400
 * otherwise, 503 when the chain cannot be read.
 */
export async function requireIssuerAuthor(wallet: string, issuerPda: string, assetPda: string | null): Promise<void> {
  await requireProfileOwner(wallet, issuerPda, "issuer");
  const rpc = getServerRpc();
  const options = { commitment: "finalized" as const, abortSignal: AbortSignal.timeout(8_000) };
  let verified: boolean;
  let assetIssuer: string | null = null;
  try {
    const issuer = await fetchMaybeIssuer(rpc, address(issuerPda), options);
    verified = issuer.exists && issuer.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
      sameBytes(issuer.data.discriminator, getIssuerDiscriminatorBytes()) && issuer.data.kybStatus === KybStatus.Verified;
    if (assetPda) {
      const asset = await fetchMaybeAsset(rpc, address(assetPda), options);
      if (asset.exists && asset.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
          sameBytes(asset.data.discriminator, getAssetDiscriminatorBytes())) {
        const [expected] = await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId });
        if (expected === assetPda) assetIssuer = asset.data.issuer.toString();
      }
    }
  } catch {
    throw new SiwsError(503, "Issuer check unavailable — try again");
  }
  if (!verified) throw new SiwsError(403, "Only a verified issuer (KYB approved on chain) can publish updates");
  if (assetPda && assetIssuer !== issuerPda) throw new SiwsError(400, "This asset is not one of the issuer's assets");
}

/** Whether `wallet` is the issuer's authority (403 → false; a 503 propagates, fail closed). */
export async function isIssuerAuthority(wallet: string, issuerPda: string): Promise<boolean> {
  try {
    await requireProfileOwner(wallet, issuerPda, "issuer");
    return true;
  } catch (error) {
    if (error instanceof SiwsError && error.status === 403) return false;
    throw error;
  }
}

// ── Chain: holders ──────────────────────────────────────────────────────────

export type HeldAsset = { asset: string; issuer: string };

/** getMultipleAccounts takes at most 100 addresses. */
const ACCOUNTS_PER_READ = 100;

/**
 * Which of `assets` the wallet holds units of, read on chain now: each asset
 * must be a registry Asset at its own PDA; its share classes are the registry
 * accounts at ["share_class", asset, i] for i < shareClassesCount (each must
 * name this asset and have its mint); the wallet holds the asset when its
 * Token-2022 balance of one of those mints is above zero. Assets that do not
 * pass are left out (never an error: a holder read answers what it can
 * prove). Any RPC failure is a 503: an unverifiable claim is never a holding.
 */
export async function verifyHeldAssets(wallet: string, assets: readonly string[]): Promise<HeldAsset[]> {
  if (assets.length === 0) return [];
  const rpc = getServerRpc();
  const options = { commitment: "confirmed" as const, abortSignal: AbortSignal.timeout(10_000) };
  let facts: Array<{ asset: string; issuer: string; mints: string[] } | null>;
  let balances: Map<string, bigint>;
  try {
    [facts, balances] = await Promise.all([
      Promise.all(assets.map(async (pda) => {
        const asset = await fetchMaybeAsset(rpc, address(pda), options);
        if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
            !sameBytes(asset.data.discriminator, getAssetDiscriminatorBytes())) return null;
        const [expected] = await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId });
        if (expected !== pda) return null;
        const classAddresses: Address[] = [];
        for (let i = 0; i < asset.data.shareClassesCount; i++) classAddresses.push(await findShareClassPda(address(pda), i));
        const mints: string[] = [];
        for (let i = 0; i < classAddresses.length; i += ACCOUNTS_PER_READ) {
          const classes = await fetchAllMaybeShareClass(rpc, classAddresses.slice(i, i + ACCOUNTS_PER_READ), options);
          for (const sc of classes) {
            if (sc.exists && sc.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
                sameBytes(sc.data.discriminator, getShareClassDiscriminatorBytes()) &&
                sc.data.asset.toString() === pda && sc.data.mintInitialized) mints.push(sc.data.mint.toString());
          }
        }
        return { asset: pda, issuer: asset.data.issuer.toString(), mints };
      })),
      getToken2022Balances(wallet),
    ]);
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    throw new SiwsError(503, "On-chain holdings check unavailable — try again");
  }
  return facts.flatMap((fact) =>
    fact && fact.mints.some((mint) => (balances.get(mint) ?? BigInt(0)) > BigInt(0)) ? [{ asset: fact.asset, issuer: fact.issuer }] : []);
}

/** 1–ISSUER_UPDATE_LIMITS.holderAssets distinct asset addresses. */
export function readHolderAssets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ISSUER_UPDATE_LIMITS.holderAssets) {
    throw new SiwsError(400, `Name 1–${ISSUER_UPDATE_LIMITS.holderAssets} assets`);
  }
  return [...new Set(value.map((v) => readAddress(v, "Each asset")))];
}

// ── Public reads ────────────────────────────────────────────────────────────

/**
 * Whether an archived issuer or asset (lib/archive.ts) hides the public
 * updates. Fails open, like the published profile lists: hiding is a
 * convenience, never a security boundary (holders keep their signed reads).
 */
export async function hiddenByArchive(sb: SupabaseClient, issuerPda: string, assetPda: string | null): Promise<boolean> {
  try {
    const archived = await readArchivedSet(sb);
    return archived.issuers.includes(issuerPda) || (assetPda !== null && archived.assets.includes(assetPda));
  } catch {
    return false;
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * A short-lived (CONFIDENTIAL_URL_TTL_S) signed URL for an attachment in the
 * private bucket, handed out only after the caller's own access check. 404
 * when the object is missing, 503 when storage cannot sign.
 */
export async function signDocumentUrl(sb: SupabaseClient, storagePath: string): Promise<string> {
  const { data, error } = await sb.storage.from(CONFIDENTIAL_BUCKET).createSignedUrl(storagePath, CONFIDENTIAL_URL_TTL_S);
  if (error || !data?.signedUrl) {
    if (/not.?found/i.test(error?.message ?? "")) throw new SiwsError(404, "The document file is missing");
    console.error("[issuer-updates] signing failed:", error?.message ?? "no URL");
    throw new SiwsError(503, "Could not sign the download link — try again");
  }
  return data.signedUrl;
}

export { CONFIDENTIAL_URL_TTL_S as DOCUMENT_URL_TTL_S };
