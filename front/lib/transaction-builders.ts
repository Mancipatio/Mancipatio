import {
  assertAccountExists,
  fetchEncodedAccount,
  isSome,
  type Address,
  type FetchAccountConfig,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findMintPda,
  fetchMaybeShareClass,
  getClawbackBlocklistedHolderInstructionAsync,
  getClawbackFromHolderInstructionAsync,
  getCreateVestingSeriesInstructionAsync,
  getUpdateMintMetadataInstruction,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeTransferHookConfig,
  findConfigPda,
} from "@/lib/generated/transfer_hook";
import { hookTransferMetas, mintHasManciHook } from "@/lib/hook-metas";
import type { Network } from "@/lib/network";
import {
  NOT_ALLOWED_ON_MAINNET,
  TOKEN_2022,
  TOKEN_CLASSIC,
  assertKnownMintLayout,
  assertVestingMintExtensions,
  classifyMintAccount,
  isAllowedPaymentMint,
} from "@/lib/payment-mints";

// The mint classification lives in lib/payment-mints (pure, shared with the
// server routes); re-exported for the callers that import it from here.
export { TOKEN_2022, TOKEN_CLASSIC, assertVestingMintExtensions };

type Rpc = Parameters<typeof hookTransferMetas>[0];

/** Resolve the actual initialized mint; never guess Token-2022 on RPC failure. */
async function inspectMint(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
  opts: { plainPayment: boolean } = { plainPayment: false },
) {
  const account = await fetchEncodedAccount(rpc, mint, config);
  assertAccountExists(account);
  return classifyMintAccount(account, opts);
}

/**
 * The permissive EXIT check (cancel, refund, reclaim, claim, expire): the
 * mint's actual token program, whatever its extensions, so an existing
 * position can always be unwound.
 */
export async function fetchMintTokenProgram(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
) {
  return (await inspectMint(rpc, mint, config)).owner;
}
export async function fetchVestingMintTokenProgram(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
) {
  const inspected = await inspectMint(rpc, mint, config);
  assertVestingMintExtensions(inspected.mint);
  const extensions = isSome(inspected.mint.extensions)
    ? inspected.mint.extensions.value
    : [];
  const hook = extensions.find((e) => e.__kind === "TransferHook");
  if (hook?.__kind === "TransferHook") {
    const [configPda] = await findConfigPda({ mint });
    const hooked = await fetchMaybeTransferHookConfig(rpc, configPda, config);
    if (
      !hooked.exists ||
      hooked.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS ||
      hooked.data.mint !== mint ||
      hook.authority !== hooked.data.shareClass
    )
      throw new Error(
        "The mint does not have a verified Manci transfer-hook configuration",
      );
    const share = await fetchMaybeShareClass(
      rpc,
      hooked.data.shareClass,
      config,
    );
    const delegate = extensions.find((e) => e.__kind === "PermanentDelegate");
    if (
      !share.exists ||
      share.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      share.data.mint !== mint ||
      (await findMintPda({ shareClass: hooked.data.shareClass }))[0] !== mint ||
      !isSome(inspected.mint.mintAuthority) ||
      inspected.mint.mintAuthority.value !== hooked.data.shareClass ||
      (delegate?.__kind === "PermanentDelegate" &&
        delegate.delegate !== hooked.data.shareClass)
    )
      throw new Error("The hook is not bound to this registry share class");
  }
  return inspected.owner;
}

/** Used by the issuer form; external vesting tokens may use either supported program. */
export async function buildCreateVestingSeriesInstruction(
  rpc: Rpc,
  input: Omit<
    Parameters<typeof getCreateVestingSeriesInstructionAsync>[0],
    "tokenProgram"
  >,
) {
  const tokenProgram = await fetchVestingMintTokenProgram(rpc, input.tokenMint);
  return getCreateVestingSeriesInstructionAsync({ ...input, tokenProgram });
}

/** Share-class metadata is always a Token-2022 extension. */
export function buildUpdateMintMetadataInstruction(
  input: Omit<
    Parameters<typeof getUpdateMintMetadataInstruction>[0],
    "tokenProgram"
  >,
) {
  return getUpdateMintMetadataInstruction({
    ...input,
    tokenProgram: TOKEN_2022,
  });
}

type ClawbackLeg = {
  mint: Address;
  shareClass: Address;
  holder: Address;
  holderShareAccount: Address;
  destination: Address;
  custodyVault: Address;
};

/**
 * The holder -> quarantine leg's hook tail, in the mint's CURRENT mode (Open:
 * 3 accounts, KycGated: 9). The transfer authority is the ShareClass (the
 * mint's permanent delegate); the BlockEntry and source marker stay keyed on
 * the holder, the destination marker on the custody vault.
 */
function clawbackHookTail(rpc: Rpc, leg: ClawbackLeg) {
  return hookTransferMetas(rpc, leg.mint, {
    sourceTokenAccount: leg.holderShareAccount,
    destTokenAccount: leg.destination,
    sourceOwner: leg.holder,
    transferAuthority: leg.shareClass,
    destOwner: leg.custodyVault,
  });
}

/** clawback_from_holder: KycGated mint, revoked / expired passport. */
export async function buildClawbackInstruction(
  rpc: Rpc,
  input: Omit<
    Parameters<typeof getClawbackFromHolderInstructionAsync>[0],
    "tokenProgram"
  >,
) {
  const ix = await getClawbackFromHolderInstructionAsync({
    ...input,
    tokenProgram: TOKEN_2022,
  });
  const metas = await clawbackHookTail(rpc, input);
  return { ...ix, accounts: [...ix.accounts, ...metas] };
}

/**
 * clawback_blocklisted_holder: Open or KycGated mint, holder on the
 * transfer-hook blocklist (BlocklistAuthority) + an Admin signature.
 */
export async function buildBlocklistClawbackInstruction(
  rpc: Rpc,
  input: Omit<
    Parameters<typeof getClawbackBlocklistedHolderInstructionAsync>[0],
    "tokenProgram"
  >,
) {
  // The instruction reads the mint's hook config in any mode; without one it
  // can only fail on-chain, so refuse before asking the wallet to sign.
  if (!(await mintHasManciHook(rpc, input.mint)))
    throw new Error(
      "This mint has no transfer-hook config, so it cannot be clawed back.",
    );
  const ix = await getClawbackBlocklistedHolderInstructionAsync({
    ...input,
    tokenProgram: TOKEN_2022,
  });
  const metas = await clawbackHookTail(rpc, input);
  return { ...ix, accounts: [...ix.accounts, ...metas] };
}

/** Purchase payment CPI has no transfer-hook resolver and accounts in gross base units. */
export async function fetchPlainPaymentMintTokenProgram(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
) {
  return (await inspectMint(rpc, mint, config, { plainPayment: true })).owner;
}

/**
 * The ENTRY check for a payment mint (create, take, deposit, reserve, buy):
 * the plain-payment rule, the known USDC layout (a mismatch means a wrong
 * cluster or RPC) and, on mainnet, the allowlist. Returns the mint's actual
 * token program and decimals.
 */
export async function inspectPaymentMint(
  rpc: Rpc,
  mint: Address,
  network: Network,
  config?: FetchAccountConfig,
): Promise<{ owner: Address; decimals: number }> {
  if (!isAllowedPaymentMint(network, mint)) throw new Error(NOT_ALLOWED_ON_MAINNET);
  const { owner, decimals } = await inspectMint(rpc, mint, config, { plainPayment: true });
  assertKnownMintLayout(network, mint, { owner, decimals });
  return { owner, decimals };
}

/**
 * A sale's payment-mint decimals for pricing a Buy (entry path): SPL Token
 * or Token-2022, read from chain, at most 18.
 */
export async function loadSalePaymentDecimals(
  rpc: Rpc,
  paymentMint: Address,
  network: Network,
  config?: FetchAccountConfig,
): Promise<number> {
  const { decimals } = await inspectPaymentMint(rpc, paymentMint, network, config);
  if (decimals > 18) throw new Error("The payment token has more than 18 decimals.");
  return decimals;
}
