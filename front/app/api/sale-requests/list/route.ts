// POST /api/sale-requests/list — public-sale requests ("saleRequests.list",
// a session read: requests in, no write).
//
// Params:
//   share_class (address) → that class's request, for its issuer authority
//                           (read on chain) or an Admin;
//   pending: true         → every request the operator still has to act on
//                           (Admin): "requested", and not yet opened or closed
//                           (an approved one stays listed for the pre-clear
//                           check and "Reopen primary issuance"), each with the
//                           asset's offering clearance on mainnet
//                           (lib/whitepaper-approval offeringClearance: an
//                           SSC-approved whitepaper or a recorded offering
//                           exemption; the reserve route refuses without it).
// Each row carries `outcome` (lib/server/sale-requests requestStates):
// approved / opened / closed from the raise-cap ledger (opened as soon as the
// reserved sale's account exists on chain), or null; and `reservation`: the
// approval and sale the operator reserved for it (the pre-clear check's
// "this approval" — any other live approval of the class is a stray).
// Client wrapper: listSaleRequests() in lib/sale-requests.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { addressParam } from "@/lib/server/sale-capacity";
import { offeringClearance, type OfferingClearanceProfile } from "@/lib/whitepaper-approval";
import type { SaleRequest } from "@/lib/public-sale";
import {
  REQUEST_PROFILE_COLUMNS,
  readRequestProfile,
  requestStates,
  storedRequest,
  type RequestProfileRow,
} from "@/lib/server/sale-requests";
import { shareClassChain } from "@/app/api/sale-approvals/_lib";

const CLEARANCE_COLUMNS = "whitepaper_status,ssc_decision_ref,ssc_decision_version_id,offering_exemption_ref,offering_exemption_reason";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleRequests.list");
    const network = detectNetwork();
    const sb = getSupabaseAdmin();

    if (params.pending === true) {
      await requireAdmin(wallet);
      const { data, error } = await sb
        .from("asset_profiles")
        .select(network === "mainnet" ? `${REQUEST_PROFILE_COLUMNS},${CLEARANCE_COLUMNS}` : REQUEST_PROFILE_COLUMNS)
        .eq("network", network)
        .eq("fields->sale_request->>status", "requested")
        .limit(100);
      if (error) throw new SiwsError(503, "Could not load the sale requests");
      const rows = ((data ?? []) as unknown as (RequestProfileRow & OfferingClearanceProfile)[])
        .map((row) => ({ row, request: storedRequest(row) }))
        .filter((r): r is { row: RequestProfileRow & OfferingClearanceProfile; request: SaleRequest } => r.request?.status === "requested");
      const states = await requestStates(sb, rows.map((r) => r.request));
      return NextResponse.json(
        {
          ok: true,
          data: rows
            .map(({ row, request: saleRequest }) => ({
              asset: row.asset_pda,
              display_name: row.display_name,
              request: saleRequest,
              outcome: states.get(saleRequest.id)?.outcome ?? null,
              reservation: states.get(saleRequest.id)?.reservation ?? null,
              clearance: offeringClearance(network === "mainnet" ? row : null, network),
            }))
            .filter((r) => r.outcome === null || r.outcome === "approved"),
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    if (params.share_class === undefined) throw new SiwsError(400, "share_class or pending is required");
    const shareClass = addressParam(params.share_class, "share_class");
    const chain = await shareClassChain(shareClass);
    if (chain.authority !== wallet) await requireAdmin(wallet);
    const row = await readRequestProfile(sb, chain.asset);
    const stored = storedRequest(row);
    const saleRequest = stored?.share_class === shareClass ? stored : null;
    const state = saleRequest?.status === "requested" ? ((await requestStates(sb, [saleRequest])).get(saleRequest.id) ?? null) : null;
    return NextResponse.json(
      {
        ok: true,
        data: [
          {
            asset: chain.asset,
            display_name: row?.display_name ?? null,
            request: saleRequest,
            outcome: state?.outcome ?? null,
            reservation: state?.reservation ?? null,
          },
        ],
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
