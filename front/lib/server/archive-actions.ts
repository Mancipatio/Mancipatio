import "server-only";

// The archive decisions (lib/archive.ts) as the two routes take them:
// /api/archive/check reports them (no write), /api/archive/set acts on them.
//
// Who may act:
//   asset  — the SUPER admin (any asset; blockers need `confirm`), or the
//            asset's own issuer authority while it is a Draft / never minted
//            with nothing in the way (issuerArchiveRefusal). An issuer may
//            unarchive only what it archived itself.
//   issuer — the SUPER admin only; refused while one of its assets that is
//            not archived still has tokens in circulation.
// Other admins may look (check) but not act.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import { detectNetwork } from "@/lib/network";
import { isProfileAdmin, requireProfileOwner } from "@/lib/server/profile-read";
import {
  isMissingArchiveColumn,
  isSuperAdminWallet,
  readAssetArchiveFacts,
  readIssuerAssets,
  requireIssuerAccount,
  type AssetArchiveChain,
} from "@/lib/server/archive";
import {
  assetArchiveBlockers,
  issuerArchiveRefusal,
  lockableAtZero,
  readArchiveRecord,
  type ArchiveBlocker,
  type ArchiveKind,
  type ArchiveRecord,
} from "@/lib/archive";

export type ArchiveActor = "super" | "issuer" | "admin";

export const ISSUER_ARCHIVE_UNAVAILABLE =
  "Issuer archive needs database migration 0081 (issuer_profiles.archive), which is not applied yet. Asset archive works without it.";

export function readKind(value: unknown): ArchiveKind {
  if (value !== "asset" && value !== "issuer") throw new SiwsError(400, "kind must be \"asset\" or \"issuer\"");
  return value;
}

export function readPda(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())) {
    throw new SiwsError(400, "A base58 address is required");
  }
  return value.trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type AssetProfileRow = { status: string | null; is_published: boolean | null; fields: Record<string, unknown> | null } | null;

export type AssetArchiveState = {
  kind: "asset";
  pda: string;
  actor: ArchiveActor;
  chain: AssetArchiveChain;
  row: AssetProfileRow;
  record: ArchiveRecord | null;
  archived: boolean;
  blockers: ArchiveBlocker[];
  /** Why the issuer path may not archive (null for the super admin, or when allowed). */
  refusal: string | null;
  canArchive: boolean;
  canUnarchive: boolean;
  /** Why unarchive is refused for this actor (null when allowed or not archived). */
  unarchiveRefusal: string | null;
};

/** Who the wallet is for this asset: super admin, its issuer authority, or (look-only) another admin. 403 otherwise. */
async function assetActor(wallet: string, pda: string): Promise<ArchiveActor> {
  if (await isSuperAdminWallet(wallet)) return "super";
  try {
    await requireProfileOwner(wallet, pda, "asset");
    return "issuer";
  } catch (err) {
    if (!(err instanceof SiwsError) || err.status !== 403) throw err;
  }
  if (await isProfileAdmin(wallet)) return "admin";
  throw new SiwsError(403, "Only the super admin or the asset's issuer can archive it");
}

export async function assetArchiveState(sb: SupabaseClient, wallet: string, pda: string): Promise<AssetArchiveState> {
  const actor = await assetActor(wallet, pda);
  const chain = await readAssetArchiveFacts(pda);
  const { data, error } = await sb.from("asset_profiles").select("status,is_published,fields")
    .eq("network", detectNetwork()).eq("asset_pda", pda).maybeSingle();
  if (error) throw new SiwsError(503, "Asset profile unavailable — try again");
  const row: AssetProfileRow = data
    ? {
        status: typeof data.status === "string" ? data.status : null,
        is_published: data.is_published === true,
        fields: isPlainObject(data.fields) ? data.fields : null,
      }
    : null;
  const archived = row?.status === "archived";
  const record = archived ? readArchiveRecord(row?.fields?.archive) : null;
  const blockers = assetArchiveBlockers(chain);
  const refusal = actor === "issuer" ? issuerArchiveRefusal(chain) : null;
  let unarchiveRefusal: string | null = null;
  if (archived && actor === "issuer" && record?.archived_by !== wallet) {
    unarchiveRefusal = "The platform archived this asset: only the super admin can unarchive it.";
  }
  if (actor === "admin") unarchiveRefusal = archived ? "Only the super admin can unarchive it." : null;
  return {
    kind: "asset",
    pda,
    actor,
    chain,
    row,
    record,
    archived,
    blockers,
    refusal: actor === "admin" ? "Only the super admin (or the asset's issuer, for a draft) can archive it." : refusal,
    canArchive: !archived && (actor === "super" || (actor === "issuer" && refusal === null)),
    canUnarchive: archived && unarchiveRefusal === null && actor !== "admin",
    unarchiveRefusal,
  };
}

export type IssuerArchiveState = {
  kind: "issuer";
  pda: string;
  actor: ArchiveActor;
  available: boolean;
  record: ArchiveRecord | null;
  archived: boolean;
  rowExists: boolean;
  blockers: ArchiveBlocker[];
  canArchive: boolean;
  canUnarchive: boolean;
};

export async function issuerArchiveState(sb: SupabaseClient, wallet: string, pda: string): Promise<IssuerArchiveState> {
  const superAdmin = await isSuperAdminWallet(wallet);
  if (!superAdmin && !(await isProfileAdmin(wallet))) {
    throw new SiwsError(403, "Only the super admin can archive an issuer");
  }
  await requireIssuerAccount(pda);
  const network = detectNetwork();
  const { data, error } = await sb.from("issuer_profiles").select("issuer_pda,archive")
    .eq("network", network).eq("issuer_pda", pda).maybeSingle();
  if (error && !isMissingArchiveColumn(error)) throw new SiwsError(503, "Issuer profile unavailable — try again");
  const available = !error;
  const record = available ? readArchiveRecord((data as { archive?: unknown } | null)?.archive) : null;
  const archived = record !== null;
  let blockers: ArchiveBlocker[] = [];
  if (!archived) {
    const assets = await readIssuerAssets(pda);
    const withSupply = assets.filter((a) => a.circulating > BigInt(0));
    if (withSupply.length) {
      const { data: rows, error: archivedError } = await sb.from("asset_profiles").select("asset_pda")
        .eq("network", network).eq("status", "archived").in("asset_pda", withSupply.map((a) => a.assetPda));
      if (archivedError) throw new SiwsError(503, "Archived assets unavailable — try again");
      const archivedAssets = new Set((rows ?? []).map((r) => String((r as { asset_pda: string }).asset_pda)));
      const open = withSupply.filter((a) => !archivedAssets.has(a.assetPda));
      if (open.length) {
        blockers = [{
          code: "issuer_assets_with_supply",
          message: `${open.length} asset${open.length === 1 ? "" : "s"} of this issuer still ${open.length === 1 ? "has" : "have"} tokens in circulation and ${open.length === 1 ? "is" : "are"} not archived (${open.map((a) => `${a.name}: ${a.circulating.toString()}`).join(", ")}). Archive ${open.length === 1 ? "that asset" : "those assets"} first — each asks you to confirm why.`,
        }];
      }
    }
  }
  return {
    kind: "issuer",
    pda,
    actor: superAdmin ? "super" : "admin",
    available,
    record,
    archived,
    rowExists: !!data,
    blockers,
    canArchive: superAdmin && available && !archived && blockers.length === 0,
    canUnarchive: superAdmin && available && archived,
  };
}

/** JSON view of a state for the dialog (bigints as strings). */
export function stateView(state: AssetArchiveState | IssuerArchiveState) {
  if (state.kind === "issuer") {
    const { kind, pda, actor, available, record, archived, blockers, canArchive, canUnarchive } = state;
    return { kind, pda, actor, available, record, archived, blockers, canArchive, canUnarchive, refusal: available ? null : ISSUER_ARCHIVE_UNAVAILABLE };
  }
  const { kind, pda, actor, chain, record, archived, blockers, refusal, canArchive, canUnarchive, unarchiveRefusal } = state;
  const cls = (c: (typeof chain.classes)[number]) => ({
    address: c.address,
    classIndex: c.classIndex,
    circulating: c.circulating.toString(),
    lifetimeMinted: c.lifetimeMinted.toString(),
    supplyLocked: c.supplyLocked,
  });
  return {
    kind, pda, actor, record, archived, blockers, refusal, canArchive, canUnarchive, unarchiveRefusal,
    available: true,
    name: chain.name,
    assetId: chain.assetId,
    issuer: chain.issuer,
    draft: chain.draft,
    openSales: chain.openSales,
    liveApprovals: chain.liveApprovals,
    classes: chain.classes.map(cls),
    lockableAtZero: lockableAtZero(chain).map(cls),
  };
}
