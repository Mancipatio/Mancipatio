// Super Admin and blocklist-authority rotation (propose / accept / cancel),
// v1.0.0-rc (8.3). Both are staged proposals with an expiry:
//
// * Platform: `AuthorityProposal` at ["authority_proposal", platform]. The
//   proposed key accepts inside [eta, expiresAt): eta = proposal + 48 h, waived
//   while the one-way bootstrap window is open; the window is 14 days. The
//   Super Admin, any live Admin or the program upgrade authority may cancel.
//   An accept is refused while a `PlatformRecovery` is pending (6155).
// * Blocklist: `BlocklistAuthorityProposal` at ["blocklist_authority_proposal"],
//   no timelock, acceptable for 14 days; only the live BA cancels. An accept
//   is refused while a `BlocklistRecovery` is pending (hook 6020).
//
// A proposal whose `current_authority` is not the live holder is STALE: an
// executed recovery retires a pending proposal by zeroing that field
// (`util::retire_pending_proposal`, hook `retire_pending`) instead of closing
// it. It can never be accepted, but it stays cancellable (rent to its
// proposer) and a new propose overwrites it (init_if_needed), so it is
// reported (`stale`), never thrown: only a proposal of the wrong owner or
// target throws.
//
// Every PDA comes from the generated clients.
import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  fetchMaybePlatformRecovery,
  findPlatformPda,
  findAcceptPlatformAdminTransferPda,
  findAcceptPlatformAdminRecoveryPda,
  fetchMaybeAuthorityProposal,
  getProposePlatformAdminInstructionAsync,
  getAcceptPlatformAdminInstructionAsync,
  getCancelPlatformAdminTransferInstructionAsync,
  findAdminRecordPda,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeBlocklistAuthority,
  fetchMaybeBlocklistRecovery,
  findBlocklistAuthorityPda,
  findRecoveryPda as findBlocklistRecoveryPda,
  findTransferPda,
  fetchMaybeBlocklistAuthorityProposal,
  getProposeBlocklistAuthorityInstructionAsync,
  getAcceptBlocklistAuthorityInstructionAsync,
  getCancelBlocklistAuthorityTransferInstructionAsync,
} from "@/lib/generated/transfer_hook";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
import { PLATFORM_BOOTSTRAP_OPEN } from "@/lib/pause-flags";
import { findProgramDataPda } from "@/lib/pdas";
export type OperationalAuthorityKind = "platform" | "blocklist";
type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
export type OperationalAuthorityState = {
  target: Address;
  current: Address;
  proposed: Address | null;
  proposal: Address;
  /** The staged proposal's payer (its rent returns here on cancel), or null. */
  proposedBy: Address | null;
  /**
   * When the staged proposal can first be accepted (unix s; the platform's
   * 48 h are waived while the bootstrap window is open), and when it stops
   * being acceptable. Null without a proposal.
   */
  eta: bigint | null;
  expiresAt: bigint | null;
  /**
   * A recovery by the program upgrade authority is pending against the live
   * authority: an accept is refused until it is cancelled or executed.
   */
  recoveryPending: boolean;
  /**
   * A proposal exists but is not bound to the live holder (retired by an
   * executed recovery, or made under an earlier holder): accept fails; it can
   * be cancelled or overwritten by a new proposal.
   */
  stale: boolean;
};

/** Accept refused: the proposal was retired by a recovery or predates the live holder. */
export const STALE_OPERATIONAL_PROPOSAL =
  "This proposal was retired by a recovery (or made under an earlier authority), so it can no longer be accepted. The current authority cancels it or proposes anew.";

/** Accept refused while a recovery is pending (registry 6155 / hook 6020). */
export const RECOVERY_PENDING_BLOCKER =
  "A recovery of this role by the program upgrade authority is pending. Cancel the recovery first (the \"Cancel the recovery\" button in its notice on /admin/platform or /account/roles; the current holder or the upgrade authority), or let it be executed; until then the proposal cannot be accepted.";

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
      }),
      [recoveryPda] = await findAcceptPlatformAdminRecoveryPda({
        platform: target,
      });
    const current = await fetchMaybePlatform(rpc, target, options);
    if (!current.exists) return null;
    if (current.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
      throw new Error("Unexpected platform owner");
    const [transfer, recovery] = await Promise.all([
      fetchMaybeAuthorityProposal(rpc, proposal, options),
      fetchMaybePlatformRecovery(rpc, recoveryPda, options),
    ]);
    if (
      transfer.exists &&
      (transfer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        transfer.data.target !== target)
    )
      throw new Error("The platform authority proposal is invalid");
    // accept_platform_admin needs current_authority == Platform.admin (and
    // proposed_by, which propose always writes equal to it).
    const stale = transfer.exists && transfer.data.currentAuthority !== current.data.admin;
    const bootstrapOpen =
      ((current.data.pauseFlags ?? 0) & PLATFORM_BOOTSTRAP_OPEN) !== 0;
    return {
      target,
      current: current.data.admin,
      proposal,
      proposed: transfer.exists ? transfer.data.newAuthority : null,
      proposedBy: transfer.exists ? transfer.data.proposedBy : null,
      eta: transfer.exists
        ? bootstrapOpen
          ? transfer.data.proposedAt
          : transfer.data.eta
        : null,
      expiresAt: transfer.exists ? transfer.data.expiresAt : null,
      recoveryPending:
        recovery.exists &&
        recovery.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
        recovery.data.platform === target &&
        recovery.data.currentAdmin === current.data.admin,
      stale,
    };
  }
  const [target] = await findBlocklistAuthorityPda(),
    [proposal] = await findTransferPda(),
    [recoveryPda] = await findBlocklistRecoveryPda();
  const current = await fetchMaybeBlocklistAuthority(rpc, target, options);
  if (!current.exists) return null;
  if (current.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS)
    throw new Error("Unexpected blocklist authority owner");
  const [transfer, recovery] = await Promise.all([
    fetchMaybeBlocklistAuthorityProposal(rpc, proposal, options),
    fetchMaybeBlocklistRecovery(rpc, recoveryPda, options),
  ]);
  if (transfer.exists && transfer.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS)
    throw new Error("The blocklist authority proposal is invalid");
  return {
    target,
    current: current.data.authority,
    proposal,
    proposed: transfer.exists ? transfer.data.newAuthority : null,
    // The BA proposal's rent returns to the live authority on cancel.
    proposedBy: transfer.exists ? current.data.authority : null,
    eta: transfer.exists ? transfer.data.proposedAt : null,
    expiresAt: transfer.exists ? transfer.data.expiresAt : null,
    recoveryPending:
      recovery.exists &&
      recovery.programAddress === TRANSFER_HOOK_PROGRAM_ADDRESS &&
      recovery.data.currentAuthority === current.data.authority,
    // accept_blocklist_authority: current_authority == BlocklistAuthority.authority.
    stale: transfer.exists && transfer.data.currentAuthority !== current.data.authority,
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
  if (state.stale) throw new Error(STALE_OPERATIONAL_PROPOSAL);
  if (state.recoveryPending) throw new Error(RECOVERY_PENDING_BLOCKER);
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

/**
 * Withdraws a staged rotation (live, stale — retired by a recovery — or
 * expired). Platform: the Super Admin, any live Admin or the program upgrade
 * authority signs (the program checks which; the rent returns to the
 * proposer). Blocklist: only the live blocklist authority (the rent returns
 * to it).
 */
export async function buildCancelOperationalAuthority(
  rpc: Rpc,
  kind: OperationalAuthorityKind,
  signer: TransactionSigner,
) {
  const state = await loadOperationalAuthority(rpc, kind);
  if (!state?.proposed || !state.proposedBy)
    throw new Error("No authority proposal is staged");
  if (kind === "blocklist") {
    if (state.current !== signer.address)
      throw new Error(`Connect the blocklist authority (current: ${state.current}) to cancel its proposal`);
    return getCancelBlocklistAuthorityTransferInstructionAsync({
      authority: signer,
      blocklistAuthority: state.target,
      transfer: state.proposal,
    });
  }
  return getCancelPlatformAdminTransferInstructionAsync({
    canceller: signer,
    platform: state.target,
    transfer: state.proposal,
    proposer: state.proposedBy,
    programData: await findProgramDataPda(ASSET_REGISTRY_PROGRAM_ADDRESS),
  });
}
