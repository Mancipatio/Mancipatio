// POST /api/passport/update — admin triage/decision update on a passport
// request row (status flips + handled_by/handled_at stamps from /admin/kyc).
//
// Signed route, platform admin OR the KYC provider (`KycRegistry.authority`
// — a separate on-chain role that survives a platform-admin rotation, e2e §5;
// the rotated provider still stamps the decisions only it can make on-chain).
// When the patch carries handled_by it is
// FORCED to the verified signer wallet — an admin cannot attribute a decision
// to someone else. An optional top-level `reason` (decisions only) is written
// to the linked client's timeline and, on rejection, emailed to the applicant
// (best-effort; the approval email is sent by /api/clients/passport-sync once
// the on-chain passport actually exists). Client wrapper:
// updatePassportRequest() in lib/passport.ts (action "passport.update").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import { insertNote, isTerminalKycStatus } from "../../clients/_helpers";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["new", "in_review", "approved", "rejected"]);
const REASON_MAX = 2000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "passport.update");
    await requireAdminOrKycProvider(wallet);

    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!UUID_RE.test(id)) {
      throw new SiwsError(400, "id must be a UUID");
    }
    if (!isPlainObject(params.patch)) {
      throw new SiwsError(400, "Missing patch");
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params.patch)) {
      if (key === "status") {
        if (typeof value !== "string" || !STATUSES.has(value)) {
          throw new SiwsError(400, "Unknown request status");
        }
        patch.status = value;
      } else if (key === "handled_by") {
        // Attribution is server-controlled: always the verified signer.
        patch.handled_by = wallet;
      } else if (key === "handled_at") {
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
          throw new SiwsError(400, "handled_at must be an ISO timestamp");
        }
        patch.handled_at = value;
      } else {
        throw new SiwsError(400, `Field "${key}" is not patchable`);
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Empty patch");
    }

    let reason: string | null = null;
    if (params.reason !== undefined && params.reason !== null) {
      if (typeof params.reason !== "string" || params.reason.length > REASON_MAX) {
        throw new SiwsError(400, `reason must be a string of at most ${REASON_MAX} characters`);
      }
      reason = params.reason.trim() || null;
    }

    const sb = getSupabaseAdmin();
    const { data: reqRow, error: readErr } = await sb
      .from("passport_requests")
      .select("id, wallet")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new SiwsError(500, "Database read failed");
    if (!reqRow) throw new SiwsError(404, "Passport request not found");

    const { error } = await sb
      .from("passport_requests")
      .update(patch)
      .eq("id", id);
    if (error) {
      console.error("[api/passport/update] update failed:", error.message);
      throw new SiwsError(500, "Passport request update failed");
    }

    // Decision side effects (best-effort — the status flip already succeeded).
    const decided =
      patch.status === "approved" || patch.status === "rejected"
        ? (patch.status as "approved" | "rejected")
        : null;
    if (decided) {
      const applicantWallet = (reqRow as { wallet: string }).wallet;
      // Read EVERY row for the wallet (0041's unique index is skipped when
      // historic duplicates exist) and let a terminal dossier speak for the
      // wallet — the rejection copy below depends on whether self-service
      // re-onboarding is still open, and picking only the oldest row would
      // invite a suspended applicant to reapply into a 403.
      const { data: clientRows } = await sb
        .from("clients")
        .select("id, email, kyc_status")
        .eq("wallet", applicantWallet)
        .order("created_at", { ascending: true });
      const rows = (clientRows ?? []) as {
        id: string;
        email: string | null;
        kyc_status: string;
      }[];
      const client =
        rows.find((r) => isTerminalKycStatus(r.kyc_status)) ?? rows[0] ?? null;

      if (client) {
        await insertNote(
          sb,
          (client as { id: string }).id,
          wallet,
          `Passport request ${decided}${reason ? `: ${reason}` : ""}`,
          "kyc-event",
        );
      }

      const email = client?.email ?? null;
      // The dossier — not this request row — decides whether reapplying is
      // possible: /api/passport/submit 403s terminal dossiers outright.
      const dossierTerminal = client
        ? isTerminalKycStatus(client.kyc_status)
        : false;
      if (decided === "rejected" && email) {
        const reasonBlock = reason
          ? `<p style="margin:12px 0;padding:12px;border-left:3px solid #cbd5e1;color:#334155;white-space:pre-wrap;">${escapeHtml(reason)}</p>`
          : "";
        await sendEmail({
          to: email,
          subject: "Update on your Manci investor passport application",
          html:
            `<p>Hi,</p>` +
            `<p>After review, your investor passport application for wallet ` +
            `<code>${escapeHtml(applicantWallet)}</code> was not approved.</p>` +
            reasonBlock +
            (dossierTerminal
              ? `<p>Your KYC dossier is ${escapeHtml(client?.kyc_status ?? "")} — self-service reapplication is disabled. Please contact the compliance team if you believe this is a mistake.</p>`
              : `<p>You are welcome to reapply from your portfolio once the issue is addressed.</p>`) +
            `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
        });
      }
    }

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
