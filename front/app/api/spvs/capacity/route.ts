// POST /api/spvs/capacity — the rolling 12-month EUR capacity of an SPV, or
// of the subject behind an asset ("spvs.capacity"; a wallet session may
// authorize it; Talas 5.1). Replaces the browser's calendar-year read of
// spv_issuances (anonymous reads end with migration 0074).
//   {spv_id}  an admin only
//   {asset}   an admin or the asset's issuer authority; the subject is the
//             asset's SPV (0066 sale_capacity_spv, non-strict) or its issuer
// Returns cap, issued, reserved, used, remaining, window_start, holds.

import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, fetchMaybeAsset, fetchMaybeIssuer } from "@/lib/generated/asset_registry";
import { getServerRpc } from "@/lib/server/rpc";
import { UUID_RE, addressParam, resolveSubjectSpv, saleCapacity } from "@/lib/server/sale-capacity";
import { isAdminWallet } from "@/app/api/launchpad/_lib";

async function assetIssuer(asset: string): Promise<{ issuer: string; authority: string } | null> {
  try {
    const config = { commitment: "confirmed" as const, abortSignal: AbortSignal.timeout(12_000) };
    const a = await fetchMaybeAsset(getServerRpc(), address(asset), config);
    if (!a.exists || a.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
    const i = await fetchMaybeIssuer(getServerRpc(), a.data.issuer, config);
    if (!i.exists || i.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
    return { issuer: a.data.issuer, authority: i.data.authority };
  } catch {
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "spvs.capacity");
    const sb = getSupabaseAdmin();
    let subject: string;
    let spvId: string | null = null;
    if (typeof params.spv_id === "string") {
      await requireAdmin(wallet);
      if (!UUID_RE.test(params.spv_id)) throw new SiwsError(400, "spv_id must be a UUID");
      const { data, error } = await sb.from("spvs").select("id").eq("id", params.spv_id).eq("network", detectNetwork()).maybeSingle();
      if (error) throw new SiwsError(503, "Could not load the SPV");
      if (!data) throw new SiwsError(404, "SPV not found");
      spvId = params.spv_id;
      subject = `spv:${spvId}`;
    } else if (params.asset !== undefined) {
      const asset = addressParam(params.asset, "asset");
      const chain = await assetIssuer(asset);
      if (!chain) throw new SiwsError(404, "Asset not found on-chain");
      if (chain.authority !== wallet && !(await isAdminWallet(wallet))) {
        throw new SiwsError(403, "Only the asset's issuer or an admin may read its raise capacity");
      }
      spvId = await resolveSubjectSpv(sb, asset, chain.issuer, false);
      subject = spvId ? `spv:${spvId}` : `issuer:${chain.issuer}`;
    } else {
      throw new SiwsError(400, "spv_id or asset is required");
    }
    const capacity = await saleCapacity(sb, subject);
    return NextResponse.json({ ok: true, data: { subject, spv_id: spvId, ...capacity } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
