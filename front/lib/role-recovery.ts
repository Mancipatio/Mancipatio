// Recovery of a LOST Super Admin or blocklist-authority key by the program
// upgrade authority (D4, v1.0.0-rc):
//
// * propose — the upgrade authority (normally the multisig, through the
//   Squads export) stages `PlatformRecovery` ["platform_recovery", platform] /
//   hook `BlocklistRecovery` ["blocklist_recovery"], executable after 7 days
//   for 14 days; a re-proposal restarts both clocks;
// * cancel — the current holder of the role (a key that was not lost) or the
//   proposer; in the `incident` build only the proposer;
// * execute — the recovered key signs inside [eta, expiresAt) while the role
//   is still the one proposed against. A pending rotation is retired.
//
// While a recovery is pending the role cannot be rotated (registry 6155 /
// hook 6020): cancel the recovery first. Every PDA comes from the generated
// clients; ProgramData is the loader's.
import type { Address, TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  fetchMaybePlatformRecovery,
  findAcceptPlatformAdminRecoveryPda,
  findAdminRecordPda,
  findPlatformPda,
  getCancelPlatformRecoveryInstructionAsync,
  getExecutePlatformRecoveryInstructionAsync,
  getProposePlatformRecoveryInstructionAsync,
  type PlatformRecovery,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeBlocklistAuthority,
  fetchMaybeBlocklistRecovery,
  findBlocklistAuthorityPda,
  findRecoveryPda as findBlocklistRecoveryPda,
  getCancelBlocklistRecoveryInstructionAsync,
  getExecuteBlocklistRecoveryInstructionAsync,
  getProposeBlocklistRecoveryInstructionAsync,
  type BlocklistRecovery,
} from "@/lib/generated/transfer_hook";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
import { findProgramDataPda } from "@/lib/pdas";
import { proposalWindowState, type ProposalWindowState } from "@/lib/proposal-window";

type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
export type RecoveryKind = "platform" | "blocklist";
const finalized = () => ({ commitment: "finalized" as const, abortSignal: AbortSignal.timeout(10_000) });

export type RoleRecoveryState = {
  kind: RecoveryKind;
  /** The Platform PDA or the BlocklistAuthority PDA. */
  target: Address;
  /** The live holder of the role. */
  current: Address;
  recoveryPda: Address;
  /** The staged recovery, or null. */
  recovery: (PlatformRecovery | BlocklistRecovery) | null;
  /**
   * The recovery names another holder than the live one (the role moved
   * since): execute fails; a cancel still works.
   */
  stale: boolean;
};

export async function loadRoleRecovery(rpc: Rpc, kind: RecoveryKind): Promise<RoleRecoveryState | null> {
  if (kind === "platform") {
    const [target] = await findPlatformPda();
    const [recoveryPda] = await findAcceptPlatformAdminRecoveryPda({ platform: target });
    const platform = await fetchMaybePlatform(rpc, target, finalized());
    if (!platform.exists) return null;
    if (platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected platform owner");
    const r = await fetchMaybePlatformRecovery(rpc, recoveryPda, finalized());
    const recovery = r.exists && r.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS && r.data.platform === target ? r.data : null;
    return {
      kind,
      target,
      current: platform.data.admin,
      recoveryPda,
      recovery,
      stale: recovery !== null && recovery.currentAdmin !== platform.data.admin,
    };
  }
  const [target] = await findBlocklistAuthorityPda();
  const [recoveryPda] = await findBlocklistRecoveryPda();
  const ba = await fetchMaybeBlocklistAuthority(rpc, target, finalized());
  if (!ba.exists) return null;
  if (ba.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS) throw new Error("Unexpected blocklist authority owner");
  const r = await fetchMaybeBlocklistRecovery(rpc, recoveryPda, finalized());
  const recovery = r.exists && r.programAddress === TRANSFER_HOOK_PROGRAM_ADDRESS ? r.data : null;
  return {
    kind,
    target,
    current: ba.data.authority,
    recoveryPda,
    recovery,
    stale: recovery !== null && recovery.currentAuthority !== ba.data.authority,
  };
}

const newKeyOf = (r: PlatformRecovery | BlocklistRecovery) => ("newAdmin" in r ? r.newAdmin : r.newAuthority);

/**
 * `propose_platform_recovery` / `propose_blocklist_recovery`, signed by the
 * program upgrade authority (the program checks ProgramData). On a multisig
 * upgrade authority this goes through the Squads export instead.
 */
export async function buildProposeRoleRecovery(
  rpc: Rpc,
  kind: RecoveryKind,
  signer: TransactionSigner,
  newKey: Address,
) {
  if (newKey === DEFAULT_ADDRESS) throw new Error("The default 1111…1111 address cannot hold a role");
  const state = await loadRoleRecovery(rpc, kind);
  if (!state) throw new Error("The role is not initialized on this network");
  if (newKey === state.current) throw new Error("Choose a key other than the current holder");
  return kind === "platform"
    ? getProposePlatformRecoveryInstructionAsync({
        upgradeAuthority: signer,
        platform: state.target,
        recovery: state.recoveryPda,
        programData: await findProgramDataPda(ASSET_REGISTRY_PROGRAM_ADDRESS),
        newAdmin: newKey,
      })
    : getProposeBlocklistRecoveryInstructionAsync({
        upgradeAuthority: signer,
        blocklistAuthority: state.target,
        recovery: state.recoveryPda,
        programData: await findProgramDataPda(TRANSFER_HOOK_PROGRAM_ADDRESS),
        newAuthority: newKey,
      });
}

/** Cancel: the live holder of the role or the proposer (the program decides which build allows whom). */
export async function buildCancelRoleRecovery(rpc: Rpc, kind: RecoveryKind, signer: TransactionSigner) {
  const state = await loadRoleRecovery(rpc, kind);
  if (!state?.recovery) throw new Error("No recovery is pending");
  if (signer.address !== state.current && signer.address !== state.recovery.proposedBy)
    throw new Error("Only the current holder of the role or the upgrade authority that proposed it can cancel a recovery");
  return kind === "platform"
    ? getCancelPlatformRecoveryInstructionAsync({
        canceller: signer,
        platform: state.target,
        recovery: state.recoveryPda,
        proposer: state.recovery.proposedBy,
      })
    : getCancelBlocklistRecoveryInstructionAsync({
        canceller: signer,
        blocklistAuthority: state.target,
        recovery: state.recoveryPda,
        proposer: state.recovery.proposedBy,
      });
}

/** Execute: signed by the recovered key; the window is enforced on-chain (6150 / 6151, hook 6018 / 6017). */
export async function buildExecuteRoleRecovery(rpc: Rpc, kind: RecoveryKind, signer: TransactionSigner) {
  const state = await loadRoleRecovery(rpc, kind);
  if (!state?.recovery) throw new Error("No recovery is pending");
  if (newKeyOf(state.recovery) !== signer.address) throw new Error("Connect the recovered key named by the recovery");
  if (state.stale)
    throw new Error("The role moved after this recovery was proposed, so it can no longer be executed. Cancel it.");
  if (kind === "platform") {
    const [oldAdminRecord] = await findAdminRecordPda({ authority: state.current });
    return getExecutePlatformRecoveryInstructionAsync({
      newAdmin: signer,
      platform: state.target,
      recovery: state.recoveryPda,
      proposer: state.recovery.proposedBy,
      programData: await findProgramDataPda(ASSET_REGISTRY_PROGRAM_ADDRESS),
      oldAdminRecord,
    });
  }
  return getExecuteBlocklistRecoveryInstructionAsync({
    newAuthority: signer,
    blocklistAuthority: state.target,
    recovery: state.recoveryPda,
    proposer: state.recovery.proposedBy,
    programData: await findProgramDataPda(TRANSFER_HOOK_PROGRAM_ADDRESS),
  });
}

export type RoleRecoveryNotice = {
  title: string;
  /** The key the recovery hands the role to. */
  newKey: Address;
  window: ProposalWindowState;
  /** Shown to everyone: the role cannot rotate while this is pending. */
  blocked: string;
  /** Who may cancel, in words. */
  cancelers: string;
  /** Whether the connected wallet may cancel it (current holder or proposer). */
  canCancel: boolean;
  /** Whether the connected wallet is the recovered key (it executes at /account/roles). */
  isNewKey: boolean;
};

/**
 * What /account/roles shows about a pending recovery (pure). The window is
 * the recovery's own [eta, expiresAt): 7 days, never waived by the bootstrap
 * window. A cancel is refused in the `incident` build for anyone but the
 * proposer; the program decides.
 */
export function describeRoleRecovery(
  state: RoleRecoveryState | null,
  wallet: Address | null,
  nowSec: number,
): RoleRecoveryNotice | null {
  if (!state?.recovery) return null;
  const r = state.recovery;
  const role = state.kind === "platform" ? "Super Admin" : "blocklist authority";
  const newKey = newKeyOf(r);
  return {
    title: `Recovery of the ${role} key pending`,
    newKey,
    window: proposalWindowState(r, nowSec),
    blocked: state.stale
      ? `This recovery was proposed against an earlier ${role} and can no longer be executed; until it is cancelled, the ${role} role cannot be rotated.`
      : `While this recovery is pending, the ${role} role cannot be rotated (no new proposal, no accept). Cancel the recovery first, or let the recovered key execute it.`,
    cancelers: `The current ${role} (${state.current}) or the upgrade authority that proposed it (${r.proposedBy}) can cancel it; the upgrade authority acts through the CLI / Squads export. In the incident build only the proposer can.`,
    canCancel: wallet !== null && (wallet === state.current || wallet === r.proposedBy),
    isNewKey: wallet !== null && wallet === newKey,
  };
}
