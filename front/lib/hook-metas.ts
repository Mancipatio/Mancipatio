"use client";

// Mode-aware transfer-hook account tails for share-class mint transfers.
//
// Every `transfer_checked` of a Manci share-class mint (Token-2022 with
// the Manci transfer_hook) needs the hook's extra accounts appended after
// the four standard transfer accounts. The required shape depends on the
// mint's `TransferHookConfig.restriction_mode`:
//
//   Open (or no config yet) — 3 accounts:
//     [BlockEntry(source owner), ExtraAccountMetaList(mint), hook program]
//
//   KycGated — 9 accounts, mirroring the on-chain `build_metas` meta-list
//   order EXACTLY (transfer_hook Execute idx 5–11, then the validation
//   account + hook program that Token-2022 also requires):
//     [BlockEntry(source owner),
//      TransferHookConfig(mint),
//      KycRegistry (from config),
//      asset_registry program,
//      KycEntry(registry, destination owner),
//      EscrowMarker(destination owner),
//      EscrowMarker(source owner)]
//     + ExtraAccountMetaList(mint) + hook program
//
// The two EscrowMarker PDAs implement the platform-escrow exemption: when the
// source or destination token account is owned by a deal / offer / custody
// vault / distribution PDA (which carries an initialised EscrowMarker), the
// hook skips the receiver-KYC check for that leg. For non-escrow owners the
// marker PDA simply resolves to an uninitialised (system-owned) address and
// no exemption applies — the address must still be passed so Token-2022 can
// satisfy the meta list.
//
// `BlockEntry` and source EscrowMarker use the token account's owner. The
// transfer authority is separate: for both clawbacks (clawback_from_holder,
// and clawback_blocklisted_holder on Open or KycGated mints) it is the
// ShareClass permanent delegate PDA, while the source owner remains the
// holder. The hook resolves the owner from source-account data and admits a
// blocked owner only for that permanent-delegate leg into a registry escrow,
// in either mode — so the clawback tail is simply this mode's normal tail. These tails target that owner-based hook; upgrade existing meta lists
// together with the program before enabling the updated client on that cluster.

import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  unwrapOption,
  type Address,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  fetchMaybeTransferHookConfig,
  findConfigPda,
  RestrictionMode,
  type TransferHookConfig,
} from "@/lib/generated/transfer_hook";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
} from "@/lib/generated/asset_registry";
import {
  findBlockEntryPda,
  findExtraMetasPda,
  TRANSFER_HOOK_PROGRAM,
} from "@/lib/pdas";

type Rpc = SolanaClient["runtime"]["rpc"];

export type HookTransferMeta = { address: Address; role: AccountRole };

/** True when `mint` is wired to the Manci transfer hook (a share-class
 *  mint). Vesting escrows accept ANY mint — hook metas may only be appended
 *  when this is true; a mint without the hook rejects the extra accounts. */
export async function mintHasManciHook(
  rpc: Rpc,
  mint: Address,
): Promise<boolean> {
  return (await loadHookConfig(rpc, mint)) !== null;
}

export type HookTransferAccounts = {
  /** The token account the transfer debits (informational — the seeds are
   * keyed on the owners, which the caller passes directly). */
  sourceTokenAccount: Address;
  /** The token account the transfer credits (informational — see above). */
  destTokenAccount: Address;
  /** Actual owner of the source token account; used for both owner PDA seeds. */
  sourceOwner: Address;
  /** Signer of the token transfer; may be a delegate instead of sourceOwner.
   * Kept explicit at call sites; it never substitutes for an owner PDA seed. */
  transferAuthority: Address;
  /** Owner of the destination token account. */
  destOwner: Address;
};

const addressEncoder = getAddressEncoder();
const seed = (s: string) => new TextEncoder().encode(s);

/** asset_registry `["escrow_marker", owner]` — platform-escrow marker PDA. */
async function findEscrowMarkerPdaFor(owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [seed("escrow_marker"), addressEncoder.encode(owner)],
  });
  return pda;
}

// Short-lived TransferHookConfig cache — one action often builds several
// tails for the same mint (e.g. deposit + settle legs); the mode only changes
// via the super-admin `update_transfer_hook_config`, so 30s staleness is fine.
const CONFIG_TTL_MS = 30_000;
const configCaches = new WeakMap<
  Rpc,
  Map<string, { at: number; promise: Promise<TransferHookConfig | null> }>
>();

async function loadHookConfig(
  rpc: Rpc,
  mint: Address,
): Promise<TransferHookConfig | null> {
  const key = mint.toString();
  // The same PDA may exist with different data on different clusters.
  let configCache = configCaches.get(rpc);
  if (!configCache) {
    configCache = new Map();
    configCaches.set(rpc, configCache);
  }
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.promise;
  const promise = (async () => {
    const [configPda] = await findConfigPda({ mint });
    const maybe = await fetchMaybeTransferHookConfig(rpc, configPda);
    return maybe.exists ? maybe.data : null;
  })().catch((err) => {
    // Never cache a failure.
    configCache.delete(key);
    throw err;
  });
  configCache.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Builds the hook account tail for ONE `transfer_checked` leg of `mint`,
 * matching the mint's current restriction mode (fetched on-chain, cached
 * 30s). Append the result after an instruction's fixed accounts — for
 * program instructions the on-chain handler forwards it via
 * `remaining_accounts`; for direct `transfer_checked` instructions Token-2022
 * consumes it directly. All returned accounts are read-only.
 */
const ro = (address: Address): HookTransferMeta => ({
  address,
  role: AccountRole.READONLY,
});

export async function hookTransferMetas(
  rpc: Rpc,
  mint: Address,
  accounts: HookTransferAccounts,
): Promise<HookTransferMeta[]> {
  const { sourceOwner, destOwner } = accounts;

  const blockEntry = await findBlockEntryPda(sourceOwner);
  const extraMetas = await findExtraMetasPda(mint);
  const openTail = [ro(blockEntry), ro(extraMetas), ro(TRANSFER_HOOK_PROGRAM)];

  const config = await loadHookConfig(rpc, mint);
  if (!config || config.restrictionMode !== RestrictionMode.KycGated) {
    return openTail;
  }

  const kycRegistry = unwrapOption(config.kycRegistry);
  if (!kycRegistry) {
    // The program guarantees a registry whenever the mode is KycGated.
    throw new Error(
      `Mint ${mint} is KycGated but its hook config has no KYC registry.`,
    );
  }
  const [configPda] = await findConfigPda({ mint });
  const [kycEntry] = await findKycEntryPda({ kycRegistry, holder: destOwner });
  const destMarker = await findEscrowMarkerPdaFor(destOwner);
  const sourceMarker = await findEscrowMarkerPdaFor(sourceOwner);

  return [
    ro(blockEntry),
    ro(configPda),
    ro(kycRegistry),
    ro(ASSET_REGISTRY_PROGRAM_ADDRESS),
    ro(kycEntry),
    ro(destMarker),
    ro(sourceMarker),
    ro(extraMetas),
    ro(TRANSFER_HOOK_PROGRAM),
  ];
}

/**
 * Pure derivation of the Open-mode receiver-KYC proof tail for `buy`:
 *   [BlockEntry(receiver), ExtraAccountMetaList(mint), transfer_hook program]
 * — the same 3-account shape an Open-mode hook transfer uses (the form
 * `buy`'s account docs specify). The on-chain check only reads the
 * ExtraAccountMetaList from it: the hook program rewrites/resizes that PDA
 * atomically with every mode flip, so its Open shape (exactly one extra
 * meta) PROVES Open mode. A `mint_to` has no source authority, so the
 * BlockEntry — which the check ignores — is keyed on the receiver purely to
 * keep the documented hook-tail form. No RPC involved: building this tail
 * can never fail on a flaky connection.
 */
export async function openKycReceiverTail(
  mint: Address,
  receiver: Address,
): Promise<HookTransferMeta[]> {
  const blockEntry = await findBlockEntryPda(receiver);
  const extraMetas = await findExtraMetasPda(mint);
  return [ro(blockEntry), ro(extraMetas), ro(TRANSFER_HOOK_PROGRAM)];
}

/**
 * Builds the receiver-KYC remaining-accounts tail for a NON-transfer
 * instruction that must still enforce receiver KYC on-chain. Primary-sale
 * `buy` is the case: delivery is a `mint_to` CPI, which never fires the
 * Token-2022 transfer hook — so, unlike transfer legs, no hook CPI backstops
 * a stripped tail. The program therefore re-checks the receiver FAIL-CLOSED
 * (`require_receiver_kyc_for_mint_to`), resolving accounts from the tail by
 * re-derived PDA key (identity cannot be spoofed):
 *
 *   * hook config present in the tail → its restriction_mode is
 *     authoritative (Open passes; KycGated demands the receiver's approved,
 *     unexpired KycEntry plus the registry's jurisdiction bitmaps);
 *   * config absent → the mint's ExtraAccountMetaList in its Open shape is
 *     the on-chain proof of Open mode;
 *   * neither → the buy fails with KycProofRequired (6077).
 *
 * An empty tail is therefore NEVER valid — this function always returns
 * accounts: Open (or unconfigured) mints get the 3-account Open proof tail
 * (openKycReceiverTail); KycGated mints get, in the take_offer tail's
 * relative order:
 *   [TransferHookConfig(mint), KycRegistry (from config),
 *    asset_registry program, KycEntry(registry, receiver)]
 *
 * NOTE: the fail-closed gate lives in the asset_registry SOURCE
 * (handle_buy → require_receiver_kyc_for_mint_to) and binds once that build
 * is DEPLOYED. Against an older deployed program the tail is inert (extra
 * remaining accounts are ignored) and the caller's client-side eligibility
 * gate is the only live protection.
 */
export async function kycReceiverMetas(
  rpc: Rpc,
  mint: Address,
  receiver: Address,
): Promise<HookTransferMeta[]> {
  const config = await loadHookConfig(rpc, mint);
  if (!config || config.restrictionMode !== RestrictionMode.KycGated) {
    return openKycReceiverTail(mint, receiver);
  }
  const kycRegistry = unwrapOption(config.kycRegistry);
  if (!kycRegistry) {
    // The program guarantees a registry whenever the mode is KycGated.
    throw new Error(
      `Mint ${mint} is KycGated but its hook config has no KYC registry.`,
    );
  }
  const [configPda] = await findConfigPda({ mint });
  const [kycEntry] = await findKycEntryPda({ kycRegistry, holder: receiver });
  return [
    ro(configPda),
    ro(kycRegistry),
    ro(ASSET_REGISTRY_PROGRAM_ADDRESS),
    ro(kycEntry),
  ];
}
