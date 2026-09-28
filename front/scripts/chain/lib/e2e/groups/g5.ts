/**
 * G5: distributions, vesting, rights, governance and the payout vault
 * (design-6.3 §A G5, v1.0.0-rc).
 *
 * Both networks: a canonical-plan distribution (create, one batch, close), a
 * claim-mode vesting series on class A (refused before its unlock, 6100), a
 * governance proposal (a proof for another weight is refused, 6030; an
 * early finalize, 6031). Localnet adds the payout / Merkle modules, off on
 * mainnet (PAUSE_PAYOUT_MODULES, 0x40): with the bit set a Startup sale and
 * a rights issuance are refused (6000); the Super Admin clears it on its own;
 * a rights issuance with a milestone (refused before its unlock, 6032), a
 * Startup raise into a payout vault whose freeze is refused while nothing is
 * overdue (6038). One clock move (a warp on localnet, a wait on devnet) then
 * runs the "after" steps: the vesting claim, the finalize, the milestone
 * claim, the freeze after three missed monthly updates, and a vault vote
 * that must run at least 7 days (6147). An Admin sets 0x40 again at the end.
 */
import { AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import {
  DistributionStatus,
  PayoutVaultState,
  ProposalStatus,
  RaiseType,
  VestingSeriesStatus,
  VoteChoice,
  fetchMaybeDistribution,
  fetchMaybePayoutVault,
  fetchMaybeProposal,
  fetchMaybeRightsIssuance,
  fetchMaybeSale,
  fetchMaybeVestingPosition,
  fetchMaybeVestingSeries,
  fetchPlatform,
  fetchSale,
  findCreateVestingSeriesEscrowPda,
  findCreateVestingSeriesIdentityPda,
  findDistributionPda,
  findPlatformPda,
  findPositionPda,
  findSaleApprovalPda,
  findSeriesPda,
  findVaultPda,
  getApproveSaleInstructionAsync,
  getCastVoteInstructionAsync,
  getClaimMilestoneInstruction,
  getCreateProposalInstructionAsync,
  getCreateRightsIssuanceInstructionAsync,
  getDepositToVestingEscrowInstruction,
  getFinalizeProposalInstruction,
  getFreezeVaultInstruction,
  getMintToTreasuryInstructionAsync,
  getOpenSaleInstructionAsync,
  getOpenVaultVoteInstructionAsync,
  getPublishMilestoneInstructionAsync,
  getSetPauseFlagsInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  canonicalDistributionPlan,
  type DistributionPlanEntry,
  type PreparedDistributionPlan,
} from "@/lib/distribution-plans";
import {
  buildDistributionClose,
  buildDistributionFunding,
  buildDistributionPayment,
  isDistributionBatchPaid,
} from "@/lib/distribution-transactions";
import { hookTransferMetas } from "@/lib/hook-metas";
import { ISSUER_CAPABILITIES, resolveIssuerPermission } from "@/lib/issuer-permissions";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { PAUSE_PAYOUT_MODULES } from "@/lib/pause-flags";
import { vaultVotePda } from "@/lib/payout-vote-pda";
import { findClaimPda, findMilestonePda, findProposalPda, findRightsIssuancePda, findSalePda } from "@/lib/pdas";
import { buildOpenPayoutVaultInstruction } from "@/lib/proceeds-exits";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { MIN_VAULT_VOTING_PERIOD_SECONDS } from "@/lib/deadline-bounds";
import { buildVestingCreationSteps, type VestingCreationIntent } from "@/lib/vesting-creation";
import { buildVestingReleaseInstruction } from "@/lib/vesting-release";
import { ChainPlanError } from "../../safety";
import { chainNow } from "../clock";
import { shareAta, withTail } from "../custody";
import { PAYMENT_UNIT, mintPaymentInstructions, paymentAta, tokenBalance } from "../fixtures";
import { entity } from "../state";
import { CLOCK_GUARD_S, ONE_DAY, accountExists, reachChainTime, sha256Bytes, type World } from "../world";
import { UNIT_PRICE, buyIxs, saleEnd } from "./g1";

/** How far out the devnet-waitable deadlines of G5 lie (vesting unlock, voting end, milestone unlock). */
const SHORT_S = BigInt(180);
/** Startup payout schedule: no cliff, three monthly tranches (open_payout_vault needs vesting > cliff). */
const STARTUP_VESTING_MONTHS = 3;
/** constants.rs MONTH: one payout period. */
export const PAYOUT_MONTH_S = BigInt(2_592_000);
/** freeze_vault needs three periods overdue: two months past the vault's start (cliff 0). */
const FREEZE_AFTER_S = BigInt(2) * PAYOUT_MONTH_S;
const ADMIN_PAYMENT = BigInt(100) * PAYMENT_UNIT;

export const DISTRIBUTION_1 = 1;
export const VESTING_SERIES_1 = 1;
export const PROPOSAL_1 = 1;
export const RIGHTS_1 = 1;
export const STARTUP_SALE = 30;

// ── Distributions (the app's canonical plan and builders) ────────────────────

/** The plan a distribution commits to: the recipients' payment ATAs and amounts. */
export async function distributionPlan(
  w: World,
  distributionId: number,
  recipients: readonly { owner: Address; amount: bigint }[],
): Promise<PreparedDistributionPlan> {
  const shareClass = entity(w.runner.state, "classA") as Address;
  const paymentMint = entity(w.runner.state, "paymentMint") as Address;
  const [distribution] = await findDistributionPda({ shareClass, distributionId: BigInt(distributionId) });
  const entries: DistributionPlanEntry[] = await Promise.all(
    recipients.map(async (r) => ({ token_account: await paymentAta(r.owner, paymentMint), token_owner: r.owner, amount: String(r.amount) })),
  );
  const total = recipients.reduce((sum, r) => sum + r.amount, BigInt(0));
  const canonical = await canonicalDistributionPlan(
    {
      distribution_pda: distribution,
      distribution_id: String(distributionId),
      share_class: shareClass,
      payment_mint: paymentMint,
      payment_token_program: TOKEN_CLASSIC,
      funder: w.roles.admin.address,
      total_amount: String(total),
      snapshot_supply: String(BigInt(100)),
    },
    entries,
  );
  return { ...canonical, id: `e2e-${w.runId}-distribution-${distributionId}`, network: w.network, status: "bound", bound_slot: null };
}

export async function distributionStatus(w: World, plan: PreparedDistributionPlan): Promise<DistributionStatus | null> {
  const account = await fetchMaybeDistribution(w.rpc, plan.distribution_pda as Address, { commitment: "finalized" });
  return account.exists ? account.data.status : null;
}

export async function fundDistributionIxs(w: World, plan: PreparedDistributionPlan): Promise<Instruction[]> {
  return [await buildDistributionFunding(w.rpc, plan, w.roles.admin)];
}

/** distribute_batch of batch 0 with the recipients' ATAs (the plan's one batch). */
export async function payDistributionIxs(w: World, plan: PreparedDistributionPlan): Promise<Instruction[]> {
  const built = await buildDistributionPayment(w.rpc, plan, plan.batches[0], w.roles.admin);
  return [...built.preparation.flat(), ...built.payment];
}

export async function closeDistributionIxs(w: World, plan: PreparedDistributionPlan): Promise<Instruction[]> {
  const account = await fetchMaybeDistribution(w.rpc, plan.distribution_pda as Address, { commitment: "finalized" });
  if (!account.exists) throw new ChainPlanError(`distribution ${plan.distribution_id} is not on chain`);
  return buildDistributionClose({
    authority: w.roles.admin,
    distribution: plan.distribution_pda as Address,
    data: account.data,
    tokenProgram: TOKEN_CLASSIC,
  });
}

// ── Startup sales (the payout-vault module) ──────────────────────────────────

export async function approveStartupIxs(w: World, saleId: number, total: bigint, expiresAt: bigint): Promise<Instruction[]> {
  return [
    await getApproveSaleInstructionAsync({
      authority: w.roles.admin,
      issuer: entity(w.runner.state, "issuer") as Address,
      asset: entity(w.runner.state, "asset") as Address,
      shareClass: entity(w.runner.state, "classA") as Address,
      paymentMint: entity(w.runner.state, "paymentMint") as Address,
      saleId: BigInt(saleId),
      maxGrossRaise: UNIT_PRICE * total,
      minPricePerUnit: UNIT_PRICE,
      maxPricePerUnit: UNIT_PRICE,
      raiseType: RaiseType.Startup,
      expiresAt,
      applicationHash: sha256Bytes(`manci-e2e:${w.runId}:approval:${saleId}`),
      cliffMonths: 0,
      vestingMonths: STARTUP_VESTING_MONTHS,
    }),
  ];
}

export async function openStartupIxs(w: World, saleId: number, total: bigint): Promise<Instruction[]> {
  const start = await chainNow(w.rpc);
  return [
    await getOpenSaleInstructionAsync({
      authority: w.roles.issuer,
      issuer: entity(w.runner.state, "issuer") as Address,
      asset: entity(w.runner.state, "asset") as Address,
      shareClass: entity(w.runner.state, "classA") as Address,
      mint: entity(w.runner.state, "mintA") as Address,
      paymentMint: entity(w.runner.state, "paymentMint") as Address,
      paymentTokenProgram: TOKEN_CLASSIC,
      approvedBy: w.roles.admin.address,
      saleId: BigInt(saleId),
      pricePerUnit: UNIT_PRICE,
      totalForSale: total,
      startTs: start,
      endTs: saleEnd(w, start),
      raiseType: RaiseType.Startup,
      cliffMonths: 0,
      vestingMonths: STARTUP_VESTING_MONTHS,
    }),
  ];
}

export async function setPauseIxs(w: World, signer: KeyPairSigner, setMask: number, clearMask: number): Promise<Instruction[]> {
  return [await getSetPauseFlagsInstructionAsync({ authority: signer, setMask, clearMask })];
}

export async function pauseFlags(w: World): Promise<number> {
  const [platform] = await findPlatformPda();
  return (await fetchPlatform(w.rpc, platform, { commitment: "finalized" })).data.pauseFlags;
}

// ── Vesting (the issuer form's creation steps, the portfolio's claim) ───────

async function vestingRow(w: World, unlockTs: bigint): Promise<VestingCreationIntent> {
  const [, b2, b3] = w.roles.buyers;
  const authority = w.roles.buyers[0].address;
  const [series] = await findSeriesPda({ authority, seriesId: BigInt(VESTING_SERIES_1) });
  const [escrow] = await findCreateVestingSeriesEscrowPda({ series });
  return {
    id: `e2e-${w.runId}-vesting-${VESTING_SERIES_1}`,
    network: w.network,
    client_wallet: authority,
    token_mint: entity(w.runner.state, "mintA"),
    token_label: "Manci e2e class A",
    timing_mode: "auto",
    delivery_mode: "claim",
    approval_window_secs: 0,
    recovery_enabled: false,
    cancellation_enabled: false,
    pre_cliff_bps: 0,
    schedule: [{ unlock_ts: Number(unlockTs), amount: "2" }],
    recipients: [
      { wallet: b2.address, allocation: "1" },
      { wallet: b3.address, allocation: "1" },
    ],
    series_id: String(VESTING_SERIES_1),
    series_pda: series,
    escrow,
    approved_terms_hash: "e2e",
    creation_terms_hash: "e2e",
  };
}

async function vestingSeries(w: World) {
  const [series] = await findSeriesPda({ authority: w.roles.buyers[0].address, seriesId: BigInt(VESTING_SERIES_1) });
  const account = await fetchMaybeVestingSeries(w.rpc, series, { commitment: "finalized" });
  return { series, data: account.exists ? account.data : null };
}

/** One kind of the creation steps (create / positions / finalize), resumable from the live series. */
async function vestingStepIxs(w: World, kind: "create" | "positions" | "finalize"): Promise<Instruction[]> {
  const unlock = BigInt(entity(w.runner.state, "vestingUnlockTs"));
  const { data } = await vestingSeries(w);
  const steps = await buildVestingCreationSteps(await vestingRow(w, unlock), TOKEN_2022, w.roles.buyers[0], data);
  const step = steps.find((s) => s.kind === kind);
  if (!step) throw new ChainPlanError(`vesting series #${VESTING_SERIES_1} has no ${kind} step left`);
  return step.instructions;
}

/** claim_vested (claim mode) with the escrow → recipient hook tail. */
export async function claimVestedIxs(w: World, recipient: KeyPairSigner, positionIndex: number): Promise<Instruction[]> {
  const { series, data } = await vestingSeries(w);
  if (!data) throw new ChainPlanError(`vesting series #${VESTING_SERIES_1} is not on chain`);
  const [position] = await findPositionPda({ series, positionIndex });
  const ata = await shareAta(recipient.address, data.tokenMint);
  const release = await buildVestingReleaseInstruction({
    mode: "claim",
    signer: recipient,
    series,
    position,
    positionIndex,
    recipient: recipient.address,
    tokenMint: data.tokenMint,
    escrow: data.escrow,
    recipientTokenAccount: ata,
    tokenProgram: TOKEN_2022,
  });
  const tail = await hookTransferMetas(w.rpc, data.tokenMint, {
    sourceTokenAccount: data.escrow,
    destTokenAccount: ata,
    transferAuthority: series,
    sourceOwner: series,
    destOwner: recipient.address,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: recipient, owner: recipient.address, mint: data.tokenMint, tokenProgram: TOKEN_2022 }),
    withTail(release, tail),
  ];
}

/** deposit_to_vesting_escrow into series #1, as the issuer's vesting panel builds it (hook tail depositor → escrow). */
export async function vestingDepositInstructions(w: World, depositor: KeyPairSigner, amount: bigint): Promise<Instruction[]> {
  const { series, data } = await vestingSeries(w);
  if (!data) throw new ChainPlanError(`vesting series #${VESTING_SERIES_1} is not on chain`);
  const from = await shareAta(depositor.address, data.tokenMint);
  const deposit = getDepositToVestingEscrowInstruction({
    platform: (await findPlatformPda())[0],
    depositor,
    series,
    tokenMint: data.tokenMint,
    escrow: data.escrow,
    depositorTokenAccount: from,
    tokenProgram: TOKEN_2022,
    amount,
    identity: (await findCreateVestingSeriesIdentityPda({ series }))[0],
  });
  const tail = await hookTransferMetas(w.rpc, data.tokenMint, {
    sourceTokenAccount: from,
    destTokenAccount: data.escrow,
    transferAuthority: depositor.address,
    sourceOwner: depositor.address,
    destOwner: series,
  });
  return [withTail(deposit, tail)];
}

export async function vestingReleased(w: World, positionIndex: number): Promise<boolean> {
  const { series } = await vestingSeries(w);
  const [position] = await findPositionPda({ series, positionIndex });
  const account = await fetchMaybeVestingPosition(w.rpc, position, { commitment: "finalized" });
  return account.exists && account.data.released > BigInt(0);
}

// ── Governance ───────────────────────────────────────────────────────────────

/** The e2e snapshot: B1 3, B2 2, B3 1 (class A). */
function voteWeights(w: World): [Address, bigint][] {
  const [b1, b2, b3] = w.roles.buyers;
  return [
    [b1.address, BigInt(3)],
    [b2.address, BigInt(2)],
    [b3.address, BigInt(1)],
  ];
}

async function snapshot(entries: readonly [Address, bigint][]) {
  const leaves = await Promise.all(entries.map(([who, weight]) => snapshotLeaf(who, weight)));
  return { leaves, root: await merkleRoot(leaves) };
}

export async function createProposalIxs(w: World, proposalId: number, endTs: bigint): Promise<Instruction[]> {
  const { root } = await snapshot(voteWeights(w));
  const slot = await w.rpc.getSlot({ commitment: "finalized" }).send();
  return [
    await getCreateProposalInstructionAsync({
      authority: w.roles.admin,
      shareClass: entity(w.runner.state, "classA") as Address,
      proposalId: BigInt(proposalId),
      metadataHash: sha256Bytes(`manci-e2e:${w.runId}:proposal:${proposalId}`),
      snapshotSlot: slot,
      snapshotRoot: root,
      startTs: await chainNow(w.rpc),
      endTs,
    }),
  ];
}

/** cast_vote with `voter`'s snapshot proof; `weight` defaults to the voter's own (a wrong one fails the proof). */
export async function castVoteIxs(w: World, proposalId: number, voter: KeyPairSigner, choice: VoteChoice, weight?: bigint): Promise<Instruction[]> {
  const entries = voteWeights(w);
  const index = entries.findIndex(([who]) => who === voter.address);
  if (index < 0) throw new ChainPlanError(`${voter.address} is not in the e2e vote snapshot`);
  const { leaves } = await snapshot(entries);
  return [
    await getCastVoteInstructionAsync({
      voter,
      proposal: await findProposalPda(entity(w.runner.state, "classA") as Address, BigInt(proposalId)),
      choice,
      weight: weight ?? entries[index][1],
      proof: await merkleProof(leaves, index),
    }),
  ];
}

async function proposalStatus(w: World, proposalId: number): Promise<ProposalStatus | null> {
  const account = await fetchMaybeProposal(
    w.rpc,
    await findProposalPda(entity(w.runner.state, "classA") as Address, BigInt(proposalId)),
    { commitment: "finalized" },
  );
  return account.exists ? account.data.status : null;
}

// ── Rights (Merkle milestones) ───────────────────────────────────────────────

/** Milestone snapshot of issuance #1: B1 2, B2 1 (index 0), B1 1 (index 1, G7). */
export function milestoneWeights(w: World, index: number): [Address, bigint][] {
  const [b1, b2] = w.roles.buyers;
  return index === 0
    ? [
        [b1.address, BigInt(2)],
        [b2.address, BigInt(1)],
      ]
    : [[b1.address, BigInt(1)]];
}

export async function rightsPda(w: World, issuanceId: number): Promise<Address> {
  return findRightsIssuancePda(entity(w.runner.state, "classA") as Address, BigInt(issuanceId));
}

export async function createRightsIxs(w: World, issuanceId: number): Promise<Instruction[]> {
  return [
    await getCreateRightsIssuanceInstructionAsync({
      authority: w.roles.admin,
      shareClass: entity(w.runner.state, "classA") as Address,
      underlyingMint: entity(w.runner.state, "mintA") as Address,
      tokenProgram: TOKEN_2022,
      issuanceId: BigInt(issuanceId),
    }),
  ];
}

export async function publishMilestoneIxs(w: World, issuanceId: number, index: number, unlockTs: bigint): Promise<Instruction[]> {
  const entries = milestoneWeights(w, index);
  const { root } = await snapshot(entries);
  return [
    await getPublishMilestoneInstructionAsync({
      authority: w.roles.admin,
      rightsIssuance: await rightsPda(w, issuanceId),
      index,
      merkleRoot: root,
      amountPool: entries.reduce((sum, [, amount]) => sum + amount, BigInt(0)),
      unlockTs,
    }),
  ];
}

/** claim_milestone as /portfolio/rights builds it (escrow → claimer hook tail). */
export async function claimMilestoneIxs(w: World, issuanceId: number, index: number, claimer: KeyPairSigner): Promise<Instruction[]> {
  const issuance = await rightsPda(w, issuanceId);
  const account = await fetchMaybeRightsIssuance(w.rpc, issuance, { commitment: "finalized" });
  if (!account.exists) throw new ChainPlanError(`rights issuance #${issuanceId} is not on chain`);
  const entries = milestoneWeights(w, index);
  const at = entries.findIndex(([who]) => who === claimer.address);
  if (at < 0) throw new ChainPlanError(`${claimer.address} is not in milestone ${index}`);
  const { leaves } = await snapshot(entries);
  const milestone = await findMilestonePda(issuance, index);
  const ata = await shareAta(claimer.address, account.data.underlyingMint);
  const claim = getClaimMilestoneInstruction({
    claimer,
    rightsIssuance: issuance,
    milestone,
    claim: await findClaimPda(milestone, claimer.address),
    underlyingMint: account.data.underlyingMint,
    escrow: account.data.escrow,
    claimerTokenAccount: ata,
    tokenProgram: TOKEN_2022,
    amount: entries[at][1],
    proof: await merkleProof(leaves, at),
  });
  const tail = await hookTransferMetas(w.rpc, account.data.underlyingMint, {
    sourceTokenAccount: account.data.escrow,
    destTokenAccount: ata,
    transferAuthority: issuance,
    sourceOwner: issuance,
    destOwner: claimer.address,
  });
  return [withTail(claim, tail)];
}

export async function milestoneClaimed(w: World, issuanceId: number, index: number, claimer: Address): Promise<boolean> {
  const milestone = await findMilestonePda(await rightsPda(w, issuanceId), index);
  return accountExists(w.rpc, await findClaimPda(milestone, claimer));
}

// ── The group ────────────────────────────────────────────────────────────────

export async function runGroup5(w: World): Promise<"completed"> {
  const { admin, funder, issuer: issuerKey, buyers } = w.roles;
  const [b1, b2, b3] = buyers;
  const paymentMint = entity(w.runner.state, "paymentMint") as Address;
  const classA = entity(w.runner.state, "classA") as Address;

  // 5.0–5.1: a distribution funded by the Admin, paid in one batch, closed.
  await w.runner.step(
    "5.0",
    async () => ({
      payer: funder,
      ixs: await mintPaymentInstructions({ payer: funder, mintAuthority: funder, mint: paymentMint, owners: [admin.address], amount: ADMIN_PAYMENT }),
    }),
    { done: async () => (await tokenBalance(w.rpc, await paymentAta(admin.address, paymentMint))) >= BigInt(10) * PAYMENT_UNIT },
  );
  const plan1 = await distributionPlan(w, DISTRIBUTION_1, [
    { owner: b1.address, amount: BigInt(3) * PAYMENT_UNIT },
    { owner: b2.address, amount: BigInt(2) * PAYMENT_UNIT },
    { owner: b3.address, amount: PAYMENT_UNIT },
  ]);
  w.runner.setEntity("distribution1", plan1.distribution_pda);
  await w.runner.step("5.1a", async () => ({ payer: admin, ixs: await fundDistributionIxs(w, plan1) }), {
    done: async () => (await distributionStatus(w, plan1)) !== null,
  });
  await w.runner.step("5.1b", async () => ({ payer: admin, ixs: await payDistributionIxs(w, plan1) }), {
    done: async () => (await distributionStatus(w, plan1)) === DistributionStatus.Closed || (await isDistributionBatchPaid(w.rpc, plan1, plan1.batches[0])),
  });
  await w.runner.step("5.1c", async () => ({ payer: admin, ixs: await closeDistributionIxs(w, plan1) }), {
    done: async () => (await distributionStatus(w, plan1)) === DistributionStatus.Closed,
  });

  // 5.2: a claim-mode vesting series of class A (authority B1; B2 and B3 one unit each).
  const { series } = await vestingSeries(w);
  w.runner.setEntity("vestingSeries1", series);
  const seriesStatus = async () => (await vestingSeries(w)).data?.status ?? null;
  await w.runner.step(
    "5.2a",
    async () => {
      if (w.runner.state.entities.vestingUnlockTs === undefined || (await seriesStatus()) === null) {
        w.runner.setEntity("vestingUnlockTs", (await chainNow(w.rpc)) + SHORT_S);
      }
      return { payer: b1, ixs: await vestingStepIxs(w, "create") };
    },
    { done: async () => (await seriesStatus()) !== null },
  );
  const vestingUnlock = BigInt(entity(w.runner.state, "vestingUnlockTs"));
  await w.runner.step("5.2b", async () => ({ payer: b1, ixs: await vestingStepIxs(w, "positions") }), {
    done: async () => {
      const { data } = await vestingSeries(w);
      return data !== null && (data.positionsCount >= 2 || data.status !== VestingSeriesStatus.Draft);
    },
  });
  await w.runner.step("5.2c", async () => ({ payer: b1, ixs: await vestingStepIxs(w, "finalize") }), {
    done: async () => (await seriesStatus()) === VestingSeriesStatus.Active,
  });
  await w.runner.step(
    "5.2d",
    async () => ({ payer: b1, ixs: await vestingDepositInstructions(w, b1, BigInt(2)) }),
    {
      done: async () => {
        const { data } = await vestingSeries(w);
        return data !== null && data.deposited >= BigInt(2);
      },
    },
  );
  await w.runner.step("5.2e", async () => ({ payer: b2, ixs: await claimVestedIxs(w, b2, 0) }), {
    notRun: async () => ((await chainNow(w.rpc)) + CLOCK_GUARD_S < vestingUnlock ? null : `the vesting unlock ${vestingUnlock} has passed (chain time)`),
  });

  // 5.3: governance on class A (snapshot B1 3, B2 2, B3 1).
  const proposal = await findProposalPda(classA, BigInt(PROPOSAL_1));
  await w.runner.step(
    "5.3a",
    async () => {
      if (w.runner.state.entities.proposal1EndTs === undefined || !(await accountExists(w.rpc, proposal))) {
        w.runner.setEntity("proposal1EndTs", (await chainNow(w.rpc)) + SHORT_S);
      }
      return { payer: admin, ixs: await createProposalIxs(w, PROPOSAL_1, BigInt(entity(w.runner.state, "proposal1EndTs"))) };
    },
    { done: () => accountExists(w.rpc, proposal) },
  );
  const proposalEnd = BigInt(entity(w.runner.state, "proposal1EndTs"));
  const votingOpen = async () =>
    (await chainNow(w.rpc)) + CLOCK_GUARD_S < proposalEnd ? null : `proposal #1 voting ended at ${proposalEnd} (chain time)`;
  await w.runner.step("5.3b", async () => ({ payer: b1, ixs: await castVoteIxs(w, PROPOSAL_1, b1, VoteChoice.For) }), {
    notRun: votingOpen,
  });
  await w.runner.step("5.3c", async () => ({ payer: b2, ixs: await castVoteIxs(w, PROPOSAL_1, b2, VoteChoice.Against, BigInt(3)) }), {
    notRun: votingOpen,
  });
  await w.runner.step("5.3d", async () => ({ payer: b2, ixs: await castVoteIxs(w, PROPOSAL_1, b2, VoteChoice.Against) }), {
    notRun: votingOpen,
  });
  await w.runner.step("5.3e", async () => ({ payer: b3, ixs: [getFinalizeProposalInstruction({ payer: b3, proposal })] }), {
    notRun: votingOpen,
  });

  // 5.4–5.6 (localnet): the payout / Merkle modules.
  const local = w.runner.applies("5.4a");
  const sa = w.roles.superAdmin;
  const [payoutVault] = await findVaultPda({ sale: await findSalePda(classA, BigInt(STARTUP_SALE)) });
  const issuance = await rightsPda(w, RIGHTS_1);
  if (local) {
    if (!sa) throw new ChainPlanError("5.4 needs the localnet Super Admin key");
    const salePda = await findSalePda(classA, BigInt(STARTUP_SALE));
    w.runner.setEntity("sale30", salePda);
    w.runner.setEntity("payoutVault30", payoutVault);
    await w.runner.step(
      "5.4a",
      async () => ({ payer: admin, ixs: await approveStartupIxs(w, STARTUP_SALE, BigInt(10), (await chainNow(w.rpc)) + ONE_DAY) }),
      { done: async () => (await accountExists(w.rpc, salePda)) || (await approvalExists(w, STARTUP_SALE)) },
    );
    const modulesOff = async () => (((await pauseFlags(w)) & PAUSE_PAYOUT_MODULES) !== 0 ? null : "the payout modules are already on (5.4d ran)");
    await w.runner.step("5.4b", async () => ({ payer: issuerKey, ixs: await openStartupIxs(w, STARTUP_SALE, BigInt(10)) }), {
      notRun: modulesOff,
    });
    await w.runner.step("5.4c", async () => ({ payer: admin, ixs: await createRightsIxs(w, RIGHTS_1) }), { notRun: modulesOff });
    await w.runner.step("5.4d", async () => ({ payer: sa, ixs: await setPauseIxs(w, sa, 0, PAUSE_PAYOUT_MODULES) }), {
      done: async () => ((await pauseFlags(w)) & PAUSE_PAYOUT_MODULES) === 0 || w.runner.passed("5.7"),
    });

    await w.runner.step("5.5a", async () => ({ payer: admin, ixs: await createRightsIxs(w, RIGHTS_1) }), {
      done: () => accountExists(w.rpc, issuance),
    });
    const escrowFunded = async () => {
      const account = await fetchMaybeRightsIssuance(w.rpc, issuance, { commitment: "finalized" });
      return account.exists && ((await tokenBalance(w.rpc, account.data.escrow)) > BigInt(0) || account.data.totalClaimed > BigInt(0));
    };
    await w.runner.step(
      "5.5b",
      async () => {
        const account = await fetchMaybeRightsIssuance(w.rpc, issuance, { commitment: "finalized" });
        if (!account.exists) throw new ChainPlanError("rights issuance #1 is not on chain");
        const issuer = entity(w.runner.state, "issuer") as Address;
        const mint = await getMintToTreasuryInstructionAsync({
          authority: issuerKey,
          adminRecord: await resolveIssuerPermission(w.rpc, issuer, issuerKey.address, ISSUER_CAPABILITIES.Mint),
          issuer,
          asset: entity(w.runner.state, "asset") as Address,
          shareClass: classA,
          destination: account.data.escrow,
          tokenProgram: TOKEN_2022,
          amount: BigInt(4),
        });
        // The escrow's parent: mint_to_treasury binds the destination through it.
        return { payer: issuerKey, ixs: [withTail(mint, [{ address: issuance, role: AccountRole.READONLY }])] };
      },
      { done: escrowFunded },
    );
    const milestone0 = await findMilestonePda(issuance, 0);
    await w.runner.step(
      "5.5c",
      async () => {
        if (w.runner.state.entities.milestone0UnlockTs === undefined || !(await accountExists(w.rpc, milestone0))) {
          w.runner.setEntity("milestone0UnlockTs", (await chainNow(w.rpc)) + SHORT_S);
        }
        return { payer: admin, ixs: await publishMilestoneIxs(w, RIGHTS_1, 0, BigInt(entity(w.runner.state, "milestone0UnlockTs"))) };
      },
      { done: () => accountExists(w.rpc, milestone0) },
    );
    const milestoneUnlock = BigInt(entity(w.runner.state, "milestone0UnlockTs"));
    await w.runner.step("5.5d", async () => ({ payer: b1, ixs: await claimMilestoneIxs(w, RIGHTS_1, 0, b1) }), {
      notRun: async () =>
        (await chainNow(w.rpc)) + CLOCK_GUARD_S < milestoneUnlock ? null : `milestone 0 unlocked at ${milestoneUnlock} (chain time)`,
    });

    await w.runner.step("5.6a", async () => ({ payer: issuerKey, ixs: await openStartupIxs(w, STARTUP_SALE, BigInt(10)) }), {
      done: () => accountExists(w.rpc, salePda),
    });
    await w.runner.step("5.6b", async () => ({ payer: b1, ixs: await startupBuyIxs(w, b1, BigInt(3)) }), {
      done: async () => {
        const sale = await fetchMaybeSale(w.rpc, salePda, { commitment: "finalized" });
        return sale.exists && sale.data.sold >= BigInt(3);
      },
    });
    await w.runner.step(
      "5.6c",
      async () => {
        const sale = await fetchSale(w.rpc, salePda, { commitment: "finalized" });
        return {
          payer: issuerKey,
          ixs: [
            await buildOpenPayoutVaultInstruction(w.rpc, {
              authority: issuerKey,
              sale: { address: salePda, shareClass: classA, proceeds: sale.data.proceeds, paymentMint },
              paymentTokenProgram: TOKEN_CLASSIC,
              metadataHash: sha256Bytes(`manci-e2e:${w.runId}:payout:${STARTUP_SALE}`),
            }),
          ],
        };
      },
      { done: () => accountExists(w.rpc, payoutVault) },
    );
    await w.runner.step("5.6d", async () => ({ payer: b3, ixs: [getFreezeVaultInstruction({ vault: payoutVault })] }), {
      notRun: async () => {
        const vault = await fetchMaybePayoutVault(w.rpc, payoutVault, { commitment: "finalized" });
        if (!vault.exists) return null;
        if (vault.data.state !== PayoutVaultState.Active) return "payout vault #30 is no longer Active (5.6e ran)";
        // With no cliff the first update is due at once (one period overdue); a freeze needs three.
        return (await chainNow(w.rpc)) + CLOCK_GUARD_S < vault.data.startTs + FREEZE_AFTER_S
          ? null
          : "vault #30 is already three payout periods overdue (chain time)";
      },
    });
  }

  // One clock move for every "after" step.
  let target = [vestingUnlock, proposalEnd].reduce((a, b) => (a > b ? a : b));
  if (local) {
    const vault = await fetchMaybePayoutVault(w.rpc, payoutVault, { commitment: "finalized" });
    const freezeAt = vault.exists ? vault.data.startTs + FREEZE_AFTER_S : BigInt(0);
    for (const t of [BigInt(entity(w.runner.state, "milestone0UnlockTs")), freezeAt]) if (t > target) target = t;
  }
  const after = ["5.2f", "5.3f", "5.5e", "5.6e", "5.6f", "5.6g", "5.7"];
  if (!after.every((id) => w.runner.passed(id) || !w.runner.applies(id))) {
    const blocked = await reachChainTime(w, target + BigInt(2), "the G5 unlocks, voting end and three missed payout months");
    if (blocked) {
      for (const id of after) w.runner.markNotRun(id, blocked);
      return "completed";
    }
  }

  await w.runner.step("5.2f", async () => ({ payer: b2, ixs: await claimVestedIxs(w, b2, 0) }), {
    done: () => vestingReleased(w, 0),
  });
  await w.runner.step("5.3f", async () => ({ payer: b3, ixs: [getFinalizeProposalInstruction({ payer: b3, proposal })] }), {
    done: async () => (await proposalStatus(w, PROPOSAL_1)) === ProposalStatus.Finalized,
  });
  if (!local) return "completed";
  await w.runner.step("5.5e", async () => ({ payer: b1, ixs: await claimMilestoneIxs(w, RIGHTS_1, 0, b1) }), {
    done: () => milestoneClaimed(w, RIGHTS_1, 0, b1.address),
  });
  const vaultState = async () => {
    const vault = await fetchMaybePayoutVault(w.rpc, payoutVault, { commitment: "finalized" });
    return vault.exists ? vault.data : null;
  };
  await w.runner.step("5.6e", async () => ({ payer: b3, ixs: [getFreezeVaultInstruction({ vault: payoutVault })] }), {
    done: async () => (await vaultState())?.state === PayoutVaultState.Frozen,
  });
  const vote = async (days: bigint) => {
    const data = await vaultState();
    if (!data) throw new ChainPlanError("payout vault #30 is not on chain");
    const { root } = await snapshot([[b1.address, BigInt(3)]]);
    return [
      await getOpenVaultVoteInstructionAsync({
        authority: admin,
        vault: payoutVault,
        vote: await vaultVotePda(payoutVault, data.voteRound + BigInt(1)),
        snapshotRoot: root,
        totalWeight: BigInt(3),
        votingPeriod: days * ONE_DAY,
      }),
    ];
  };
  const votePending = async () => (await vaultState())?.votePending === true;
  await w.runner.step("5.6f", async () => ({ payer: admin, ixs: await vote(BigInt(1)) }), {
    notRun: async () => ((await votePending()) ? "a vault vote is already open (5.6g ran)" : null),
  });
  await w.runner.step("5.6g", async () => ({ payer: admin, ixs: await vote(BigInt(MIN_VAULT_VOTING_PERIOD_SECONDS) / ONE_DAY) }), {
    done: votePending,
  });
  await w.runner.step("5.7", async () => ({ payer: admin, ixs: await setPauseIxs(w, admin, PAUSE_PAYOUT_MODULES, 0) }), {
    done: async () => ((await pauseFlags(w)) & PAUSE_PAYOUT_MODULES) !== 0,
  });
  return "completed";
}

async function approvalExists(w: World, saleId: number): Promise<boolean> {
  const [approval] = await findSaleApprovalPda({ shareClass: entity(w.runner.state, "classA") as Address, saleId: BigInt(saleId) });
  return accountExists(w.rpc, approval);
}

/** A buy on the Startup sale (the app's documented purchase). */
async function startupBuyIxs(w: World, buyer: KeyPairSigner, amount: bigint): Promise<Instruction[]> {
  return buyIxs(w, buyer, "classA", STARTUP_SALE, amount);
}

