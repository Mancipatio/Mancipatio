// POST /api/sale-requests/decide — a public-sale request leaves "requested"
// ("saleRequests.decide", signed).
//
//   withdraw  the class's issuer authority takes its request back;
//   decline   an Admin declines it, with a reason (5–1000 characters);
//   opened    the issuer authority opened the sale: the Sale account (read on
//             chain) must be of this class and opened by this key.
// An approval already on chain is not touched here (the operator revokes
// it on /admin/launchpad). The server stamps who and when.
//
// Params: share_class, request_id, action, reason? (decline), sale? (opened).
// Client wrapper: decideSaleRequest() in lib/sale-requests.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { addressParam } from "@/lib/server/sale-capacity";
import { getServerRpc } from "@/lib/server/rpc";
import { fetchMaybeSale } from "@/lib/generated/asset_registry";
import type { SaleRequest } from "@/lib/public-sale";
import { fieldsWithRequest, readRequestProfile, storedRequest } from "@/lib/server/sale-requests";
import { shareClassChain } from "@/app/api/sale-approvals/_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "saleRequests.decide");
    const network = detectNetwork();
    const shareClass = addressParam(params.share_class, "share_class");
    const action = params.action;
    if (action !== "withdraw" && action !== "decline" && action !== "opened") {
      throw new SiwsError(400, "action must be withdraw, decline or opened");
    }
    const requestId = typeof params.request_id === "string" ? params.request_id : "";
    const chain = await shareClassChain(shareClass);

    let reason: string | null = null;
    let sale: string | null = null;
    if (action === "decline") {
      await requireAdmin(wallet);
      reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (reason.length < 5 || reason.length > 1000) throw new SiwsError(400, "A reason (5–1000 characters) is required to decline");
    } else {
      if (chain.authority !== wallet) throw new SiwsError(403, "Only the issuer's key may change its own request");
    }
    if (action === "opened") {
      const saleAddress = addressParam(params.sale, "sale");
      let found;
      try {
        found = await fetchMaybeSale(getServerRpc(), saleAddress, { commitment: "confirmed", abortSignal: AbortSignal.timeout(12_000) });
      } catch {
        throw new SiwsError(503, "On-chain check unavailable — try again");
      }
      if (!found.exists || found.data.shareClass !== shareClass || found.data.authority !== wallet) {
        throw new SiwsError(409, "No sale of this class opened by this key at that address");
      }
      sale = saleAddress;
    }

    const sb = getSupabaseAdmin();
    const profile = await readRequestProfile(sb, chain.asset);
    const current = storedRequest(profile);
    if (!profile || !current || current.share_class !== shareClass || current.id !== requestId) {
      throw new SiwsError(404, "No such request for this class");
    }
    if (current.status !== "requested") throw new SiwsError(409, `The request is already ${current.status}`);

    const next: SaleRequest = {
      ...current,
      status: action === "withdraw" ? "withdrawn" : action === "decline" ? "declined" : "opened",
      decided_by: wallet,
      decided_at: new Date().toISOString(),
      reason,
      sale,
    };
    const { error } = await sb
      .from("asset_profiles")
      .update({ fields: fieldsWithRequest(profile.fields, next) })
      .eq("network", network)
      .eq("asset_pda", chain.asset);
    if (error) throw new SiwsError(500, "Could not save the decision");

    try {
      await writeServerAudit(sb, {
        ix_name: `sale_request_${action}`,
        category: "launchpad",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: reason ?? `Public sale request ${current.id.slice(0, 8)} ${next.status}`,
        target_label: shareClass,
        metadata: { network, request_id: current.id, asset: chain.asset, sale },
      });
    } catch (auditErr) {
      console.warn("[api/sale-requests/decide] audit event not written:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }
    return NextResponse.json({ ok: true, data: { request: next } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
