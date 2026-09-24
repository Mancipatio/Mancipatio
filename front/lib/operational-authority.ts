import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
  findAcceptPlatformAdminTransferPda,
  fetchMaybeAuthorityTransfer,
  getProposePlatformAdminInstructionAsync,
  getAcceptPlatformAdminInstructionAsync,
  findAdminRecordPda,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeBlocklistAuthority,
  findBlocklistAuthorityPda,
  findTransferPda,
  fetchMaybeBlocklistAuthorityTransfer,
  getProposeBlocklistAuthorityInstructionAsync,
  getAcceptBlocklistAuthorityInstructionAsync,
} from "@/lib/generated/transfer_hook";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
export type OperationalAuthorityKind = "platform" | "blocklist";
type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
export type OperationalAuthorityState = {
  target: Address;
  current: Address;
  proposed: Address | null;
  proposal: Address;
};
export async function loadOperationalAuthority(
  rpc: Rpc,
  kind: OperationalAuthorityKind,
): Promise<OperationalAuthorityState | null> {
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(10_000),
  };
  if (kind === "platform") {
    const [target] = await findPlatformPda(),
      [proposal] = await findAcceptPlatformAdminTransferPda({
        platform: target,
      });
    const current = await fetchMaybePlatform(rpc, target, options);
    if (!current.exists) return null;
    if (current.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
      throw new Error("Unexpected platform owner");
    const transfer = await fetchMaybeAuthorityTransfer(rpc, proposal, options);
    if (
      transfer.exists &&
      (transfer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        transfer.data.target !== target ||
        transfer.data.currentAuthority !== current.data.admin)
    )
      throw new Error("The platform authority proposal is stale or invalid");
    return {
      target,
      current: current.data.admin,
      proposal,
      proposed: transfer.exists ? transfer.data.newAuthority : null,
    };
  }
  const [target] = await findBlocklistAuthorityPda(),
    [proposal] = await findTransferPda();
  const current = await fetchMaybeBlocklistAuthority(rpc, target, options);
  if (!current.exists) return null;
  if (current.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS)
    throw new Error("Unexpected blocklist authority owner");
  const transfer = await fetchMaybeBlocklistAuthorityTransfer(
    rpc,
    proposal,
    options,
  );
  if (
    transfer.exists &&
    (transfer.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS ||
      transfer.data.currentAuthority !== current.data.authority)
  )
    throw new Error("The blocklist authority proposal is stale or invalid");
  return {
    target,
    current: current.data.authority,
    proposal,
    proposed: transfer.exists ? transfer.data.newAuthority : null,
  };
}
/**
 * Refuses unless `signer` is the live blocklist authority (Talas 3.1 K7/K8):
 * the BlocklistAuthority singleton read at `finalized`, owner-checked. Every
 * blocklist change and hook-mode change calls it before building, so a wallet
 * that merely looks like the authority in the UI (a confirmed-but-not-
 * finalized rotation, a stale page) never signs a transaction the hook must
 * reject. Returns the authority.
 */
export async function assertBlocklistAuthority(
  rpc: Rpc,
  signer: TransactionSigner | Address,
): Promise<Address> {
  const [pda] = await findBlocklistAuthorityPda();
  const current = await fetchMaybeBlocklistAuthority(rpc, pda, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(10_000),
  });
  if (!current.exists)
    throw new Error("The blocklist authority is not initialized on this network");
  if (current.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS)
    throw new Error("Unexpected blocklist authority owner");
  const wallet = typeof signer === "string" ? signer : signer.address;
  if (current.data.authority !== wallet)
    throw new Error(`Connect the blocklist authority (current: ${current.data.authority})`);
  return current.data.authority;
}
export async function buildProposeOperationalAuthority(
  rpc: Rpc,
  kind: OperationalAuthorityKind,
  signer: TransactionSigner,
  newAuthority: string,
) {
  const next = address(newAuthority);
  // validate_new_authority rejects Pubkey::default(); refuse before signing.
  if (next === DEFAULT_ADDRESS)
    throw new Error("The default 1111…1111 address cannot be an authority");
  const state = await loadOperationalAuthority(rpc, kind);
  if (!state || state.current !== signer.address)
    throw new Error(
      "Only the current operational authority can propose this change",
    );
  if (next === state.current)
    throw new Error("Choose a different authority wallet");
  return kind === "platform"
    ? getProposePlatformAdminInstructionAsync({
        authority: signer,
        platform: state.target,
        transfer: state.proposal,
        newAdmin: next,
      })
    : getProposeBlocklistAuthorityInstructionAsync({
        authority: signer,
        blocklistAuthority: state.target,
        transfer: state.proposal,
        newAuthority: next,
      });
}
/**
 * Appended when a builder's finalized re-read does not (yet) show the
 * proposal /account/roles listed at `confirmed` (~15–30 s behind).
 */
export const PROPOSAL_NOT_FINALIZED_HINT =
  "a new proposal may not be finalized yet — retry in about 30 s";

export async function buildAcceptOperationalAuthority(
  rpc: Rpc,
  kind: OperationalAuthorityKind,
  signer: TransactionSigner,
) {
  const state = await loadOperationalAuthority(rpc, kind);
  if (!state?.proposed || state.proposed !== signer.address)
    throw new Error(
      `Connect the proposed new authority wallet to accept this change (${PROPOSAL_NOT_FINALIZED_HINT})`,
    );
  if (kind === "blocklist")
    return getAcceptBlocklistAuthorityInstructionAsync({
      newAuthority: signer,
      blocklistAuthority: state.target,
      transfer: state.proposal,
    });
  const [oldAdminRecord] = await findAdminRecordPda({
    authority: state.current,
  });
  return getAcceptPlatformAdminInstructionAsync({
    newAdmin: signer,
    platform: state.target,
    transfer: state.proposal,
    oldAdminRecord,
  });
}
