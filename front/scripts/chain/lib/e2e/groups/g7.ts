/**
 * G7 (localnet): the emergency pause matrix (design-6.3 §A G7, v1.0.0-rc
 * pause bits). Positions are staged first (sales, offers, an unfunded offer,
 * deals, a delivery vault, a funded distribution, a proposal, a draft asset
 * with one class). G7 needs 0x40 set when it starts (G5 ends by setting it
 * again) and refuses to run otherwise: with only 0x40 set, as on mainnet,
 * the payout / Merkle entries are refused (6000). Then each emergency bit on
 * its own: an Admin sets it, its entries are refused (6000), the Super Admin
 * clears it; each entry is one that would land without the bit (the
 * deposits go to the unfunded offer and a fresh deal, the class and mint to
 * the draft asset). Then every bit is set (0x7F, checked): an Admin cannot
 * clear (6119), every exit still lands (cancels, expiries, returns, the
 * quarantine and clawback, claims, a vote, approvals, a wallet transfer),
 * the Super Admin cannot clear 0x40 together with other bits (6154), clears
 * the emergency bits (0x3F) and a buy lands again. 0x40 stays set.
 *
 * Not here: the 0x10 refusals of create_rights_issuance / publish_milestone
 * need 0x40 clear (G5 5.5f–i shows them); route_yield has no e2e flow
 * (LiteSVM: test_payout_vault.rs).
 */
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  AssetType,
  DistributionStatus,
  ShareClassType,
  OfferStatus,
  OtcDealStatus,
  VoteChoice,
  fetchMaybeOtcDeal,
  fetchOtcDeal,
  fetchSale,
  findDealPda,
  findSaleApprovalPda,
  getCancelOfferInstructionAsync,
  getCreateAssetInstructionAsync,
  getExpireOfferInstructionAsync,
  getMintToTreasuryInstructionAsync,
  getRegisterIssuerInstructionAsync,
  getRevokeSaleApprovalInstructionAsync,
  fetchMaybeVoteRecord,
  fetchMaybeShareClass,
  findAssetPda,
  findMintPda,
  findVoteRecordPda,
  getAddShareClassInstructionAsync,
  getInitializeShareClassMintInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findConfigPda,
  findExtraAccountMetaListPda,
  getAddToBlocklistInstructionAsync,
  getRemoveFromBlocklistInstructionAsync,
} from "@/lib/generated/transfer_hook";
import { ISSUER_CAPABILITIES, resolveIssuerPermission } from "@/lib/issuer-permissions";
import { buildDepositOtcAssetInstructions } from "@/lib/otc-transactions";
import {
  PAUSE_CUSTODY_ENTRY,
  PAUSE_DISTRIBUTIONS,
  PAUSE_FLAGS_ALL,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PAYOUT_MODULES,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
  EMERGENCY_PAUSE_BITS,
} from "@/lib/pause-flags";
import { findBlockEntryPda, findOfferPda, findProposalPda, findSalePda, findShareClassPda } from "@/lib/pdas";
import { buildCloseSaleInstruction } from "@/lib/proceeds-exits";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { ChainPlanError } from "../../safety";
import { chainNow, waitForChainTime } from "../clock";
import {
  VaultState,
  VaultType,
  clawbackIxs,
  deposited,
  depositIxs,
  loadVault,
  openQuarantineIxs,
  openVaultIxs,
  realizeIxs,
  returnIxs,
  shareAta,
  triggerIxs,
  vaultIn,
  vaultPda,
  walletTransferIxs,
  withTail,
} from "../custody";
import { paymentAta, tokenBalance } from "../fixtures";
import { entity } from "../state";
import { ONE_DAY, accountExists, defaultJurisdiction, expiringDeadline, sha256Bytes, type World } from "../world";
import { UNIT_PRICE, approveSaleIxs, buyIxs, openSaleIxs, saleApprovalExists, saleEnd, saleExists, saleSold } from "./g1";
import {
  cancelDealIxs,
  createAndFundOffer,
  createDealIxs,
  createOfferIxs,
  depositPaymentIxs,
  fundOfferIxs,
  offerReturnTail,
  offerStatus,
  takeIxs,
} from "./g3";
import { DELIVERY_DEADLINE_S, e2eRegistry } from "./g4";
import {
  RIGHTS_1,
  RIGHTS_2,
  castVoteIxs,
  claimMilestoneIxs,
  claimVestedIxs,
  closeDistributionIxs,
  createProposalIxs,
  createRightsIxs,
  distributionPlan,
  distributionStatus,
  fundDistributionIxs,
  milestoneClaimed,
  openStartupIxs,
  approveStartupIxs,
  pauseFlags,
  payDistributionIxs,
  publishMilestoneIxs,
  setPauseIxs,
  vestingDepositInstructions,
  vestingReleased,
} from "./g5";

const SALE_20 = 20;
const SALE_22 = 22;
const SALE_23 = 23;
const STARTUP_SALE_31 = 31;
const OFFER_5 = 5;
const OFFER_6 = 6;
const OFFER_7 = 7;
/** Created without a deposit; its deposit_to_offer_escrow is only tried under 0x04. */
const OFFER_8 = 8;
const DEAL_10 = 10;
const DEAL_11 = 11;
/** Created without deposits; its deposit_otc_payment is only tried under 0x04. */
const DEAL_12 = 12;
const VAULT_V4 = 4;
const QUARANTINE_A2 = 12;
const VAULT_REFUSED = 97;
const DISTRIBUTION_2 = 2;
const DISTRIBUTION_3 = 3;
const PROPOSAL_2 = 2;
/** Offer #6 expires while the rounds run; its permissionless expire is an exit under 0x7F. */
const EXPIRING_OFFER_S = BigInt(120);

type Entry = { id: string; build: () => Promise<{ payer: KeyPairSigner; ixs: Instruction[] }> };

export async function runGroup7(w: World): Promise<"completed"> {
  const { admin, issuer: issuerKey, buyers } = w.roles;
  const [b1, b2, b3, b4] = buyers;
  const sa = w.roles.superAdmin;
  const ba = w.roles.blocklistAuthority;
  if (!sa || !ba) throw new ChainPlanError("G7 needs the localnet Super Admin and BlocklistAuthority keys");
  const classA = entity(w.runner.state, "classA") as Address;
  const flags = () => pauseFlags(w);
  // As on mainnet: 0x40 is set through the whole group (7.1 relies on it,
  // 7.8a adds 0x3F to reach 0x7F, 7.9 clears only 0x3F). G5 sets it again
  // on every path (5.7); a platform without it is not the one G7 tests.
  if (((await flags()) & PAUSE_PAYOUT_MODULES) === 0) {
    throw new ChainPlanError(
      `G7 needs PAUSE_PAYOUT_MODULES (0x40) set, the flags are 0x${(await flags()).toString(16)}: run G5 to its end (5.7 sets it) before G7`,
    );
  }
  const now = await chainNow(w.rpc);

  // 7.0: the positions the exits below unwind.
  await w.runner.step(
    "7.0a",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classA", saleId: SALE_20, maxGross: UNIT_PRICE * BigInt(20), minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: now + ONE_DAY }),
    }),
    { done: async () => (await saleApprovalExists(w, "classA", SALE_20)) || (await saleExists(w, "classA", SALE_20)) },
  );
  await w.runner.step(
    "7.0b",
    async () => ({
      payer: issuerKey,
      ixs: await openSaleIxs(w, { classKey: "classA", saleId: SALE_20, price: UNIT_PRICE, total: BigInt(20), startTs: now, endTs: saleEnd(w, now) }),
    }),
    { done: () => saleExists(w, "classA", SALE_20) },
  );
  await w.runner.step(
    "7.0c",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classA", saleId: SALE_22, maxGross: UNIT_PRICE * BigInt(5), minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: now + ONE_DAY }),
    }),
    { done: () => saleApprovalExists(w, "classA", SALE_22) },
  );
  await w.runner.step("7.0d", async () => ({ payer: admin, ixs: await approveStartupIxs(w, STARTUP_SALE_31, BigInt(5), now + ONE_DAY) }), {
    done: () => saleApprovalExists(w, "classA", STARTUP_SALE_31),
  });
  const offer5 = await findOfferPda(classA, BigInt(OFFER_5));
  const offer6 = await findOfferPda(classA, BigInt(OFFER_6));
  await w.runner.step(
    "7.0e",
    async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, OFFER_5, BigInt(1), UNIT_PRICE, BigInt(0))).ixs }),
    { done: () => accountExists(w.rpc, offer5) },
  );
  await w.runner.step(
    "7.0f",
    async () => {
      const expiresAt = await expiringDeadline(w, { key: "offer6ExpiresAt", step: "7.0f", seconds: EXPIRING_OFFER_S, exists: () => accountExists(w.rpc, offer6) });
      return { payer: b1, ixs: (await createAndFundOffer(w, b1, OFFER_6, BigInt(1), UNIT_PRICE, expiresAt)).ixs };
    },
    { done: () => accountExists(w.rpc, offer6) },
  );
  const offer6Expiry = BigInt(entity(w.runner.state, "offer6ExpiresAt"));
  const [deal10] = await findDealPda({ shareClass: classA, dealId: BigInt(DEAL_10) });
  await w.runner.step("7.0g", async () => ({ payer: admin, ixs: await createDealIxs(w, DEAL_10, b1.address, b2.address, BigInt(1), UNIT_PRICE) }), {
    done: () => accountExists(w.rpc, deal10),
  });
  await w.runner.step("7.0h", async () => ({ payer: b2, ixs: await depositPaymentIxs(w, b2, deal10) }), {
    done: async () => {
      const account = await fetchMaybeOtcDeal(w.rpc, deal10, { commitment: "finalized" });
      return !account.exists || account.data.paymentDepositedAmount > BigInt(0) || account.data.status !== OtcDealStatus.Open;
    },
  });
  const registry = await e2eRegistry(w);
  const v4 = await vaultPda(w, "classA", VAULT_V4);
  w.runner.setEntity("vaultV4", v4);
  await w.runner.step(
    "7.0i",
    async () => ({
      payer: admin,
      ixs: await openVaultIxs(w, {
        classKey: "classA",
        vaultId: VAULT_V4,
        vaultType: VaultType.DeliveryEscrow,
        amount: BigInt(1),
        deadline: (await chainNow(w.rpc)) + DELIVERY_DEADLINE_S,
        beneficiary: b1.address,
        registry,
      }),
    }),
    { done: () => accountExists(w.rpc, v4) },
  );
  await w.runner.step("7.0j", async () => ({ payer: b1, ixs: await depositIxs(w, b1, v4, BigInt(1)) }), { done: deposited(w, v4, BigInt(1)) });
  const plan2 = await distributionPlan(w, DISTRIBUTION_2, [
    { owner: b1.address, amount: BigInt(1_000_000) },
    { owner: b2.address, amount: BigInt(1_000_000) },
  ]);
  await w.runner.step("7.0k", async () => ({ payer: admin, ixs: await fundDistributionIxs(w, plan2) }), {
    done: async () => (await distributionStatus(w, plan2)) !== null,
  });
  const proposal2 = await findProposalPda(classA, BigInt(PROPOSAL_2));
  await w.runner.step("7.0l", async () => ({ payer: admin, ixs: await createProposalIxs(w, PROPOSAL_2, (await chainNow(w.rpc)) + ONE_DAY) }), {
    done: () => accountExists(w.rpc, proposal2),
  });
  // Entry targets that land without the bit: an unfunded offer, a deal with
  // no deposit, a draft asset with one class and no mint.
  const offer8 = await findOfferPda(classA, BigInt(OFFER_8));
  await w.runner.step("7.0m", async () => ({ payer: b1, ixs: await createOfferIxs(w, b1, OFFER_8, BigInt(1), UNIT_PRICE, BigInt(0)) }), {
    done: () => accountExists(w.rpc, offer8),
  });
  const [deal12] = await findDealPda({ shareClass: classA, dealId: BigInt(DEAL_12) });
  await w.runner.step("7.0n", async () => ({ payer: admin, ixs: await createDealIxs(w, DEAL_12, b1.address, b2.address, BigInt(1), UNIT_PRICE) }), {
    done: () => accountExists(w.rpc, deal12),
  });
  const draftId = `e2e-${w.runId}-d`;
  const [draft] = await findAssetPda({ issuer: entity(w.runner.state, "issuer") as Address, assetId: draftId });
  w.runner.setEntity("draftAsset", draft);
  await w.runner.step("7.0o", async () => ({ payer: issuerKey, ixs: await createDraftAssetIxs(w, draftId) }), {
    done: () => accountExists(w.rpc, draft),
  });
  const draftClass0 = await findShareClassPda(draft, 0);
  await w.runner.step("7.0p", async () => ({ payer: issuerKey, ixs: await addDraftClassIxs(w, draft, 0) }), {
    done: () => accountExists(w.rpc, draftClass0),
  });

  // 7.1: 0x40 alone (as on mainnet) refuses the payout / Merkle entries.
  const whileSet = (bits: number, label: string) => async () =>
    ((await flags()) & bits) === bits ? null : `${label} is no longer set (the round's clear ran)`;
  const refused: Entry[] = [
    { id: "7.1a", build: async () => ({ payer: admin, ixs: await createRightsIxs(w, RIGHTS_2) }) },
    { id: "7.1b", build: async () => ({ payer: admin, ixs: await publishMilestoneIxs(w, RIGHTS_1, 1, (await chainNow(w.rpc)) + ONE_DAY) }) },
    { id: "7.1c", build: async () => ({ payer: issuerKey, ixs: await openStartupIxs(w, STARTUP_SALE_31, BigInt(5)) }) },
  ];
  for (const entry of refused) await w.runner.step(entry.id, entry.build, { notRun: whileSet(PAUSE_PAYOUT_MODULES, "0x40") });

  // 7.2–7.7: one emergency bit at a time.
  const issuer = entity(w.runner.state, "issuer") as Address;
  const asset = entity(w.runner.state, "asset") as Address;
  const sale20 = await findSalePda(classA, BigInt(SALE_20));
  const rounds: { prefix: string; bit: number; label: string; entries: Entry[] }[] = [
    {
      prefix: "7.2",
      bit: PAUSE_ONBOARDING,
      label: "0x01",
      entries: [
        {
          id: "7.2b",
          build: async () => {
            const legalEntityId = new Uint8Array(32);
            legalEntityId.set(new TextEncoder().encode(`MANCI-E2E-${w.runId}-P`));
            return {
              payer: b4,
              ixs: [
                await getRegisterIssuerInstructionAsync({
                  authority: b4,
                  legalEntityId,
                  jurisdiction: defaultJurisdiction(),
                  kybDocHash: sha256Bytes(`manci-e2e:${w.runId}:kyb:paused`),
                }),
              ],
            };
          },
        },
        {
          id: "7.2c",
          build: async () => ({
            payer: issuerKey,
            ixs: [
              await getCreateAssetInstructionAsync({
                authority: issuerKey,
                issuer,
                assetId: `e2e-${w.runId}-p`,
                assetType: AssetType.Equity,
                name: `Manci e2e ${w.runId} paused`,
                symbolPrefix: "E2P",
                legalDocHash: sha256Bytes(`manci-e2e:${w.runId}:asset:paused`),
                jurisdictionRules: { allowedCountries: new Uint8Array(128), maxHolders: 0, restrictedPeriodEnd: BigInt(0), allowP2p: true },
              }),
            ],
          }),
        },
        { id: "7.2d", build: async () => ({ payer: issuerKey, ixs: await addDraftClassIxs(w, draft, 1) }) },
        { id: "7.2e", build: async () => ({ payer: issuerKey, ixs: await initDraftMintIxs(w, draft, draftClass0) }) },
      ],
    },
    {
      prefix: "7.3",
      bit: PAUSE_PRIMARY,
      label: "0x02",
      entries: [
        { id: "7.3b", build: async () => ({ payer: b1, ixs: await buyIxs(w, b1, "classA", SALE_20, BigInt(1)) }) },
        {
          id: "7.3c",
          build: async () => {
            const at = await chainNow(w.rpc);
            return { payer: issuerKey, ixs: await openSaleIxs(w, { classKey: "classA", saleId: SALE_22, price: UNIT_PRICE, total: BigInt(5), startTs: at, endTs: saleEnd(w, at) }) };
          },
        },
        {
          id: "7.3d",
          build: async () => {
            const mint = entity(w.runner.state, "mintA") as Address;
            const [destination] = await findAssociatedTokenPda({ owner: issuerKey.address, mint, tokenProgram: TOKEN_2022 });
            return {
              payer: issuerKey,
              ixs: [
                await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: issuerKey, owner: issuerKey.address, mint, tokenProgram: TOKEN_2022 }),
                await getMintToTreasuryInstructionAsync({
                  authority: issuerKey,
                  adminRecord: await resolveIssuerPermission(w.rpc, issuer, issuerKey.address, ISSUER_CAPABILITIES.Mint),
                  issuer,
                  asset,
                  shareClass: classA,
                  destination,
                  tokenProgram: TOKEN_2022,
                  amount: BigInt(1),
                }),
              ],
            };
          },
        },
      ],
    },
    {
      prefix: "7.4",
      bit: PAUSE_SECONDARY,
      label: "0x04",
      entries: [
        { id: "7.4b", build: async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, OFFER_7, BigInt(1), UNIT_PRICE, BigInt(0))).ixs }) },
        { id: "7.4c", build: async () => ({ payer: b2, ixs: await takeIxs(w, b2, offer5) }) },
        { id: "7.4d", build: async () => ({ payer: admin, ixs: await createDealIxs(w, DEAL_11, b1.address, b2.address, BigInt(1), UNIT_PRICE) }) },
        {
          id: "7.4e",
          build: async () => {
            const d = (await fetchOtcDeal(w.rpc, deal10, { commitment: "finalized" })).data;
            return { payer: b1, ixs: await buildDepositOtcAssetInstructions(w.rpc, { seller: b1, dealPda: deal10, deal: d, paymentTokenProgram: TOKEN_CLASSIC }) };
          },
        },
        { id: "7.4f", build: async () => ({ payer: b1, ixs: await fundOfferIxs(w, b1, OFFER_8, BigInt(1)) }) },
        { id: "7.4g", build: async () => ({ payer: b2, ixs: await depositPaymentIxs(w, b2, deal12) }) },
      ],
    },
    {
      prefix: "7.5",
      bit: PAUSE_CUSTODY_ENTRY,
      label: "0x08",
      entries: [
        {
          id: "7.5b",
          build: async () => ({
            payer: admin,
            ixs: await openVaultIxs(w, {
              classKey: "classA",
              vaultId: VAULT_REFUSED,
              vaultType: VaultType.DeliveryEscrow,
              amount: BigInt(1),
              deadline: (await chainNow(w.rpc)) + DELIVERY_DEADLINE_S,
              beneficiary: b1.address,
              registry,
            }),
          }),
        },
        { id: "7.5c", build: async () => ({ payer: b1, ixs: await depositIxs(w, b1, v4, BigInt(1)) }) },
      ],
    },
    {
      prefix: "7.6",
      bit: PAUSE_DISTRIBUTIONS,
      label: "0x10",
      entries: [
        {
          id: "7.6b",
          build: async () => ({
            payer: admin,
            ixs: await fundDistributionIxs(w, await distributionPlan(w, DISTRIBUTION_3, [{ owner: b1.address, amount: BigInt(1_000_000) }])),
          }),
        },
        { id: "7.6c", build: async () => ({ payer: admin, ixs: await payDistributionIxs(w, plan2) }) },
        { id: "7.6d", build: async () => ({ payer: b1, ixs: await vestingDepositInstructions(w, b1, BigInt(1)) }) },
      ],
    },
    {
      prefix: "7.7",
      bit: PAUSE_ISSUER_PROCEEDS,
      label: "0x20",
      entries: [
        {
          id: "7.7b",
          build: async () => {
            const sale = (await fetchSale(w.rpc, sale20, { commitment: "finalized" })).data;
            const paymentMint = entity(w.runner.state, "paymentMint") as Address;
            return {
              payer: issuerKey,
              ixs: [
                await buildCloseSaleInstruction(w.rpc, {
                  authority: issuerKey,
                  sale: { address: sale20, shareClass: classA, proceeds: sale.proceeds, paymentMint },
                  destination: await paymentAta(issuerKey.address, paymentMint),
                  destinationOwner: issuerKey.address,
                  paymentTokenProgram: TOKEN_CLASSIC,
                }),
              ],
            };
          },
        },
      ],
    },
  ];
  for (const round of rounds) {
    const setId = `${round.prefix}a`;
    const clearId = `${round.prefix}${String.fromCharCode("a".charCodeAt(0) + round.entries.length + 1)}`;
    await w.runner.step(setId, async () => ({ payer: admin, ixs: await setPauseIxs(w, admin, round.bit, 0) }), {
      done: async () => ((await flags()) & round.bit) !== 0 || w.runner.passed(clearId),
    });
    for (const entry of round.entries) await w.runner.step(entry.id, entry.build, { notRun: whileSet(round.bit, round.label) });
    await w.runner.step(clearId, async () => ({ payer: sa, ixs: await setPauseIxs(w, sa, 0, round.bit) }), {
      done: async () => ((await flags()) & round.bit) === 0 && w.runner.passed(setId),
    });
  }

  // 7.8: every bit set (0x7F). Exits stay open.
  const allSet = async () => ((await flags()) & PAUSE_FLAGS_ALL) === PAUSE_FLAGS_ALL;
  const underAll = async () => ((await allSet()) ? null : "the platform is no longer fully paused (7.9b ran)");
  await w.runner.step("7.8a", async () => ({ payer: admin, ixs: await setPauseIxs(w, admin, EMERGENCY_PAUSE_BITS, 0) }), {
    done: async () => (await allSet()) || w.runner.passed("7.9b"),
  });
  // The exits below are evidence only under every bit: 0x3F plus the 0x40 G7 started with.
  if (!w.runner.passed("7.9b") && !(await allSet())) {
    throw new ChainPlanError(`7.8a: the pause flags are 0x${(await flags()).toString(16)}, not 0x7f; the exits would not run under a full pause`);
  }
  await w.runner.step("7.8b", async () => ({ payer: admin, ixs: await setPauseIxs(w, admin, 0, PAUSE_ONBOARDING) }), { notRun: underAll });
  await w.runner.step("7.8c", async () => ({ payer: b1, ixs: await cancelOfferIxs(w, b1, offer5) }), {
    notRun: underAll,
    done: async () => (await offerStatus(w, offer5)) === OfferStatus.Cancelled,
  });
  await waitForChainTime({ rpc: w.rpc, target: offer6Expiry + BigInt(2), sleep: w.sleep, signal: w.signal, log: w.log, label: "offer #6 expiry" });
  await w.runner.step("7.8d", async () => ({ payer: b2, ixs: await expireOfferIxs(w, b2, offer6) }), {
    notRun: underAll,
    done: async () => (await offerStatus(w, offer6)) === OfferStatus.Expired,
  });
  await w.runner.step("7.8e", async () => ({ payer: admin, ixs: await cancelDealIxs(w, deal10) }), {
    notRun: underAll,
    done: async () => {
      const account = await fetchMaybeOtcDeal(w.rpc, deal10, { commitment: "finalized" });
      return !account.exists || account.data.status === OtcDealStatus.Cancelled;
    },
  });
  await w.runner.step("7.8f", async () => ({ payer: admin, ixs: await returnIxs(w, v4, admin) }), {
    notRun: underAll,
    done: vaultIn(w, v4, [VaultState.Returned]),
  });
  const qa2 = await vaultPda(w, "classA", QUARANTINE_A2);
  w.runner.setEntity("quarantineA2", qa2);
  await w.runner.step("7.8g", async () => ({ payer: admin, ixs: await openQuarantineIxs(w, "classA", QUARANTINE_A2) }), {
    notRun: underAll,
    done: () => accountExists(w.rpc, qa2),
  });
  const b2Entry = await findBlockEntryPda(b2.address);
  const b2Blocked = () => accountExists(w.rpc, b2Entry);
  await w.runner.step("7.8h", async () => ({ payer: ba, ixs: [await getAddToBlocklistInstructionAsync({ authority: ba, wallet: b2.address })] }), {
    notRun: underAll,
    done: async () => (await b2Blocked()) || w.runner.passed("7.8j"),
  });
  await w.runner.step(
    "7.8i",
    async () => ({ payer: admin, ixs: await clawbackIxs(w, { path: "blocklist", classKey: "classA", quarantine: qa2, holder: b2.address, amount: BigInt(1) }) }),
    {
      notRun: underAll,
      done: async () => {
        const vault = await loadVault(w, qa2);
        return vault === null || vault.state !== VaultState.Active || (await tokenBalance(w.rpc, vault.escrow)) > BigInt(0);
      },
    },
  );
  await w.runner.step("7.8j", async () => ({ payer: ba, ixs: [await getRemoveFromBlocklistInstructionAsync({ authority: ba, wallet: b2.address })] }), {
    notRun: underAll,
    done: async () => !(await b2Blocked()),
  });
  await w.runner.step("7.8k", async () => ({ payer: admin, ixs: await triggerIxs(w, qa2) }), {
    notRun: underAll,
    done: vaultIn(w, qa2, [VaultState.Triggered, VaultState.Realized]),
  });
  await w.runner.step("7.8l", async () => ({ payer: admin, ixs: await realizeIxs(w, qa2) }), { notRun: underAll, done: vaultIn(w, qa2, [VaultState.Realized]) });
  await w.runner.step("7.8m", async () => ({ payer: b3, ixs: await claimVestedIxs(w, b3, 1) }), { notRun: underAll, done: () => vestingReleased(w, 1) });
  await w.runner.step("7.8n", async () => ({ payer: b2, ixs: await claimMilestoneIxs(w, RIGHTS_1, 0, b2) }), {
    notRun: underAll,
    done: () => milestoneClaimed(w, RIGHTS_1, 0, b2.address),
  });
  await w.runner.step("7.8o", async () => ({ payer: admin, ixs: await closeDistributionIxs(w, plan2) }), {
    notRun: underAll,
    done: async () => (await distributionStatus(w, plan2)) === DistributionStatus.Closed,
  });
  await w.runner.step("7.8p", async () => ({ payer: b1, ixs: await castVoteIxs(w, PROPOSAL_2, b1, VoteChoice.For) }), {
    notRun: underAll,
    done: async () => {
      const [record] = await findVoteRecordPda({ proposal: proposal2, voter: b1.address });
      return (await fetchMaybeVoteRecord(w.rpc, record, { commitment: "finalized" })).exists;
    },
  });
  const [approval23] = await findSaleApprovalPda({ shareClass: classA, saleId: BigInt(SALE_23) });
  await w.runner.step(
    "7.8q",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classA", saleId: SALE_23, maxGross: UNIT_PRICE, minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: (await chainNow(w.rpc)) + ONE_DAY }),
    }),
    { notRun: underAll, done: async () => (await accountExists(w.rpc, approval23)) || w.runner.passed("7.8r") },
  );
  await w.runner.step(
    "7.8r",
    async () => ({ payer: admin, ixs: [await getRevokeSaleApprovalInstructionAsync({ authority: admin, saleApproval: approval23, approvedBy: admin.address })] }),
    { notRun: underAll, done: async () => !(await accountExists(w.rpc, approval23)) },
  );
  const b2ShareBefore = w.runner.state.entities.g7TransferB2Before;
  await w.runner.step(
    "7.8s",
    async () => {
      w.runner.setEntity("g7TransferB2Before", await tokenBalance(w.rpc, await shareAta(b2.address, entity(w.runner.state, "mintA") as Address)));
      return { payer: b1, ixs: await walletTransferIxs(w, b1, b2.address, "classA", BigInt(1)) };
    },
    {
      notRun: underAll,
      done: async () =>
        b2ShareBefore !== undefined &&
        (await tokenBalance(w.rpc, await shareAta(b2.address, entity(w.runner.state, "mintA") as Address))) > BigInt(b2ShareBefore),
    },
  );

  // 7.9: the Super Admin resumes the emergency bits; 0x40 clears only on its own.
  await w.runner.step("7.9a", async () => ({ payer: sa, ixs: await setPauseIxs(w, sa, 0, PAUSE_FLAGS_ALL) }), { notRun: underAll });
  await w.runner.step("7.9b", async () => ({ payer: sa, ixs: await setPauseIxs(w, sa, 0, EMERGENCY_PAUSE_BITS) }), {
    done: async () => ((await flags()) & EMERGENCY_PAUSE_BITS) === 0,
  });
  await w.runner.step("7.9c", async () => ({ payer: b1, ixs: await buyIxs(w, b1, "classA", SALE_20, BigInt(1)) }), {
    done: () => saleSold(w, "classA", SALE_20, BigInt(1)),
  });
  return "completed";
}

async function cancelOfferIxs(w: World, maker: KeyPairSigner, offer: Address): Promise<Instruction[]> {
  const { data, makerShare, tail } = await offerReturnTail(w, offer);
  const cancel = await getCancelOfferInstructionAsync({
    maker,
    offer,
    mint: data.mint,
    escrow: data.escrow,
    makerShareAccount: makerShare,
    shareTokenProgram: TOKEN_2022,
  });
  return [withTail(cancel, tail)];
}

async function expireOfferIxs(w: World, payer: KeyPairSigner, offer: Address): Promise<Instruction[]> {
  const { data, makerShare, tail } = await offerReturnTail(w, offer);
  const expire = await getExpireOfferInstructionAsync({
    payer,
    offer,
    mint: data.mint,
    escrow: data.escrow,
    makerShareAccount: makerShare,
    shareTokenProgram: TOKEN_2022,
  });
  return [withTail(expire, tail)];
}


/** create_asset of the draft asset D (never activated: add_share_class needs a Draft asset). */
async function createDraftAssetIxs(w: World, assetId: string): Promise<Instruction[]> {
  return [
    await getCreateAssetInstructionAsync({
      authority: w.roles.issuer,
      issuer: entity(w.runner.state, "issuer") as Address,
      assetId,
      assetType: AssetType.Equity,
      name: `Manci e2e ${w.runId} draft`,
      symbolPrefix: "E2D",
      legalDocHash: sha256Bytes(`manci-e2e:${w.runId}:asset:draft`),
      jurisdictionRules: { allowedCountries: new Uint8Array(128), maxHolders: 0, restrictedPeriodEnd: BigInt(0), allowP2p: true },
    }),
  ];
}

/** add_share_class `index` (Common; voting, dividend, transferable) on the draft asset D. */
async function addDraftClassIxs(w: World, asset: Address, index: number): Promise<Instruction[]> {
  return [
    await getAddShareClassInstructionAsync({
      authority: w.roles.issuer,
      issuer: entity(w.runner.state, "issuer") as Address,
      asset,
      shareClass: await findShareClassPda(asset, index),
      classIndex: index,
      classType: ShareClassType.Common,
      rightsBitfield: 1 | 2 | 32,
      liqPrefMultiplierBps: 10_000,
      liqSeniority: 0,
      votingWeight: 1,
      maxSupply: null,
      mintablePostLaunch: true,
    }),
  ];
}

/** initialize_share_class_mint of a class of D, as G1 initializes class A's (the issuer's MINT grant). */
async function initDraftMintIxs(w: World, asset: Address, shareClass: Address): Promise<Instruction[]> {
  const issuer = entity(w.runner.state, "issuer") as Address;
  const account = await fetchMaybeShareClass(w.rpc, shareClass, { commitment: "finalized" });
  if (!account.exists) throw new ChainPlanError(`share class ${shareClass} of the draft asset is not on chain`);
  const [mint] = await findMintPda({ shareClass });
  return [
    await getInitializeShareClassMintInstructionAsync({
      authority: w.roles.issuer,
      adminRecord: await resolveIssuerPermission(w.rpc, issuer, w.roles.issuer.address, ISSUER_CAPABILITIES.Mint),
      issuer,
      asset,
      shareClass,
      mint,
      hookConfig: (await findConfigPda({ mint }))[0],
      extraAccountMetaList: (await findExtraAccountMetaListPda({ mint }))[0],
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ADDRESS,
      tokenProgram: TOKEN_2022,
    }),
  ];
}
