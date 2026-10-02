import type {
  SolanaClient,
  TransactionPrepareAndSendRequest,
  TransactionPrepared,
  TransactionPrepareRequest,
  WalletSession,
} from "@solana/client";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork, type Network } from "@/lib/network";
import { guardTransactionGraph } from "@/lib/transaction-session-guard";
import { requestTransactionWalletPolicy, transactionWalletPolicyRevision, TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { assertSiteWritable } from "@/lib/maintenance";
import { priceForRequest } from "@/lib/priority-fee";
import { MAX_COMPUTE_UNIT_LIMIT, decodeComputeBudgetInstruction } from "@/lib/compute-budget";
import { clearWalletChange } from "@/lib/wallet-changes";
import { assertInstructionsInScope, assertInstructionsNotPaused } from "@/lib/pause-gate";
import { assertGateAccountsUnset } from "@/lib/proceeds-gate";
import {
  computeUnitLimitFromSimulation,
  PROBE_LIFETIME,
  refusalFromSimulation,
  simulateMessage,
  SimulationUnavailableError,
  waitForSignature,
  type SimulatableMessage,
  type SimulationVerdict,
} from "@/lib/simulation-gate";

/** A send this client made less than this long ago is waited for before the next one is simulated. */
export const SETTLE_WINDOW_MS = 60_000;
/** The longest the next send waits for the previous one to be confirmed. */
export const SETTLE_TIMEOUT_MS = 30_000;

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
  function withSimulatedComputeUnitLimit(request: TransactionPrepareAndSendRequest, verdict: SimulationVerdict): TransactionPrepareAndSendRequest {
    const overrides = request.prepareTransaction === false ? {} : (request.prepareTransaction ?? {});
    return {
      ...request,
      computeUnitLimit: computeUnitLimitFromSimulation(verdict.unitsConsumed, overrides.computeUnitLimitMultiplier),
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

  // The last send this client made, so the next one can wait for it.
  let lastSend: { rpc: Context["rpc"]; signature: string; at: number } | null = null;

  function rememberSend(context: Context, signature: unknown) {
    if (typeof signature === "string" && signature) lastSend = { rpc: context.rpc, signature, at: Date.now() };
  }

  /**
   * sendBatches and any other flow that sends twice in a row: `prepareAndSend`
   * returns once the transaction is submitted, not confirmed, and the next
   * transaction's simulation would otherwise run against the state before it
   * (before the gate, the second wallet review hid this). Waits until the
   * previous send of the last minute is confirmed or failed, at most 30 s,
   * then lets the simulation decide.
   */
  async function settlePreviousSend(context: Context) {
    const previous = lastSend;
    if (!previous || previous.rpc !== context.rpc || Date.now() - previous.at > SETTLE_WINDOW_MS) return;
    await waitForSignature(context.rpc, previous.signature, { timeoutMs: SETTLE_TIMEOUT_MS });
    context.assertCurrent();
    if (lastSend === previous) lastSend = null;
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
  return {
    ...client,
    transaction,
    helpers: Object.freeze({ ...client.helpers, transaction }),
  };
}
