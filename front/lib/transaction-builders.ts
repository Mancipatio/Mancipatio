import {
  assertAccountExists,
  fetchEncodedAccount,
  isSome,
  type Address,
  type FetchAccountConfig,
} from "@solana/kit";
import { getMintDecoder, type Mint } from "@solana-program/token-2022";
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

export const TOKEN_CLASSIC =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const TOKEN_2022 =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

type Rpc = Parameters<typeof hookTransferMetas>[0];

/** Resolve the actual initialized mint; never guess Token-2022 on RPC failure. */
async function inspectMint(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
) {
  const account = await fetchEncodedAccount(rpc, mint, config);
  assertAccountExists(account);
  const owner = account.programAddress;
  if (owner !== TOKEN_CLASSIC && owner !== TOKEN_2022) {
    throw new Error(
      "The selected mint is not owned by a supported token program.",
    );
  }
  // Token-2022 uses the 82-byte base mint, or padding + Mint account type (1)
  // at offset 165 before extensions. A 165-byte token account is not a mint.
  const baseMint = account.data.length === 82;
  const extendedMint =
    owner === TOKEN_2022 &&
    account.data.length >= 166 &&
    account.data[165] === 1;
  if (
    (!baseMint && !extendedMint) ||
    !getMintDecoder().decode(account.data).isInitialized
  ) {
    throw new Error("The selected account is not an initialized token mint.");
  }
  return { owner, mint: getMintDecoder().decode(account.data) };
}

export async function fetchMintTokenProgram(
  rpc: Rpc,
  mint: Address,
  config?: FetchAccountConfig,
) {
  return (await inspectMint(rpc, mint, config)).owner;
}

/** This flow has no net-fee accounting, confidential transfers or foreign hook resolver. */
export function assertVestingMintExtensions(mint: Mint) {
  const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
  const benign = new Set([
    "MintCloseAuthority",
    "MetadataPointer",
    "TokenMetadata",
    "GroupPointer",
    "TokenGroup",
    "GroupMemberPointer",
    "TokenGroupMember",
  ]);
  for (const extension of extensions) {
    if (benign.has(extension.__kind)) continue;
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
  const inspected = await inspectMint(rpc, mint, config);
  assertVestingMintExtensions(inspected.mint);
  if (
    isSome(inspected.mint.extensions) &&
    inspected.mint.extensions.value.some(
      (e) => e.__kind === "TransferHook" || e.__kind === "PermanentDelegate",
    )
  )
    throw new Error(
      "This payment flow requires a token without a transfer hook or permanent delegate.",
    );
  return inspected.owner;
}
