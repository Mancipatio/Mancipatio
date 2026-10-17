import type { WalletSession } from "@solana/client";
import { isAddress } from "@solana/kit";
import type { Network } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import { MaintenanceModeError } from "@/lib/maintenance";
import { emitSendStage } from "@/lib/send-stage";
import { OffchainMessageLimitError } from "@/lib/siws-offchain";
import { HardwareWalletSigningError } from "@/lib/siws-signing";

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

/**
 * The longest the account check waits for Manci's answer, counted only while
 * no wallet prompt is open: the sign-in message a browser without a live
 * 12 h session is asked for (lib/siws-client startSession) may take as long
 * as the user needs, a Ledger included. lib/siws-client's fetch carries no
 * signal, so the wait is bounded here; an answer that comes after it is
 * dropped (the route reads the account and ensures its profile row, which
 * is idempotent). A page's busy modal cannot be closed meanwhile, so an
 * unbounded request would hold "Working…" with no end.
 */
export const TRANSACTION_WALLET_POLICY_TIMEOUT_MS = 15_000;

/** Why the account check did not confirm the wallet. */
export type TransactionWalletPolicyFailure =
  /** The user declined the sign-in message. */
  | "rejected"
  /** Manci did not answer within TRANSACTION_WALLET_POLICY_TIMEOUT_MS outside the wallet's prompts. */
  | "timeout"
  /** No response at all (fetch's own TypeError). */
  | "no-answer"
  /** Manci answered with an error (a 5xx, a 401 after the retry, anything else). */
  | "server"
  /** Manci answered, but not with a policy for this wallet on this network. */
  | "misbound";

const COULD_NOT_VERIFY = "We could not verify your primary transaction wallet";

/**
 * One sentence per failure, in Manci's words: never the server's or the
 * wallet's own text, which can carry internal detail. Only a declined
 * sign-in message is the user's to fix by approving it; a server failure is
 * not, and says so.
 */
function failureText(reason: TransactionWalletPolicyFailure): string {
  switch (reason) {
    case "rejected":
      return `${COULD_NOT_VERIFY}. Approve the wallet verification and try again.`;
    case "timeout":
      return `${COULD_NOT_VERIFY}: Manci did not answer in time. Nothing was sent — try again.`;
    case "no-answer":
      return `${COULD_NOT_VERIFY}: Manci could not be reached. Nothing was sent — check your connection and try again.`;
    case "server":
      return `${COULD_NOT_VERIFY}: Manci could not confirm your account right now. Nothing was sent — try again.`;
    case "misbound":
      return `${COULD_NOT_VERIFY}. Open Your account and try again.`;
  }
}

/** The account check did not confirm the wallet: nothing was sent. `reason` says why. */
export class TransactionWalletPolicyError extends Error {
  constructor(readonly reason: TransactionWalletPolicyFailure) {
    super(failureText(reason));
    this.name = "TransactionWalletPolicyError";
  }
}

/** fetch()'s own rejections when no response came back (browsers and Node). */
const NO_ANSWER_RE = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i;

/** The user said no to the sign-in message: the standard 4001, or a wallet's own wording. */
function isUserRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (code === 4001 || code === "WALLET_REJECTED") return true;
  const text = [name, message].filter((part): part is string => typeof part === "string").join(" ");
  return /reject|declin|denied|cancel/i.test(text);
}

/**
 * The time a wallet prompt is open, kept out of the deadline: `outside` is
 * how long has passed since `started` with no prompt open.
 */
function promptClock() {
  let inPrompts = 0;
  let openedAt: number | null = null;
  return {
    open() {
      openedAt = Date.now();
    },
    close() {
      if (openedAt === null) return;
      inPrompts += Date.now() - openedAt;
      openedAt = null;
    },
    outside(started: number, now = Date.now()): number {
      return now - started - inPrompts - (openedAt === null ? 0 : now - openedAt);
    },
  };
}

/**
 * `work`, or a "timeout" failure once `ms` have passed outside the wallet's
 * prompts (`clock`). `work` goes on after the deadline; its outcome is then
 * dropped, never left unhandled.
 */
async function withinDeadline<T>(work: Promise<T>, ms: number, clock: ReturnType<typeof promptClock>): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const tick = () => {
      const remaining = ms - clock.outside(started);
      if (remaining <= 0) reject(new TransactionWalletPolicyError("timeout"));
      else timer = setTimeout(tick, Math.max(remaining, 250));
    };
    tick();
  });
  void work.then(() => undefined, () => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Invoked on an explicit sign/send intent, never on render or account reads.
 * Every attempt asks the server; no persisted browser value grants authority.
 * The verification is a SIWS signature (lib/siws-signing.ts): a Ledger behind
 * Phantom/Solflare signs it as a Solana off-chain message (a second prompt
 * only the first time a Ledger refuses raw bytes). The sign-in message, when
 * one is asked for, is announced on lib/send-stage (the site-wide notice says
 * it is a message, not a transaction), and the wait for Manci's answer is
 * bounded (TRANSACTION_WALLET_POLICY_TIMEOUT_MS) outside that prompt. A
 * failure is a TransactionWalletPolicyError in Manci's words, by its reason:
 * "Approve the wallet verification" only when the user declined the message. */
export async function requestTransactionWalletPolicy(
  session: WalletSession,
  network: Network,
  assertCurrent: () => void,
): Promise<TransactionWalletPolicy> {
  assertCurrent();
  const signMessage = session.signMessage;
  if (!signMessage) throw new Error("This wallet cannot verify your account. Connect a wallet that supports message signing.");
  const clock = promptClock();
  const guardedSession: WalletSession = {
    ...session,
    async signMessage(message) {
      assertCurrent();
      // The sign-in message (lib/siws-client startSession): announced, and its time not counted against the deadline.
      emitSendStage({ kind: "account", signIn: true });
      clock.open();
      try {
        const result = await signMessage.call(session, message);
        assertCurrent();
        return result;
      } finally {
        clock.close();
      }
    },
  };
  let response: unknown;
  try {
    response = await withinDeadline(
      signedFetch(guardedSession, "/api/account/wallets/transaction", "account.wallets.transaction", {}),
      TRANSACTION_WALLET_POLICY_TIMEOUT_MS,
      clock,
    );
  } catch (error) {
    assertCurrent();
    if (error instanceof TransactionWalletChangedError || error instanceof MaintenanceModeError ||
        error instanceof HardwareWalletSigningError || error instanceof OffchainMessageLimitError ||
        error instanceof TransactionWalletPolicyError) throw error;
    if (isUserRejection(error)) throw new TransactionWalletPolicyError("rejected");
    if (error instanceof TypeError && NO_ANSWER_RE.test(error.message)) throw new TransactionWalletPolicyError("no-answer");
    throw new TransactionWalletPolicyError("server");
  }
  assertCurrent();
  const policy = response as Partial<TransactionWalletPolicy> | null;
  if (!policy || policy.wallet !== session.account.address.toString() || policy.network !== network ||
      typeof policy.account_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.account_id) ||
      typeof policy.primary_wallet !== "string" || !isAddress(policy.primary_wallet)) {
    throw new TransactionWalletPolicyError("misbound");
  }
  if (policy.primary_wallet !== session.account.address.toString()) throw new PrimaryWalletRequiredError();
  return policy as TransactionWalletPolicy;
}
