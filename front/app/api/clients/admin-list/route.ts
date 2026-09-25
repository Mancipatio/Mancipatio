// POST /api/clients/admin-list — admin / KYC-provider read of the client
// directory. Signed + requireAdminOrKycProvider (Talas 3.1 K6: the KYC
// provider triages the queue without an Admin record). clients has no anon
// SELECT (the row set is the full client directory: names, emails, KYC
// verdicts — PII), so the operator pages load it through this route.
//
// With `{ review: true }` (the /admin/clients page) each row also carries
// `review_reasons`: why the dossier waits for a reviewer (documents / final /
// kyb — kyb for admins only), from the same reader as the /admin/clients menu
// badge (lib/server/client-review-queue.ts), so the page's "Needs review" tab
// reproduces that number. The other pages that only need the directory skip
// those reads. The reasons are best-effort: if they cannot be read within
// REVIEW_QUEUE_TIMEOUT_MS (4 s, aborted), `review_available` is false and the
// directory still loads — it never waits longer on the review tables.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { readClientReviewQueue, REVIEW_QUEUE_TIMEOUT_MS } from "@/lib/server/client-review-queue";
import { withTimeout } from "@/lib/server/with-timeout";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Explicit column list — EXCLUDES onboarding_token (the magic-link bearer
// secret), which must never leave the server even for admins.
const CLIENT_COLUMNS =
  "id,created_at,updated_at,network,type,types,tier,tags,source,email," +
  "display_name,company_name,jurisdiction,kyc_status,kyc_provider," +
  "kyc_verified_at,kyc_expires_at,onboarding_status,wallet,issuer_pda," +
  "suspended_at,notes_count,last_activity_at,tos_accepted_at,tos_version";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.adminList");
    const role = await requireAdminOrKycProvider(wallet);
    const withReview = params.review === true;

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const [{ data, error }, review] = await Promise.all([
      sb
        .from("clients")
        .select(CLIENT_COLUMNS)
        .eq("network", network)
        .order("created_at", { ascending: false }),
      withReview
        ? withTimeout(REVIEW_QUEUE_TIMEOUT_MS, (signal) => readClientReviewQueue(sb, network, role, signal)).catch((err: unknown) => {
          console.warn("[api/clients/admin-list] review queue unavailable:", err instanceof Error ? err.message : err);
          return null;
        })
        : Promise.resolve(null),
    ]);
    if (error) {
      console.error("[api/clients/admin-list] query failed:", error.message);
      throw new SiwsError(500, "Could not load the client directory");
    }

    const rows = (data ?? []) as unknown as { id: string }[];
    if (!withReview) return NextResponse.json({ ok: true, data: { clients: rows } });
    const clients = review
      ? rows.map((row) => ({ ...row, review_reasons: review.reasons.get(row.id) ?? [] }))
      : rows;
    return NextResponse.json({ ok: true, data: { clients, review_available: review !== null } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
