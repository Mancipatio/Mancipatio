import "server-only";

// Server side of the archive (lib/archive.ts): the archived set every list
// reads, and the chain facts an archive decision rests on (read fresh, fail
// closed: an RPC failure is a 503, never "nothing in the way").

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  address,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetStatus,
  fetchAllMaybeShareClass,
  fetchMaybeAsset,
  findAssetPda,
  getAssetDecoder,
  getAssetDiscriminatorBytes,
  getIssuerDiscriminatorBytes,
  fetchMaybeIssuer,
  findIssuerPda,
} from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import { listOpenSales } from "@/lib/distribution-chain";
import { listLiveApprovals } from "@/lib/server/sale-capacity-chain";
import { getServerRpc } from "@/lib/server/rpc";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { SiwsError } from "@/lib/server/siws";
import { detectNetwork } from "@/lib/network";
import { circulatingOf, type AssetArchiveFacts } from "@/lib/archive";

/** Postgres undefined_column / PostgREST schema-cache miss: migration 0081 not applied yet. */
export function isMissingArchiveColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /column .*archive|'archive' column/i.test(error.message ?? "");
}

export type ArchivedPdas = { assets: string[]; issuers: string[]; issuerArchiveAvailable: boolean };

/** The archived asset and issuer PDAs of this network. Throws 503 when the asset rows are unreadable. */
export async function readArchivedSet(sb: SupabaseClient): Promise<ArchivedPdas> {
  const network = detectNetwork();
  const assets = await sb.from("asset_profiles").select("asset_pda").eq("network", network).eq("status", "archived");
  if (assets.error) throw new SiwsError(503, "Archived assets unavailable — try again");
  let issuers: string[] = [];
  let issuerArchiveAvailable = true;
  const rows = await sb.from("issuer_profiles").select("issuer_pda,archive").eq("network", network);
  if (rows.error) {
    if (!isMissingArchiveColumn(rows.error)) throw new SiwsError(503, "Archived issuers unavailable — try again");
    issuerArchiveAvailable = false;
  } else {
    issuers = (rows.data ?? [])
      .filter((r) => (r as { archive?: unknown }).archive !== null && (r as { archive?: unknown }).archive !== undefined)
      .map((r) => String((r as { issuer_pda: string }).issuer_pda));
  }
  return {
    assets: (assets.data ?? []).map((r) => String((r as { asset_pda: string }).asset_pda)),
    issuers,
    issuerArchiveAvailable,
  };
}

/**
 * The archived issuer PDAs, for public reads that hide them (the published
 * profiles). Fails open: an unreadable set (or a database before 0081) hides
 * nothing — hiding is a convenience, never a security boundary.
 */
export async function readArchivedIssuers(sb: SupabaseClient): Promise<Set<string>> {
  try {
    const { data, error } = await sb.from("issuer_profiles").select("issuer_pda,archive").eq("network", detectNetwork());
    if (error) return new Set();
    return new Set((data ?? [])
      .filter((r) => (r as { archive?: unknown }).archive !== null && (r as { archive?: unknown }).archive !== undefined)
      .map((r) => String((r as { issuer_pda: string }).issuer_pda)));
  } catch {
    return new Set();
  }
}

export const ARCHIVED_ASSET_REFUSAL =
  "This asset is archived: unarchive it first (Admin → Assets → Show archived → Unarchive), then try again.";
export const ARCHIVED_ISSUER_REFUSAL =
  "This asset's issuer is archived: unarchive the issuer first (Admin → Issuers → Show archived → Unarchive issuer), then try again.";

/**
 * Refuses (409) a write that would offer, approve or mint an archived asset,
 * or an asset of an archived issuer: a sale request (which publishes the
 * profile), a sale approval, a treasury mint. Only /api/archive/set takes an
 * archive back, with its reason and audit event. Fails closed (503) when the
 * rows cannot be read; before migration 0081 no issuer is archived.
 */
export async function requireNotArchived(sb: SupabaseClient, asset: string, issuer: string): Promise<void> {
  const network = detectNetwork();
  const [assetRow, issuerRow] = await Promise.all([
    sb.from("asset_profiles").select("status").eq("network", network).eq("asset_pda", asset).maybeSingle(),
    sb.from("issuer_profiles").select("archive").eq("network", network).eq("issuer_pda", issuer).maybeSingle(),
  ]);
  if (assetRow.error) throw new SiwsError(503, "Asset profile unavailable — try again");
  if ((assetRow.data as { status?: unknown } | null)?.status === "archived") {
    throw new SiwsError(409, ARCHIVED_ASSET_REFUSAL);
  }
  if (issuerRow.error) {
    if (!isMissingArchiveColumn(issuerRow.error)) throw new SiwsError(503, "Issuer profile unavailable — try again");
    return;
  }
  const archive = (issuerRow.data as { archive?: unknown } | null)?.archive;
  if (archive !== null && archive !== undefined) throw new SiwsError(409, ARCHIVED_ISSUER_REFUSAL);
}

/** Non-throwing super-admin probe: 403 -> false; 503 propagates (fail closed). */
export async function isSuperAdminWallet(wallet: string): Promise<boolean> {
  try {
    await requireSuperAdmin(wallet);
    return true;
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) return false;
    throw err;
  }
}

const options = () => ({ commitment: "confirmed" as const, abortSignal: AbortSignal.timeout(12_000) });

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export type AssetArchiveChain = AssetArchiveFacts & { issuer: string; name: string; assetId: string };

/** The asset's classes, Open sales and live approvals, read fresh. 404 when it is not a registry asset. */
export async function readAssetArchiveFacts(assetPda: string): Promise<AssetArchiveChain> {
  let pda: Address;
  try { pda = address(assetPda); } catch { throw new SiwsError(400, "Invalid asset address"); }
  try {
    const rpc = getServerRpc();
    const asset = await fetchMaybeAsset(rpc, pda, options());
    if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !sameBytes(asset.data.discriminator, getAssetDiscriminatorBytes())) {
      throw new SiwsError(404, "Asset not found on chain");
    }
    const [expected] = await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId });
    if (expected !== pda) throw new SiwsError(404, "Asset not found on chain");
    const classPdas = await Promise.all(
      Array.from({ length: asset.data.shareClassesCount }, (_, i) => findShareClassPda(pda, i)),
    );
    const [classes, approvals] = await Promise.all([
      classPdas.length ? fetchAllMaybeShareClass(rpc, classPdas, options()) : Promise.resolve([]),
      listLiveApprovals(AbortSignal.timeout(12_000)),
    ]);
    const existing = classes.filter((c) => c.exists);
    const sales = await Promise.all(existing.map((c) => listOpenSales(rpc, { shareClass: c.address })));
    const classSet = new Set(existing.map((c) => c.address.toString()));
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      issuer: asset.data.issuer.toString(),
      name: asset.data.name,
      assetId: asset.data.assetId,
      draft: asset.data.status === AssetStatus.Draft,
      classes: existing.map((c) => ({
        address: c.address.toString(),
        classIndex: c.data.classIndex,
        circulating: BigInt(c.data.circulatingSupply),
        lifetimeMinted: BigInt(c.data.lifetimeMinted),
        supplyLocked: c.data.supplyLocked,
      })),
      openSales: sales.reduce((n, list) => n + list.length, 0),
      liveApprovals: approvals.filter((a) => classSet.has(a.shareClass.toString()) && a.expiresAt >= now).length,
    };
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    console.error("[archive] chain read failed:", err instanceof Error ? err.message : String(err));
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** Confirms the PDA is a registry Issuer. 404 otherwise. */
export async function requireIssuerAccount(issuerPda: string): Promise<{ authority: string }> {
  let pda: Address;
  try { pda = address(issuerPda); } catch { throw new SiwsError(400, "Invalid issuer address"); }
  try {
    const issuer = await fetchMaybeIssuer(getServerRpc(), pda, options());
    if (!issuer.exists || issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !sameBytes(issuer.data.discriminator, getIssuerDiscriminatorBytes())) {
      throw new SiwsError(404, "Issuer not found on chain");
    }
    const [expected] = await findIssuerPda({ legalEntityId: issuer.data.legalEntityId });
    if (expected !== pda) throw new SiwsError(404, "Issuer not found on chain");
    return { authority: issuer.data.authority.toString() };
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

/** Every asset of an issuer (PDA, name, circulating supply), read fresh. */
export async function readIssuerAssets(issuerPda: string): Promise<{ assetPda: string; name: string; circulating: bigint }[]> {
  try {
    const rpc = getServerRpc();
    const discriminator = getBase58Decoder().decode(getAssetDiscriminatorBytes()) as Base58EncodedBytes;
    const rows = await rpc.getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: BigInt(0), bytes: discriminator, encoding: "base58" } },
        { memcmp: { offset: BigInt(8), bytes: issuerPda as unknown as Base58EncodedBytes, encoding: "base58" } },
      ],
    }).send({ abortSignal: AbortSignal.timeout(12_000) });
    const decoder = getAssetDecoder();
    const out: { assetPda: string; name: string; circulating: bigint }[] = [];
    for (const row of rows) {
      const asset = decoder.decode(b64ToBytes((row.account.data as readonly [string, string])[0]));
      if (asset.issuer.toString() !== issuerPda) continue;
      const classPdas = await Promise.all(
        Array.from({ length: asset.shareClassesCount }, (_, i) => findShareClassPda(row.pubkey, i)),
      );
      const classes = classPdas.length ? await fetchAllMaybeShareClass(rpc, classPdas, options()) : [];
      out.push({
        assetPda: row.pubkey.toString(),
        name: asset.name,
        circulating: circulatingOf({
          classes: classes.filter((c) => c.exists).map((c) => ({
            address: c.address.toString(),
            classIndex: c.data.classIndex,
            circulating: BigInt(c.data.circulatingSupply),
            lifetimeMinted: BigInt(c.data.lifetimeMinted),
            supplyLocked: c.data.supplyLocked,
          })),
        }),
      });
    }
    return out;
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    console.error("[archive] issuer assets read failed:", err instanceof Error ? err.message : String(err));
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}
