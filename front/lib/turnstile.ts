// Cloudflare Turnstile — the pieces both the browser widget and the server
// check need (no "use client" / "server-only"). Server verification lives in
// lib/server/turnstile.ts; the widget in components/turnstile-widget.tsx.
//
// Turnstile is opt-in per deployment: the widget renders only when
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is set, and the server checks tokens only
// when TURNSTILE_SECRET_KEY is set. Set both together — a secret without a
// site key makes every protected form fail (the server fails closed), so a
// production build with the secret and no site key refuses to build
// (assertBuildTurnstile in next.config.ts).

/** Actions bound into the token on render and re-checked by the server
 *  (Turnstile allows [A-Za-z0-9_-], at most 32 characters). */
export const TURNSTILE_ACTIONS = {
  emailLogin: "email_login",
  inquiry: "contact_inquiry",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

/** Turnstile tokens are at most 2048 characters. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** Request body field that carries the widget's token. */
export const TURNSTILE_BODY_FIELD = "turnstile_token";

/** The public site key, or null when Turnstile is off for this build. A
 *  literal process.env read so Next inlines it into the client bundle. */
export function turnstileSiteKey(): string | null {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;
}
