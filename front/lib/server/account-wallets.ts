import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { callAccountMutation, type AccountWho } from "@/lib/server/account-profile";

function unavailable(): SiwsError { return new SiwsError(503, "Wallet linking is temporarily unavailable. Please try again."); }
function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

export async function startAccountWalletLink(wallet: string, network: Network, targetWallet: string, expectedAccountId: string): Promise<NextResponse> {
  const token = randomBytes(32).toString("base64url");
  const data = await callAccountMutation<Record<string, unknown>>(wallet, network, expectedAccountId, "wallets.start", {
    target_wallet: targetWallet, token_hash: tokenHash(token),
  });
  if (!data || typeof data !== "object") throw unavailable();
  if (data.status === "rate_limited") throw new SiwsError(429, "Too many wallet link requests. Please try again later.");
  if (data.status === "same_wallet") throw new SiwsError(409, "This wallet is already linked to your account.");
  if (data.status === "wallet_limit") throw new SiwsError(409, "You can link up to 10 wallets to one account.");
  if (data.status === "not_member") throw new SiwsError(403, "This wallet no longer has access to the account.");
  if (data.status !== "started" || data.requested_by !== wallet || data.target_wallet !== targetWallet ||
      typeof data.account_id !== "string" || typeof data.expires_at !== "string") throw unavailable();
  return NextResponse.json({ ok: true, data: { token, account_id: data.account_id,
    requested_by: wallet, target_wallet: targetWallet, expires_at: data.expires_at,
  } }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function completeAccountWalletLink(wallet: string, network: Network, input: {
  token: string; account_id: string; requested_by: string; target_wallet: string;
}): Promise<void> {
  if (wallet !== input.target_wallet) throw new SiwsError(403, "Connect the target wallet to confirm this link.");
  const { data, error } = await getSupabaseAdmin().rpc("complete_account_wallet_link", {
    p_wallet: wallet, p_network: network, p_token_hash: tokenHash(input.token),
    p_account_id: input.account_id, p_requested_by: input.requested_by, p_target_wallet: input.target_wallet,
  });
  if (error) throw unavailable();
  if (data === "account_conflict") throw new SiwsError(409, "This wallet already has an account. Existing account data cannot be merged.");
  if (data === "wallet_limit") throw new SiwsError(409, "You can link up to 10 wallets to one account.");
  if (data !== "linked") throw new SiwsError(400, "This wallet link is invalid or expired. Start a new request from a linked wallet.");
}

export async function cancelAccountWalletLink(wallet: string, network: Network, input: {
  token: string; account_id: string; requested_by: string; target_wallet: string;
}): Promise<void> {
  if (wallet !== input.requested_by && wallet !== input.target_wallet) throw new SiwsError(403, "Connect one of the wallets involved in this link.");
  const { data, error } = await getSupabaseAdmin().rpc("cancel_account_wallet_link", {
    p_wallet: wallet, p_network: network, p_token_hash: tokenHash(input.token),
    p_account_id: input.account_id, p_requested_by: input.requested_by, p_target_wallet: input.target_wallet,
  });
  if (error) throw unavailable();
  if (data !== true) throw new SiwsError(403, "This wallet cannot cancel that link request.");
}

export async function setAccountPrimaryWallet(wallet: AccountWho, network: Network, primaryWallet: string, expectedAccountId: string): Promise<void> {
  const data = await callAccountMutation<string>(wallet, network, expectedAccountId, "wallets.primary", { wallet: primaryWallet });
  if (data !== "updated") throw new SiwsError(403, "The primary wallet must be linked to your account.");
}

export async function removeAccountWallet(wallet: AccountWho, network: Network, targetWallet: string, expectedAccountId: string): Promise<void> {
  const data = await callAccountMutation<string>(wallet, network, expectedAccountId, "wallets.remove", { wallet: targetWallet });
  if (data === "self") throw new SiwsError(409, "Connect another linked wallet before removing this wallet.");
  if (data === "primary") throw new SiwsError(409, "Choose another primary wallet before removing this wallet.");
  if (data === "last") throw new SiwsError(409, "Your account must keep at least one linked wallet.");
  if (data !== "removed") throw new SiwsError(403, "This wallet is not linked to your account.");
}

/** Add a wallet to the signed-in account: the wallet signed the request and
 * the account session cookie is live. */
export async function attachAccountWallet(accountId: string, network: Network, wallet: string): Promise<void> {
  const { data, error } = await getSupabaseAdmin().rpc("attach_account_wallet", {
    p_account_id: accountId, p_network: network, p_wallet: wallet,
  });
  if (error) throw unavailable();
  if (data === "same_wallet") throw new SiwsError(409, "This wallet is already linked to your account.");
  if (data === "wallet_limit") throw new SiwsError(409, "You can link up to 10 wallets to one account.");
  if (data === "account_conflict") throw new SiwsError(409, "This wallet already belongs to another account with its own data. Existing accounts cannot be merged.");
  if (data !== "linked") throw unavailable();
}
