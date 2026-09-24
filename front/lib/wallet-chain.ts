// The Wallet Standard chain a wallet is told a transaction belongs to.
//
// @solana/client passes `chain` to the wallet's solana:signTransaction and
// solana:signAndSendTransaction. Without a connector `defaultChain` it uses
// the account's FIRST listed chain, which for Phantom and most wallets is
// solana:mainnet: the wallet then previews, and "enhances" (priority fee,
// blockhash), a devnet transaction as if it were a mainnet one, and a
// sign-and-send wallet would broadcast it there. The connectors are
// therefore created with the build's own network as their default chain,
// when the wallet lists it.
import type { IdentifierString, Wallet } from "@wallet-standard/base";
import type { Network } from "@/lib/network";

const WALLET_CHAINS: Readonly<Record<Network, IdentifierString>> = Object.freeze({
  mainnet: "solana:mainnet",
  devnet: "solana:devnet",
  testnet: "solana:testnet",
  localnet: "solana:localnet",
});

/** The Wallet Standard chain identifier for `network` (solana:devnet, ...). */
export function walletChain(network: Network): IdentifierString {
  const chain = WALLET_CHAINS[network];
  if (!chain) throw new Error(`Unknown network ${String(network)}`);
  return chain;
}

/**
 * `overrides` for autoDiscover(): every wallet that lists the build's chain
 * gets it as its `defaultChain`. A wallet that does not list it (a local
 * validator, which wallets rarely declare) keeps the SDK default. The list is
 * the wallet's own `chains`, read once when the connectors are created; a
 * wallet that fills it in later keeps the SDK default too.
 */
export function walletConnectorOverrides(network: Network) {
  const chain = walletChain(network);
  return (wallet: Pick<Wallet, "chains">): { defaultChain: IdentifierString } | undefined =>
    wallet.chains.includes(chain) ? { defaultChain: chain } : undefined;
}
