// SERVER-ONLY — archive an OTC deal's history before its rent is reclaimed
// (2D). OTC deals are not mirrored by the indexer (lib/otc.ts scans them
// live), so once `reclaim_rent` tombstones a deal its terms would be gone.
// The deal admin calls this first; it stores the account's finalized bytes in
// `indexer_closed_rows` (0069) and closes any linked `otc_requests` row.
import "server-only";
import { address, fetchEncodedAccount } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDealPda,
  getOtcDealDecoder,
  getOtcDealDiscriminatorBytes,
  OtcDealStatus,
} from "@/lib/generated/asset_registry";
import { isClosedAccount } from "@/lib/closed-account";
import { detectNetwork } from "@/lib/network";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** otc_requests status for each terminal deal status. */
const REQUEST_STATUS: Partial<Record<OtcDealStatus, string>> = {
  [OtcDealStatus.Completed]: "completed",
  [OtcDealStatus.Cancelled]: "cancelled",
  [OtcDealStatus.Expired]: "expired",
};

export async function archiveOtcDeal(wallet: string, dealPda: unknown) {
  if (typeof dealPda !== "string" || !BASE58_RE.test(dealPda))
    throw new SiwsError(400, "deal_pda is not a valid address");
  const network = detectNetwork();
  const sb = getSupabaseAdmin();
  let account;
  try {
    account = await fetchEncodedAccount(getServerRpc(), address(dealPda), {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SiwsError(503, "Deal lookup unavailable; try again");
  }
  if (!account.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
    throw new SiwsError(404, "OTC deal not found");
  if (isClosedAccount(account.programAddress, account.data)) {
    // Already reclaimed: fine only if its history was archived first.
    const { data } = await sb
      .from("indexer_closed_rows")
      .select("pda")
      .eq("network", network)
      .eq("table_name", "otc_deals")
      .eq("pda", dealPda)
      .maybeSingle();
    if (data) return { pda: dealPda, archived: true, closed: true };
    throw new SiwsError(409, "This deal was closed without an archived record");
  }
  const bytes = account.data;
  const discriminator = getOtcDealDiscriminatorBytes();
  if (!discriminator.every((byte, index) => bytes[index] === byte))
    throw new SiwsError(400, "The address is not an OTC deal");
  const deal = getOtcDealDecoder().decode(bytes);
  const [expected] = await findDealPda({
    shareClass: deal.shareClass,
    dealId: deal.dealId,
  });
  if (expected !== dealPda) throw new SiwsError(400, "OTC deal identity mismatch");
  if (deal.admin !== wallet)
    throw new SiwsError(403, "Only the deal's admin can archive and close it");
  const requestStatus = REQUEST_STATUS[deal.status];
  if (!requestStatus)
    throw new SiwsError(
      409,
      "Only a completed, cancelled or expired deal can be archived",
    );
  const { error } = await sb.from("indexer_closed_rows").upsert(
    {
      network,
      table_name: "otc_deals",
      pda: dealPda,
      row: {
        pda: dealPda,
        status: deal.status,
        admin: deal.admin,
        buyer: deal.buyer,
        seller: deal.seller,
        raw: { base64: Buffer.from(bytes).toString("base64") },
      },
      closed_at: new Date().toISOString(),
    },
    { onConflict: "network,table_name,pda" },
  );
  if (error) throw new SiwsError(503, "Could not archive the deal; try again");
  const flipped = await sb
    .from("otc_requests")
    .update({ status: requestStatus })
    .eq("network", network)
    .eq("deal_pda", dealPda)
    .eq("status", "created");
  if (flipped.error)
    console.warn("[otc-archive] linked request update failed:", flipped.error.message);
  return { pda: dealPda, archived: true, closed: false };
}
