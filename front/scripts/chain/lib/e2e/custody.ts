/**
 * Share legs the e2e groups G4–G8 share: custody vaults (G4 delivery /
 * conversion, G6 quarantine, G7 exits under the pause) built as the admin
 * custody page and the holder's delivery page build them, clawbacks as the
 * clawback panel builds them, and a plain wallet transfer. Every Token-2022
 * share leg carries the transfer-hook tail of the mint's current mode; a
 * DeliveryEscrow realize passes its KYC accounts (lib/custody-kyc) and every
 * vault exit its authority's Admin record (lib/custody-authority).
 */
import type { Address, Instruction, KeyPairSigner, TransactionSigner } from "@solana/kit";
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  RealizeAction,
  VaultState,
  VaultType,
  findOpenCustodyVaultEscrowPda,
  getDepositToCustodyVaultInstructionAsync,
  getOpenCustodyVaultInstructionAsync,
  getRealizeCustodyVaultInstructionAsync,
  getReturnCustodyVaultInstructionAsync,
  getTriggerCustodyVaultInstructionAsync,
  type CustodyVault,
} from "@/lib/generated/asset_registry";
import { custodyAuthorityRecord } from "@/lib/custody-authority";
import { realizeKycAccounts, DEFAULT_PUBKEY } from "@/lib/custody-kyc";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findCustodyVaultPda } from "@/lib/pdas";
import { TOKEN_2022, buildBlocklistClawbackInstruction, buildClawbackInstruction } from "@/lib/transaction-builders";
import { ChainPlanError } from "../safety";
import { entity } from "./state";
import { sha256Bytes, type World } from "./world";

export type ClassKey = "classA" | "classB";

export function withTail(ix: Instruction, tail: readonly { address: Address; role: number }[]): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ...tail] } as Instruction;
}

export function classMint(w: World, classKey: ClassKey): Address {
  return entity(w.runner.state, classKey === "classA" ? "mintA" : "mintB") as Address;
}

export async function shareAta(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022 }))[0];
}

export async function vaultPda(w: World, classKey: ClassKey, vaultId: number): Promise<Address> {
  return findCustodyVaultPda(entity(w.runner.state, classKey) as Address, BigInt(vaultId));
}

/** The vault's decoded data, or null when it never existed or is a tombstone. */
export async function loadVault(w: World, vault: Address): Promise<CustodyVault | null> {
  const account = await fetchMaybeLiveCustodyVault(w.rpc, vault, { commitment: "finalized" });
  return account.exists ? account.data : null;
}

export async function vaultState(w: World, vault: Address): Promise<VaultState | null> {
  return (await loadVault(w, vault))?.state ?? null;
}

async function requireVault(w: World, vault: Address): Promise<CustodyVault> {
  const data = await loadVault(w, vault);
  if (!data) throw new ChainPlanError(`custody vault ${vault} is not on chain`);
  return data;
}

/**
 * open_custody_vault by the Admin. A DeliveryEscrow pins `registry` and
 * names its beneficiary; every other type passes neither.
 */
export async function openVaultIxs(
  w: World,
  input: {
    classKey: ClassKey;
    vaultId: number;
    vaultType: VaultType;
    amount: bigint;
    deadline: bigint;
    beneficiary?: Address;
    registry?: Address;
    signer?: TransactionSigner;
  },
): Promise<Instruction[]> {
  return [
    await getOpenCustodyVaultInstructionAsync({
      authority: input.signer ?? w.roles.admin,
      shareClass: entity(w.runner.state, input.classKey) as Address,
      mint: classMint(w, input.classKey),
      tokenProgram: TOKEN_2022,
      vaultId: BigInt(input.vaultId),
      vaultType: input.vaultType,
      realizeAction: RealizeAction.BurnAndAttest,
      amount: input.amount,
      deadline: input.deadline,
      metadataHash: sha256Bytes(`manci-e2e:${w.runId}:vault:${input.classKey}:${input.vaultId}`),
      beneficiary: input.beneficiary ?? (DEFAULT_PUBKEY as Address),
      ...(input.registry ? { kycRegistry: input.registry } : {}),
    }),
  ];
}

/** The beneficiary's deposit (holder → vault escrow), with the hook tail. */
export async function depositIxs(w: World, depositor: KeyPairSigner, vault: Address, amount: bigint): Promise<Instruction[]> {
  const data = await requireVault(w, vault);
  const depositorShare = await shareAta(depositor.address, data.mint);
  const deposit = await getDepositToCustodyVaultInstructionAsync({
    depositor,
    shareClass: data.shareClass,
    custodyVault: vault,
    mint: data.mint,
    escrow: data.escrow,
    depositorShareAccount: depositorShare,
    tokenProgram: TOKEN_2022,
    amount,
  });
  const tail = await hookTransferMetas(w.rpc, data.mint, {
    sourceTokenAccount: depositorShare,
    destTokenAccount: data.escrow,
    transferAuthority: depositor.address,
    sourceOwner: depositor.address,
    destOwner: vault,
  });
  return [withTail(deposit, tail)];
}

export async function triggerIxs(w: World, vault: Address, signer: TransactionSigner = w.roles.admin): Promise<Instruction[]> {
  return [
    await getTriggerCustodyVaultInstructionAsync({
      authority: signer,
      custodyVault: vault,
      authorityAdminRecord: await custodyAuthorityRecord(w.rpc, vault),
    }),
  ];
}

/** realize (burn): a DeliveryEscrow passes its pinned registry and the beneficiary's entry. */
export async function realizeIxs(w: World, vault: Address, signer: TransactionSigner = w.roles.admin): Promise<Instruction[]> {
  const data = await requireVault(w, vault);
  return [
    await getRealizeCustodyVaultInstructionAsync({
      authority: signer,
      shareClass: data.shareClass,
      custodyVault: vault,
      mint: data.mint,
      escrow: data.escrow,
      tokenProgram: TOKEN_2022,
      authorityAdminRecord: await custodyAuthorityRecord(w.rpc, vault),
      ...(await realizeKycAccounts(data)),
    }),
  ];
}

/**
 * return_custody_vault as the admin custody page builds it: the
 * beneficiary's ATA (idempotent) and the escrow → beneficiary hook tail.
 * `signer` is the vault authority, or anyone once the deadline passed.
 */
export async function returnIxs(w: World, vault: Address, signer: KeyPairSigner): Promise<Instruction[]> {
  const data = await requireVault(w, vault);
  const [escrow] = await findOpenCustodyVaultEscrowPda({ custodyVault: vault });
  const beneficiaryShare = await shareAta(data.beneficiary, data.mint);
  const base = await getReturnCustodyVaultInstructionAsync({
    signer,
    shareClass: data.shareClass,
    custodyVault: vault,
    mint: data.mint,
    escrow,
    beneficiaryTokenAccount: beneficiaryShare,
    tokenProgram: TOKEN_2022,
    authorityAdminRecord: await custodyAuthorityRecord(w.rpc, vault),
  });
  const tail = await hookTransferMetas(w.rpc, data.mint, {
    sourceTokenAccount: escrow,
    destTokenAccount: beneficiaryShare,
    transferAuthority: vault,
    sourceOwner: vault,
    destOwner: data.beneficiary,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: data.beneficiary, mint: data.mint, tokenProgram: TOKEN_2022 }),
    withTail(base, tail),
  ];
}

/** A burn-only quarantine vault (RedemptionQueue + BurnAndAttest, no deadline): the clawback destination. */
export async function openQuarantineIxs(w: World, classKey: ClassKey, vaultId: number): Promise<Instruction[]> {
  return openVaultIxs(w, { classKey, vaultId, vaultType: VaultType.RedemptionQueue, amount: BigInt(0), deadline: BigInt(0) });
}

/**
 * clawback_from_holder (KycGated mint, revoked or long-expired passport) or
 * clawback_blocklisted_holder (any mode, holder on the hook blocklist), as
 * /admin/kyc's clawback panel builds them (lib/transaction-builders adds the
 * holder → quarantine hook tail). `amount` 0 seizes the whole balance.
 */
export async function clawbackIxs(
  w: World,
  input: { path: "kyc" | "blocklist"; classKey: ClassKey; quarantine: Address; holder: Address; amount: bigint; registry?: Address },
): Promise<Instruction[]> {
  const vault = await requireVault(w, input.quarantine);
  const leg = {
    authority: w.roles.admin,
    shareClass: vault.shareClass,
    mint: vault.mint,
    holderShareAccount: await shareAta(input.holder, vault.mint),
    destination: vault.escrow,
    custodyVault: input.quarantine,
    holder: input.holder,
    amount: input.amount,
  };
  if (input.path === "blocklist") return [await buildBlocklistClawbackInstruction(w.rpc, leg)];
  if (!input.registry) throw new ChainPlanError("clawback_from_holder needs the KYC registry");
  return [await buildClawbackInstruction(w.rpc, { ...leg, kycRegistry: input.registry })];
}

/** A plain wallet → wallet share transfer (transfer_checked + the hook tail), as a holder's wallet sends it. */
export async function walletTransferIxs(w: World, from: KeyPairSigner, to: Address, classKey: ClassKey, amount: bigint): Promise<Instruction[]> {
  const mint = classMint(w, classKey);
  const source = await shareAta(from.address, mint);
  const destination = await shareAta(to, mint);
  const decimals = (await fetchMint(w.rpc, mint, { commitment: "finalized" })).data.decimals;
  const transfer = getTransferCheckedInstruction({ source, mint, destination, authority: from, amount, decimals }, { programAddress: TOKEN_2022 });
  const tail = await hookTransferMetas(w.rpc, mint, {
    sourceTokenAccount: source,
    destTokenAccount: destination,
    transferAuthority: from.address,
    sourceOwner: from.address,
    destOwner: to,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: from, owner: to, mint, tokenProgram: TOKEN_2022 }),
    withTail(transfer, tail),
  ];
}

/** `done` probes: the vault reached (or passed) a state. */
export function vaultIn(w: World, vault: Address, states: readonly VaultState[]) {
  return async () => {
    const account = await fetchMaybeLiveCustodyVault(w.rpc, vault, { commitment: "finalized" });
    if (!account.exists) return account.closed;
    return states.includes(account.data.state);
  };
}

/** A deposit's `done`: the ledger holds at least `amount`, or the vault moved on. */
export function deposited(w: World, vault: Address, amount: bigint) {
  return async () => {
    const data = await loadVault(w, vault);
    return data !== null && (data.deposited >= amount || data.state !== VaultState.Active);
  };
}

export { VaultState, VaultType };
