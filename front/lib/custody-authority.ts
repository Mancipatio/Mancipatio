import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAdminRecordPda,
  findPlatformPda,
  fetchMaybePlatform,
  findTransferPda,
  fetchMaybeAuthorityProposal,
  fetchMaybeAdmin,
  getProposeCustodyAuthorityInstructionAsync,
  getAcceptCustodyAuthorityInstructionAsync,
  getCancelCustodyAuthorityTransferInstructionAsync,
  VaultState,
} from "@/lib/generated/asset_registry";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { findCustodyVaultPda } from "@/lib/pdas";
import { PROPOSAL_NOT_FINALIZED_HINT } from "@/lib/operational-authority";
/** Bind the proof to the vault's current operator. The PDA may be absent after
 * revocation: permissionless deadline returns must still be constructible. */
export async function custodyAuthorityRecord(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
) {
  const vault = await fetchMaybeLiveCustodyVault(rpc, vaultPda, {
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

// ── Custody operator rotation (Talas 3.1 K10) ───────────────────────────────
//
// `accept_custody_authority` requires the vault to be Active or Triggered,
// `transfer.current_authority == vault.authority`, `transfer.proposed_by ==
// platform.admin` and, since v1.0.0-rc, a proposal younger than 14 days
// (`AuthorityProposal.expires_at`, ProposalExpired 6151). A proposal made
// before the vault operator or the Super Admin changed is therefore STALE: it
// can never be accepted; the Super Admin re-proposes (overwriting it) or it is
// cancelled — by the Super Admin, or by the vault's current operator while it
// holds a live Admin record. A stale proposal is reported, not thrown; a
// proposal of the wrong owner or target still throws.

/** Accept (and propose) need the vault in one of these states. */
export function isCustodyRotatable(state: VaultState): boolean {
  return state === VaultState.Active || state === VaultState.Triggered;
}

export const CUSTODY_STALE_PROPOSAL =
  "Proposal is stale — the Super Admin must re-propose";
export const CUSTODY_EXPIRED_PROPOSAL =
  "Proposal expired (14 days) — the Super Admin must re-propose, or cancel it";

/**
 * Why the proposed wallet cannot accept custody responsibility now, or null.
 * Mirrors the `accept_custody_authority` constraints (the acceptor's live
 * Admin record included).
 */
export function custodyAcceptBlocker(p: {
  stale: boolean;
  vaultState: VaultState;
  acceptorIsAdmin: boolean;
  /** Chain time is at or past the proposal's `expires_at` (unknown: false; the program decides). */
  expired?: boolean;
}): string | null {
  if (!isCustodyRotatable(p.vaultState))
    return `The vault is ${VaultState[p.vaultState] ?? "closed"}; custody responsibility can move only while it is Active or Triggered.`;
  if (p.stale) return CUSTODY_STALE_PROPOSAL;
  if (p.expired) return CUSTODY_EXPIRED_PROPOSAL;
  if (!p.acceptorIsAdmin)
    return "This wallet needs an active Admin record before it can accept custody responsibility.";
  return null;
}

type Rpc = Parameters<typeof fetchMaybeLiveCustodyVault>[0];

export type CustodyAuthorityState = {
  vaultPda: Address;
  platformPda: Address;
  transferPda: Address;
  /** The vault's live operator. */
  current: Address;
  superAdmin: Address;
  vaultState: VaultState;
  /** The staged operator, or null. */
  proposed: Address | null;
  proposedBy: Address | null;
  /** When the staged proposal stops being acceptable (unix s), or null. */
  expiresAt: bigint | null;
  /**
   * A proposal exists but accept would fail: the vault operator or the Super
   * Admin changed after it was made. The Super Admin re-proposes.
   */
  stale: boolean;
};

export async function loadCustodyAuthority(
  rpc: Rpc,
  vaultPda: Address,
): Promise<CustodyAuthorityState> {
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(10_000),
  };
  const [platformPda] = await findPlatformPda(),
    [transferPda] = await findTransferPda({ custodyVault: vaultPda });
  const [vault, platform, transfer] = await Promise.all([
    fetchMaybeLiveCustodyVault(rpc, vaultPda, options),
    fetchMaybePlatform(rpc, platformPda, options),
    fetchMaybeAuthorityProposal(rpc, transferPda, options),
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
      transfer.data.target !== vaultPda)
  )
    throw new Error("Custody authority proposal is invalid");
  const stale =
    transfer.exists &&
    (transfer.data.proposedBy !== platform.data.admin ||
      transfer.data.currentAuthority !== vault.data.authority);
  return {
    vaultPda,
    platformPda,
    transferPda,
    current: vault.data.authority,
    superAdmin: platform.data.admin,
    vaultState: vault.data.state,
    proposed: transfer.exists ? transfer.data.newAuthority : null,
    proposedBy: transfer.exists ? transfer.data.proposedBy : null,
    expiresAt: transfer.exists ? transfer.data.expiresAt : null,
    stale,
  };
}

/**
 * `cancel_custody_authority_transfer`: withdraws a staged custody rotation
 * (live, stale or expired). The Super Admin may always cancel; the vault's
 * current operator only while it holds a live Admin record (an operator
 * removed for cause cannot block its own replacement). The rent returns to
 * the proposer.
 */
export async function buildCancelCustodyAuthorityTransfer(
  rpc: Rpc,
  vaultPda: Address,
  signer: TransactionSigner,
) {
  const state = await loadCustodyAuthority(rpc, vaultPda);
  if (!state.proposed || !state.proposedBy)
    throw new Error("No custody operator proposal is staged for this vault");
  if (signer.address !== state.superAdmin) {
    if (signer.address !== state.current)
      throw new Error(
        "Only the Super Admin or the vault's current custody operator can cancel this proposal",
      );
    const [record] = await findAdminRecordPda({ authority: signer.address });
    const admin = await fetchMaybeAdmin(rpc, record, {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(8_000),
    });
    if (
      !admin.exists ||
      admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      admin.data.admin !== signer.address
    )
      throw new Error(
        "The custody operator can cancel only while it holds a live Admin role; ask the Super Admin",
      );
  }
  return getCancelCustodyAuthorityTransferInstructionAsync({
    canceller: signer,
    platform: state.platformPda,
    custodyVault: vaultPda,
    transfer: state.transferPda,
    proposer: state.proposedBy,
  });
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
  if (!isCustodyRotatable(state.vaultState))
    throw new Error(
      "Custody responsibility can move only while the vault is Active or Triggered",
    );
  if (action === "propose" && state.superAdmin !== signer.address)
    throw new Error(
      "Only the current Super Admin may propose a custody operator",
    );
  if (action === "accept" && state.proposed !== signer.address)
    throw new Error(`Connect the proposed custody operator to accept (${PROPOSAL_NOT_FINALIZED_HINT})`);
  if (action === "accept" && state.stale)
    throw new Error(CUSTODY_STALE_PROPOSAL);
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
