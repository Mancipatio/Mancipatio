import type {
  SolanaClient,
  TransactionPrepareAndSendRequest,
  TransactionPrepared,
  TransactionPrepareRequest,
  WalletSession,
} from "@solana/client";
import {
  compileTransaction,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork, type Network } from "@/lib/network";
import { features } from "@/lib/features";
import { guardTransactionGraph } from "@/lib/transaction-session-guard";
import { requestTransactionWalletPolicy, transactionWalletPolicyRevision, TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { assertSiteWritable } from "@/lib/maintenance";
import { priceForRequest, priorityFeeCap } from "@/lib/priority-fee";
import { MAX_COMPUTE_UNIT_LIMIT, TRANSACTION_SIZE_LIMIT, decodeComputeBudgetInstruction } from "@/lib/compute-budget";
import {
  clearWalletChange,
  judgeWalletRewrite,
  noteWalletChange,
  type ComputeBudgetBounds,
  type WalletRewriteRefusal,
} from "@/lib/wallet-changes";
import { walletChain } from "@/lib/wallet-chain";
import { BatchSigningUnsupportedError, signTransactionsWithWallet } from "@/lib/wallet-standard-batch";
import { assertInstructionsInScope, assertInstructionsNotPaused } from "@/lib/pause-gate";
import { assertGateAccountsUnset } from "@/lib/proceeds-gate";
import {
  computeUnitLimitFromSimulation,
  PROBE_LIFETIME,
  refusalFromSimulation,
  simulateMessage,
  SimulationUnavailableError,
  waitForSignatures,
  type SignatureOutcome,
  type SignatureWaitOptions,
  type SimulatableMessage,
  type SimulationVerdict,
} from "@/lib/simulation-gate";

/** One signed transaction of prepareAndSendAll, before it is broadcast. */
export type BatchSigned = { index: number; signature: string; lastValidBlockHeight: bigint };

/** What became of one transaction of prepareAndSendAll. */
export type BatchOutcome = {
  index: number;
  /** null when it was never signed. */
  signature: string | null;
  lastValidBlockHeight: bigint | null;
  /** The node accepted it (preflight passed); it still has to be confirmed. */
  sent: boolean;
  error: unknown;
};

/** What onSigned is told besides the signatures. */
export type BatchSignedInfo = {
  /**
   * How long the hook may take before the broadcast starts eating into the
   * BATCH_EXPIRY_MARGIN_BLOCKS the blockhash keeps for it (~MS_PER_BLOCK
   * each): the batch path counts it from the block height read after
   * signing, the per-transaction path estimates it from the time since its
   * blockhash was fetched (BLOCKHASH_LIFETIME_BLOCKS). 0 when there is none
   * to spare. A hook that awaits something it can also finish during the
   * broadcast (Send to wallets: the pending audit rows) waits no longer.
   */
  waitMs: number;
};

export type BatchSendOptions = {
  /**
   * Every transaction of the prompt, signed, BEFORE any of them is broadcast
   * (the caller's journal: signature and last valid block height). Throwing
   * stops the broadcast: nothing is sent; so does a wallet, RPC or network
   * change while it ran (assertCurrent after it).
   */
  onSigned: (signed: readonly BatchSigned[], info: BatchSignedInfo) => void | Promise<void>;
  /** "per-transaction": one prompt each from the start (after a refused batch, or by choice). */
  mode?: "auto" | "per-transaction";
  /** The wallet is about to be asked. */
  onPrompt?: (info: { mode: "batch" | "per-transaction"; index: number; count: number }) => void;
  /**
   * The one-prompt path was given up (`reason`, as BatchSendResult.fallbackReason
   * will say) and the transactions are about to be signed one by one: called
   * before the first of those prompts, so the caller can remember the choice
   * (remembersSignSeparately) even when that prompt then throws.
   */
  onFallback?: (reason: string) => void;
  /**
   * Transaction `index` of the per-transaction path was sent and is waited
   * for (at most SETTLE_TIMEOUT_MS) before the next one is signed: the wallet
   * is not being asked anything meanwhile.
   */
  onWaiting?: (info: { index: number; count: number }) => void;
  /**
   * The `count` transactions of this client's previous send (the last
   * minute: a distribution's previous group) are about to be waited for, at
   * most SETTLE_TIMEOUT_MS, before anything of this call is simulated or
   * signed. Not called when there is nothing to wait for.
   */
  onSettlingPrevious?: (info: { count: number }) => void;
  /**
   * Compute units added to each transaction's limit on top of 1.1 × what the
   * gate's simulation consumed (still at least 200,000, at most the 1.4M
   * ceiling): room for the guards a wallet adds after that simulation. Send
   * to wallets passes DISTRIBUTION_GUARD_HEADROOM_UNITS (lib/wallet-changes:
   * four guards; the priority fee is paid on the limit, so up to 28,000 ×
   * the price more per transaction: 2,800 lamports at the mainnet floor of
   * 100,000 µlamports per unit, 56,000 at its cap of 2,000,000). Only for a
   * limit this sender sets (a request without its own). Default 0: the
   * SDK's formula, as every other send.
   */
  computeUnitHeadroom?: number;
};

export type BatchSendResult = {
  outcomes: BatchOutcome[];
  /** Wallet prompts used for the transactions (the policy check adds none within a session). */
  prompts: number;
  mode: "batch" | "per-transaction";
  /** Why the one-prompt path was not used, or null. */
  fallbackReason: string | null;
};

export type BatchSender = {
  /**
   * Transactions none of which needs another's result, every gate of
   * prepareAndSend applied to EACH — network, maintenance, pilot scope and
   * pause, proceeds gate, priority fee, the simulation gate — then one
   * wallet-policy check, ONE wallet prompt for all of them (Wallet Standard
   * `solana:signTransaction` with N inputs, one shared blockhash), each
   * returned message compared with the one built (identical, or the same
   * transaction with only Lighthouse assertions added — Phantom on mainnet —
   * and/or the wallet's own compute budget within bounds: price up to the
   * network's cap, limit no lower than the simulation consumed;
   * lib/wallet-changes judgeWalletRewrite), the caller's journal written
   * with the wallet's own signatures, and every transaction sent right away
   * with preflight. Falls back to one prompt per transaction when the wallet
   * cannot sign them together (no feature, fewer outputs, a message changed
   * beyond that, any error but the user's refusal), when signing outlasted
   * the shared blockhash (BATCH_EXPIRY_MARGIN_BLOCKS), or when the wallet
   * added guards to any of several (WALLET_STATE_GUARDS: each holds only
   * against the state before the others land); a refusal stops everything.
   * One by one, each transaction is signed only once the previous one is
   * confirmed (the wallet simulates, and guards, against the state it
   * left), is compared with the one built the same way, and one changed
   * beyond that is refused (SignedTransactionChangedError), never sent.
   * The call itself starts only once every transaction this client sent in
   * the last minute (the previous group) is confirmed: one that failed or is
   * not confirmed within SETTLE_TIMEOUT_MS throws
   * EarlierTransactionUnconfirmedError before anything is simulated or
   * signed. Status reads the RPC refuses for a moment are retried within
   * that wait (lib/rpc-retry).
   *
   * Single sends (prepareAndSend) have no such comparison: `@solana/client`
   * broadcasts whatever message the wallet returns (the guarded session only
   * notes the change). A distribution journals each signature before the
   * broadcast and resumes from it, so it accepts no change but those two.
   */
  prepareAndSendAll(requests: readonly TransactionPrepareAndSendRequest[], options: BatchSendOptions): Promise<BatchSendResult>;
};

const batchSenders = new WeakMap<object, BatchSender>();

/** The batch sender of a client made by withVerifiedTransactions (the app's), or null. */
export function getBatchSender(client: SolanaClient): BatchSender | null {
  return batchSenders.get(client) ?? null;
}

/**
 * A transaction signed on its own (prepareAndSendAll's per-transaction path)
 * that is not the one built, beyond what lib/wallet-changes
 * judgeWalletRewrite accepts (Lighthouse assertions, a compute budget within
 * bounds): it is never journalled or broadcast. The journal's expiry height
 * belongs to the blockhash Manci built with; a wallet that swapped the
 * blockhash (or added an instruction that moves anything) would make the
 * resume declare the transaction expired while it can still land, and its
 * rows would be sent twice. The advice follows what was refused (`about`):
 * only a priority fee or limit out of bounds is a wallet setting.
 */
export class SignedTransactionChangedError extends Error {
  constructor(
    readonly change: string,
    readonly about: WalletRewriteRefusal = "transaction",
  ) {
    // The run needs the same account (checkAuthority): "another wallet" is another wallet app holding it.
    const advice =
      about === "compute-budget"
        ? "A wallet may set its own priority fee up to Manci's cap and a compute limit no lower than the transaction needs. Turn off the wallet's custom priority fee or use another wallet app that holds this same account, then open this page again to continue the run (rows already sent are not sent again)."
        : about === "guards"
          ? "Manci accepts the wallet's own safety checks (Lighthouse assertions, as Phantom adds) only when it can verify them and they fit in the transaction. Open this page again to continue the run (rows already sent are not sent again) with another wallet app that holds this same account, or send the remaining recipients one at a time with “Send to holder” on the share-class screen instead."
          : "A wallet may only add its own safety checks (Lighthouse assertions, as Phantom does) and set its priority fee within Manci's cap. Use another wallet app that holds this same account and open this page again to continue the run (rows already sent are not sent again), or send the remaining recipients one at a time with “Send to holder” on the share-class screen instead.";
    super(
      `${change.charAt(0).toUpperCase()}${change.slice(1)}, so it was not sent. A distribution sends only the transactions Manci built and saved, so that nothing is ever sent twice. ${advice}`,
    );
    this.name = "SignedTransactionChangedError";
  }
}

/** A signed copy that may not be journalled or broadcast; `change` says why, `about` what kind of change. */
class SignedCopyRefused extends Error {
  constructor(
    readonly change: string,
    readonly about: WalletRewriteRefusal,
  ) {
    super(change);
  }
}

/**
 * One signed copy checked against what was built: the same message, or the
 * same transaction with only Lighthouse assertions added and/or its compute
 * budget rewritten within `bounds` (judgeWalletRewrite: price at most the
 * network's cap, limit at least what the simulation consumed plus room for
 * the guards; the change is noted either way), no larger than the network's
 * packet (TRANSACTION_SIZE_LIMIT: one larger would be journalled and never
 * land), and a 64-byte signature for every signer the message names.
 * Returns the wallet's copy, whose signature is the one journalled and
 * broadcast, and how many guards the wallet added. Throws SignedCopyRefused.
 */
function checkSigned(original: Transaction, signed: Transaction, label: string, bounds: ComputeBudgetBounds): { tx: Transaction; guards: number } {
  const verdict = judgeWalletRewrite(original.messageBytes, signed.messageBytes, bounds);
  if (verdict.kind === "refused") {
    noteWalletChange(verdict.change);
    throw new SignedCopyRefused(`${verdict.change} (${label})`, verdict.about);
  }
  if (verdict.kind === "accepted") {
    noteWalletChange(verdict.change);
    console.info(`[wallet] ${verdict.change} (${label}): accepted`);
  }
  const guards = verdict.kind === "accepted" ? verdict.guards : 0;
  const size = getTransactionEncoder().encode(signed).length;
  if (size > TRANSACTION_SIZE_LIMIT) {
    throw new SignedCopyRefused(
      `${label} came back at ${size} bytes, over the network's ${TRANSACTION_SIZE_LIMIT}-byte packet limit${guards > 0 ? ` with the ${guards} Lighthouse instructions the wallet added` : ""}`,
      guards > 0 ? "guards" : "transaction",
    );
  }
  for (const signer of Object.keys(original.signatures)) {
    const signature = signed.signatures[signer as keyof typeof signed.signatures];
    if (!signature || signature.length !== 64) {
      throw new SignedCopyRefused(`the wallet returned ${label} without its signature`, "transaction");
    }
  }
  return { tx: signed, guards };
}

/**
 * The fallback reason (in BatchSendResult.fallbackReason) when the wallet
 * added guards (Lighthouse assertions) to any transaction of a batch of
 * several. A guard holds only against the state the wallet simulated when
 * it signed: Phantom's floor on the fee payer's balance leaves about 0.005
 * SOL plus 10 % of the transaction's own rent, and another transaction of
 * the batch that creates 4 token accounts or more spends more than that, so
 * whichever lands later fails (its fee spent, nothing moved). Nothing is
 * journalled or sent then: the transactions are signed one by one, each
 * once the previous one is confirmed. A batch of one keeps its guards.
 */
export const WALLET_STATE_GUARDS = "the wallet added safety checks that hold only while none of the other transactions has landed";

/**
 * The wallet's signed copies checked against what was built (checkSigned,
 * one `bounds` per transaction): a wallet that changed anything else — a
 * blockhash, an instruction, an account — or set its price above the cap or
 * its limit below the need, or a copy over the packet limit, makes the batch
 * fall back (BatchSigningUnsupportedError), the change noted; so does a
 * guard on any of several (WALLET_STATE_GUARDS), the full packs of a
 * distribution included, which have no room for one while a partly filled
 * one does. The network verifies the signatures themselves at preflight.
 */
export function verifySignedBatch(
  built: readonly Transaction[],
  signedBytes: readonly Uint8Array[],
  bounds: readonly ComputeBudgetBounds[],
): Transaction[] {
  const decoder = getTransactionDecoder();
  let guarded = false;
  const copies = built.map((original, i) => {
    let signed: Transaction;
    try {
      signed = decoder.decode(signedBytes[i]);
    } catch (cause) {
      throw new BatchSigningUnsupportedError(`transaction ${i + 1} came back unreadable`, cause);
    }
    try {
      const checked = checkSigned(original, signed, `transaction ${i + 1}`, bounds[i]);
      if (checked.guards > 0) guarded = true;
      return checked.tx;
    } catch (err) {
      if (err instanceof SignedCopyRefused) throw new BatchSigningUnsupportedError(err.change);
      throw err;
    }
  });
  if (copies.length > 1 && guarded) throw new BatchSigningUnsupportedError(WALLET_STATE_GUARDS);
  return copies;
}

/**
 * The same check for one transaction signed on its own, where nothing is
 * left to fall back to: a refused copy throws SignedTransactionChangedError.
 */
export function verifySignedTransaction(
  original: Transaction,
  signed: Transaction,
  label: string,
  bounds: ComputeBudgetBounds,
): Transaction {
  try {
    return checkSigned(original, signed, label, bounds).tx;
  } catch (err) {
    if (err instanceof SignedCopyRefused) throw new SignedTransactionChangedError(err.change, err.about);
    throw err;
  }
}

/**
 * prepareAndSendAll's per-transaction path signs a transaction only once
 * the one sent before it is confirmed: the wallet simulates a transaction
 * when it is asked to sign it, and Phantom guards the fee payer's balance as
 * that simulation saw it. One that failed on the network, or is not
 * confirmed within SETTLE_TIMEOUT_MS, stops the run there: the rest are not
 * signed (their outcomes carry this error) and the resume decides.
 *
 * The same holds across calls (a distribution's next group of transactions):
 * prepareAndSendAll first waits for every transaction this client sent in
 * the last minute (settlePreviousSend), and one of them failed or not
 * confirmed stops it before anything is simulated or signed (`position`
 * null: thrown, nothing of this call was sent). That send is the client's
 * last, whichever page made it; the message says only what happened, and
 * the caller adds how to go on (Send to wallets catches it, reports the
 * groups already sent and points to its resume).
 */
export class EarlierTransactionUnconfirmedError extends Error {
  constructor(
    /** "i of n" within this call, or null: a transaction of an earlier call (nothing of this one was signed). */
    readonly position: string | null,
    readonly outcome: Exclude<SignatureOutcome, "confirmed">,
  ) {
    super(
      // An earlier call's: the caller says how to go on (a distribution: its resume).
      position === null
        ? outcome === "failed"
          ? "A transaction sent just before these failed on the network (nothing of it moved), so these were not signed."
          : "A transaction sent just before these is not confirmed yet, so these were not signed."
        : outcome === "failed"
          ? `Transaction ${position} failed on the network (nothing of it moved), so the ones after it were not signed.`
          : `Transaction ${position} is not confirmed yet, so the ones after it were not signed.`,
    );
    this.name = "EarlierTransactionUnconfirmedError";
  }
}

/**
 * Blocks before the shared blockhash's last valid block height that a batch
 * must still have when the wallet hands it back: broadcasting up to 8
 * transactions and landing them takes a few seconds (~0.4 s per block). A
 * Ledger confirming each transaction on the device can take longer than the
 * blockhash lives; the batch then falls back to one prompt per transaction
 * with a fresh blockhash each, before anything is journalled or sent. The
 * caller's onSigned is told how long it may take without eating into this
 * margin (BatchSignedInfo.waitMs), on either path.
 */
export const BATCH_EXPIRY_MARGIN_BLOCKS = BigInt(30);
/** About how long one block takes (~400 ms slots): for the onSigned estimates only, never a check. */
export const MS_PER_BLOCK = 400;
/** Blocks a blockhash stays valid for once fetched (its lastValidBlockHeight − the block height then). */
export const BLOCKHASH_LIFETIME_BLOCKS = 150;

/** The fallback reason (in BatchSendResult.fallbackReason) when signing outlasted the shared blockhash. */
export const SIGNING_TOO_SLOW = "signing took too long: the transactions would expire before they land";

/**
 * Whether a batch's fallback is remembered for the wallet app and address
 * ("Sign each transaction separately", lib/wallet-standard-batch): the ones
 * every later batch would repeat — signing too slow for the shared
 * blockhash (a Ledger) or guards on each transaction (Phantom on mainnet) —
 * so the wallet is not asked for a batch it cannot use.
 */
export function remembersSignSeparately(fallbackReason: string | null): boolean {
  return fallbackReason !== null && (fallbackReason.includes(SIGNING_TOO_SLOW) || fallbackReason.includes(WALLET_STATE_GUARDS));
}

/** The transaction id: the fee payer's (first) signature, base58. */
export function transactionId(tx: Transaction): string {
  const first = Object.values(tx.signatures)[0];
  if (!first) throw new Error("The transaction is not signed.");
  return getBase58Decoder().decode(first);
}

/** A send this client made less than this long ago is waited for before the next one is simulated. */
export const SETTLE_WINDOW_MS = 60_000;
/** The longest the next send waits for the previous one to be confirmed. */
export const SETTLE_TIMEOUT_MS = 30_000;
/**
 * How a send is waited for: at most SETTLE_TIMEOUT_MS in all, a status read
 * the RPC refused for a moment (HTTP 429, a 5xx, no response) retried within
 * that time (lib/rpc-retry) instead of ending the wait as "unknown" — one
 * refused read no longer stops a per-transaction run. A wallet, RPC or
 * network change (assertCurrent) ends it at the next read instead of after
 * the whole timeout; the caller's assertCurrent then throws.
 */
function settleWait(context: { assertCurrent: () => void }): SignatureWaitOptions {
  return {
    timeoutMs: SETTLE_TIMEOUT_MS,
    retryReads: true,
    isCancelled: () => {
      try {
        context.assertCurrent();
        return false;
      } catch {
        return true;
      }
    },
  };
}

/** Both useSendTransaction and useTransactionPool use these public helpers.
 * Check the live runtime RPC before preparing, signing or sending, including
 * wallet sign-and-send and caller-supplied blockhashes. Prepared transactions
 * must originate here so they retain exact session/RPC provenance.
 * Explicit issuer recovery collects its required authorities separately and
 * does not use this default-primary flow; linked profiles confer no roles.
 * Maintenance mode is read (at most a few seconds old) before preparing and
 * before any wallet prompt, so no transaction is offered while the site is
 * paused; the server's refusal of the policy check backs it up. The
 * program's emergency pause is read the same way (lib/pause-gate.ts, a few
 * seconds old at most, fail-open): an instruction a set bit holds back is
 * refused with a readable PausedFlowError before the wallet opens, and an
 * entry of a switched-off pilot-scope module (lib/features.ts) with a
 * ModuleDisabledFlowError (no chain read; its entries have no server route
 * that could refuse them).
 * This is the one place a wallet send gets its priority fee: prepare and
 * prepareAndSend set `computeUnitPrice` from lib/priority-fee (clamped to the
 * network's cap) before any wallet prompt, and `@solana/client` prepends the
 * one SetComputeUnitPrice. A caller-set price is refused, and a transaction
 * that would no longer fit the packet limit is sent without one.
 * prepareAndSend also puts the SetComputeUnitLimit in FRONT (see
 * withLeadingComputeUnitLimit), where a wallet looks for it.
 * Simulation gate (lib/simulation-gate.ts): every send and every prepared
 * transaction is simulated exactly as it will be signed (sigVerify off, the
 * node's blockhash) BEFORE the wallet-policy prompt and the wallet; one that
 * would fail is refused with a SimulationRefusedError naming the step, the
 * program and the error in plain words, and an RPC that cannot answer fails
 * closed (SimulationUnavailableError). The same simulation sets the compute
 * unit limit, so a send still makes one simulateTransaction call. A send
 * made by this client in the last minute is first waited for (at most 30 s),
 * so back-to-back dependent sends (lib/issuer-authority sendBatches) are
 * simulated against the state the earlier one created.
 * Not covered, on purpose: the co-signed envelopes (issuer recovery, KYC
 * registry creation) are signed outside this client by two keys over a fixed
 * message (fixed blockhash and compute budget), run their own live checks
 * before each signature and are sent with RPC preflight; see
 * signIssuerRecovery / signKycRegistryCreation. The app has no durable-nonce
 * transactions. */
export function withVerifiedTransactions(
  client: SolanaClient,
  network: Network,
): SolanaClient {
  const verifiers = new WeakMap<
    SolanaClient["runtime"]["rpc"],
    ReturnType<typeof createNetworkVerifier>
  >();
  type Context = {
    session: WalletSession;
    rpc: SolanaClient["runtime"]["rpc"];
    assertCurrent: () => void;
  };
  const preparedContexts = new WeakMap<TransactionPrepared, Context>();
  const base = client.transaction;

  function capture(): Context {
    const current = client.store.getState().wallet;
    if (current.status !== "connected") throw new Error("Connect your primary wallet before sending a transaction.");
    const session = current.session;
    const rpc = client.runtime.rpc;
    const revision = transactionWalletPolicyRevision();
    function assertCurrent() {
      const wallet = client.store.getState().wallet;
      if (wallet.status !== "connected" || wallet.session !== session || client.runtime.rpc !== rpc ||
          transactionWalletPolicyRevision() !== revision || detectNetwork() !== network) throw new TransactionWalletChangedError();
    }
    assertCurrent();
    return { session, rpc, assertCurrent };
  }

  async function assertNetwork(context: Context) {
    context.assertCurrent();
    const { rpc } = context;
    let verify = verifiers.get(rpc);
    if (!verify) {
      verify = createNetworkVerifier(rpc, network);
      verifiers.set(rpc, verify);
    }
    await verify();
    context.assertCurrent();
  }

  function checkAuthority(input: TransactionPrepareRequest | TransactionPrepared, context: Context) {
    const expected = context.session.account.address.toString();
    const authority = "authority" in input ? input.authority : undefined;
    if (authority && "account" in authority && authority !== context.session) throw new TransactionWalletChangedError();
    const authorityAddress = authority && ("account" in authority ? authority.account.address : authority.address);
    const feePayer = typeof input.feePayer === "object" ? input.feePayer.address : input.feePayer;
    if ((authorityAddress && authorityAddress.toString() !== expected) || (feePayer ?? authorityAddress)?.toString() !== expected ||
        ("message" in input && input.message.feePayer.address.toString() !== expected)) {
      throw new Error("This transaction was prepared for another wallet. Connect your primary wallet and prepare it again.");
    }
  }

  /** The app-set priority fee, resolved against the captured session; no wallet prompt. */
  async function withFee<R extends TransactionPrepareRequest>(request: R, context: Context): Promise<R> {
    const price = await priceForRequest(network, context.session.account.address, request);
    context.assertCurrent();
    return price === undefined ? request : { ...request, computeUnitPrice: price };
  }

  /**
   * prepareAndSend only. The SDK appends the SetComputeUnitLimit it estimates
   * at the END of the message, so the wallet sees [price, ...app, limit]; a
   * wallet that finds no compute budget where it looks may add its own
   * (Phantom documents that it does), which the network would refuse before
   * execution. Without a limit from the caller the request instead carries a
   * placeholder limit (the 1.4M ceiling, so the simulation itself cannot run
   * out) that the SDK places first: the gate simulates [limit, price, ...app]
   * once and replaces the placeholder with the estimate from that same
   * simulation (withSimulatedComputeUnitLimit), so the wallet gets
   * [limit, price, ...app] (or [limit, ...app] when the price was left off
   * for size; the bytes are the same either way), as the co-signed envelopes
   * build it. `prepareTransaction: false` and a caller-set limit are left as
   * they are. prepare() gets no placeholder (nothing in the app uses it).
   * Accepted cost: the gate's simulation carries the placeholder's priority
   * fee (1.4M × price: at most 0.00014 SOL on devnet and 0.0028 SOL at the
   * mainnet cap); a payer below that is refused before the wallet opens with
   * the InsufficientFundsForFee wording (the SDK used to fall back to its 200k
   * floor and open the wallet anyway).
   */
  function withLeadingComputeUnitLimit(request: TransactionPrepareAndSendRequest): { request: TransactionPrepareAndSendRequest; placeholder: boolean } {
    if (
      request.computeUnitLimit !== undefined ||
      request.prepareTransaction === false ||
      request.instructions.some((ix) => decodeComputeBudgetInstruction(ix)?.kind === "limit")
    ) {
      return { request, placeholder: false };
    }
    return {
      request: {
        ...request,
        computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT,
        prepareTransaction: { ...request.prepareTransaction, computeUnitLimitReset: true },
      },
      placeholder: true,
    };
  }

  /**
   * The placeholder replaced by the gate's own estimate, with the SDK told
   * not to estimate again: it keeps the limit in place and, with the message's
   * lifetime already set, fetches no second blockhash. One simulation and one
   * getLatestBlockhash per send, as before the gate.
   */
  function withSimulatedComputeUnitLimit(
    request: TransactionPrepareAndSendRequest,
    verdict: SimulationVerdict,
    headroom = 0,
  ): TransactionPrepareAndSendRequest {
    const overrides = request.prepareTransaction === false ? {} : (request.prepareTransaction ?? {});
    return {
      ...request,
      computeUnitLimit: computeUnitLimitFromSimulation(verdict.unitsConsumed, overrides.computeUnitLimitMultiplier, headroom),
      prepareTransaction: { ...overrides, computeUnitLimitReset: false },
    };
  }

  async function writable(context: Context) {
    await assertSiteWritable();
    context.assertCurrent();
  }

  async function requestPolicy(context: Context) {
    await requestTransactionWalletPolicy(context.session, network, context.assertCurrent);
    context.assertCurrent();
  }

  // The last send this client made (every transaction of it not yet known
  // to be confirmed: a batch's all, the per-transaction path's last one), so
  // the next one can wait for it.
  let lastSend: { rpc: Context["rpc"]; signatures: readonly string[]; at: number } | null = null;

  function rememberSend(context: Context, sent: unknown) {
    const signatures = (Array.isArray(sent) ? sent : [sent]).filter((s): s is string => typeof s === "string" && s.length > 0);
    if (signatures.length > 0) lastSend = { rpc: context.rpc, signatures, at: Date.now() };
  }

  /**
   * sendBatches and any other flow that sends twice in a row: `prepareAndSend`
   * returns once the transaction is submitted, not confirmed, and the next
   * transaction's simulation would otherwise run against the state before it
   * (before the gate, the second wallet review hid this). Waits until every
   * transaction of the previous send of the last minute is confirmed or
   * failed (one status read for all of them per poll, a refused read
   * retried), at most 30 s. Returns how the previous send ended: null when
   * there was nothing to wait for or all of it is confirmed, else the worst
   * outcome ("failed" first), for prepareAndSendAll to act on; a single send
   * lets the simulation decide. A send not decided yet (timeout, unreadable)
   * is kept, so the next send waits for it again (within SETTLE_WINDOW_MS).
   */
  async function settlePreviousSend(
    context: Context,
    onWait?: (info: { count: number }) => void,
  ): Promise<Exclude<SignatureOutcome, "confirmed"> | null> {
    const previous = lastSend;
    if (!previous || previous.rpc !== context.rpc || Date.now() - previous.at > SETTLE_WINDOW_MS) return null;
    onWait?.({ count: previous.signatures.length });
    const outcomes = await waitForSignatures(context.rpc, previous.signatures, settleWait(context));
    context.assertCurrent();
    if (lastSend === previous && outcomes.every((o) => o === "confirmed" || o === "failed")) lastSend = null;
    const open = outcomes.filter((o): o is Exclude<SignatureOutcome, "confirmed"> => o !== "confirmed");
    return open.find((o) => o === "failed") ?? open[0] ?? null;
  }

  /**
   * The gate: one simulation of `message` (exactly what the wallet will be
   * asked to sign, apart from the blockhash the node supplies). A failing
   * transaction is refused here, before the policy prompt and the wallet; an
   * RPC that cannot answer fails closed.
   */
  async function gate(message: SimulatableMessage, appInstructions: TransactionPrepared["instructions"], context: Context) {
    let verdict: SimulationVerdict;
    try {
      verdict = await simulateMessage(context.rpc, message);
    } catch (cause) {
      context.assertCurrent();
      throw new SimulationUnavailableError(network, cause);
    }
    context.assertCurrent();
    if (verdict.err !== null) {
      throw refusalFromSimulation(verdict, {
        appInstructions,
        messageInstructionCount: message.instructions.length,
        network,
        // A sale's Unauthorized points at the sale sync only while that UI is on.
        issuerRotation: features(network).issuerRotation,
      }) ?? new SimulationUnavailableError(network, verdict.err);
    }
    return verdict;
  }

  /** The request prepared with a probe lifetime (no blockhash round trip) and gated. */
  async function gateRequest(request: TransactionPrepareAndSendRequest, context: Context) {
    const { prepareTransaction: _ignored, ...rest } = request;
    void _ignored;
    const probe = await base.prepare(
      guardTransactionGraph({ ...rest, lifetime: rest.lifetime ?? PROBE_LIFETIME }, context.session, context.assertCurrent),
    );
    context.assertCurrent();
    return gate(probe.message as SimulatableMessage, request.instructions, context);
  }

  async function forPrepared(prepared: TransactionPrepared, options: { sends?: boolean } = {}) {
    const context = preparedContexts.get(prepared) ?? capture();
    await assertNetwork(context);
    if (!preparedContexts.has(prepared)) throw new TransactionWalletChangedError();
    checkAuthority(prepared, context);
    await writable(context);
    if (options.sends) await settlePreviousSend(context);
    await gate(prepared.message as SimulatableMessage, prepared.instructions, context);
    await requestPolicy(context);
    return context;
  }
  const transaction: SolanaClient["transaction"] = Object.freeze({
    prepare: async (input) => {
      const context = capture();
      await assertSiteWritable();
      await assertNetwork(context);
      checkAuthority(input, context);
      assertInstructionsInScope(input.instructions, network);
      await assertInstructionsNotPaused(context.rpc, input.instructions);
      // v1: a frozen issuer or a blocklisted party, as the program would refuse it (lib/proceeds-gate.ts).
      await assertGateAccountsUnset(context.rpc, input.instructions);
      context.assertCurrent();
      const request = await withFee(input, context);
      // Preparation does not prompt for a message signature. The server policy
      // is read only when sign/send/toWire is explicitly requested.
      const prepared = await base.prepare(guardTransactionGraph(request, context.session, context.assertCurrent));
      context.assertCurrent();
      checkAuthority(prepared, context);
      const guarded = guardTransactionGraph(prepared, context.session, context.assertCurrent);
      preparedContexts.set(guarded, context);
      return guarded;
    },
    sign: async (prepared, options) => {
      const context = await forPrepared(prepared);
      const result = await base.sign(prepared, options);
      context.assertCurrent();
      return result;
    },
    toWire: async (prepared, options) => {
      const context = await forPrepared(prepared);
      const result = await base.toWire(prepared, options);
      context.assertCurrent();
      return result;
    },
    send: async (prepared, options) => {
      const context = await forPrepared(prepared, { sends: true });
      const result = await base.send(prepared, options);
      rememberSend(context, result);
      context.assertCurrent();
      return result;
    },
    prepareAndSend: async (input, options) => {
      // A note about an earlier signing never explains this send (lib/wallet-changes).
      clearWalletChange();
      const context = capture();
      await assertNetwork(context);
      checkAuthority(input, context);
      // The pilot scope and the emergency pause, before any wallet prompt (lib/pause-gate.ts).
      assertInstructionsInScope(input.instructions, network);
      await assertInstructionsNotPaused(context.rpc, input.instructions);
      await assertGateAccountsUnset(context.rpc, input.instructions);
      context.assertCurrent();
      // The fee is settled before the policy check's wallet prompt.
      const { request, placeholder } = withLeadingComputeUnitLimit(await withFee(input, context));
      // Maintenance first: nothing is simulated or offered while the site is paused.
      await writable(context);
      await settlePreviousSend(context);
      // The simulation gate, before the policy prompt and the wallet.
      const verdict = await gateRequest(request, context);
      const tuned = placeholder ? withSimulatedComputeUnitLimit(request, verdict) : request;
      await requestPolicy(context);
      const result = await base.prepareAndSend(guardTransactionGraph(tuned, context.session, context.assertCurrent), options);
      rememberSend(context, result);
      clearWalletChange();
      context.assertCurrent();
      return result;
    },
  });

  async function broadcast(context: Context, tx: Transaction) {
    await context.rpc
      .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed", skipPreflight: false })
      .send();
  }

  async function prepareAndSendAll(
    requests: readonly TransactionPrepareAndSendRequest[],
    options: BatchSendOptions,
  ): Promise<BatchSendResult> {
    if (requests.length === 0) return { outcomes: [], prompts: 0, mode: "batch", fallbackReason: null };
    const headroom = options.computeUnitHeadroom ?? 0;
    if (!Number.isSafeInteger(headroom) || headroom < 0 || headroom > MAX_COMPUTE_UNIT_LIMIT) {
      throw new Error(`The compute unit headroom must be an integer between 0 and ${MAX_COMPUTE_UNIT_LIMIT}`);
    }
    clearWalletChange();
    const context = capture();
    await assertNetwork(context);
    // Every gate of prepareAndSend, for each transaction, before any prompt.
    const gated: { request: TransactionPrepareAndSendRequest; placeholder: boolean }[] = [];
    for (const input of requests) {
      checkAuthority(input, context);
      assertInstructionsInScope(input.instructions, network);
      await assertInstructionsNotPaused(context.rpc, input.instructions);
      await assertGateAccountsUnset(context.rpc, input.instructions);
      context.assertCurrent();
      gated.push(withLeadingComputeUnitLimit(await withFee(input, context)));
    }
    await writable(context);
    // Once, before the batch (the treasury mint, or the previous group of a
    // distribution, before it). Not between a batch's own sends: they are
    // pre-signed, each was simulated on its own, and none carries a wallet
    // guard (a guarded batch falls back, WALLET_STATE_GUARDS). One by one,
    // each waits for the one before it. Every transaction of the previous send
    // is waited for, and its outcome counts as it does between this call's own
    // one-by-one prompts: one that failed or is not confirmed stops this call
    // before anything is simulated or signed (a wallet would guard against a
    // state that is about to change; the resume decides).
    const previous = await settlePreviousSend(context, options.onSettlingPrevious);
    if (previous !== null) throw new EarlierTransactionUnconfirmedError(null, previous);
    const tuned: TransactionPrepareRequest[] = [];
    // What a wallet may do to each one's compute budget if it sets its own (a
    // price up to the network's cap, a limit no lower than the units the
    // gate's simulation consumed, plus room for any Lighthouse guards it adds;
    // Phantom on mainnet keeps Manci's and adds guards).
    const bounds: ComputeBudgetBounds[] = [];
    const maxComputeUnitPrice = priorityFeeCap(network);
    for (const { request, placeholder } of gated) {
      const verdict = await gateRequest(request, context);
      const { prepareTransaction: _prepared, ...rest } = placeholder ? withSimulatedComputeUnitLimit(request, verdict, headroom) : request;
      void _prepared;
      tuned.push(rest);
      bounds.push({ maxComputeUnitPrice, minComputeUnitLimit: verdict.unitsConsumed || null });
    }
    await requestPolicy(context);

    const outcomes: BatchOutcome[] = requests.map((_, index) => ({
      index,
      signature: null,
      lastValidBlockHeight: null,
      sent: false,
      error: null,
    }));
    let fallbackReason: string | null = null;
    let lastSent: string | null = null;

    if (options.mode !== "per-transaction") {
      // One blockhash for all of them: they are signed together and sent at once.
      const lifetime = (await context.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      context.assertCurrent();
      const prepared: TransactionPrepared[] = [];
      for (const request of tuned) {
        const p = await base.prepare(guardTransactionGraph({ ...request, lifetime }, context.session, context.assertCurrent));
        context.assertCurrent();
        checkAuthority(p, context);
        prepared.push(p);
      }
      const built = prepared.map((p) => compileTransaction(p.message));
      try {
        options.onPrompt?.({ mode: "batch", index: 0, count: built.length });
        const signedBytes = await signTransactionsWithWallet({
          session: context.session,
          transactions: built.map((t) => Uint8Array.from(getTransactionEncoder().encode(t))),
          version: prepared[0].version,
          chain: walletChain(network),
          assertCurrent: context.assertCurrent,
        });
        // The wallet's copies (a compute budget within bounds accepted, and
        // Lighthouse guards on a batch of one): their signatures are
        // journalled and broadcast.
        const signed = verifySignedBatch(built, signedBytes, bounds);
        // Signing N transactions can outlast the one blockhash (a Ledger confirms
        // each on the device): nothing is journalled or sent then, and the batch
        // falls back to fresh-blockhash signing one by one.
        const height = BigInt(await context.rpc.getBlockHeight({ commitment: "confirmed" }).send());
        context.assertCurrent();
        if (height + BATCH_EXPIRY_MARGIN_BLOCKS >= lifetime.lastValidBlockHeight) {
          throw new BatchSigningUnsupportedError(SIGNING_TOO_SLOW);
        }
        const journal = signed.map((tx, index) => ({
          index,
          signature: transactionId(tx),
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        }));
        // Journal first: the signatures are known before the network can see them. The hook may
        // take the blocks above the margin (the pending audit rows), never the margin itself.
        await options.onSigned(journal, { waitMs: Number(lifetime.lastValidBlockHeight - height - BATCH_EXPIRY_MARGIN_BLOCKS) * MS_PER_BLOCK });
        // It may have taken a while: still the same wallet, RPC and network before anything is sent.
        context.assertCurrent();
        const sentSignatures: string[] = [];
        for (const [index, tx] of signed.entries()) {
          outcomes[index] = { ...outcomes[index], signature: journal[index].signature, lastValidBlockHeight: lifetime.lastValidBlockHeight };
          try {
            await broadcast(context, tx);
            outcomes[index].sent = true;
            sentSignatures.push(journal[index].signature);
          } catch (error) {
            outcomes[index].error = error;
          }
        }
        // None of them is confirmed yet: the next send waits for all of them.
        rememberSend(context, sentSignatures);
        return { outcomes, prompts: 1, mode: "batch", fallbackReason: null };
      } catch (err) {
        if (!(err instanceof BatchSigningUnsupportedError)) throw err;
        fallbackReason = err.message;
      }
      // Before the first one-by-one prompt, which may throw (a refusal).
      options.onFallback?.(fallbackReason);
    }

    // One prompt per transaction (a fresh blockhash each: signing may take a
    // while), each once the one before it is confirmed: the wallet simulates
    // the next one, and Phantom guards the fee payer's balance, against the
    // state the previous one left.
    let prompts = 0;
    for (let index = 0; index < tuned.length; index++) {
      context.assertCurrent();
      const lifetime = (await context.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      const fetchedAt = Date.now();
      const p = await base.prepare(guardTransactionGraph({ ...tuned[index], lifetime }, context.session, context.assertCurrent));
      context.assertCurrent();
      checkAuthority(p, context);
      let signed: Transaction;
      try {
        options.onPrompt?.({ mode: "per-transaction", index, count: tuned.length });
        prompts += 1;
        // The SDK keeps the wallet's message bytes: compared with the one built
        // (S6; Lighthouse guards and a compute budget within bounds accepted),
        // so the journal holds the wallet's own signature and the expiry height
        // of the signed blockhash.
        signed = verifySignedTransaction(
          compileTransaction(p.message),
          await base.sign(p),
          `transaction ${index + 1} of ${tuned.length}`,
          bounds[index],
        );
        context.assertCurrent();
      } catch (error) {
        // Nothing sent yet: the caller sees the wallet's own error.
        if (!lastSent) throw error;
        // Some were sent: report the rest as not sent and stop (a refusal stops here).
        for (let rest = index; rest < tuned.length; rest++) outcomes[rest].error = error;
        break;
      }
      const signature = transactionId(signed);
      // No block height read here: what the blockhash can spare above the margin, from the time signing took.
      const waitMs = Math.max(0, (BLOCKHASH_LIFETIME_BLOCKS - Number(BATCH_EXPIRY_MARGIN_BLOCKS)) * MS_PER_BLOCK - (Date.now() - fetchedAt));
      await options.onSigned([{ index, signature, lastValidBlockHeight: lifetime.lastValidBlockHeight }], { waitMs });
      outcomes[index] = { ...outcomes[index], signature, lastValidBlockHeight: lifetime.lastValidBlockHeight };
      try {
        // The hook may have taken a while: still the same wallet, RPC and network (else not sent).
        context.assertCurrent();
        await broadcast(context, signed);
      } catch (error) {
        // Refused, or failed in flight and still able to land (or not sent: the
        // wallet changed): the next one is not signed against a state nobody
        // knows. The run stops here.
        for (let rest = index; rest < tuned.length; rest++) outcomes[rest].error = error;
        break;
      }
      outcomes[index].sent = true;
      lastSent = signature;
      if (index + 1 === tuned.length) break;
      options.onWaiting?.({ index, count: tuned.length });
      const [settled] = await waitForSignatures(context.rpc, [signature], settleWait(context));
      context.assertCurrent();
      if (settled !== "confirmed") {
        const error = new EarlierTransactionUnconfirmedError(`${index + 1} of ${tuned.length}`, settled);
        for (let rest = index + 1; rest < tuned.length; rest++) outcomes[rest].error = error;
        break;
      }
    }
    // The ones before it were each confirmed before the next prompt: the next send waits for this one.
    if (lastSent) rememberSend(context, lastSent);
    return { outcomes, prompts, mode: "per-transaction", fallbackReason };
  }

  const verified: SolanaClient = {
    ...client,
    transaction,
    helpers: Object.freeze({ ...client.helpers, transaction }),
  };
  batchSenders.set(verified, Object.freeze({ prepareAndSendAll }));
  return verified;
}
