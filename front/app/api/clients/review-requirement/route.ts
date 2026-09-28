// POST /api/clients/review-requirement — an admin or the KYC provider
// approves/rejects a submitted KYC requirement (SIWS +
// requireAdminOrKycProvider, Talas 3.1 K6). Action:
// "clients.review-requirement". Client half: lib/clients.ts
// reviewRequirement(). The recompute below only ever moves `more_info` →
// `pending`, as a compare-and-set on `more_info`, so it never lifts a
// terminal status, even one that lands concurrently.
//
// On approval the parent client's kyc_status is recomputed server-side:
// a `more_info` client with no remaining open requirements flips to `pending`
// (returned as `recomputed` so the UI can explain the transition).
//
// On rejection (sim gaps G6 and G4) the client is asked for a replacement:
// a `pending` dossier moves to `more_info` (compare-and-set on `pending`, so
// a verified or terminal dossier is never touched), the client is emailed
// which document was refused and why (optional `reason`, best-effort), and
// the timeline gets a kyc-event note saying whether the email went out. A
// per-document reject is therefore an explicit request for a new upload,
// not a silent state the client can race before the dossier verdict;
// rejecting the whole dossier stays a separate, terminal decision
// (/api/clients/status).
//
// Who is asked: a dossier whose KYC is still in review (pending /
// more_info), AND a KYC-verified dossier whose company verification (KYB)
// is still pending: the KYB documents are requirements of the same dossier
// (a founder verifies first, then sends the company documents), so a
// refused registry extract is asked for again without touching the verified
// KYC status. A dossier without a review in progress is not asked (the
// decision there is compliance's, not an upload); `not_notified` says why
// no email went out, so the console does not guess.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  applyClientStatus,
  assertPositiveInt,
  fetchClientOr404,
  insertNote,
  oneOf,
  optString,
  recomputeKycFromRequirements,
  type DbClientRow,
  type ServerKycStatus,
} from "../_helpers";

const REVIEW_STATUSES = ["approved", "rejected"] as const;

/** The client-facing email for one refused document. */
function documentRejectedEmail(
  displayName: string | null,
  label: string,
  reason: string | null,
  siteUrl: string,
): { subject: string; html: string } {
  const hi = `<p>Hi${displayName ? ` ${escapeHtml(displayName)}` : ""},</p>`;
  const reasonBlock = reason
    ? `<p style="margin:12px 0;padding:12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap;">${escapeHtml(reason)}</p>`
    : "";
  const link = new URL("/verify", siteUrl).toString();
  return {
    subject: "Manci KYC — please upload a replacement document",
    html:
      hi +
      `<p>Our compliance team could not accept this document: <strong>${escapeHtml(label)}</strong>.</p>` +
      reasonBlock +
      `<p>Please upload a replacement from your verification page: <a href="${escapeHtml(link)}">Continue verification</a>.</p>` +
      `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
  };
}

/** Why no email went out for a rejected document (null when one did). */
type NotNotified = "no_review_in_progress" | "no_email_on_file" | "email_failed";

/**
 * Whether the dossier has a review the client can still answer with an
 * upload: KYC in review, or (KYC verified or not) a KYB review pending.
 * Terminal dossiers never. Fails closed to "no" on a read error.
 */
async function reviewInProgress(
  sb: ReturnType<typeof getSupabaseAdmin>,
  client: DbClientRow,
): Promise<boolean> {
  if (client.kyc_status === "pending" || client.kyc_status === "more_info") return true;
  if (client.kyc_status !== "verified") return false;
  const { data, error } = await sb
    .from("client_verification_details")
    .select("status")
    .eq("client_id", client.id)
    .eq("kind", "kyb")
    .maybeSingle();
  if (error) {
    console.warn("[api/clients/review-requirement] KYB review read failed:", error.message);
    return false;
  }
  return (data as { status?: string } | null)?.status === "pending";
}

/** Moves a pending dossier to more_info; the new status, or null when unchanged. */
async function askForReplacement(
  sb: ReturnType<typeof getSupabaseAdmin>,
  client: DbClientRow,
): Promise<ServerKycStatus | null> {
  if (client.kyc_status !== "pending") return null;
  try {
    await applyClientStatus(sb, client.id, "more_info", undefined, { expectedStatus: "pending" });
    return "more_info";
  } catch (err) {
    // 409: the dossier changed in between (another decision wins).
    if (err instanceof SiwsError && err.status === 409) return null;
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "clients.review-requirement",
    );
    await requireAdminOrKycProvider(wallet);

    const id = assertPositiveInt(params.id, "id");
    const status = oneOf(params.status, REVIEW_STATUSES, "status");
    const reason = status === "rejected" ? optString(params, "reason", 2000) : null;

    const sb = getSupabaseAdmin();
    const { data: req, error: readErr } = await sb
      .from("kyc_requirements")
      .select("id, client_id, status, label, doc_kind")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new SiwsError(500, "Database read failed");
    if (!req) throw new SiwsError(404, "Requirement not found");
    const client = await fetchClientOr404(sb, String(req.client_id));

    const { error } = await sb
      .from("kyc_requirements")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      console.warn("[api/clients/review-requirement] failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    let recomputed: ServerKycStatus | null = null;
    let notified = false;
    let notNotified: NotNotified | null = null;
    if (status === "approved") {
      recomputed = await recomputeKycFromRequirements(sb, (req as { client_id: string }).client_id);
    } else {
      const row = req as { label?: string | null; doc_kind?: string | null };
      const label = row.label || row.doc_kind || `requirement #${id}`;
      recomputed = await askForReplacement(sb, client);
      // Only a dossier with a review in progress is asked (KYC in review, or
      // a pending KYB on a verified dossier); see the header.
      if (!(await reviewInProgress(sb, client))) {
        notNotified = "no_review_in_progress";
      } else if (!client.email) {
        notNotified = "no_email_on_file";
      } else {
        const email = documentRejectedEmail(
          client.display_name ?? null,
          label,
          reason,
          process.env.NEXT_PUBLIC_SITE_URL || "https://www.manci.io",
        );
        const sent = await sendEmail({ to: client.email, ...email });
        notified = sent?.sent === true;
        if (!notified) notNotified = "email_failed";
      }
      await insertNote(
        sb,
        client.id,
        wallet,
        `Document "${label}" rejected${reason ? `: ${reason}` : ""} — ${
          notified
            ? "the client was asked for a replacement."
            : notNotified === "no_review_in_progress"
              ? "no review is in progress, so the client was not emailed."
              : notNotified === "no_email_on_file"
                ? "no email address is on file, so the client was not asked; contact them."
                : "the email to the client failed; contact them."
        }`,
        "kyc-event",
      );
    }

    return NextResponse.json({ ok: true, data: { status, recomputed, notified, not_notified: notNotified } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
