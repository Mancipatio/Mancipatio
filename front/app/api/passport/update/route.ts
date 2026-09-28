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
//
// `approved` is refused (409) unless the wallet holds a live on-chain
// KycEntry at finalized (sim gap G1, lib/server/passport-state.ts
// passportFinality): the route gives a passport its own RPC does not see
// yet a few seconds of grace, waits up to 30 s for a just-confirmed
// approve_holder to finalize, and fails closed (503) when the chain cannot
// be read.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import { passportFinality } from "@/lib/server/passport-state";
import { insertNote, isTerminalKycStatus } from "../../clients/_helpers";

// `approved` waits (bounded) for the passport's block to be finalized.
export const maxDuration = 60;

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

    // G1 (sim review): `approved` means "the passport exists". Only a live
    // on-chain KycEntry at finalized makes it true; a request is otherwise
    // left undecided, so /api/passport/status keeps telling the investor the
    // passport is still pending instead of releasing them without one.
    if (patch.status === "approved") {
      let finality: Awaited<ReturnType<typeof passportFinality>>;
      try {
        finality = await passportFinality((reqRow as { wallet: string }).wallet);
      } catch (err) {
        console.error("[api/passport/update] on-chain passport check failed:", err instanceof Error ? err.message : String(err));
        throw new SiwsError(503, "Could not check the on-chain passport — nothing was changed; try again");
      }
      if (finality === "none") {
        throw new SiwsError(
          409,
          "This wallet has no live on-chain passport visible yet, so the request cannot be marked approved; nothing was changed. If you just issued it, retry the sync in a few seconds (the network may still be catching up); otherwise issue the passport first (approve_holder).",
        );
      }
      if (finality === "not-finalized") {
        throw new SiwsError(
          409,
          "The passport is on-chain but not finalized yet — retry in a few seconds; nothing was changed.",
        );
      }
    }

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
