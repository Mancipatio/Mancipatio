// POST /api/compliance/screen-recipients — the sender of a distribution
// ("Send to wallets") screens its RECIPIENTS against the sanctions lists
// before anything is signed. Direct transfers never pass a server otherwise
// (the transfer hook checks only the on-chain blocklist, and the alarm
// worker screens buys and trades only), so this is where a listed recipient
// is stopped.
//
// Signed or wallet session ("compliance.screenRecipients" is a session read:
// addresses in, the matching addresses out). Not an oracle for anyone: the
// caller must be a Manci Admin or the issuer authority of the share class it
// names (read on chain), and the answer carries no list, entry or reason —
// a hit blocks that row with the generic counterparty copy. The screen is
// lib/server/sanctions screenAndRaise, the one requireSanctionsClear runs:
// on mainnet a list that cannot answer refuses the whole request (503), so
// nothing is sent unscreened.
//
// Its writes: the compliance alert of a hit (deduplicated per wallet) and,
// since the 2026-10-03 rehearsal (P1), the screening RECORD — one
// server-attributed audit_events row with every wallet's result and the list
// publication used (lib/server/screening-evidence.ts). A record that cannot
// be written refuses the screen (503). /api/compliance/distribution-evidence
// later checks these records before the sender signs.
//
// Rate-limited like the other screened routes: an in-memory burst per IP
// before the signature is checked, then a limit per wallet shared by every
// instance (lib/server/shared-rate-limit). The panel's background screen
// ignores a refusal (the send screens again), so the limits only cost a
// flood.
//
// Params: share_class (address), wallets (1–100 addresses), run_id (the
// distribution run, optional: the background screen has none yet).
// Client wrapper: screenRecipients() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf } from "@/lib/server/audit";
import { recordRecipientScreening } from "@/lib/server/screening-evidence";
import { addressParam } from "@/lib/server/sale-capacity";
import { consumeSharedRateLimit } from "@/lib/server/shared-rate-limit";
import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import { recipientWallets, requireClassSender, runIdParam } from "@/app/api/compliance/_recipients";

/** Per IP and instance: a list typed and sent screens a handful of times a minute. */
const SCREEN_RECIPIENTS_BURST_LIMIT = 30;
const SCREEN_RECIPIENTS_BURST_WINDOW_MS = 60_000;
/** Per wallet, shared by every instance. */
const SCREEN_RECIPIENTS_SHARED_LIMIT = 60;
const SCREEN_RECIPIENTS_SHARED_WINDOW_SECONDS = 600;

export async function POST(request: Request) {
  try {
    if (rateLimited(`screen-recipients:${ipRateLimitKey(clientIpOf(request))}`, SCREEN_RECIPIENTS_BURST_LIMIT, SCREEN_RECIPIENTS_BURST_WINDOW_MS)) {
      throw new SiwsError(429, "Too many screening requests — wait a minute and try again");
    }
    const { wallet, params, via } = await verifySigned(request, "compliance.screenRecipients");
    if (
      (await consumeSharedRateLimit(`screen-recipients:wallet:${wallet}`, SCREEN_RECIPIENTS_SHARED_LIMIT, SCREEN_RECIPIENTS_SHARED_WINDOW_SECONDS)) ===
      "limited"
    ) {
      throw new SiwsError(429, "Too many screening requests — wait a few minutes and try again");
    }
    const shareClass = addressParam(params.share_class, "share_class");
    const wallets = recipientWallets(params.wallets);
    const runId = runIdParam(params.run_id, false);

    await requireClassSender(shareClass, wallet);

    const { blocked, record } = await recordRecipientScreening(getSupabaseAdmin(), {
      actor: { wallet, source: actorSourceOf(via) },
      shareClass,
      runId,
      wallets,
      route: "distribution (send to wallets)",
    });
    return NextResponse.json(
      // The record's id, time and list version: what the sender's evidence will cite (no per-wallet reason).
      { ok: true, data: { blocked, screening: { id: record.id, screened_at: record.screened_at, list_version: record.list_version } } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
