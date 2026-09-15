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
  applyClientStatus,
  assertWalletNotTerminal,
  clientIpOf,
  detectNetworkServer,
  DEGRADED_TTL_MESSAGE,
  insertNote,
  isMissingTtlColumnError,
  isOnboardingTokenLive,
  isTerminalKycStatus,
  onboardingTokenExpiry,
  randomOnboardingToken,
  rateLimited,
  withoutTtlColumn,
} from "../../clients/_helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NOTE_MAX = 500;

// Standard investor KYC checklist requested when a dossier is provisioned (or
// re-opened) from a passport application. Mirrors KYC_DOC_KINDS labels in
// lib/clients.ts.
const STANDARD_INVESTOR_REQUIREMENTS = [
  { doc_kind: "passport", label: "Passport" },
  { doc_kind: "proof_of_address", label: "Proof of address" },
  { doc_kind: "selfie", label: "Selfie / liveness" },
] as const;

type ClientLite = {
  id: string;
  created_at: string;
  email: string | null;
  jurisdiction: string | null;
  kyc_status: string;
  onboarding_token: string | null;
  onboarding_token_expires_at?: string | null;
  types: string[] | null;
  type: string;
};

/** Projection every dossier read in this route shares. */
const SELECT_COLS =
  "id, created_at, email, jurisdiction, kyc_status, onboarding_token, onboarding_token_expires_at, types, type";

function assertNotTerminal(client: Pick<ClientLite, "kyc_status">): void {
  if (isTerminalKycStatus(client.kyc_status)) {
    throw new SiwsError(
      403,
      `Your KYC dossier is ${client.kyc_status} — contact the compliance team; reapplying is disabled.`,
    );
  }
}

/**
 * Find the oldest clients row linked to `wallet` (mirrors lookupClientKyc) or
 * create a fresh investor dossier. Returns the row plus a usable onboarding
 * token (re-issued when missing and documents may still be needed).
 *
 * The terminal-status gate runs over ALL rows of the wallet BEFORE the
 * "oldest wins" pick (assertWalletNotTerminal): with duplicate rows, checking
 * only the oldest let a suspension recorded on the newer dossier be bypassed
 * by re-applying — see the helper's docblock.
 */
async function ensureClientDossier(
  sb: SupabaseClient,
  wallet: string,
  jurisdiction: number,
): Promise<{
  client: ClientLite;
  token: string | null;
  created: boolean;
  /**
   * True when `token` exists but the server would REJECT it (no 0041 stamp on
   * a dossier older than the created_at + 14d fallback) — the caller must show
   * a message instead of a link.
   */
  linkUnusable: boolean;
}> {
  await assertWalletNotTerminal(sb, wallet);
  const { data: existing, error: lookupErr } = await sb
    .from("clients")
    .select(SELECT_COLS)
    .eq("wallet", wallet)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    console.error("[api/passport/submit] client lookup failed:", lookupErr.message);
    throw new SiwsError(500, "Client lookup failed");
  }

  const jurisdictionStr = String(jurisdiction).padStart(3, "0");

  if (!existing) {
    const token = randomOnboardingToken();
    const insertRow: Record<string, unknown> = {
      network: detectNetworkServer(),
      type: "investor",
      types: ["investor"],
      display_name: `Investor ${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      jurisdiction: jurisdictionStr,
      source: "passport-request",
      wallet,
      // Wallet is already known, but the magic-link token is still needed —
      // it is the credential for the /onboarding/{id} document uploads.
      onboarding_token: token,
      onboarding_token_expires_at: onboardingTokenExpiry(),
      onboarding_status: "connected",
    };
    let { data: created, error: insertErr } = await sb
      .from("clients")
      .insert(insertRow)
      .select(SELECT_COLS)
      .single();
    if (insertErr && isMissingTtlColumnError(insertErr)) {
      // Pre-0041 database — degrade to "no TTL stamp" instead of failing the
      // application (server-side TTL then falls back to created_at + 14d).
      console.warn(
        "[api/passport/submit] 0041 not applied — retrying insert without TTL column",
      );
      ({ data: created, error: insertErr } = await sb
        .from("clients")
        .insert(withoutTtlColumn(insertRow))
        .select(SELECT_COLS)
        .single());
    }
    if (insertErr && insertErr.code === "23505") {
      // Unique-violation on clients_wallet_unique (0041): a concurrent submit
      // provisioned the dossier between our lookup and this insert — adopt the
      // winning row instead of failing (closes the TOCTOU dupe).
      const { data: winner, error: rereadErr } = await sb
        .from("clients")
        .select(SELECT_COLS)
        .eq("wallet", wallet)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (rereadErr || !winner) {
        console.error(
          "[api/passport/submit] dupe re-read failed:",
          rereadErr?.message,
        );
        throw new SiwsError(500, "Could not provision the KYC dossier");
      }
      const adopted = winner as ClientLite;
      assertNotTerminal(adopted);
      return {
        client: adopted,
        token: adopted.onboarding_token,
        created: false,
        // The winning row's stamp decides whether its token is live at all.
        linkUnusable: !isOnboardingTokenLive(
          adopted.created_at,
          adopted.onboarding_token_expires_at,
        ),
      };
    }
    if (insertErr || !created) {
      console.error("[api/passport/submit] client insert failed:", insertErr?.message);
      throw new SiwsError(500, "Could not provision the KYC dossier");
    }
    const createdRow = created as ClientLite;
    // A brand-new row is inside the created_at + 14d fallback window even
    // without the 0041 stamp, so the link works either way.
    return { client: createdRow, token, created: true, linkUnusable: false };
  }

  const row = existing as ClientLite;
  // FAIL-CLOSED for terminal statuses: a suspended (AML/sanctions hit) or
  // rejected client must not be able to reset their own KYC state or mint a
  // fresh upload credential by simply reapplying — only compliance can lift
  // these. No status change, no token issuance, no request row.
  assertNotTerminal(row);
  const patch: Record<string, unknown> = {};
  // Fill jurisdiction when the dossier has none (never overwrite admin data).
  if (!row.jurisdiction) patch.jurisdiction = jurisdictionStr;
  // Make sure the dossier carries the investor type.
  const types = Array.isArray(row.types) && row.types.length > 0 ? row.types : [row.type];
  if (!types.includes("investor")) patch.types = [...types, "investor"];

  // Re-issue the magic-link when it is gone and documents may still be needed
  // (a verified client keeps no token — nothing to upload).
  let token = row.onboarding_token;
  if (!token && row.kyc_status !== "verified") {
    token = randomOnboardingToken();
    patch.onboarding_token = token;
    patch.onboarding_token_expires_at = onboardingTokenExpiry();
  } else if (token) {
    // Refresh the TTL — the applicant is actively using the flow.
    patch.onboarding_token_expires_at = onboardingTokenExpiry();
  }

  // Tracks the pre-0041 retry: the token then carries NO expiry stamp, so the
  // server falls back to created_at + 14d — which is already in the past for
  // any dossier older than two weeks. Handing out such a link would produce a
  // 401 on the very next click, so the caller suppresses it instead.
  let ttlDegraded = false;
  if (Object.keys(patch).length > 0) {
    let { error: patchErr } = await sb.from("clients").update(patch).eq("id", row.id);
    if (patchErr && isMissingTtlColumnError(patchErr)) {
      console.warn(
        "[api/passport/submit] 0041 not applied — retrying patch without TTL column",
      );
      ttlDegraded = true;
      ({ error: patchErr } = await sb
        .from("clients")
        .update(withoutTtlColumn(patch))
        .eq("id", row.id));
    }
    if (patchErr) {
      console.warn("[api/passport/submit] client patch failed:", patchErr.message);
    }
  }
  // Whether stamped now or inherited from the row, the link is only worth
  // advertising while the server would still accept it.
  const tokenLive = ttlDegraded
    ? isOnboardingTokenLive(row.created_at, null)
    : isOnboardingTokenLive(
        row.created_at,
        (patch.onboarding_token_expires_at as string | undefined) ??
          row.onboarding_token_expires_at,
      );
  return { client: row, token, created: false, linkUnusable: !tokenLive };
}

/**
 * Request the standard investor document set when the dossier has no open
 * checklist and is not verified; parks the client in `more_info` (same
 * semantics as /api/clients/request-docs). Best-effort — never throws.
 */
async function ensureStandardRequirements(
  sb: SupabaseClient,
  client: ClientLite,
): Promise<void> {
  if (client.kyc_status === "verified") return;
  // Defense in depth (the route 403s terminal statuses earlier): NEVER flip a
  // suspended/rejected dossier back to more_info — that would erase a
  // compliance verdict through a self-service endpoint.
  if (isTerminalKycStatus(client.kyc_status)) return;
  const { data: open, error } = await sb
    .from("kyc_requirements")
    .select("id")
    .eq("client_id", client.id)
    .in("status", ["requested", "submitted"])
    .limit(1);
  if (error) {
    console.warn("[api/passport/submit] requirements check failed:", error.message);
    return;
  }
  if ((open ?? []).length > 0) return;

  const { error: insertErr } = await sb.from("kyc_requirements").insert(
    STANDARD_INVESTOR_REQUIREMENTS.map((r) => ({
      client_id: client.id,
      doc_kind: r.doc_kind,
      label: r.label,
      note: "Requested automatically with your investor passport application.",
      requested_by: "system:passport-request",
    })),
  );
  if (insertErr) {
    console.warn("[api/passport/submit] requirements insert failed:", insertErr.message);
    return;
  }
  try {
    await applyClientStatus(sb, client.id, "more_info");
  } catch (err) {
    console.warn("[api/passport/submit] more_info flip failed:", err);
  }
}

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
    await ensureStandardRequirements(sb, client);

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
