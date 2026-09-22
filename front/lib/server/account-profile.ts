import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { AccountFeatures, AccountProfile, AccountVerification, AccountWalletKyc, AccountWalletKycStatus } from "@/lib/account";
import type { Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { MaintenanceError, maintenanceResponse } from "@/lib/server/maintenance";
import { sendEmail, escapeHtml, emailConfigured } from "@/lib/server/email";
import { accountSiteOrigin } from "@/lib/server/account-origin";

const PROFILE_FIELDS = [
  "id", "primary_wallet", "wallet", "network", "display_name", "email", "email_verified_at", "pending_email",
  "pending_email_expires_at", "google_email", "google_linked_at", "created_at", "updated_at",
] as const;

export function accountFeatures(): AccountFeatures {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()),
    email: emailConfigured(),
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

/** Who is acting: a wallet (SIWS / wallet session) or a signed-in account (email/Google). */
export type AccountWho = string | { accountId: string };

/** A new wallet gets a contact profile only; never creates or changes KYC/CRM. */
export async function getAccountProfile(who: AccountWho, network: Network): Promise<AccountProfile> {
  if (typeof who !== "string") {
    const { data, error } = await getSupabaseAdmin().rpc("get_account_profile", { p_account_id: who.accountId, p_network: network });
    if (error || !data || typeof data !== "object" || Array.isArray(data) || data.id !== who.accountId ||
        data.network !== network || !Array.isArray(data.wallets)) throw new SiwsError(401, "Please sign in again.");
    return projectAccountProfile(data as Record<string, unknown>);
  }
  const wallet = who;
  const { data, error } = await getSupabaseAdmin().rpc("ensure_account_profile", { p_wallet: wallet, p_network: network });
  if (error || !data || typeof data !== "object" || Array.isArray(data) || data.wallet !== wallet || data.network !== network ||
      !Array.isArray(data.wallets) || !data.wallets.some((member: { wallet?: unknown }) => member?.wallet === wallet)) throw accountUnavailable();
  return projectAccountProfile(data as Record<string, unknown>);
}

// Higher rank wins when a wallet has several dossiers: a terminal status must
// never be masked by an older active row.
const KYC_RANK: Record<string, number> = { suspended: 5, rejected: 4, verified: 3, more_info: 2, pending: 1 };

/** Per-wallet dossier status for the account's own wallets. Read-only; a
 * failure degrades to null instead of hiding the profile. */
export async function getAccountWalletKyc(wallets: string[], network: Network): Promise<AccountWalletKyc[] | null> {
  if (wallets.length === 0) return [];
  const { data, error } = await getSupabaseAdmin().from("clients")
    .select("wallet,kyc_status,kyc_expires_at").eq("network", network).in("wallet", wallets);
  if (error || !Array.isArray(data)) return null;
  const now = Date.now();
  return wallets.map((wallet) => {
    let best: { kyc_status: string; kyc_expires_at: string | null } | null = null;
    for (const row of data as { wallet: string; kyc_status: string; kyc_expires_at: string | null }[]) {
      if (row.wallet !== wallet || !(row.kyc_status in KYC_RANK)) continue;
      if (!best || KYC_RANK[row.kyc_status] > KYC_RANK[best.kyc_status]) best = row;
    }
    if (!best) return { wallet, status: "none", expires_at: null };
    const expired = best.kyc_status === "verified" && best.kyc_expires_at !== null && Date.parse(best.kyc_expires_at) <= now;
    return { wallet, status: (expired ? "expired" : best.kyc_status) as AccountWalletKycStatus, expires_at: best.kyc_expires_at };
  });
}

/** KYC (individual) and KYB (company) state of the account's dossier. The
 * dossier belongs to the account; legacy dossiers are found by a linked wallet. */
export async function getAccountVerification(profile: AccountProfile, network: Network): Promise<AccountVerification | null> {
  const sb = getSupabaseAdmin();
  const cols = "id,kyc_status,kyc_expires_at,type,types";
  const byAccount = await sb.from("clients").select(cols).eq("network", network).eq("account_id", profile.id);
  if (byAccount.error) return null;
  let rows = byAccount.data ?? [];
  const wallets = profile.wallets.map((w) => w.wallet);
  if (rows.length === 0 && wallets.length > 0) {
    const byWallet = await sb.from("clients").select(cols).eq("network", network).in("wallet", wallets);
    if (byWallet.error) return null;
    rows = byWallet.data ?? [];
  }
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) return { kyc: "none", kyb: "none", documents_requested: 0 };
  const row = [...rows].sort((a, b) => (KYC_RANK[b.kyc_status] ?? 0) - (KYC_RANK[a.kyc_status] ?? 0))[0] as {
    id: string; kyc_status: string; kyc_expires_at: string | null; type: string; types: string[] | null;
  };
  const [details, requirements] = await Promise.all([
    sb.from("client_verification_details").select("kind,status").eq("client_id", row.id),
    sb.from("kyc_requirements").select("id").eq("client_id", row.id).eq("status", "requested"),
  ]);
  if (details.error || requirements.error) return null;
  const byKind = new Map((details.data ?? []).map((d: { kind: string; status: string }) => [d.kind, d.status]));
  const roles = new Set(Array.isArray(row.types) && row.types.length ? row.types : [row.type]);
  const documentsRequested = (requirements.data ?? []).length;
  const terminal = row.kyc_status === "suspended" || row.kyc_status === "rejected";
  const expired = row.kyc_status === "verified" && row.kyc_expires_at !== null && Date.parse(row.kyc_expires_at) <= Date.now();
  const status = (expired ? "expired" : (row.kyc_status in KYC_RANK ? row.kyc_status : "pending")) as AccountWalletKycStatus;
  // KYB has its own review decision; it never inherits the individual KYC verdict.
  const kybRow = byKind.get("kyb");
  const kyb: AccountWalletKycStatus = terminal ? (row.kyc_status as AccountWalletKycStatus)
    : !kybRow ? "none"
    : kybRow === "verified" ? "verified" : kybRow === "rejected" ? "rejected"
    : documentsRequested > 0 ? "more_info" : "pending";
  return {
    kyc: byKind.has("kyc") || roles.has("investor") ? status : "none",
    kyb,
    documents_requested: documentsRequested,
  };
}

export async function accountResponse(who: AccountWho, network: Network): Promise<NextResponse> {
  const profile = await getAccountProfile(who, network);
  let kyc: AccountWalletKyc[] | null = null;
  let verification: AccountVerification | null = null;
  try { kyc = await getAccountWalletKyc(profile.wallets.map((entry) => entry.wallet), network); } catch { kyc = null; }
  try { verification = await getAccountVerification(profile, network); } catch { verification = null; }
  return NextResponse.json({ ok: true, data: {
    profile, features: accountFeatures(), kyc, verification,
  } }, { headers: { "Cache-Control": "no-store" } });
}

/** Account handlers never log provider responses, identity fields or tokens. */
export function accountErrorResponse(error: unknown): NextResponse {
  if (error instanceof MaintenanceError) return maintenanceResponse(error);
  const known = error instanceof SiwsError;
  return NextResponse.json({ ok: false, error: known ? error.message : "Your account is temporarily unavailable. Please try again." },
    { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Atomically bind a delayed signed mutation to the account the user approved. */
export async function callAccountMutation<T = unknown>(who: AccountWho, network: Network, expectedAccountId: string,
  action: string, params: Record<string, unknown>): Promise<T> {
  if (typeof who !== "string" && who.accountId !== expectedAccountId) {
    throw new SiwsError(403, "Your signed-in account changed. Reload your account and try again.");
  }
  const { data, error } = typeof who === "string"
    ? await getSupabaseAdmin().rpc("mutate_account_profile", {
      p_wallet: who, p_network: network, p_account_id: expectedAccountId, p_action: action, p_params: params,
    })
    : await getSupabaseAdmin().rpc("mutate_account_by_id", {
      p_account_id: who.accountId, p_network: network, p_action: action, p_params: params,
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

export async function updateAccountName(wallet: AccountWho, network: Network, displayName: string, expectedAccountId: string): Promise<void> {
  const data = await callAccountMutation<boolean>(wallet, network, expectedAccountId, "update", { display_name: displayName });
  if (data !== true) throw new SiwsError(403, "This wallet no longer has access to the account.");
}

export async function cancelAccountEmail(wallet: AccountWho, network: Network, tokenHash: string | null, expectedAccountId: string): Promise<void> {
  await callAccountMutation<boolean>(wallet, network, expectedAccountId, "email.cancel", { token_hash: tokenHash });
}

export async function requestAccountEmail(request: Request, wallet: AccountWho, network: Network, email: string, expectedAccountId: string): Promise<void> {
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
        "<p>This link expires in 30 minutes. Open it while signed in to the same Manci account (or with a wallet linked to it). If you did not request this, you can ignore this email.</p>",
    })).sent;
  } catch { /* A transport adapter must not expose provider diagnostics. */ }
  if (!sent) {
    // Only remove this failed challenge. A newer request must survive a slow
    // provider response, and previous verified contact details are preserved.
    await cancelAccountEmail(wallet, network, tokenHash, expectedAccountId);
    throw new SiwsError(503, "We could not send the verification email. Please try again later.");
  }
}

export async function verifyAccountEmail(wallet: AccountWho, network: Network, token: string): Promise<void> {
  if (typeof wallet !== "string") {
    const { data, error } = await getSupabaseAdmin().rpc("mutate_account_by_id", {
      p_account_id: wallet.accountId, p_network: network, p_action: "email.verify", p_params: { token_hash: hash(token) },
    });
    if (error || !data || typeof data !== "object" || data.ok !== true) throw accountUnavailable();
    if (data.result !== true) throw new SiwsError(400, "This verification link is invalid or expired, or the email is used by another account.");
    return;
  }
  const { data, error } = await getSupabaseAdmin().rpc("verify_account_email", {
    p_wallet: wallet, p_network: network, p_token_hash: hash(token),
  });
  if (error || typeof data !== "boolean") throw accountUnavailable();
  if (!data) throw new SiwsError(400, "This verification link is invalid or expired. Use a wallet linked to the same account.");
}
