import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeCustodyVault,
  findAdminRecordPda,
  findPlatformPda,
  fetchMaybePlatform,
  findTransferPda,
  fetchMaybeAuthorityTransfer,
  fetchMaybeAdmin,
  getProposeCustodyAuthorityInstructionAsync,
  getAcceptCustodyAuthorityInstructionAsync,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";
/** Bind the proof to the vault's current operator. The PDA may be absent after
 * revocation: permissionless deadline returns must still be constructible. */
export async function custodyAuthorityRecord(
  rpc: Parameters<typeof fetchMaybeCustodyVault>[0],
  vaultPda: Address,
) {
  const vault = await fetchMaybeCustodyVault(rpc, vaultPda, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(8_000),
  });
  if (
    !vault.exists ||
    vault.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    (await findCustodyVaultPda(vault.data.shareClass, vault.data.vaultId)) !==
      vaultPda
  )
    throw new Error("Custody vault identity could not be verified");
  const [record] = await findAdminRecordPda({
    authority: vault.data.authority,
  });
  return record;
}

type Rpc = Parameters<typeof fetchMaybeCustodyVault>[0];
export async function loadCustodyAuthority(rpc: Rpc, vaultPda: Address) {
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(10_000),
  };
  const [platformPda] = await findPlatformPda(),
    [transferPda] = await findTransferPda({ custodyVault: vaultPda });
  const [vault, platform, transfer] = await Promise.all([
    fetchMaybeCustodyVault(rpc, vaultPda, options),
    fetchMaybePlatform(rpc, platformPda, options),
    fetchMaybeAuthorityTransfer(rpc, transferPda, options),
  ]);
  if (
    !vault.exists ||
    vault.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    (await findCustodyVaultPda(vault.data.shareClass, vault.data.vaultId)) !==
      vaultPda ||
    !platform.exists ||
    platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
  )
    throw new Error("Custody authority could not be verified");
  if (
    transfer.exists &&
    (transfer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      transfer.data.target !== vaultPda ||
      transfer.data.currentAuthority !== vault.data.authority)
  )
    throw new Error("Custody authority proposal is stale or invalid");
  return {
    vaultPda,
    platformPda,
    transferPda,
    current: vault.data.authority,
    superAdmin: platform.data.admin,
    proposed: transfer.exists ? transfer.data.newAuthority : null,
  };
}
export async function buildCustodyAuthorityChange(
  rpc: Rpc,
  vaultPda: Address,
  signer: TransactionSigner,
  action: "propose" | "accept",
  next?: string,
) {
  const state = await loadCustodyAuthority(rpc, vaultPda);
  const newAuthority =
    action === "propose" ? address(next ?? "") : signer.address;
  if (action === "propose" && state.superAdmin !== signer.address)
    throw new Error(
      "Only the current Super Admin may propose a custody operator",
    );
  if (action === "accept" && state.proposed !== signer.address)
    throw new Error("Connect the proposed custody operator to accept");
  if (newAuthority === state.current)
    throw new Error("Choose a different custody operator");
  const [newAdminRecord] = await findAdminRecordPda({
    authority: newAuthority,
  });
  const admin = await fetchMaybeAdmin(rpc, newAdminRecord, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(8_000),
  });
  if (
    !admin.exists ||
    admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    admin.data.admin !== newAuthority
  )
    throw new Error(
      "The replacement custody operator must have a current Admin role",
    );
  return action === "propose"
    ? getProposeCustodyAuthorityInstructionAsync({
        superAdmin: signer,
        platform: state.platformPda,
        custodyVault: vaultPda,
        newAdminRecord,
        transfer: state.transferPda,
        newAuthority,
      })
    : getAcceptCustodyAuthorityInstructionAsync({
        newAuthority: signer,
        platform: state.platformPda,
        custodyVault: vaultPda,
        newAdminRecord,
        transfer: state.transferPda,
      });
}
