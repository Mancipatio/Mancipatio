// Shared server-side helpers for the /api/vesting/* signed routes.
// (Underscore prefix keeps this file out of routing — same trick as
// app/api/applications/_lib.ts.)
//
// Authorization model for editing an existing vesting schedule
// (update-status / publish-milestone):
//   1. platform admin (on-chain Admin PDA / super admin), OR
//   2. schedule author (the wallet that created it via the admin-only
//      builder — preserved so today's "author can manage" circle keeps
//      working even if the admin role is later rotated), OR
//   3. the on-chain Issuer.authority of the schedule's asset — resolved
//      asset_mint -> share_classes.asset_pda (indexer DB, service role)
//      -> ShareClass -> Asset.issuer -> Issuer.authority (fresh finalized RPC).
// Any RPC failure fails CLOSED with 503.

import "server-only";

import { address as toAddress } from "@solana/kit";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeShareClass,
  fetchMaybeAsset,
  fetchMaybeIssuer,
} from "@/lib/generated/asset_registry";

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const DIGITS_RE = /^[0-9]{1,36}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VESTING_STATUSES = new Set([
  "draft",
  "beneficiaries_set",
  "merkle_built",
  "published",
  "live",
  "completed",
  "cancelled",
]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-throwing admin probe: 403 -> false; 503 (RPC down) propagates so we
 *  never fall through to a weaker path while auth checks are blind. */
export async function isAdminWallet(wallet: string): Promise<boolean> {
  try {
    await requireAdmin(wallet);
    return true;
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Issuer authority is a live authorization check; role rotation takes effect immediately.
// ---------------------------------------------------------------------------

/**
 * Returns the on-chain issuer authority wallet for a share-class mint, or
 * null when the mint is unknown to the indexer / the asset does not exist
 * on-chain. Throws SiwsError(503) on RPC failure (fail closed).
 */
export async function issuerAuthorityForMint(
  mint: string,
): Promise<string | null> {
  // Indexer lookup is only a HINT (mint -> asset_pda); the actual grant is
  // confirmed against the live on-chain Asset/Issuer accounts below.
  const sb = getSupabaseAdmin();
  const { data: sc, error: scErr } = await sb
    .from("share_classes")
    .select("pda, asset_pda")
    .eq("mint", mint)
    .eq("network", detectNetwork())
    .limit(1)
    .maybeSingle();
  if (scErr) {
    console.error("[api/vesting] share_classes lookup failed:", scErr.message);
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }

  let authority: string | null = null;
  const assetPda = (sc?.asset_pda as string | undefined) ?? null;
  if (assetPda && BASE58_RE.test(assetPda)) {
    try {
      const rpc = getServerRpc();
      const options = {
        commitment: "finalized" as const,
        abortSignal: AbortSignal.timeout(10_000),
      };
      if (!sc?.pda) return null;
      const share = await fetchMaybeShareClass(rpc, toAddress(sc.pda), options);
      if (
        !share.exists ||
        share.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        share.data.mint !== mint ||
        share.data.asset !== assetPda
      )
        return null;
      const asset = await fetchMaybeAsset(rpc, toAddress(assetPda), options);
      if (
        asset.exists &&
        asset.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS
      ) {
        const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer, options);
        if (
          issuer.exists &&
          issuer.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS
        )
          authority = issuer.data.authority.toString();
      }
    } catch (err) {
      console.error(
        "[api/vesting] RPC failure resolving issuer authority:",
        err,
      );
      throw new SiwsError(503, "Authorization check unavailable — try again");
    }
  }

  return authority;
}

export type VestingScheduleRow = {
  id: string;
  author: string;
  asset_mint: string;
  title: string;
  status: string;
};

/**
 * Loads the schedule and enforces the edit circle (admin OR author OR
 * on-chain issuer authority of the schedule's asset). Throws SiwsError
 * 400/404/403/503. Returns the schedule row on success.
 */
export async function requireVestingEditor(
  wallet: string,
  scheduleId: string,
): Promise<VestingScheduleRow> {
  if (!UUID_RE.test(scheduleId)) {
    throw new SiwsError(400, "schedule_id must be a UUID");
  }
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("vesting_schedules")
    .select("id, author, asset_mint, title, status")
    .eq("id", scheduleId)
    .maybeSingle();
  if (error) {
    console.error("[api/vesting] schedule lookup failed:", error.message);
    throw new SiwsError(500, "Schedule lookup failed");
  }
  if (!data) throw new SiwsError(404, "Schedule not found");
  const row = data as VestingScheduleRow;

  if (await isAdminWallet(wallet)) return row;
  if (row.author === wallet) return row;
  const authority = await issuerAuthorityForMint(row.asset_mint);
  if (authority !== null && authority === wallet) return row;

  throw new SiwsError(
    403,
    "Only a platform admin, the schedule author, or the asset's issuer authority may edit this schedule",
  );
}
