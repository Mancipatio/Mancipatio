import type { WalletSession } from "@solana/client";
import type { AccountResponse } from "@/lib/account";
import { detectNetwork, type Network } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";

export type AccountRequestContext = {
  session: WalletSession;
  network: Network;
  isCurrent: () => boolean;
};

export class AccountSessionChangedError extends Error {
  constructor() {
    super("The connected wallet or network changed. Open your account again.");
    this.name = "AccountSessionChangedError";
  }
}

function assertCurrent(context: AccountRequestContext) {
  if (!context.isCurrent() || detectNetwork() !== context.network) {
    throw new AccountSessionChangedError();
  }
}

async function request<T>(
  context: AccountRequestContext,
  path: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  assertCurrent(context);
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
  if (
    response.profile.wallet !== context.session.account.address.toString() ||
    response.profile.network !== context.network
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

/** Show useful next steps without reflecting provider messages or secrets. */
export function accountErrorMessage(error: unknown, fallback: string) {
  if (error instanceof AccountSessionChangedError) return error.message;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
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
  return fallback;
}
