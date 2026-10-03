// POST /api/compliance/screen-recipients — the sender of a distribution
// ("Send to wallets") screens its RECIPIENTS against the sanctions lists
// before anything is signed. Direct transfers never pass a server otherwise
// (the transfer hook checks only the on-chain blocklist, and the alarm
// worker screens buys and trades only), so this is where a listed recipient
// is stopped.
//
// Signed or wallet session ("compliance.screenRecipients" is a session read:
// addresses in, the matching addresses out; its only write is the compliance
// alert of a hit, deduplicated per wallet). Not an oracle for anyone: the
// caller must be a Manci Admin or the issuer authority of the share class it
// names (read on chain), and the answer carries no list, entry or reason —
// a hit blocks that row with the generic counterparty copy. The screen is
// lib/server/sanctions screenAndRaiseHits, the same one requireSanctionsClear
// runs: on mainnet a list that cannot answer refuses the whole request
// (503), so nothing is sent unscreened.
//
// Rate-limited like the other screened routes: an in-memory burst per IP
// before the signature is checked, then a limit per wallet shared by every
// instance (lib/server/shared-rate-limit). The panel's background screen
// ignores a refusal (the send screens again), so the limits only cost a
// flood.
//
// Params: share_class (address), wallets (1–100 addresses).
// Client wrapper: screenRecipients() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { isAddress } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { screenAndRaiseHits } from "@/lib/server/sanctions";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { addressParam } from "@/lib/server/sale-capacity";
import { consumeSharedRateLimit } from "@/lib/server/shared-rate-limit";
import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import { shareClassChain } from "@/app/api/sale-approvals/_lib";

/** Most recipients one request may carry (the client wrapper chunks). */
const MAX_SCREEN_RECIPIENTS = 100;
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
    const { wallet, params } = await verifySigned(request, "compliance.screenRecipients");
    if (
      (await consumeSharedRateLimit(`screen-recipients:wallet:${wallet}`, SCREEN_RECIPIENTS_SHARED_LIMIT, SCREEN_RECIPIENTS_SHARED_WINDOW_SECONDS)) ===
      "limited"
    ) {
      throw new SiwsError(429, "Too many screening requests — wait a few minutes and try again");
    }
    const shareClass = addressParam(params.share_class, "share_class");
    const raw = params.wallets;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCREEN_RECIPIENTS) {
      throw new SiwsError(400, `wallets must be an array of 1–${MAX_SCREEN_RECIPIENTS} addresses`);
    }
    const wallets = [
      ...new Set(
        raw.map((w) => {
          if (typeof w !== "string" || !isAddress(w)) throw new SiwsError(400, "wallets must contain valid addresses only");
          return w;
        }),
      ),
    ];

    // Who may ask: the class's issuer authority (the treasury that sends) or an Admin.
    const chain = await shareClassChain(shareClass);
    if (chain.authority !== wallet) await requireAdmin(wallet);

    const blocked = await screenAndRaiseHits(getSupabaseAdmin(), {
      route: "distribution (send to wallets)",
      wallets: wallets.map((w) => ({ wallet: w, role: "counterparty" as const })),
    });
    return NextResponse.json(
      { ok: true, data: { blocked: wallets.filter((w) => blocked.has(w)) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
