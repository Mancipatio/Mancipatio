import type { WalletSession } from "@solana/client";
import { isAddress } from "@solana/kit";
import type { Network } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import { MaintenanceModeError } from "@/lib/maintenance";

export type TransactionWalletPolicy = {
  wallet: string;
  network: Network;
  account_id: string;
  primary_wallet: string;
};

let revision = 0;

/** Invalidate pending intents after a successful membership/primary change.
 * This is cancellation only: browser state never authorizes a transaction. */
export function invalidateTransactionWalletPolicy() { revision += 1; }
export function transactionWalletPolicyRevision() { return revision; }

export class TransactionWalletChangedError extends Error {
  constructor() {
    super("The wallet, account preference, or network changed. Review your transaction activity and prepare the transaction again.");
    this.name = "TransactionWalletChangedError";
  }
}

export class PrimaryWalletRequiredError extends Error {
  constructor() {
    super("Connect your primary wallet before sending a transaction, or change your primary wallet in Your account.");
    this.name = "PrimaryWalletRequiredError";
  }
}

/** Invoked on an explicit sign/send intent, never on render or account reads.
 * Every attempt asks the server; no persisted browser value grants authority. */
export async function requestTransactionWalletPolicy(
  session: WalletSession,
  network: Network,
  assertCurrent: () => void,
): Promise<TransactionWalletPolicy> {
  assertCurrent();
  const signMessage = session.signMessage;
  if (!signMessage) throw new Error("This wallet cannot verify your account. Connect a wallet that supports message signing.");
  const guardedSession: WalletSession = {
    ...session,
    async signMessage(message) {
      assertCurrent();
      const result = await signMessage.call(session, message);
      assertCurrent();
      return result;
    },
  };
  let response: unknown;
  try {
    response = await signedFetch(guardedSession, "/api/account/wallets/transaction", "account.wallets.transaction", {});
  } catch (error) {
    assertCurrent();
    if (error instanceof TransactionWalletChangedError || error instanceof MaintenanceModeError) throw error;
    throw new Error("We could not verify your primary transaction wallet. Approve the wallet verification and try again.");
  }
  assertCurrent();
  const policy = response as Partial<TransactionWalletPolicy> | null;
  if (!policy || policy.wallet !== session.account.address.toString() || policy.network !== network ||
      typeof policy.account_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.account_id) ||
      typeof policy.primary_wallet !== "string" || !isAddress(policy.primary_wallet)) {
    throw new Error("We could not verify your primary transaction wallet. Open Your account and try again.");
  }
  if (policy.primary_wallet !== session.account.address.toString()) throw new PrimaryWalletRequiredError();
  return policy as TransactionWalletPolicy;
}
