import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { AccountFeatures, AccountProfile } from "@/lib/account";
import type { Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import { accountSiteOrigin } from "@/lib/server/account-origin";

const PROFILE_FIELDS = [
  "id", "primary_wallet", "wallet", "network", "display_name", "email", "email_verified_at", "pending_email",
  "pending_email_expires_at", "google_email", "google_linked_at", "created_at", "updated_at",
] as const;

export function accountFeatures(): AccountFeatures {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()),
    email: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()),
  };
}

/** Explicit projection also guards against an accidental broader DB select. */
export function projectAccountProfile(row: Record<string, unknown>): AccountProfile {
  const wallets = Array.isArray(row.wallets) ? row.wallets.map((value: unknown) => {
    const member = value as Record<string, unknown>;
    return { wallet: member.wallet, linked_at: member.linked_at };
  }) : [];
  return { ...Object.fromEntries(PROFILE_FIELDS.map((key) => [key, row[key] ?? null])), wallets } as AccountProfile;
}

function accountUnavailable(): SiwsError {
  return new SiwsError(503, "Your account is temporarily unavailable. Please try again.");
}

/** A new wallet gets a contact profile only; never creates or changes KYC/CRM. */
export async function getAccountProfile(wallet: string, network: Network): Promise<AccountProfile> {
  const { data, error } = await getSupabaseAdmin().rpc("ensure_account_profile", { p_wallet: wallet, p_network: network });
  if (error || !data || typeof data !== "object" || Array.isArray(data) || data.wallet !== wallet || data.network !== network ||
      !Array.isArray(data.wallets) || !data.wallets.some((member: { wallet?: unknown }) => member?.wallet === wallet)) throw accountUnavailable();
  return projectAccountProfile(data as Record<string, unknown>);
}

export async function accountResponse(wallet: string, network: Network): Promise<NextResponse> {
  return NextResponse.json({ ok: true, data: {
    profile: await getAccountProfile(wallet, network), features: accountFeatures(),
  } }, { headers: { "Cache-Control": "no-store" } });
}

/** Account handlers never log provider responses, identity fields or tokens. */
export function accountErrorResponse(error: unknown): NextResponse {
  const known = error instanceof SiwsError;
  return NextResponse.json({ ok: false, error: known ? error.message : "Your account is temporarily unavailable. Please try again." },
    { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Atomically bind a delayed signed mutation to the account the user approved. */
export async function callAccountMutation<T = unknown>(wallet: string, network: Network, expectedAccountId: string,
  action: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseAdmin().rpc("mutate_account_profile", {
    p_wallet: wallet, p_network: network, p_account_id: expectedAccountId, p_action: action, p_params: params,
  });
  if (error || !data || typeof data !== "object" || typeof data.ok !== "boolean") throw accountUnavailable();
  if (!data.ok) throw new SiwsError(403, "Your linked account changed. Reload your account and try again.");
  if (!("result" in data)) throw accountUnavailable();
  return data.result as T;
}

export async function consumeAccountRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const { data, error } = await getSupabaseAdmin().rpc("consume_account_rate_limit", {
    p_key_hash: hash(key), p_limit: limit, p_window_seconds: windowSeconds,
  });
  if (error || typeof data !== "boolean") throw accountUnavailable();
  if (!data) throw new SiwsError(429, "Too many requests. Please try again later.");
}

export async function updateAccountName(wallet: string, network: Network, displayName: string, expectedAccountId: string): Promise<void> {
  const data = await callAccountMutation<boolean>(wallet, network, expectedAccountId, "update", { display_name: displayName });
  if (data !== true) throw new SiwsError(403, "This wallet no longer has access to the account.");
}

export async function cancelAccountEmail(wallet: string, network: Network, tokenHash: string | null, expectedAccountId: string): Promise<void> {
  await callAccountMutation<boolean>(wallet, network, expectedAccountId, "email.cancel", { token_hash: tokenHash });
}

export async function requestAccountEmail(request: Request, wallet: string, network: Network, email: string, expectedAccountId: string): Promise<void> {
  if (!accountFeatures().email) throw new SiwsError(503, "Email verification is not available yet.");
  const origin = accountSiteOrigin(request);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const data = await callAccountMutation<string>(wallet, network, expectedAccountId, "email.request", {
    email, token_hash: tokenHash, recipient_hash: hash(email),
  });
  if (data === "not_member") throw new SiwsError(403, "This wallet no longer has access to the account.");
  if (!["requested", "rate_limited"].includes(data)) throw accountUnavailable();
  if (data === "rate_limited") throw new SiwsError(429, "Please wait before requesting another verification email.");
  const link = new URL("/account/verify", origin);
  link.searchParams.set("token", token);
  let sent = false;
  try {
    sent = (await sendEmail({
      to: email,
      redactErrors: true,
      subject: "Verify your Manci email",
      html: `<p>Confirm this email address for your Manci account:</p><p><a href="${escapeHtml(link.toString())}">Verify email address</a></p>` +
        "<p>This link expires in 30 minutes. Open it with a wallet linked to the same Manci account. If you did not request this, you can ignore this email.</p>",
    })).sent;
  } catch { /* A transport adapter must not expose provider diagnostics. */ }
  if (!sent) {
    // Only remove this failed challenge. A newer request must survive a slow
    // provider response, and previous verified contact details are preserved.
    await cancelAccountEmail(wallet, network, tokenHash, expectedAccountId);
    throw new SiwsError(503, "We could not send the verification email. Please try again later.");
  }
}

export async function verifyAccountEmail(wallet: string, network: Network, token: string): Promise<void> {
  const { data, error } = await getSupabaseAdmin().rpc("verify_account_email", {
    p_wallet: wallet, p_network: network, p_token_hash: hash(token),
  });
  if (error || typeof data !== "boolean") throw accountUnavailable();
  if (!data) throw new SiwsError(400, "This verification link is invalid or expired. Use a wallet linked to the same account.");
}
