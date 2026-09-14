// POST /api/applications/public — PUBLIC read of approved launch applications
// for the marketplace deal pages. Unsigned (no auth) but tightly scoped:
//   * only applications whose status = 'approved' are returned (pending /
//     needs_changes / rejected applicants' data is never exposed), and
//   * only the public-safe columns of a fundraising profile — founder_email,
//     annual_revenue, valuation, incorporation and internal review fields are
//     NEVER selected.
// launch_applications has no anon SELECT (migration 0036); this route is the
// only public window into it, via the service role.
//
// Body: { ids: string[] } (1..50). Returns { applications: [...] }.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Fundraising-profile columns shown on the public deal page. Deliberately
// EXCLUDES founder_email, annual_revenue, valuation, incorporation,
// review_reason, reviewed_by.
const PUBLIC_COLUMNS =
  "id,created_at,applicant_wallet,raise_type,company_name,one_liner,website," +
  "category,stage,incorporation,problem_or_why,existing_investors,raise_amount," +
  "equity_offered,min_ticket,raise_structure,cliff_months,vesting_months," +
  "founder_name,founder_twitter,founder_linkedin,founder_why,pitch_deck,status," +
  "linked_sale_pubkey,submitted_at";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    const raw = (body as { ids?: unknown })?.ids;
    const ids = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string").slice(0, 50)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ ok: true, data: { applications: [] } });
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("launch_applications")
      .select(PUBLIC_COLUMNS)
      .eq("network", detectNetwork())
      .in("id", ids)
      .eq("status", "approved");
    if (error) {
      console.error("[api/applications/public] query failed:", error.message);
      return NextResponse.json(
        { ok: false, error: "Could not load applications" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, data: { applications: data ?? [] } });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unexpected error" },
      { status: 500 },
    );
  }
}
