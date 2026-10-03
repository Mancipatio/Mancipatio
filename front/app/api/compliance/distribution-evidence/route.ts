// POST /api/compliance/distribution-evidence — "Send to wallets", right
// before the sender signs (devnet rehearsal 2026-10-03, P1): the server
// checks that EVERY recipient of the declared run has a clear sanctions
// screening of this share class from the last 15 minutes (the records
// /api/compliance/screen-recipients wrote; the latest one per wallet counts,
// so a wallet screened clear and then hit is refused), then records the run's
// evidence and returns it per recipient. The panel signs nothing for a row
// without it and cites it in every distribution audit row
// (lib/distribution-screening.ts, lib/server/screening-evidence.ts).
//
// 409 when a recipient has no fresh clear screening (the copy names no
// wallet and no reason: the sender screens again and the screen says which
// row is blocked); 503 when the records cannot be read or the evidence
// cannot be written. "unscreened" (a list that could not answer) passes only
// where the screen is not enforced (off mainnet without
// SANCTIONS_SCREENING=enforce); mainnet never records one.
//
// Signed or wallet session ("compliance.distributionEvidence": its only
// write is the evidence row that records this check). The caller rule and
// the limits are screen-recipients' (the class's issuer authority or an
// Admin). The transfers themselves are signed by the sender's wallet and
// never pass a server, so this cannot stop a sender who bypasses the site;
// it makes the site's own path refuse, and leaves the evidence an
// investigation reads.
//
// Params: share_class (address), run_id (the distribution run), wallets
// (1–100 addresses; the client wrapper chunks). Client wrapper:
// distributionEvidence() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf } from "@/lib/server/audit";
import { requireRunEvidence } from "@/lib/server/screening-evidence";
import { addressParam } from "@/lib/server/sale-capacity";
import { consumeSharedRateLimit } from "@/lib/server/shared-rate-limit";
import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import { recipientWallets, requireClassSender, runIdParam } from "@/app/api/compliance/_recipients";

const EVIDENCE_BURST_LIMIT = 30;
const EVIDENCE_BURST_WINDOW_MS = 60_000;
const EVIDENCE_SHARED_LIMIT = 60;
const EVIDENCE_SHARED_WINDOW_SECONDS = 600;

export async function POST(request: Request) {
  try {
    if (rateLimited(`distribution-evidence:${ipRateLimitKey(clientIpOf(request))}`, EVIDENCE_BURST_LIMIT, EVIDENCE_BURST_WINDOW_MS)) {
      throw new SiwsError(429, "Too many requests — wait a minute and try again");
    }
    const { wallet, params, via } = await verifySigned(request, "compliance.distributionEvidence");
    if (
      (await consumeSharedRateLimit(`distribution-evidence:wallet:${wallet}`, EVIDENCE_SHARED_LIMIT, EVIDENCE_SHARED_WINDOW_SECONDS)) === "limited"
    ) {
      throw new SiwsError(429, "Too many requests — wait a few minutes and try again");
    }
    const shareClass = addressParam(params.share_class, "share_class");
    const runId = runIdParam(params.run_id, true)!;
    const wallets = recipientWallets(params.wallets);

    await requireClassSender(shareClass, wallet);

    const evidence = await requireRunEvidence(getSupabaseAdmin(), {
      actor: { wallet, source: actorSourceOf(via) },
      shareClass,
      runId,
      wallets,
    });
    return NextResponse.json({ ok: true, data: evidence }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
