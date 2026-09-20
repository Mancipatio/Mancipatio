import { isAddress } from "@solana/kit";
import type { AccountWalletLinkAttempt } from "@/lib/account";
import type { Network } from "@/lib/network";

export const ACCOUNT_WALLET_LINK_STORAGE_KEY = "manci:account-wallet-link:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Local checks protect the flow; the server still verifies both signatures. */
export function validWalletLinkAttempt(value: unknown, now = Date.now()): value is AccountWalletLinkAttempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.token) ||
    !isAccountId(item.account_id) || typeof item.requested_by !== "string" ||
    typeof item.target_wallet !== "string" || !isAddress(item.requested_by) ||
    !isAddress(item.target_wallet) || item.requested_by === item.target_wallet ||
    typeof item.expires_at !== "string") return false;
  const expiry = Date.parse(item.expires_at);
  return Number.isFinite(expiry) && expiry > now && expiry <= now + 11 * 60_000;
}

export function restoreWalletLinkAttempt(raw: string | null, network: Network, now = Date.now()): AccountWalletLinkAttempt | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const item = JSON.parse(raw) as { network?: unknown; attempt?: unknown };
    if (item.network !== network || !validWalletLinkAttempt(item.attempt, now)) return null;
    return cleanAttempt(item.attempt);
  } catch {
    return null;
  }
}

function cleanAttempt(attempt: AccountWalletLinkAttempt): AccountWalletLinkAttempt {
  const { token, account_id, requested_by, target_wallet, expires_at } = attempt;
  return { token, account_id, requested_by, target_wallet, expires_at };
}

/** Never persist a profile, contact details or a signed request envelope. */
export function serializeWalletLinkAttempt(attempt: AccountWalletLinkAttempt, network: Network) {
  return JSON.stringify({ network, attempt: cleanAttempt(attempt) });
}
