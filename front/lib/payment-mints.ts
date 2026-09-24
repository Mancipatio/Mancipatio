// Payment mints (Talas 4.2, design-4.2-4.3 §3.1). Pure and isomorphic.
//
// A payment mint's owner (SPL Token or Token-2022), layout and decimals are
// always read from chain; nothing falls back to "classic". Two rules:
// * ENTRY paths (create, take, deposit, reserve, buy) use the plain-payment
//   rule — no transfer hook, no permanent delegate, no fee or confidential
//   extension — and, on mainnet, the allowlist below;
// * EXIT paths (cancel, refund, reclaim, claim, expire) use only the
//   permissive owner check (lib/transaction-builders fetchMintTokenProgram),
//   so an existing position can always be unwound.
// A token symbol or label never authorizes a payment: labels are display only.
import { isSome, type Address } from "@solana/kit";
import { getMintDecoder, type Mint } from "@solana-program/token-2022";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { Network } from "@/lib/network";

export const TOKEN_CLASSIC =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const TOKEN_2022 =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/**
 * Circle USDC per network (addresses verified 2026-09-07:
 * https://developers.circle.com/stablecoins/usdc-contract-addresses).
 * Testnet and localnet have no default payment mint.
 */
export const USDC: Readonly<Record<Network, { mint: Address; label: string } | null>> = Object.freeze({
  mainnet: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address, label: "USDC" },
  devnet: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address, label: "test USDC" },
  testnet: null,
  localnet: null,
});
/** What the network's USDC must look like on chain (G1): an SPL Token mint with 6 decimals. */
export const KNOWN_MINT_LAYOUT = { tokenProgram: TOKEN_CLASSIC, decimals: 6 } as const;

export type FxKind = "rate" | "eur_peg";
/**
 * The only payment mints entry paths accept on mainnet, with the FX kind the
 * server enforces for each (D6, D18). EURC ("eur_peg") joins later, once its
 * address is verified from Circle.
 */
export const MAINNET_PAYMENT_MINTS: Readonly<Record<string, { label: string; fxKind: FxKind }>> = Object.freeze({
  [USDC.mainnet!.mint]: { label: "USDC", fxKind: "rate" },
});

export const NOT_ALLOWED_ON_MAINNET = "This token is not an allowed payment token on mainnet.";
/** D18: a mainnet "rate" FX row may be at most this many days old (weekly refresh). */
export const MAINNET_MAX_RATE_AGE_DAYS = 7;

/** The mint forms and the admin screens start with: the network's USDC, if any. */
export function defaultPaymentMint(network: Network): Address | null {
  return USDC[network]?.mint ?? null;
}

/** Mainnet: only the allowlist. Every other network accepts any mint that passes the plain rule. */
export function isAllowedPaymentMint(network: Network, mint: string): boolean {
  if (network !== "mainnet") return true;
  return Object.prototype.hasOwnProperty.call(MAINNET_PAYMENT_MINTS, mint);
}

/** Mainnet: the FX kind an allowlisted mint's rate row must have; null elsewhere (any kind). */
export function requiredFxKind(network: Network, mint: string): FxKind | null {
  if (network !== "mainnet") return null;
  return isAllowedPaymentMint(network, mint) ? MAINNET_PAYMENT_MINTS[mint].fxKind : null;
}

/** Display label; never an authorization. */
export function paymentMintLabel(mint: string, network: Network): string {
  const usdc = USDC[network];
  if (usdc && usdc.mint === mint) return usdc.label;
  if (network === "mainnet" && isAllowedPaymentMint(network, mint)) return MAINNET_PAYMENT_MINTS[mint].label;
  return "payment tokens";
}

const BENIGN_EXTENSIONS = new Set([
  "MintCloseAuthority",
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "TokenGroup",
  "GroupMemberPointer",
  "TokenGroupMember",
]);

/** This flow has no net-fee accounting, confidential transfers or foreign hook resolver. */
export function assertVestingMintExtensions(mint: Mint) {
  const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
  for (const extension of extensions) {
    if (BENIGN_EXTENSIONS.has(extension.__kind)) continue;
    if (
      extension.__kind === "TransferHook" &&
      extension.programId === TRANSFER_HOOK_PROGRAM_ADDRESS
    )
      continue;
    if (
      extension.__kind === "PermanentDelegate" &&
      extensions.some(
        (e) =>
          e.__kind === "TransferHook" &&
          e.programId === TRANSFER_HOOK_PROGRAM_ADDRESS,
      )
    )
      continue;
    throw new Error(
      `This vesting flow does not support the mint extension ${extension.__kind}. No escrow should be funded for this mint.`,
    );
  }
}

/**
 * The plain-payment rule: a payment CPI has no transfer-hook resolver and
 * accounts in gross base units, so no hook, no permanent delegate and no
 * other non-benign extension (transfer fees, confidential transfers, …).
 */
function assertPlainPaymentExtensions(mint: Mint) {
  const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
  if (extensions.some((e) => e.__kind === "TransferHook" || e.__kind === "PermanentDelegate")) {
    throw new Error("This payment flow requires a token without a transfer hook or permanent delegate.");
  }
  const unsupported = extensions.find((e) => !BENIGN_EXTENSIONS.has(e.__kind));
  if (unsupported) {
    throw new Error(`This payment flow does not support the mint extension ${unsupported.__kind}.`);
  }
}

export type MintAccount = { programAddress: string; data: Uint8Array | ArrayLike<number> };
export type ClassifiedMint = { owner: Address; decimals: number; mint: Mint };

/**
 * Classifies an account as a token mint (pure): owned by SPL Token or
 * Token-2022; exactly the 82-byte base mint, or a Token-2022 mint with the
 * Mint account type (1) at byte 165 (a 165-byte token account is not a
 * mint); initialized. With `plainPayment`, the plain-payment rule too.
 */
export function classifyMintAccount(acc: MintAccount, opts: { plainPayment: boolean }): ClassifiedMint {
  const owner = acc.programAddress;
  if (owner !== TOKEN_CLASSIC && owner !== TOKEN_2022) {
    throw new Error("The selected mint is not owned by a supported token program.");
  }
  const data = acc.data instanceof Uint8Array ? acc.data : Uint8Array.from(Array.from(acc.data));
  const baseMint = data.length === 82;
  const extendedMint = owner === TOKEN_2022 && data.length >= 166 && data[165] === 1;
  let mint: Mint | null = null;
  if (baseMint || extendedMint) {
    try {
      mint = getMintDecoder().decode(data);
    } catch {
      mint = null;
    }
  }
  if (!mint || !mint.isInitialized) {
    throw new Error("The selected account is not an initialized token mint.");
  }
  if (opts.plainPayment) assertPlainPaymentExtensions(mint);
  return { owner: owner as Address, decimals: mint.decimals, mint };
}

/**
 * The network's USDC must be an SPL Token mint with 6 decimals; anything
 * else means the RPC is on another cluster (or the address is wrong).
 */
export function assertKnownMintLayout(
  network: Network,
  mint: string,
  info: { owner: string; decimals: number },
): void {
  const usdc = USDC[network];
  if (!usdc || usdc.mint !== mint) return;
  if (info.owner !== KNOWN_MINT_LAYOUT.tokenProgram || info.decimals !== KNOWN_MINT_LAYOUT.decimals) {
    throw new Error(
      `The ${usdc.label} mint does not look like ${usdc.label} on ${network} (expected an SPL Token mint with 6 decimals): wrong cluster or RPC.`,
    );
  }
}
