// POST /api/clients/request-docs — an admin or the KYC provider requests KYC
// documents from a client (SIWS + requireAdminOrKycProvider, Talas 3.1 K6).
// Action: "clients.request-docs". Client half: lib/clients.ts
// requestRequirements().
//
// The request parks the client in `more_info`. A KYC provider without an
// Admin record must not use that to lift a suspension or a rejection (OD1):
// a terminal client is refused before any write, and the status patch
// carries `forbidLeavingTerminal` (atomic 403).
//
// Side effects mirror the pre-P1 client flow: kyc_requirements rows inserted,
// the client parked in `more_info`, and a kyc-event note on the timeline.
// Additionally: the onboarding magic-link is RE-ISSUED when the client has
// none (a verified→more_info "return to supplement" nulled it), and the
// request is emailed to the client with the upload link (best-effort).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  LEAVE_TERMINAL_ADMIN_ONLY,
  applyClientStatus,
  assertUuid,
  DEGRADED_TTL_MESSAGE,
  fetchClientOr404,
  insertNote,
  isMissingTtlColumnError,
  isTerminalKycStatus,
  isOnboardingTokenLive,
  onboardingTokenExpiry,
  randomOnboardingToken,
  withoutTtlColumn,
} from "../_helpers";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.request-docs");
    const role = await requireAdminOrKycProvider(wallet);
    const provider = role === "kycProvider";

    const clientId = assertUuid(params.client_id, "client_id");
    const rawItems = params.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 20) {
      throw new SiwsError(400, "items must be an array of 1–20 entries");
    }
    const items = rawItems.map((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new SiwsError(400, "items entries must be objects");
      }
      const item = raw as Record<string, unknown>;
      const docKind = item.doc_kind;
      const label = item.label;
      const note = item.note;
      if (typeof docKind !== "string" || docKind.length === 0 || docKind.length > 40) {
        throw new SiwsError(400, "doc_kind must be a 1–40 character string");
      }
      if (typeof label !== "string" || label.length === 0 || label.length > 120) {
        throw new SiwsError(400, "label must be a 1–120 character string");
      }
      if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 1000)) {
        throw new SiwsError(400, "note must be a string of at most 1000 characters");
      }
      return {
        doc_kind: docKind,
        label,
        note: typeof note === "string" && note.trim() ? note.trim() : null,
      };
    });

    const sb = getSupabaseAdmin();
    const client = await fetchClientOr404(sb, clientId);
    if (provider && isTerminalKycStatus(client.kyc_status)) {
      throw new SiwsError(403, LEAVE_TERMINAL_ADMIN_ONLY);
    }

    const { error } = await sb.from("kyc_requirements").insert(
      items.map((i) => ({
        client_id: clientId,
        doc_kind: i.doc_kind,
        label: i.label,
        note: i.note,
        requested_by: wallet,
      })),
    );
    if (error) {
      console.warn("[api/clients/request-docs] insert failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    await applyClientStatus(sb, clientId, "more_info", undefined, {
      forbidLeavingTerminal: provider,
    });

    // Re-issue the magic-link when it is gone (verification nulls it) or
    // refresh its TTL — the client needs a working upload credential.
    let token = client.onboarding_token;
    if (!token) token = randomOnboardingToken();
    const tokenPatch: Record<string, unknown> = {
      onboarding_token: token,
      onboarding_token_expires_at: onboardingTokenExpiry(),
    };
    let degraded = false;
    let { error: tokenErr } = await sb
      .from("clients")
      .update(tokenPatch)
      .eq("id", clientId);
    if (tokenErr && isMissingTtlColumnError(tokenErr)) {
      // Pre-0041 database — still (re)issue the token, just without the stamp.
      console.warn(
        "[api/clients/request-docs] 0041 not applied — retrying without TTL column",
      );
      degraded = true;
      ({ error: tokenErr } = await sb
        .from("clients")
        .update(withoutTtlColumn(tokenPatch))
        .eq("id", clientId));
    }
    if (tokenErr) {
      console.warn("[api/clients/request-docs] token refresh failed:", tokenErr.message);
      token = client.onboarding_token; // fall back to whatever is stored
      degraded = false; // whatever is stored keeps its own (possibly live) stamp
    }
    // An unstamped token falls back to created_at + 14d, which is already in
    // the past for any dossier older than two weeks: emailing that link sends
    // the client to an "Invalid link" screen. Detect it and say so instead.
    const linkLive = token
      ? isOnboardingTokenLive(
          client.created_at,
          degraded ? null : (tokenPatch.onboarding_token_expires_at as string),
        )
      : false;
    if (token && !linkLive) {
      console.warn(
        "[api/clients/request-docs] upload link suppressed — token has no usable TTL (0041 not applied?)",
      );
    }

    await insertNote(
      sb,
      clientId,
      wallet,
      `Requested ${items.length} document(s): ${items.map((i) => i.label).join(", ")}`,
      "kyc-event",
    );

    // Best-effort email with the checklist + upload link.
    if (client.email) {
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
        new URL(request.url).origin;
      const uploadUrl =
        token && linkLive ? `${origin}/onboarding/${clientId}?t=${token}` : null;
      const list = items
        .map(
          (i) =>
            `<li><strong>${escapeHtml(i.label)}</strong>${i.note ? ` — ${escapeHtml(i.note)}` : ""}</li>`,
        )
        .join("");
      await sendEmail({
        to: client.email,
        subject: "Manci KYC — documents requested",
        html:
          `<p>Hi${client.display_name ? ` ${escapeHtml(client.display_name)}` : ""},</p>` +
          `<p>Our compliance team needs the following document(s) to continue your KYC review:</p>` +
          `<ul>${list}</ul>` +
          (uploadUrl
            ? `<p>Upload them from your onboarding page:<br/><a href="${uploadUrl}">${uploadUrl}</a></p>`
            : `<p>We will send your personal upload link separately — please reply to this email if you do not receive it.</p>`) +
          `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
      });
    }

    return NextResponse.json({
      ok: true,
      data: {
        requested: items.length,
        // Null when the client can be sent a working upload link; otherwise
        // the reason the admin must act on (no link went out in the email).
        upload_link_warning: token && !linkLive ? DEGRADED_TTL_MESSAGE : null,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
