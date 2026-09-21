// POST /api/passport/submit — investor self-service passport (KYC) request
// from /portfolio.
//
// Signed route, NO admin gate: any wallet may apply, but the request row's
// `wallet` is ALWAYS the verified signer — a wallet can only apply for
// itself. If the client echoes a wallet in params it must match the signer.
//
// This route is the bridge between the two KYC systems: besides inserting the
// passport_requests row it AUTO-PROVISIONS (or links, by wallet) the off-chain
// clients dossier — investor type, wallet, jurisdiction — requests the
// standard investor document set (kyc_requirements) and (re)issues the
// onboarding magic-link so the applicant can upload documents through the
// existing /onboarding/{id} flow immediately. The response carries that path.
//
// Protections: per-IP + per-wallet rate limits (best-effort in-memory — see
// _helpers.rateLimited), dedupe (409 while a new/in_review request exists),
// and jurisdiction is REQUIRED + validated against the platform's default
// approved set (DEFAULT_APPROVED_JURISDICTIONS).
//
// Client wrapper: submitPassportRequest() in lib/passport.ts
// (action "passport.submit").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import { isDefaultApprovedJurisdiction } from "@/lib/passport";
import {
  clientIpOf,
  DEGRADED_TTL_MESSAGE,
  insertNote,
  rateLimited,
} from "../../clients/_helpers";
import { ensureClientDossier, ensureStandardRequirements, STANDARD_INVESTOR_REQUIREMENTS } from "@/lib/server/kyc-dossier";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NOTE_MAX = 500;


export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "passport.submit");

    // The applicant can only be the signer.
    if (typeof params.wallet === "string" && params.wallet !== wallet) {
      throw new SiwsError(403, "You can only apply for your own wallet");
    }

    // Rate limits: bursts per IP, sustained per wallet (queue-spam guard).
    const ip = clientIpOf(request);
    if (
      rateLimited(`passport-submit:ip:${ip}`, 10, 60_000) ||
      rateLimited(`passport-submit:wallet:${wallet}`, 3, 3_600_000)
    ) {
      throw new SiwsError(429, "Too many applications — try again later");
    }

    const registryPda =
      typeof params.registry_pda === "string" ? params.registry_pda.trim() : "";
    if (registryPda && !BASE58_RE.test(registryPda)) {
      throw new SiwsError(400, "registry_pda must be a base58 address");
    }

    // Jurisdiction is REQUIRED and must be in the platform's approved set —
    // a request without one produced a passport with jurisdiction 0 that every
    // on-chain check rejected while the UI showed "Verified investor".
    if (
      typeof params.jurisdiction !== "number" ||
      !Number.isInteger(params.jurisdiction) ||
      params.jurisdiction <= 0 ||
      params.jurisdiction > 999
    ) {
      throw new SiwsError(400, "jurisdiction is required (ISO numeric code)");
    }
    const jurisdiction = params.jurisdiction;
    if (!isDefaultApprovedJurisdiction(jurisdiction)) {
      throw new SiwsError(
        400,
        "This jurisdiction is not supported for investor passports yet",
      );
    }

    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (note.length > NOTE_MAX) {
      throw new SiwsError(400, `note must be ≤${NOTE_MAX} characters`);
    }

    const sb = getSupabaseAdmin();

    // Dedupe: one undecided application per wallet.
    const { data: dupe, error: dupeErr } = await sb
      .from("passport_requests")
      .select("id")
      .eq("wallet", wallet)
      .in("status", ["new", "in_review"])
      .limit(1);
    if (dupeErr) {
      console.error("[api/passport/submit] dedupe check failed:", dupeErr.message);
      throw new SiwsError(500, "Could not check existing applications");
    }
    if ((dupe ?? []).length > 0) {
      throw new SiwsError(
        409,
        "You already have an application under review — the compliance team will get back to you",
      );
    }

    // Off-chain dossier: link or auto-provision, then request the standard
    // document set so the applicant has something actionable immediately.
    const { client, token, created, linkUnusable } = await ensureClientDossier(
      sb,
      wallet,
      jurisdiction,
    );
    await ensureStandardRequirements(sb, client, STANDARD_INVESTOR_REQUIREMENTS,
      "Requested automatically with your investor passport application.", "system:passport-request");

    const { data, error } = await sb
      .from("passport_requests")
      .insert({
        wallet,
        registry_pda: registryPda || null,
        jurisdiction,
        note: note || null,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/passport/submit] insert failed:", error?.message);
      throw new SiwsError(500, "Passport request insert failed");
    }

    await insertNote(
      sb,
      client.id,
      wallet,
      created
        ? "Investor passport application submitted from the portfolio — dossier auto-provisioned."
        : "Investor passport application submitted from the portfolio.",
      "kyc-event",
    );

    // Never advertise a link the server would reject (pre-0041 degradation on
    // an older dossier): send an explicit message instead of a dead link.
    const onboardingPath =
      token && !linkUnusable ? `/onboarding/${client.id}?t=${token}` : null;
    const onboardingNotice = token && linkUnusable ? DEGRADED_TTL_MESSAGE : null;
    if (token && linkUnusable) {
      console.warn(
        "[api/passport/submit] onboarding link suppressed — token has no usable TTL (0041 not applied?)",
      );
    }

    // Best-effort confirmation email with the document-upload link (dossiers
    // provisioned from a wallet have no email yet — nothing to send).
    if (client.email && onboardingPath) {
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
        new URL(request.url).origin;
      await sendEmail({
        to: client.email,
        subject: "Your Manci investor passport application",
        html:
          `<p>Hi,</p>` +
          `<p>We received your investor passport application for wallet ` +
          `<code>${escapeHtml(wallet)}</code>.</p>` +
          `<p>To speed up the review, upload the requested documents here:<br/>` +
          `<a href="${origin}${onboardingPath}">${origin}${onboardingPath}</a></p>` +
          `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
      });
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: data.id as string,
        client_id: client.id,
        onboarding_path: onboardingPath,
        onboarding_notice: onboardingNotice,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
