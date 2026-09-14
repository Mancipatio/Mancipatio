// SERVER-ONLY — outbound email via the Resend REST API (plain fetch, no SDK).
//
// Graceful no-op: if RESEND_API_KEY is unset, logs and returns { sent: false }
// — callers must treat email as best-effort and NEVER fail the request over an
// email problem. This function does not throw.
//
// Env:
//   RESEND_API_KEY  — required to actually send
//   EMAIL_FROM      — optional sender, defaults to Resend's onboarding sender

import "server-only";

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
 *          (including when RESEND_API_KEY is not configured).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[email] RESEND_API_KEY not set — skipping email "${input.subject}"`,
    );
    return { sent: false, error: "RESEND_API_KEY not configured" };
  }

  const from =
    input.from ??
    process.env.EMAIL_FROM ??
    "Mancipatio <onboarding@resend.dev>";
  const to = Array.isArray(input.to) ? input.to : [input.to];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
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
      console.error(`[email] Resend rejected "${input.subject}" — ${detail}`);
      return { sent: false, error: detail };
    }

    const body = (await res.json()) as { id?: string };
    return { sent: true, id: body?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] network failure sending "${input.subject}":`, err);
    return { sent: false, error: message };
  }
}
