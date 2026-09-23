// POST /api/applications/review — admin decides an application
// (approved | rejected | needs_changes).
//
// SIWS-signed (action "applications.review") + requireAdmin (on-chain Admin
// PDA gate). Writes the decision, logs an application_events row, then sends
// a decision email to founder_email (item 6) — email is best-effort and never
// fails the request (sendEmail does not throw).
//
// Approving a STARTUP application needs the startupRaises feature
// (lib/features.ts; off on mainnet unless NEXT_PUBLIC_FEATURE_STARTUP_RAISES
// =true). Rejecting it or asking for changes stays possible, so a queue left
// over from when the flag was on can still be wound down.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { sendEmail } from "@/lib/server/email";
import { requireFeature } from "@/lib/server/feature-gate";
import { insertApplicationEvent } from "../_lib";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Decision = "approved" | "rejected" | "needs_changes";
const DECISIONS: readonly Decision[] = ["approved", "rejected", "needs_changes"];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Short, plain decision emails — reason + link to /apply. */
function decisionEmail(
  decision: Decision,
  company: string,
  founderName: string | null,
  reason: string,
  applyUrl: string,
): { subject: string; html: string } {
  const hi = `<p>Hi${founderName ? ` ${escapeHtml(founderName)}` : ""},</p>`;
  const reasonBlock = `<p style="margin:12px 0;padding:12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap;">${escapeHtml(reason)}</p>`;
  const footer = `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`;
  const co = escapeHtml(company);

  switch (decision) {
    case "approved":
      return {
        subject: `Your Manci application for ${company} was approved`,
        html:
          hi +
          `<p>Good news — your launch application for <strong>${co}</strong> has been approved.</p>` +
          reasonBlock +
          `<p>Next step: complete issuer onboarding (if you haven't yet) and open your sale from <a href="${applyUrl}">your application page</a>.</p>` +
          footer,
      };
    case "needs_changes":
      return {
        subject: `Changes requested on your Manci application for ${company}`,
        html:
          hi +
          `<p>Our team reviewed your launch application for <strong>${co}</strong> and needs a few changes before it can move forward:</p>` +
          reasonBlock +
          `<p>You can edit and resubmit the same application at <a href="${applyUrl}">${applyUrl}</a> — it goes back into the review queue.</p>` +
          footer,
      };
    case "rejected":
      return {
        subject: `Update on your Manci application for ${company}`,
        html:
          hi +
          `<p>Thank you for applying. After review, we decided not to move forward with your launch application for <strong>${co}</strong>.</p>` +
          reasonBlock +
          `<p>You're welcome to submit a fresh application at any time at <a href="${applyUrl}">${applyUrl}</a>.</p>` +
          footer,
      };
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.review");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    if (!UUID_RE.test(id)) throw new SiwsError(400, "id must be an application UUID");

    const decision = params.decision as Decision;
    if (!DECISIONS.includes(decision)) {
      throw new SiwsError(400, "decision must be approved, rejected or needs_changes");
    }

    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (reason.length === 0 || reason.length > 2000) {
      throw new SiwsError(400, "reason must be 1–2000 characters");
    }

    const sb = getSupabaseAdmin();
    const { data: row, error: readError } = await sb
      .from("launch_applications")
      .select("id, status, raise_type, company_name, founder_name, founder_email")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (readError) {
      console.error("[applications] review read failed:", readError.message);
      throw new SiwsError(500, "Could not load the application");
    }
    if (!row) throw new SiwsError(404, "Application not found");
    if (row.status !== "pending" && row.status !== "needs_changes") {
      throw new SiwsError(409, `Application is already ${row.status}`);
    }
    if (decision === "approved" && row.raise_type === "startup") {
      requireFeature("startupRaises");
    }

    const { data: updated, error } = await sb
      .from("launch_applications")
      .update({
        status: decision,
        review_reason: reason,
        reviewed_by: wallet,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("status", row.status)
      .select("id").maybeSingle();
    if (error) {
      console.error("[applications] review update failed:", error.message);
      throw new SiwsError(500, "Could not save the decision");
    }

    if(!updated) throw new SiwsError(409,"Application changed; refresh before submitting another decision");
    await insertApplicationEvent(sb, {
      application_id: id,
      actor: "admin",
      action: decision,
      reason,
      actor_wallet: wallet,
    });

    // Decision email (best-effort; never fails the request).
    let emailSent = false;
    const founderEmail = (row.founder_email as string | null)?.trim() ?? "";
    if (founderEmail) {
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
        new URL(request.url).origin;
      const tpl = decisionEmail(
        decision,
        (row.company_name as string | null) ?? "your company",
        row.founder_name as string | null,
        reason,
        `${origin}/apply`,
      );
      const result = await sendEmail({ to: founderEmail, ...tpl });
      emailSent = result.sent;
    }

    return NextResponse.json({ ok: true, data: { id, decision, emailSent } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
