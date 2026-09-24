// POST /api/clients/status — KYC decision: approve / reject / suspend /
// more_info / expired (SIWS + requireAdminOrKycProvider, Talas 3.1 K6).
// Action: "clients.status". Client half: lib/clients.ts updateClientStatus() /
// suspendClient().
//
// The KYC provider (registry authority without an Admin record) decides
// verdicts but can NEVER move a client out of `suspended` / `rejected`
// (OD1): the status patch carries `forbidLeavingTerminal`, which makes the
// refusal atomic (403). Every provider decision is attributed server-side
// before it is applied: a "kyc_provider_status" audit row (category "kyc",
// which only the server can write) is inserted first and the decision is
// refused (503, nothing applied) when that row cannot be written; the
// outcome follows as a second, best-effort row. The timeline also gets a
// "[KYC provider] status → X" kyc-event note (best-effort; that marker is
// reserved for this route, see /api/clients/note).
//
// When a reason is supplied it is recorded on the client timeline as a
// kyc-event note (system note for suspensions), matching the pre-P1 UX where
// the ConfirmModal reason became an addNote() call. The verdict is also
// emailed to the client (best-effort — sendEmail never throws, and an email
// problem never fails the decision).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { actorSourceOf, writeServerAudit, type ServerAuditInput } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  KYC_STATUSES,
  ONBOARDING_STATUSES,
  LEAVE_TERMINAL_ADMIN_ONLY,
  applyClientStatus,
  assertUuid,
  fetchClientOr404,
  insertNote,
  isTerminalKycStatus,
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

/** The outcome row of a provider decision; its attribution row already exists. */
async function bestEffortAudit(
  input: ServerAuditInput,
  sb: ReturnType<typeof getSupabaseAdmin>,
  err?: unknown,
): Promise<void> {
  try {
    await writeServerAudit(sb, {
      ...input,
      metadata: {
        ...input.metadata,
        ...(err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) }),
      },
    });
  } catch {
    // The pending row already attributes the decision.
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "clients.status");
    const role = await requireAdminOrKycProvider(wallet);
    const provider = role === "kycProvider";

    const id = assertUuid(params.id, "id");
    const kycStatus = oneOf(params.kyc_status, KYC_STATUSES, "kyc_status");
    const onboardingStatus =
      params.onboarding_status === undefined || params.onboarding_status === null
        ? undefined
        : oneOf(params.onboarding_status, ONBOARDING_STATUSES, "onboarding_status");
    const reason = optString(params, "reason", 2000);

    const sb = getSupabaseAdmin();
    const client = await fetchClientOr404(sb, id);
    // Fast refusal before any write; the guarded update below is the atomic
    // stop for a suspension that lands in between.
    if (provider && isTerminalKycStatus(client.kyc_status)) {
      throw new SiwsError(403, LEAVE_TERMINAL_ADMIN_ONLY);
    }
    let audit: ServerAuditInput | null = null;
    if (provider) {
      audit = {
        ix_name: "kyc_provider_status",
        category: "kyc",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: "KYC provider status decision",
        target_label: client.id,
        metadata: {
          role: "kycProvider",
          client_id: client.id,
          from: client.kyc_status,
          to: kycStatus,
          onboarding_status: onboardingStatus ?? null,
          decision_reason: reason,
        },
      };
      // Attribution first; a failed write throws 503 and nothing is applied.
      await writeServerAudit(sb, { ...audit, status: "pending" });
    }
    try {
      await applyClientStatus(sb, id, kycStatus, onboardingStatus, {
        forbidLeavingTerminal: provider,
      });
    } catch (err) {
      if (audit) await bestEffortAudit({ ...audit, status: "failed" }, sb, err);
      throw err;
    }
    if (audit) await bestEffortAudit({ ...audit, status: "success" }, sb);

    if (provider) {
      // Always on the timeline: who (the signing wallet) decided what, as
      // the KYC provider rather than an Admin.
      await insertNote(
        sb,
        id,
        wallet,
        `[KYC provider] status → ${kycStatus}${reason ? ` — ${reason}` : ""}`,
        "kyc-event",
      );
    } else if (reason) {
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
