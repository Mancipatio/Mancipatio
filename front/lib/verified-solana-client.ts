import type { SolanaClient } from "@solana/client";
import { createNetworkVerifier } from "@/lib/network-identity";
import type { Network } from "@/lib/network";

/** Both useSendTransaction and useTransactionPool use these public helpers.
 * Check the live runtime RPC before preparing, signing or sending, including
 * wallet sign-and-send and caller-supplied blockhash/prepared transactions. */
export function withVerifiedTransactions(
  client: SolanaClient,
  network: Network,
): SolanaClient {
  const verifiers = new WeakMap<
    SolanaClient["runtime"]["rpc"],
    ReturnType<typeof createNetworkVerifier>
  >();
  async function assertNetwork() {
    const rpc = client.runtime.rpc;
    let verify = verifiers.get(rpc);
    if (!verify) {
      verify = createNetworkVerifier(rpc, network);
      verifiers.set(rpc, verify);
    }
    await verify();
    if (client.runtime.rpc !== rpc) {
      throw new Error(
        "The Solana connection changed. Review the network and try again.",
      );
    }
  }
  const base = client.transaction;
  const transaction: SolanaClient["transaction"] = Object.freeze({
    prepare: async (...args) => {
      await assertNetwork();
      return base.prepare(...args);
    },
    sign: async (...args) => {
      await assertNetwork();
      return base.sign(...args);
    },
    toWire: async (...args) => {
      await assertNetwork();
      return base.toWire(...args);
    },
    send: async (...args) => {
      await assertNetwork();
      return base.send(...args);
    },
    prepareAndSend: async (...args) => {
      await assertNetwork();
      return base.prepareAndSend(...args);
    },
  });
  return {
    ...client,
    transaction,
    helpers: Object.freeze({ ...client.helpers, transaction }),
  };
}
