// SERVER-ONLY — outbound email over SMTP (preferred) or the Resend REST API.
//
// Graceful no-op: if no transport is configured, logs and returns { sent: false }
// — callers decide whether delivery is optional. Verification flows must check
// `sent` before reporting success. This function does not throw.
//
// Env:
//   SMTP_HOST, SMTP_USER, SMTP_PASS — SMTP transport (used when all three are set)
//   SMTP_PORT       — optional, defaults to 465 (implicit TLS); 587 uses STARTTLS
//   RESEND_API_KEY  — fallback transport when SMTP is not configured
//   EMAIL_FROM      — sender; required for SMTP, optional for Resend
//
// `timeoutMs` (optional) is a HARD deadline: the SMTP connection, greeting
// and socket timeouts are capped at it, and the whole send races a timer.
// On expiry it returns { sent: false, error: "TIMEOUT" } and abandons the
// send in progress (nodemailer cannot abort one; its late result is
// swallowed and the capped socket timeout ends it soon after). A send that
// completed anyway may therefore repeat: delivery is at-least-once.

import "server-only";
import nodemailer from "nodemailer";

type SmtpConfig = { host: string; port: number; user: string; pass: string };

function smtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  return { host, user, pass, port: Number.isInteger(port) && port > 0 ? port : 465 };
}

/** True when a transport and sender are configured, so delivery can succeed. */
export function emailConfigured(): boolean {
  const from = Boolean(process.env.EMAIL_FROM?.trim());
  if (smtpConfig()) return from;
  return Boolean(process.env.RESEND_API_KEY?.trim()) && from;
}

async function sendSmtp(config: SmtpConfig, input: SendEmailInput): Promise<SendEmailResult> {
  const from = input.from ?? process.env.EMAIL_FROM?.trim();
  if (!from) {
    console.warn(`[email] EMAIL_FROM not set — skipping email "${input.subject}"`);
    return { sent: false, error: "EMAIL_FROM not configured" };
  }
  try {
    const cap = (value: number) => (input.timeoutMs ? Math.max(1, Math.min(value, input.timeoutMs)) : value);
    const transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.port === 465,
      requireTLS: config.port !== 465,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: cap(10_000), greetingTimeout: cap(10_000), socketTimeout: cap(15_000),
    });
    const info = await transport.sendMail({
      from, to: input.to, subject: input.subject, html: input.html,
    });
    return { sent: true, id: info.messageId };
  } catch (err) {
    const code = (err as { responseCode?: number; code?: string })?.responseCode ??
      (err as { code?: string })?.code ?? "unknown";
    // SMTP errors can echo recipients; keep logs to the status code.
    console.error(`[email] SMTP failure sending "${input.subject}" — ${code}`);
    return { sent: false, error: input.redactErrors ? "Delivery failed" : `SMTP ${code}` };
  }
}

/** Escape user-supplied text for interpolation into email HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  /** Optional override; defaults to env EMAIL_FROM or the Resend onboarding sender. */
  from?: string;
  /** Verification emails must not expose recipient/token diagnostics in logs. */
  redactErrors?: boolean;
  /** Hard deadline for the whole send (see the header); absent = the defaults. */
  timeoutMs?: number;
};

export type SendEmailResult = {
  sent: boolean;
  /** Resend message id when sent. */
  id?: string;
  /** Failure reason when not sent (already logged server-side). */
  error?: string;
};

/**
 * Send a transactional email. Best-effort: never throws.
 *
 * @returns { sent: true, id } on success; { sent: false, error } otherwise
 *          (including when no transport is configured).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const limit = input.timeoutMs;
  if (limit === undefined) return sendOnce(input);
  if (!Number.isFinite(limit) || limit <= 0) return { sent: false, error: "TIMEOUT" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SendEmailResult>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, error: "TIMEOUT" }), limit);
  });
  const attempt = sendOnce(input);
  attempt.catch(() => {});
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendOnce(input: SendEmailInput): Promise<SendEmailResult> {
  const smtp = smtpConfig();
  if (smtp) return sendSmtp(smtp, input);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[email] no SMTP or RESEND_API_KEY configured — skipping email "${input.subject}"`,
    );
    return { sent: false, error: "Email transport not configured" };
  }

  const from =
    input.from ??
    process.env.EMAIL_FROM ??
    "Manci <onboarding@resend.dev>";
  const to = Array.isArray(input.to) ? input.to : [input.to];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ? Math.min(15_000, input.timeoutMs) : 15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject: input.subject, html: input.html }),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body?.message) detail = `${detail}: ${body.message}`;
      } catch {
        // Non-JSON error body — keep the status-only detail.
      }
      const safeDetail = input.redactErrors ? `HTTP ${res.status}` : detail;
      console.error(`[email] Resend rejected "${input.subject}" — ${safeDetail}`);
      return { sent: false, error: safeDetail };
    }

    const body = (await res.json()) as { id?: string };
    return { sent: true, id: body?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] network failure sending "${input.subject}":`, input.redactErrors ? "Delivery failed" : err);
    return { sent: false, error: input.redactErrors ? "Delivery failed" : message };
  }
}
