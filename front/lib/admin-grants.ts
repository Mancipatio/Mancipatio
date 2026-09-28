// Admin grants behind the 48 h timelock (D3, v1.0.0-rc):
//
// 1. `propose_admin(new_admin)` — the Super Admin stages a `PendingAdmin` at
//    ["pending_admin", new_admin] (the key must not hold the role yet);
// 2. `add_admin(new_admin)` — the EXECUTOR: the new admin key itself signs
//    (proof of possession) inside [eta, expiresAt), while the proposer is
//    still the Super Admin. The 48 h are waived while the bootstrap window is
//    open; a proposal expires 14 days after its eta;
// 3. `cancel_admin_proposal()` — the Super Admin, any live Admin or the
//    program upgrade authority (the veto a compromised Super Admin cannot
//    remove). The rent returns to the proposer.
//
// `remove_admin` stays instant. Every PDA comes from the generated client.
import {
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAdmin,
  fetchMaybePendingAdmin,
  fetchMaybePlatform,
  findAdminRecordPda,
  findPendingAdminPda,
  findPlatformPda,
  getAddAdminInstructionAsync,
  getCancelAdminProposalInstructionAsync,
  getPendingAdminDecoder,
  getPendingAdminDiscriminatorBytes,
  getPendingAdminSize,
  getProposeAdminInstructionAsync,
  type PendingAdmin,
} from "@/lib/generated/asset_registry";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
import { findProgramDataPda } from "@/lib/pdas";
import { PROPOSAL_NOT_FINALIZED_HINT } from "@/lib/operational-authority";

type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
const finalized = () => ({ commitment: "finalized" as const, abortSignal: AbortSignal.timeout(10_000) });

export type PendingAdminRecord = PendingAdmin & {
  address: Address;
  /** Proposed by an earlier Super Admin: `add_admin` refuses it (InvalidAdminProposal); cancel it. */
  stale: boolean;
  /**
   * The Platform's pause flags when this was read: while the one-way
   * bootstrap window (bit 7) is open, `add_admin` runs from `proposed_at`
   * (`util::effective_eta`), so a page judges the window with
   * `proposalWindowState(p, now, { pauseFlags: p.platformPauseFlags, bootstrapWaived: true })`.
   */
  platformPauseFlags: number;
};

/** Refusal copy when a proposal from an earlier Super Admin is executed. */
export const STALE_ADMIN_PROPOSAL =
  "Proposed by an earlier Super Admin, so it can no longer be executed. Cancel it; the current Super Admin proposes again if the grant is still wanted.";

async function platformAdmin(rpc: Rpc): Promise<{ platform: Address; admin: Address; pauseFlags: number }> {
  const [platform] = await findPlatformPda();
  const account = await fetchMaybePlatform(rpc, platform, finalized());
  if (!account.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
    throw new Error("The platform is not initialized on this network");
  return { platform, admin: account.data.admin, pauseFlags: account.data.pauseFlags };
}

/** The staged grant for `newAdmin`, or null (read at finalized). */
export async function loadPendingAdmin(rpc: Rpc, newAdmin: Address): Promise<PendingAdminRecord | null> {
  const [[pda], { admin, pauseFlags }] = await Promise.all([findPendingAdminPda({ newAdmin }), platformAdmin(rpc)]);
  const pending = await fetchMaybePendingAdmin(rpc, pda, finalized());
  if (!pending.exists) return null;
  if (pending.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || pending.data.newAdmin !== newAdmin)
    throw new Error("The pending Admin grant is invalid");
  return { ...pending.data, address: pda, stale: pending.data.proposedBy !== admin, platformPauseFlags: pauseFlags };
}

/**
 * Every staged Admin grant (getProgramAccounts: discriminator + size 98), for
 * the Super Admin's pending list. Proposals of earlier Super Admins are
 * flagged `stale` (K1.10: cancel them after any Super Admin change).
 */
export async function listPendingAdmins(rpc: Rpc): Promise<PendingAdminRecord[]> {
  const { admin, pauseFlags } = await platformAdmin(rpc);
  const disc = getPendingAdminDiscriminatorBytes();
  const records = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { memcmp: { offset: BigInt(0), encoding: "base58", bytes: getBase58Decoder().decode(Uint8Array.from(disc)) as Base58EncodedBytes } },
        { dataSize: BigInt(getPendingAdminSize()) },
      ],
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  const base64 = getBase64Encoder();
  const out: PendingAdminRecord[] = [];
  for (const r of records) {
    if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) continue;
    try {
      const data = getPendingAdminDecoder().decode(Uint8Array.from(base64.encode(r.account.data[0])));
      if (r.pubkey !== (await findPendingAdminPda({ newAdmin: data.newAdmin }))[0]) continue;
      out.push({ ...data, address: r.pubkey, stale: data.proposedBy !== admin, platformPauseFlags: pauseFlags });
    } catch {
      // Not a PendingAdmin of this layout: never listed.
    }
  }
  return out.sort((a, b) => Number(a.eta - b.eta));
}

/**
 * `propose_admin(new_admin)`, signed by the live Super Admin. The key must
 * not hold an Admin record yet (the program refuses it with
 * InvalidProposedAuthority). A re-proposal restarts both clocks.
 */
export async function buildProposeAdmin(rpc: Rpc, signer: TransactionSigner, newAdmin: Address) {
  if (newAdmin === DEFAULT_ADDRESS) throw new Error("The default 1111…1111 address cannot be an Admin");
  const { admin } = await platformAdmin(rpc);
  if (admin !== signer.address) throw new Error(`Only the Super Admin (${admin}) can propose an Admin`);
  const [record] = await findAdminRecordPda({ authority: newAdmin });
  const existing = await fetchMaybeAdmin(rpc, record, finalized());
  if (existing.exists) throw new Error("This wallet already holds the Admin role: nothing to propose");
  return getProposeAdminInstructionAsync({ superAdmin: signer, newAdmin });
}

/**
 * `add_admin`, signed by the PROPOSED key itself (it pays its Admin record):
 * the grant must be staged by the live Super Admin; the window is enforced
 * on-chain (TimelockActive 6150 / ProposalExpired 6151).
 */
export async function buildAddAdmin(rpc: Rpc, signer: TransactionSigner) {
  const pending = await loadPendingAdmin(rpc, signer.address);
  if (!pending)
    throw new Error(`No Admin grant is staged for this wallet (${PROPOSAL_NOT_FINALIZED_HINT}).`);
  if (pending.stale) throw new Error(STALE_ADMIN_PROPOSAL);
  return getAddAdminInstructionAsync({
    newAdmin: signer,
    pendingAdmin: pending.address,
    proposer: pending.proposedBy,
    newAdminArg: signer.address,
  });
}

/**
 * `cancel_admin_proposal`: the Super Admin, any live Admin or the program
 * upgrade authority withdraws a staged grant (live, stale or expired); the
 * program checks which. The rent returns to the proposer.
 */
export async function buildCancelAdminProposal(rpc: Rpc, signer: TransactionSigner, newAdmin: Address) {
  const pending = await loadPendingAdmin(rpc, newAdmin);
  if (!pending) throw new Error("No Admin grant is staged for this wallet");
  return getCancelAdminProposalInstructionAsync({
    canceller: signer,
    pendingAdmin: pending.address,
    proposer: pending.proposedBy,
    programData: await findProgramDataPda(ASSET_REGISTRY_PROGRAM_ADDRESS),
  });
}
