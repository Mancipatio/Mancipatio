// POST /api/inquiries/create — public contact-form submission.
//
// Deliberately UNSIGNED (no wallet required for the marketing contact form).
// Protections instead of a signature:
//   - honeypot field ("website"): bots that fill it get a plausible success
//     response but nothing is inserted;
//   - a body cap (INQUIRY_BODY_LIMIT) enforced while reading, before parsing;
//   - strict length caps + email format check;
//   - best-effort in-memory rate limit: 5 requests/min/IP (per instance);
//   - a Cloudflare Turnstile check when TURNSTILE_SECRET_KEY is set (fails
//     closed; runs after field validation, so malformed submissions are
//     refused without a call to Cloudflare).
// The insert goes through the service role, so the anon INSERT policy on
// custom_inquiries can be dropped entirely (W3-RLS: NO anon anything).
//
// On a real insert, notifies CONTACT_NOTIFY_EMAIL (env) through sendEmail
// (SMTP, or the Resend fallback) — graceful no-op when either is missing.

import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/server/email";
import { detectNetwork } from "@/lib/network";
import { verifyTurnstile } from "@/lib/server/turnstile";
import { TURNSTILE_ACTIONS, TURNSTILE_BODY_FIELD } from "@/lib/turnstile";

// ---------------------------------------------------------------------------
// Best-effort rate limit — in-memory, per serverless instance.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>(); // ip -> request timestamps

function rateLimited(ip: string, now: number): boolean {
  const windowStart = now - RATE_WINDOW_MS;
  const prev = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (prev.length >= RATE_MAX) {
    hits.set(ip, prev);
    return true;
  }
  prev.push(now);
  hits.set(ip, prev);
  // Bound the map so a scan across many IPs can't grow memory forever.
  if (hits.size > 10_000) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  return false;
}

/**
 * Best-effort client IP for rate-limiting. The LEFTMOST `x-forwarded-for` token
 * is attacker-controlled (a fronting proxy APPENDS the real IP after any
 * client-supplied value), so keying on it lets a caller rotate the header for a
 * fresh bucket every request. Prefer the platform-set `x-real-ip` (Vercel), and
 * otherwise fall back to the RIGHTMOST XFF hop — the address the closest trusted
 * proxy actually saw. NOTE: this is per-instance memory, so it still cannot
 * bound a distributed flood; a shared store / per-email cap is the real remedy.
 */
function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Request body cap: the idea (≤5000 characters, up to 3 UTF-8 bytes each),
 *  name, company, asset kind, a Turnstile token (≤2048) and the JSON around
 *  them fit with room to spare. */
const INQUIRY_BODY_LIMIT = 32 * 1024;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function POST(request: Request) {
  try {
    const ip = clientIp(request);
    if (rateLimited(ip, Date.now())) {
      throw new SiwsError(429, "Too many inquiries — please try again in a minute");
    }

    // 413 for an oversized body, before anything is parsed.
    const bounded = await boundedRequest(request, INQUIRY_BODY_LIMIT);
    let body: unknown;
    try {
      body = await bounded.json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new SiwsError(400, "Invalid request body");
    }
    const b = body as Record<string, unknown>;

    // Honeypot: real users never see/fill this field. Answer success so bots
    // don't learn they were filtered, but write nothing.
    if (typeof b.website === "string" && b.website.trim().length > 0) {
      return NextResponse.json({
        ok: true,
        data: { id: crypto.randomUUID() },
      });
    }

    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (!EMAIL_RE.test(email) || email.length > 320) {
      throw new SiwsError(400, "Enter a valid email address");
    }
    const idea = typeof b.idea === "string" ? b.idea.trim() : "";
    if (idea.length < 20 || idea.length > 5000) {
      throw new SiwsError(400, "Your idea must be 20–5000 characters");
    }
    const name =
      typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
    const company =
      typeof b.company === "string" ? b.company.trim().slice(0, 200) : "";
    const assetKind =
      typeof b.asset_kind === "string"
        ? b.asset_kind.trim().slice(0, 120)
        : "";

    await verifyTurnstile(request, b[TURNSTILE_BODY_FIELD], TURNSTILE_ACTIONS.inquiry);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("custom_inquiries")
      .insert({
        network: detectNetwork(),
        name,
        email,
        company: company || null,
        asset_kind: assetKind || null,
        idea,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[api/inquiries/create] insert failed:", error.message);
      throw new SiwsError(500, "Could not save your inquiry");
    }

    // Best-effort notification — never fails the request (sendEmail never throws).
    const notify = process.env.CONTACT_NOTIFY_EMAIL;
    if (notify) {
      await sendEmail({
        to: notify,
        subject: `New tokenization inquiry from ${name || email}`,
        html:
          `<p><strong>New custom tokenization inquiry</strong></p>` +
          `<p>Name: ${escapeHtml(name || "—")}<br/>` +
          `Email: ${escapeHtml(email)}<br/>` +
          `Company: ${escapeHtml(company || "—")}<br/>` +
          `Asset kind: ${escapeHtml(assetKind || "—")}</p>` +
          `<p style="white-space:pre-wrap">${escapeHtml(idea)}</p>` +
          `<p>Triage it in the admin console → Inquiries.</p>`,
      });
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
