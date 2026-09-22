import type { SolanaClient, TransactionPrepared, TransactionPrepareRequest, WalletSession } from "@solana/client";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork, type Network } from "@/lib/network";
import { guardTransactionGraph } from "@/lib/transaction-session-guard";
import { requestTransactionWalletPolicy, transactionWalletPolicyRevision, TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { assertSiteWritable } from "@/lib/maintenance";

/** Both useSendTransaction and useTransactionPool use these public helpers.
 * Check the live runtime RPC before preparing, signing or sending, including
 * wallet sign-and-send and caller-supplied blockhashes. Prepared transactions
 * must originate here so they retain exact session/RPC provenance.
 * Explicit issuer recovery collects its required authorities separately and
 * does not use this default-primary flow; linked profiles confer no roles.
 * Maintenance mode is read (at most a few seconds old) before preparing and
 * before any wallet prompt, so no transaction is offered while the site is
 * paused; the server's refusal of the policy check backs it up. */
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

  async function authorize(context: Context) {
    await assertSiteWritable();
    context.assertCurrent();
    await requestTransactionWalletPolicy(context.session, network, context.assertCurrent);
    context.assertCurrent();
  }

  async function forPrepared(prepared: TransactionPrepared) {
    const context = preparedContexts.get(prepared) ?? capture();
    await assertNetwork(context);
    if (!preparedContexts.has(prepared)) throw new TransactionWalletChangedError();
    checkAuthority(prepared, context);
    await authorize(context);
    return context;
  }
  const base = client.transaction;
  const transaction: SolanaClient["transaction"] = Object.freeze({
    prepare: async (request) => {
      const context = capture();
      await assertSiteWritable();
      await assertNetwork(context);
      checkAuthority(request, context);
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
      const context = await forPrepared(prepared);
      const result = await base.send(prepared, options);
      context.assertCurrent();
      return result;
    },
    prepareAndSend: async (request, options) => {
      const context = capture();
      await assertNetwork(context);
      checkAuthority(request, context);
      await authorize(context);
      const result = await base.prepareAndSend(guardTransactionGraph(request, context.session, context.assertCurrent), options);
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
