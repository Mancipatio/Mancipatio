import type { WalletSession } from "@solana/client";
import { isAddress } from "@solana/kit";
import type { AccountResponse, AccountWalletLinkAttempt } from "@/lib/account";
import { isAccountId, validWalletLinkAttempt } from "@/lib/account-wallet-link";
import { detectNetwork, type Network } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import { accountFetch } from "@/lib/account-login";
import { invalidateTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { MaintenanceModeError } from "@/lib/maintenance";

export type AccountRequestContext = {
  /** The connected wallet (wallet mode); null when signed in by email/Google. */
  session: WalletSession | null;
  /** "account" = authorized by the email/Google session cookie, no signature. */
  mode?: "wallet" | "account";
  network: Network;
  isCurrent: () => boolean;
  accountId?: string;
};

export class AccountSessionChangedError extends Error {
  constructor() {
    super("Your wallet, account or network changed. Reload this page and open your account again.");
    this.name = "AccountSessionChangedError";
  }
}

function assertCurrent(context: AccountRequestContext) {
  if (!context.isCurrent() || detectNetwork() !== context.network) {
    throw new AccountSessionChangedError();
  }
}

const ACCOUNT_BOUND_ACTIONS = new Set([
  "account.update", "account.email.request", "account.email.cancel",
  "account.google.start", "account.google.unlink", "account.wallets.start",
  "account.wallets.primary", "account.wallets.remove",
]);

async function request<T>(
  context: AccountRequestContext,
  path: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  assertCurrent(context);
  // The intended account must be part of the signature. A response-only check
  // is too late if this wallet moved to another account while a request waited.
  if (ACCOUNT_BOUND_ACTIONS.has(action)) {
    if (!isAccountId(context.accountId)) throw new Error("ACCOUNT_ID_REQUIRED");
    params = { ...params, account_id: context.accountId };
  }
  if (context.mode === "account" || !context.session) {
    const response = await accountFetch<T>(path, action, params);
    assertCurrent(context);
    return response;
  }
  const signMessage = context.session.signMessage;
  if (!signMessage) throw new Error("ACCOUNT_MESSAGE_SIGNING_UNAVAILABLE");
  // signedFetch signs before it POSTs. A wallet switch during the signature
  // prompt must prevent the old operation from being submitted at all.
  const guardedSession: WalletSession = {
    ...context.session,
    async signMessage(message) {
      assertCurrent(context);
      const signature = await signMessage.call(context.session, message);
      assertCurrent(context);
      return signature;
    },
  };
  const response = await signedFetch<T>(guardedSession, path, action, params);
  assertCurrent(context);
  return response;
}

async function profileRequest(
  context: AccountRequestContext,
  path: string,
  action: string,
  params: Record<string, unknown> = {},
) {
  const response = await request<AccountResponse>(context, path, action, params);
  const profile = response?.profile;
  const wallets = profile?.wallets;
  const accountMode = context.mode === "account" || !context.session;
  if (
    !profile || profile.network !== context.network || !isAccountId(profile.id) ||
    (context.accountId !== undefined && profile.id !== context.accountId) ||
    !Array.isArray(wallets) || wallets.length > 10 ||
    wallets.some((entry) => !entry || typeof entry.wallet !== "string" || !isAddress(entry.wallet)) ||
    new Set(wallets.map((entry) => entry.wallet)).size !== wallets.length ||
    (accountMode
      // Signed in by email/Google: no acting wallet; the primary is optional.
      ? profile.wallet !== null || (profile.primary_wallet !== null && !wallets.some((entry) => entry.wallet === profile.primary_wallet))
      : profile.wallet !== context.session!.account.address.toString() || wallets.length < 1 ||
        !wallets.some((entry) => entry.wallet === profile.wallet) ||
        !wallets.some((entry) => entry.wallet === profile.primary_wallet))
  ) {
    throw new AccountSessionChangedError();
  }
  return response;
}

export function openAccount(context: AccountRequestContext) {
  return profileRequest(context, "/api/account/me", "account.me");
}

export function updateAccount(context: AccountRequestContext, displayName: string) {
  return profileRequest(context, "/api/account/update", "account.update", { display_name: displayName });
}

export function requestAccountEmail(context: AccountRequestContext, email: string) {
  return profileRequest(context, "/api/account/email/request", "account.email.request", { email });
}

export function verifyAccountEmail(context: AccountRequestContext, token: string) {
  return profileRequest(context, "/api/account/email/verify", "account.email.verify", { token });
}

export function cancelAccountEmail(context: AccountRequestContext) {
  return profileRequest(context, "/api/account/email/cancel", "account.email.cancel");
}

export function startAccountGoogle(context: AccountRequestContext) {
  return request<{ url: string }>(context, "/api/account/google/start", "account.google.start");
}

export function unlinkAccountGoogle(context: AccountRequestContext) {
  return profileRequest(context, "/api/account/google/unlink", "account.google.unlink");
}

export async function startAccountWalletLink(context: AccountRequestContext, targetWallet: string) {
  if (!context.session || !isAddress(targetWallet) || targetWallet === context.session.account.address.toString()) {
    throw new Error("ACCOUNT_LINK_TARGET_INVALID");
  }
  const attempt = await request<AccountWalletLinkAttempt>(context, "/api/account/wallets/start", "account.wallets.start", { target_wallet: targetWallet });
  if (!validWalletLinkAttempt(attempt) || attempt.requested_by !== context.session.account.address.toString() ||
    attempt.target_wallet !== targetWallet || (context.accountId && attempt.account_id !== context.accountId)) {
    throw new AccountSessionChangedError();
  }
  return attempt;
}

export async function completeAccountWalletLink(context: AccountRequestContext, attempt: AccountWalletLinkAttempt) {
  if (!context.session || !validWalletLinkAttempt(attempt) || attempt.target_wallet !== context.session.account.address.toString()) {
    throw new Error("ACCOUNT_LINK_TARGET_INVALID");
  }
  const response = await profileRequest({ ...context, accountId: attempt.account_id }, "/api/account/wallets/complete", "account.wallets.complete", {
    token: attempt.token, account_id: attempt.account_id,
    requested_by: attempt.requested_by, target_wallet: attempt.target_wallet,
  });
  invalidateTransactionWalletPolicy();
  return response;
}

export async function cancelAccountWalletLink(context: AccountRequestContext, attempt: AccountWalletLinkAttempt) {
  if (!context.session) throw new Error("ACCOUNT_LINK_TARGET_INVALID");
  const actor = context.session.account.address.toString();
  if (!validWalletLinkAttempt(attempt) || (actor !== attempt.requested_by && actor !== attempt.target_wallet)) {
    throw new Error("ACCOUNT_LINK_TARGET_INVALID");
  }
  const response = await request<{ cancelled: boolean }>(context, "/api/account/wallets/cancel", "account.wallets.cancel", {
    token: attempt.token, account_id: attempt.account_id,
    requested_by: attempt.requested_by, target_wallet: attempt.target_wallet,
  });
  if (response?.cancelled !== true) throw new Error("Wallet link cancellation was not confirmed");
  return response;
}

export async function setAccountPrimaryWallet(context: AccountRequestContext, wallet: string) {
  const response = await profileRequest(context, "/api/account/wallets/primary", "account.wallets.primary", { wallet });
  invalidateTransactionWalletPolicy();
  return response;
}

export async function removeAccountWallet(context: AccountRequestContext, wallet: string) {
  const response = await profileRequest(context, "/api/account/wallets/remove", "account.wallets.remove", { wallet });
  invalidateTransactionWalletPolicy();
  return response;
}

/** Show useful next steps without reflecting provider messages or secrets. */
export function accountErrorMessage(error: unknown, fallback: string) {
  if (error instanceof AccountSessionChangedError || error instanceof MaintenanceModeError) return error.message;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message === "your linked account changed. reload your account and try again." ||
      message === "this wallet no longer has access to the selected account.") {
    return "Your linked account changed. Reload this page and open your account again.";
  }
  if (message.includes("account_message_signing_unavailable") || message.includes("does not support message signing")) {
    return "This wallet cannot sign messages. Connect a wallet that supports message signing to open your account.";
  }
  if (/reject|declin|user denied|user cancelled|user canceled/.test(message)) {
    return "The wallet signature was cancelled. Your changes were not submitted. You can try again when ready.";
  }
  if (/rate.limit|too many|please wait before requesting/.test(message)) {
    return "Please wait a little before trying again.";
  }
  if (message === "email verification is not available yet.") {
    return "Email verification is not available on this deployment yet.";
  }
  if (message === "account_link_target_invalid") return "Connect the exact wallet shown in this link request, or start a new request.";
  if (message === "account_id_required") return "Open your account again before making changes.";
  return fallback;
}

/** Signed in by email/Google: add the connected wallet (it signs, the cookie proves the account). */
export async function attachWalletToAccount(session: WalletSession, accountId: string): Promise<AccountResponse> {
  const response = await signedFetch<AccountResponse>(session, "/api/account/wallets/attach", "account.wallets.attach", { account_id: accountId });
  invalidateTransactionWalletPolicy();
  return response;
}
