import type { WalletSession } from "@solana/client";
import type { AccountResponse } from "@/lib/account";
import { signedFetch } from "@/lib/siws-client";

const SAFE_NEXT = /^\/(account|verify|apply|portfolio|marketplace|issuer)(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&_/-]*)?$/;

export function safeLoginNext(value: string | null): string {
  return value && SAFE_NEXT.test(value) ? value : "/account";
}

/** An explicit sign-in proves wallet ownership and opens/creates its profile.
 * Guard both sides of the wallet prompt so a changed actor never sends a
 * delayed signature. Session-only reads never fall back to a second prompt. */
export async function signInWithWallet(session: WalletSession, isCurrent: () => boolean): Promise<void> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Your wallet, account or network changed. Start sign-in again.");
  };
  assertCurrent();
  if (!session.signMessage) throw new Error("This wallet does not support message signing. Connect a wallet that does.");
  const signMessage = session.signMessage;
  const guardedSession: WalletSession = {
    ...session,
    signMessage: async (...args) => {
      assertCurrent();
      const signature = await signMessage.apply(session, args);
      assertCurrent();
      return signature;
    },
  };
  await signedFetch<AccountResponse>(guardedSession, "/api/account/me", "account.me", {}, { interactive: "session-only" });
  assertCurrent();
}
