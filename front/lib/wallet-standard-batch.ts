// Several transactions signed with ONE wallet prompt (design §3, D2).
//
// `@solana/client` signs one transaction per prompt: its session calls the
// Wallet Standard `solana:signTransaction` feature with a single input. The
// feature itself takes any number of inputs (`signTransaction(...inputs)`;
// wallet adapters map that to one `signAllTransactions` approval), so the
// distribution calls it directly on the wallet behind the connected session:
// the same wallet (connector id as the SDK derives it), the same account
// (address and public key), the build's chain. Ledger devices still confirm
// each transaction on the device. The verified client
// (lib/verified-solana-client prepareAndSendAll) runs every gate before this
// call, compares every returned message with the one it built, and falls
// back to one prompt per transaction whenever this throws
// BatchSigningUnsupportedError (no such feature or wallet, fewer outputs, an
// error that is not the user's refusal). A refusal is the user's answer and
// is rethrown as it is: nothing is sent.
import type { WalletSession } from "@solana/client";
import { getWallets } from "@wallet-standard/app";
import type { IdentifierString, Wallet, WalletAccount } from "@wallet-standard/base";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
  type SolanaTransactionVersion,
} from "@solana/wallet-standard-features";

/** The batch could not be signed in one prompt; the caller signs one transaction per prompt instead. */
export class BatchSigningUnsupportedError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`One-prompt signing is not available: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "BatchSigningUnsupportedError";
  }
}

// ── "Sign each transaction separately", remembered per wallet app + address ──
// A Ledger behind Phantom or Solflare confirms every transaction of a batch on
// the device, which can outlast the batch's one blockhash; one prompt per
// transaction gives each its own. Chosen by hand (or after a batch outlasted
// its blockhash) and kept in this browser, like lib/siws-signing's memory.

const SEPARATE_KEY = "manci:sign-separately:v1";
const SEPARATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The wallet app and address a choice applies to (lib/siws-signing signingTarget). */
export type SeparateSigningTarget = { connectorId: string; wallet: string };

function readSeparate(): Record<string, number> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SEPARATE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Whether this wallet app + address signs a distribution one transaction per prompt. */
export function signsSeparately(target: SeparateSigningTarget): boolean {
  const expires = readSeparate()[`${target.connectorId}|${target.wallet}`];
  return typeof expires === "number" && expires > Date.now();
}

/** Remember (30 days) or forget "sign each transaction separately" for this wallet app + address. */
export function rememberSignsSeparately(target: SeparateSigningTarget, on: boolean): void {
  const now = Date.now();
  const next = Object.fromEntries(Object.entries(readSeparate()).filter(([, expires]) => typeof expires === "number" && expires > now));
  const key = `${target.connectorId}|${target.wallet}`;
  if (on) next[key] = now + SEPARATE_TTL_MS;
  else delete next[key];
  try {
    window.localStorage.setItem(SEPARATE_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the choice applies to this page only */
  }
}

/** The connector id `@solana/client` derives for a Wallet Standard wallet (deriveConnectorId, 1.7.0). */
export function connectorIdOf(wallet: Pick<Wallet, "name">): string {
  return `wallet-standard:${wallet.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function sameKey(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The registered wallet and account behind `session`, or null. */
export function findSessionWallet(
  session: Pick<WalletSession, "account" | "connector">,
  wallets: readonly Wallet[],
): { wallet: Wallet; account: WalletAccount } | null {
  const address = session.account.address.toString();
  for (const wallet of wallets) {
    if (connectorIdOf(wallet) !== session.connector.id) continue;
    const account = wallet.accounts.find((a) => a.address === address && sameKey(a.publicKey, session.account.publicKey));
    if (account) return { wallet, account };
  }
  return null;
}

/** A wallet's "the user said no" (EIP-1193 4001, or the words wallets use). */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return true;
  const text = `${typeof e.name === "string" ? e.name : ""} ${typeof e.message === "string" ? e.message : ""}`;
  return /reject|denied|declined|cancel/i.test(text);
}

/**
 * Signs `transactions` (wire bytes, unsigned) with one call of the wallet's
 * `solana:signTransaction`. `assertCurrent` runs right before and right
 * after the prompt (the wallet, account and network must not have changed).
 * Returns one signed transaction per input, in order.
 */
export async function signTransactionsWithWallet(input: {
  session: Pick<WalletSession, "account" | "connector">;
  transactions: readonly Uint8Array[];
  version: SolanaTransactionVersion;
  chain: IdentifierString;
  assertCurrent: () => void;
  /** The registered wallets (getWallets().get() when omitted). */
  wallets?: readonly Wallet[];
}): Promise<Uint8Array[]> {
  const wallets = input.wallets ?? getWallets().get();
  const found = findSessionWallet(input.session, wallets);
  if (!found) throw new BatchSigningUnsupportedError("the connected wallet is not a registered Wallet Standard wallet");
  const feature = (found.wallet.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction];
  if (!feature || typeof feature.signTransaction !== "function") {
    throw new BatchSigningUnsupportedError("the wallet has no solana:signTransaction");
  }
  if (!feature.supportedTransactionVersions.includes(input.version)) {
    throw new BatchSigningUnsupportedError(`the wallet does not sign ${String(input.version)} transactions`);
  }
  if (!found.account.chains.includes(input.chain) && !found.wallet.chains.includes(input.chain)) {
    throw new BatchSigningUnsupportedError(`the wallet does not list ${input.chain}`);
  }
  input.assertCurrent();
  let outputs: readonly { signedTransaction: Uint8Array }[];
  try {
    outputs = await feature.signTransaction(
      ...input.transactions.map((transaction) => ({ account: found.account, chain: input.chain, transaction })),
    );
  } catch (err) {
    if (isUserRejection(err)) throw err;
    throw new BatchSigningUnsupportedError("the wallet could not sign them together", err);
  }
  input.assertCurrent();
  if (!Array.isArray(outputs) || outputs.length !== input.transactions.length) {
    throw new BatchSigningUnsupportedError(
      `the wallet returned ${Array.isArray(outputs) ? outputs.length : 0} of ${input.transactions.length} transactions`,
    );
  }
  return outputs.map((o) => Uint8Array.from(o.signedTransaction));
}
