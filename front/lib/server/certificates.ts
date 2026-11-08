// SERVER-ONLY — certificates of tokenized interest (migration 0087,
// lib/certificates/payload.ts): the chain reads a payload is built from,
// the admin form's prefill, the number allocation and the table access of
// the routes under app/api/admin/certificates and app/api/certificates.
//
// Chain reads go to the SERVER RPC (lib/server/rpc.ts: this deployment's
// network, genesis hash checked) at finalized commitment, and fail closed:
// an RPC that cannot answer is a 503, never a zero balance. The share class
// and its asset must be accounts of the asset registry program in the
// current layout; the class must have its mint. The holding is the sum of
// the wallet's Token-2022 accounts of that mint, read in one call whose
// context slot the certificate states; an issuance reads the mint's supply
// the same way. Amounts are integers (share-class mints have 0 decimals; a
// mint with decimals is refused rather than rounded).
//
// The prefill is a convenience only and never fails a request: the company
// details and the scale of the last certificate of the same asset that was
// not revoked (an admin's earlier corrections), else the tokenization record
// (asset_profiles.fields.tokenize: the company name and the token size), the
// issuer's profile and the asset's SPV. The admin confirms or corrects every
// field before a draft is created.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  address,
  fetchEncodedAccount,
  isAddress,
  signature as toSignature,
  type Address,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getAssetDecoder,
  getAssetDiscriminatorBytes,
} from "@/lib/generated/asset_registry";
import { decodeShareClassV2 } from "@/lib/account-versions";
import { companyFiguresFrom } from "@/lib/distribution-rows";
import { HUNDRED_PERCENT_E4 } from "@/lib/tokenize-shares";
import {
  CERTIFICATE_NUMBER_PATTERN,
  CERTIFICATE_PROGRAMS,
  parseCertificatePayload,
  type CertificateChainFacts,
  type CertificateDetail,
  type CertificateEvidence,
  type CertificateEvidenceInput,
  type CertificateKind,
  type CertificatePrefill,
  type CertificateRow,
} from "@/lib/certificates/payload";
import { CERTIFICATE_ID_PATTERN } from "@/lib/certificates/routes";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";

const READ_TIMEOUT_MS = 12_000;
const TOKEN_2022 = CERTIFICATE_PROGRAMS.token2022 as Address;

/** Every column of a row (the admin routes; the payload may hold personal data). */
export const CERTIFICATE_COLUMNS =
  "id,network,number,kind,status,asset_pda,share_class_pda,holder_wallet,payload_canonical,payload_sha256,signer," +
  "signature,signature_format,signed_at,anchor_tx,anchor_slot,anchor_block_time,anchored_at,revoked_at,revoked_by," +
  "revoke_reason,created_by,created_at,updated_at";
/**
 * What the public route selects: no revocation reason, no creator or
 * revoker. It does read the payload, to project the public facts from it
 * for a caller who gives the certificate's SHA-256
 * (lib/certificates/payload.ts publicCertificateView never copies the
 * holder's name or ID number, and without the hash returns only the status).
 */
export const PUBLIC_CERTIFICATE_COLUMNS =
  "number,network,kind,status,payload_canonical,payload_sha256,signer,signature,signature_format,signed_at," +
  "anchor_tx,anchor_slot,anchor_block_time,revoked_at";
/** How many certificates the admin list returns (newest first). */
export const CERTIFICATE_LIST_LIMIT = 200;

/** The 503 every certificate route answers while 0087 is not applied (or the table cannot be read). */
export function certificatesUnavailable(error: { code?: string } | null | undefined): SiwsError {
  return error?.code === "42P01" || error?.code === "42883" || error?.code === "PGRST202" || error?.code === "PGRST205"
    ? new SiwsError(503, "Certificates are not set up on this database yet (migration 0087)")
    : new SiwsError(503, "Certificates unavailable — try again");
}

function chainUnavailable(err: unknown): SiwsError {
  console.error("[certificates] chain read failed:", err instanceof Error ? err.message : String(err));
  return new SiwsError(503, "The chain could not be read — try again");
}

const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An account of the asset registry, or null when there is none at `pda`. 503 when the RPC cannot answer. */
async function readRegistryAccount(pda: string): Promise<Uint8Array | null> {
  let account;
  try {
    account = await fetchEncodedAccount(getServerRpc(), address(pda), {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err) {
    throw chainUnavailable(err);
  }
  if (!account.exists) return null;
  if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
    throw new SiwsError(400, "This address is not an account of the Manci asset registry");
  }
  return Uint8Array.from(account.data);
}

type JsonParsedTokenAccount = {
  account: { owner: string; data: unknown };
};

/**
 * The units of `mint` the wallet holds (Token-2022 accounts it owns, summed)
 * and the slot of the read. A mint with decimals is refused.
 */
async function readHolding(wallet: string, mint: string): Promise<{ units: bigint; slot: bigint }> {
  let response;
  try {
    response = await getServerRpc()
      .getTokenAccountsByOwner(address(wallet), { mint: address(mint) }, { encoding: "jsonParsed", commitment: "finalized" })
      .send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw chainUnavailable(err);
  }
  if (!response || !Array.isArray(response.value)) throw chainUnavailable(new Error("no token accounts in the answer"));
  let units = BigInt(0);
  for (const item of response.value as readonly JsonParsedTokenAccount[]) {
    if (item.account.owner !== TOKEN_2022) throw chainUnavailable(new Error("a token account of another program"));
    const parsed = (item.account.data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } })
      .parsed?.info;
    if (!parsed || parsed.mint !== mint || typeof parsed.tokenAmount?.amount !== "string" || !/^\d+$/.test(parsed.tokenAmount.amount)) {
      throw chainUnavailable(new Error("a token account that does not decode"));
    }
    if (parsed.tokenAmount.decimals !== 0) throw new SiwsError(400, "This mint has decimals: a certificate counts whole units only");
    units += BigInt(parsed.tokenAmount.amount);
  }
  return { units, slot: BigInt(response.context.slot) };
}

/** The mint's supply and the slot of the read. */
async function readSupply(mint: string): Promise<{ circulating: bigint; slot: bigint }> {
  let response;
  try {
    response = await getServerRpc()
      .getTokenSupply(address(mint), { commitment: "finalized" })
      .send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw chainUnavailable(err);
  }
  const amount = response?.value?.amount;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw chainUnavailable(new Error("no supply in the answer"));
  if (response.value.decimals !== 0) throw new SiwsError(400, "This mint has decimals: a certificate counts whole units only");
  return { circulating: BigInt(amount), slot: BigInt(response.context.slot) };
}

/**
 * The chain facts of a certificate of `kind` about the share class at
 * `shareClassPda` (and, for a holding, `wallet`'s units of it). 400 when the
 * address is not a share class with a mint, 503 when the chain cannot be read.
 */
export async function readCertificateChainFacts(input: {
  kind: CertificateKind;
  shareClass: string;
  wallet: string | null;
}): Promise<CertificateChainFacts> {
  if (!isAddress(input.shareClass)) throw new SiwsError(400, "Choose a share class");
  const classBytes = await readRegistryAccount(input.shareClass);
  if (!classBytes) throw new SiwsError(404, "No share class at this address on this network");
  let shareClass;
  try {
    shareClass = decodeShareClassV2(classBytes);
  } catch {
    throw new SiwsError(400, "This address is not a share class of the current registry layout");
  }
  if (!shareClass.mintInitialized) throw new SiwsError(400, "This share class has no token mint yet");
  const assetBytes = await readRegistryAccount(shareClass.asset);
  const discriminator = getAssetDiscriminatorBytes();
  if (!assetBytes || assetBytes.length < 8 || !discriminator.every((b, i) => b === assetBytes[i])) {
    throw new SiwsError(400, "The share class's asset could not be read");
  }
  let asset;
  try {
    asset = getAssetDecoder().decode(assetBytes);
  } catch {
    throw new SiwsError(400, "The share class's asset could not be read");
  }
  const mint = shareClass.mint.toString();
  const holding = input.kind === "holding" ? await readHolding(input.wallet ?? "", mint) : null;
  const supply = input.kind === "issuance" ? await readSupply(mint) : null;
  return {
    asset: {
      address: shareClass.asset.toString(),
      assetId: asset.assetId,
      name: asset.name,
      symbolPrefix: asset.symbolPrefix,
      legalDocHash: hex(asset.legalDocHash),
      issuer: asset.issuer.toString(),
    },
    shareClass: {
      address: input.shareClass,
      classIndex: shareClass.classIndex,
      mint,
      maxSupply: shareClass.maxSupply.__option === "Some" ? shareClass.maxSupply.value : null,
      lifetimeMinted: shareClass.lifetimeMinted,
    },
    holding,
    supply,
  };
}

/**
 * The evidence transactions with their slots: each must be finalized and
 * successful on this network (one getSignatureStatuses call). 400 naming the
 * first that is not, 503 when the chain cannot be read.
 */
export async function readCertificateEvidence(evidence: CertificateEvidenceInput[]): Promise<CertificateEvidence[]> {
  if (evidence.length === 0) return [];
  let response;
  try {
    response = await getServerRpc()
      .getSignatureStatuses(evidence.map((e) => toSignature(e.signature)), { searchTransactionHistory: true })
      .send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw chainUnavailable(err);
  }
  return evidence.map((e, i) => {
    const status = response.value[i];
    const short = `${e.signature.slice(0, 8)}…`;
    if (!status) throw new SiwsError(400, `Evidence ${short} is not a transaction this network knows`);
    if (status.err !== null) throw new SiwsError(400, `Evidence ${short} failed on chain`);
    if (status.confirmationStatus !== "finalized") throw new SiwsError(400, `Evidence ${short} is not finalized yet — try again shortly`);
    return { signature: e.signature, slot: BigInt(status.slot).toString(), note: e.note };
  });
}

/** What the admin form starts from for this asset (best effort: a failed read leaves the field empty). */
export async function readCertificatePrefill(
  sb: SupabaseClient,
  network: string,
  chain: Pick<CertificateChainFacts, "asset">,
): Promise<CertificatePrefill> {
  const prefill: CertificatePrefill = {
    company: { legal_name: "", registration_number: "", address: "" },
    company_source: null,
    units_for_100_percent: null,
    scale_source: null,
  };
  // A revoked certificate may have been revoked for wrong company details.
  const last = await sb
    .from("certificates")
    .select("payload_canonical")
    .eq("network", network)
    .eq("asset_pda", chain.asset.address)
    .neq("status", "revoked")
    .order("created_at", { ascending: false })
    .limit(1);
  const lastText = (last.data as Array<{ payload_canonical?: unknown }> | null)?.[0]?.payload_canonical;
  if (!last.error && typeof lastText === "string") {
    try {
      const payload = parseCertificatePayload(lastText);
      prefill.company = { ...payload.company };
      prefill.company_source = "certificate";
      prefill.units_for_100_percent = payload.share_class.units_for_100_percent;
      prefill.scale_source = "certificate";
    } catch {
      // An unreadable earlier payload is not a prefill.
    }
  }

  const profile = await sb
    .from("asset_profiles")
    .select("fields,spv_id")
    .eq("network", network)
    .eq("asset_pda", chain.asset.address)
    .maybeSingle();
  const row = profile.error ? null : (profile.data as { fields?: unknown; spv_id?: unknown } | null);
  const tokenize = row?.fields && typeof row.fields === "object" ? (row.fields as Record<string, unknown>).tokenize : null;
  const figures = companyFiguresFrom(tokenize);
  if (!prefill.units_for_100_percent && figures) {
    prefill.units_for_100_percent = (HUNDRED_PERCENT_E4 / figures.tokenE4).toString();
    prefill.scale_source = "tokenization";
  }
  if (prefill.company_source) return prefill;

  const tokenizeName = tokenize && typeof tokenize === "object" ? (tokenize as Record<string, unknown>).company_name : null;
  if (typeof tokenizeName === "string" && tokenizeName.trim()) {
    prefill.company.legal_name = tokenizeName.trim();
    prefill.company_source = "tokenization";
    return prefill;
  }
  const issuer = await sb
    .from("issuer_profiles")
    .select("company_name")
    .eq("network", network)
    .eq("issuer_pda", chain.asset.issuer)
    .maybeSingle();
  const issuerName = issuer.error ? null : (issuer.data as { company_name?: unknown } | null)?.company_name;
  if (typeof issuerName === "string" && issuerName.trim()) {
    prefill.company.legal_name = issuerName.trim();
    prefill.company_source = "issuer_profile";
    return prefill;
  }
  if (typeof row?.spv_id === "string") {
    const spv = await sb.from("spvs").select("name,registration_number").eq("network", network).eq("id", row.spv_id).maybeSingle();
    const data = spv.error ? null : (spv.data as { name?: unknown; registration_number?: unknown } | null);
    if (typeof data?.name === "string" && data.name.trim()) {
      prefill.company.legal_name = data.name.trim();
      prefill.company.registration_number = typeof data.registration_number === "string" ? data.registration_number.trim() : "";
      prefill.company_source = "spv";
    }
  }
  return prefill;
}

/** The next certificate number of `year` on this network (0087 allocate_certificate_number). */
export async function allocateCertificateNumber(sb: SupabaseClient, year: number): Promise<string> {
  const { data, error } = await sb.rpc("allocate_certificate_number", { p_year: year });
  if (error) throw certificatesUnavailable(error);
  if (typeof data !== "string" || !CERTIFICATE_NUMBER_PATTERN.test(data)) {
    throw new SiwsError(503, "Certificate number allocation answered unexpectedly — try again");
  }
  return data;
}

/**
 * Stores a new draft (the database refuses any other first status, a hash
 * that is not of the canonical text, and columns that differ from the
 * payload). 503 when the table cannot be written.
 */
export async function insertCertificateDraft(
  sb: SupabaseClient,
  draft: Pick<CertificateRow, "network" | "number" | "kind" | "asset_pda" | "share_class_pda" | "holder_wallet" | "payload_canonical" | "payload_sha256" | "signer" | "created_by">,
): Promise<CertificateRow> {
  const { data, error } = await sb.from("certificates").insert(draft).select(CERTIFICATE_COLUMNS).single();
  if (error || !data) {
    if (error?.code === "23505") throw new SiwsError(409, "This certificate number is already taken — create the draft again");
    if (error?.code === "23514" || error?.code === "22P02") {
      console.error("[certificates] draft refused by the database:", error.code, error.message);
      throw new SiwsError(500, "The database refused this certificate draft");
    }
    throw certificatesUnavailable(error);
  }
  return data as unknown as CertificateRow;
}

/** 16 random bytes, lowercase hex: the payload's salt. */
export function certificateSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One row of this network by id, or null. 503 when the table cannot be read. */
export async function readCertificate(sb: SupabaseClient, network: string, id: string): Promise<CertificateRow | null> {
  const { data, error } = await sb.from("certificates").select(CERTIFICATE_COLUMNS).eq("network", network).eq("id", id).limit(1);
  if (error) throw certificatesUnavailable(error);
  return ((data ?? []) as unknown as CertificateRow[])[0] ?? null;
}

/** The newest rows of this network. */
export async function listCertificateRows(sb: SupabaseClient, network: string): Promise<CertificateRow[]> {
  const { data, error } = await sb
    .from("certificates")
    .select(CERTIFICATE_COLUMNS)
    .eq("network", network)
    .order("created_at", { ascending: false })
    .limit(CERTIFICATE_LIST_LIMIT);
  if (error) throw certificatesUnavailable(error);
  return (data ?? []) as unknown as CertificateRow[];
}

/**
 * Moves one row from `from` to the patch's status, only while it is still in
 * `from` (compare and set: two admins acting at once cannot both move it).
 * Returns the row as written, or null when it was no longer in `from`. The
 * database's guard (certificates_guard) refuses any move or change the
 * lifecycle does not allow: such a refusal is a 409.
 */
export async function moveCertificate(
  sb: SupabaseClient,
  network: string,
  id: string,
  from: CertificateRow["status"],
  patch: Partial<Pick<CertificateRow, "status" | "signature" | "signature_format" | "anchor_tx" | "anchor_slot" | "anchor_block_time" | "revoked_by" | "revoke_reason">>,
): Promise<CertificateRow | null> {
  const { data, error } = await sb
    .from("certificates")
    .update(patch)
    .eq("network", network)
    .eq("id", id)
    .eq("status", from)
    .select(CERTIFICATE_COLUMNS);
  if (error) {
    if (error.code === "23514") throw new SiwsError(409, "The certificate's lifecycle does not allow this change");
    throw certificatesUnavailable(error);
  }
  return ((data ?? []) as unknown as CertificateRow[])[0] ?? null;
}

/** `params.id` as a certificate id, or 400. */
export function certificateIdParam(params: Record<string, unknown>): string {
  const id = typeof params.id === "string" ? params.id.trim().toLowerCase() : "";
  if (!CERTIFICATE_ID_PATTERN.test(id)) throw new SiwsError(400, "A certificate id is required");
  return id;
}

/** A row with its parsed payload (the admin detail). 500 when the stored payload does not parse. */
export function certificateDetail(row: CertificateRow): CertificateDetail {
  try {
    return { ...row, payload: parseCertificatePayload(row.payload_canonical) };
  } catch (err) {
    console.error("[certificates] stored payload does not parse:", row.id, err instanceof Error ? err.message : String(err));
    throw new SiwsError(500, "This certificate's stored payload cannot be read");
  }
}

/**
 * One server audit row of a certificate step (category "operator", a
 * server-only category). Best effort: the certificate row itself records
 * who did what and when, so a failed audit insert is logged, not fatal.
 * Nothing from the payload's holder section: the metadata is the number,
 * kind, hash, asset, class and wallet (the reason of a revocation is the
 * admin's own text, as in every audit row).
 */
export async function auditCertificate(
  sb: SupabaseClient,
  input: {
    ixName: "certificate_create" | "certificate_sign" | "certificate_anchor" | "certificate_revoke";
    wallet: string;
    via: "signature" | "session" | undefined;
    row: CertificateRow;
    reason: string;
    txSignature?: string | null;
  },
): Promise<void> {
  try {
    await writeServerAudit(sb, {
      ix_name: input.ixName,
      category: "operator",
      actor_wallet: input.wallet,
      actor_source: actorSourceOf(input.via),
      reason: input.reason.slice(0, 1_000),
      target_label: input.row.number,
      tx_signature: input.txSignature ?? null,
      status: "success",
      metadata: {
        certificate_id: input.row.id,
        number: input.row.number,
        kind: input.row.kind,
        status: input.row.status,
        payload_sha256: input.row.payload_sha256,
        asset_pda: input.row.asset_pda,
        share_class_pda: input.row.share_class_pda,
        holder_wallet: input.row.holder_wallet,
      },
    });
  } catch {
    console.error(`[certificates] audit row not written (${input.ixName})`);
  }
}
