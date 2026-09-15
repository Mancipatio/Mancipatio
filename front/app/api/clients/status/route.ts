// POST /api/clients/status — admin KYC decision: approve / reject / suspend /
// more_info / expired (SIWS + requireAdmin). Action: "clients.status".
// Client half: lib/clients.ts updateClientStatus() / suspendClient().
//
// When a reason is supplied it is recorded on the client timeline as a
// kyc-event note (system note for suspensions), matching the pre-P1 UX where
// the ConfirmModal reason became an addNote() call. The verdict is also
// emailed to the client (best-effort — sendEmail never throws, and an email
// problem never fails the decision).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  KYC_STATUSES,
  ONBOARDING_STATUSES,
  applyClientStatus,
  assertUuid,
  fetchClientOr404,
  insertNote,
  oneOf,
  optString,
  type ServerKycStatus,
} from "../_helpers";

/** Short, plain verdict emails — mirrors the /api/applications/review style. */
function verdictEmail(
  kycStatus: ServerKycStatus,
  displayName: string,
  reason: string | null,
): { subject: string; html: string } | null {
  const hi = `<p>Hi${displayName ? ` ${escapeHtml(displayName)}` : ""},</p>`;
  const reasonBlock = reason
    ? `<p style="margin:12px 0;padding:12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap;">${escapeHtml(reason)}</p>`
    : "";
  const footer = `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`;

  switch (kycStatus) {
    case "verified":
      return {
        subject: "Your Manci KYC verification is complete",
        html:
          hi +
          `<p>Good news — your KYC review is complete and your account is <strong>verified</strong>.</p>` +
          reasonBlock +
          footer,
      };
    case "rejected":
      return {
        subject: "Update on your Manci KYC review",
        html:
          hi +
          `<p>After review, your KYC application was <strong>not approved</strong>.</p>` +
          reasonBlock +
          // A rejected dossier is TERMINAL: /api/passport/submit 403s any
          // self-service reapplication (only compliance can lift it), so this
          // must not invite the applicant to "re-onboard" into an error page.
          `<p>Please contact the compliance team if you would like the decision reviewed — reapplying from the portfolio is disabled for rejected dossiers.</p>` +
          footer,
      };
    case "suspended":
      return {
        subject: "Your Manci account has been suspended",
        html:
          hi +
          `<p>Your account has been <strong>suspended</strong>. Contact the compliance team for details.</p>` +
          reasonBlock +
          footer,
      };
    case "more_info":
      return {
        subject: "Manci KYC — additional information required",
        html:
          hi +
          `<p>Our compliance team needs additional information to continue your KYC review.</p>` +
          reasonBlock +
          `<p>Please check your onboarding page for the requested documents.</p>` +
          footer,
      };
    default:
      // pending / expired flips are internal bookkeeping — no email.
      return null;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.status");
    await requireAdmin(wallet);

    const id = assertUuid(params.id, "id");
    const kycStatus = oneOf(params.kyc_status, KYC_STATUSES, "kyc_status");
    const onboardingStatus =
      params.onboarding_status === undefined || params.onboarding_status === null
        ? undefined
        : oneOf(params.onboarding_status, ONBOARDING_STATUSES, "onboarding_status");
    const reason = optString(params, "reason", 2000);

    const sb = getSupabaseAdmin();
    const client = await fetchClientOr404(sb, id);
    await applyClientStatus(sb, id, kycStatus, onboardingStatus);

    if (reason) {
      await insertNote(
        sb,
        id,
        wallet,
        reason,
        kycStatus === "suspended" ? "system" : "kyc-event",
      );
    }

    // Best-effort verdict notification.
    if (client.email) {
      const tpl = verdictEmail(kycStatus, client.display_name, reason);
      if (tpl) await sendEmail({ to: client.email, ...tpl });
    }

    return NextResponse.json({ ok: true, data: { kyc_status: kycStatus } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
