// ============================================================================
// EXEMPLAR SIGNED ROUTE — the canonical pattern for every signed API route.
// Wave-2 agents: COPY this file to app/api/<domain>/<action>/route.ts and
// adapt. The `_exemplar` folder name (underscore prefix) keeps it out of
// routing, so this file itself is never served.
// ============================================================================
//
// The pattern, step by step:
//
//   1. POST only. Export ONLY the POST handler — Next.js answers other
//      methods with 405 automatically.
//   2. `verifySigned(request, "<domain>.<action>")` — verifies the SIWS
//      envelope (signature, ±300s timestamp, nonce replay, action pin) and
//      returns { wallet, params }. The action string MUST be unique per route
//      and MUST match what the client passes to signedFetch().
//   3. OPTIONAL admin gate: `await requireAdmin(wallet)` or
//      `await requireSuperAdmin(wallet)` (lib/server/admin-gate.ts) — on-chain
//      check, 60s cached, throws SiwsError(403)/503.
//   4. Manual param validation — NO zod (no new deps). Narrow each field from
//      `params` (which is `Record<string, unknown>`) with typeof checks,
//      length caps, and allow-lists. Reject bad input with
//      `throw new SiwsError(400, "message")`.
//   5. Database writes via `getSupabaseAdmin()` (service role, bypasses RLS)
//      — never the anon client in a route.
//   6. Respond `NextResponse.json({ ok: true, data })` on success. All errors
//      funnel through `siwsErrorResponse(err)` which emits
//      `{ ok: false, error }` with the right status (SiwsError keeps its
//      status; unknown errors become a logged 500).
//
// Client side (see lib/siws-client.ts):
//   const data = await signedFetch<EchoData>(session, "/api/_exemplar",
//     "exemplar.echo", { note: "hi" });
//
// Magic-link routes (client onboarding) DO NOT use verifySigned — they
// validate the client's magic token against the clients row instead, but keep
// the same POST + { ok, data|error } envelope.
// Public unauthenticated routes (contact form) also skip verifySigned — plain
// POST with honeypot + length validation.
// Runtime note: verifySigned needs Node (Buffer) — never set runtime="edge".

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
// import { getSupabaseAdmin } from "@/lib/supabase-server";   // step 5
// import { sendEmail } from "@/lib/server/email";             // optional

export async function POST(request: Request) {
  try {
    // Step 2 — verify the signed envelope; pins this route to its action id.
    const { wallet, params } = await verifySigned(request, "exemplar.echo");

    // Step 3 — admin variant. For an admin-only route this line is
    // unconditional; here it is driven by a param purely for demonstration.
    if (params.asAdmin === true) {
      await requireAdmin(wallet);
    }

    // Step 4 — manual validation (no zod). Narrow every field you use.
    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (note.length === 0 || note.length > 500) {
      throw new SiwsError(400, "note must be 1–500 characters");
    }

    // Step 5 — service-role write would go here, e.g.:
    //   const sb = getSupabaseAdmin();
    //   const { error } = await sb.from("some_table").insert({ wallet, note });
    //   if (error) throw new SiwsError(500, "Database write failed");

    // Step 6 — success envelope.
    return NextResponse.json({
      ok: true,
      data: {
        wallet,
        note,
        echoedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
