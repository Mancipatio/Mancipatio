/**
 * G3: OTC without KYC (design-6.3 §A G3). Offers: create + fund, take (the
 * app's buildTakeOfferInstructions), cancel then a refused take, an expired
 * offer refused then expired permissionlessly. Admin deals: a wrong-party
 * deposit is refused, seller + buyer deposits settle, a payment-only deal is
 * cancelled with a refund. Instruction shapes mirror the app pages (hook tail
 * per transfer leg); the offer that must expire is created first.
 *
 * Localnet adds the v1.0.0-rc party blocklist and deadlines: a deal expiring
 * in about a minute with the buyer's payment deposited (3.7a/b), the buyer
 * then blocked (3.8a); a blocked taker is refused (3.8c, 6144); after the
 * expiry the permissionless expire (the app's buildExpireOtcDealInstructions)
 * refuses to refund the blocked buyer (3.7c, 6144, O-11) and the Admin's
 * cancel_otc_deal refunds it (3.7d); then the block is lifted (3.8d). A deal
 * expiring past 90 days is refused (3.9, 6149).
 */
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import {
  OfferStatus,
  OtcDealStatus,
  fetchMaybeOffer,
  fetchMaybeOtcDeal,
  fetchOffer,
  fetchOtcDeal,
  findCreateOfferEscrowPda,
  findDealPda,
  getCancelOfferInstructionAsync,
  getCancelOtcDealInstructionAsync,
  getCreateOfferInstructionAsync,
  getCreateOtcDealInstructionAsync,
  getDepositToOfferEscrowInstructionAsync,
  getExpireOfferInstructionAsync,
} from "@/lib/generated/asset_registry";
import { hookTransferMetas } from "@/lib/hook-metas";
import {
  buildDepositOtcAssetInstructions,
  buildDepositOtcPaymentInstructions,
  buildExpireOtcDealInstructions,
  buildTakeOfferInstructions,
} from "@/lib/otc-transactions";
import { findBlockEntryPda, findOfferPda } from "@/lib/pdas";
import { getAddToBlocklistInstructionAsync, getRemoveFromBlocklistInstructionAsync } from "@/lib/generated/transfer_hook";
import { OTC_DEAL_MAX_TTL_SECONDS } from "@/lib/deadline-bounds";
import { ChainPlanError } from "../../safety";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { chainNow, waitForChainTime } from "../clock";
import { entity } from "../state";
import { accountExists, expiringDeadline, type World } from "../world";
import { UNIT_PRICE } from "./g1";

const EXPIRING_OFFER_S = BigInt(75);
/** Deal #3 must still take the buyer's deposit (3.7b) right after it is created. */
const EXPIRING_DEAL_S = BigInt(90);

function withTail(ix: Instruction, tail: { address: Address; role: number }[]): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ...tail] } as Instruction;
}

async function shareAta(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022 }))[0];
}

async function paymentAtaOf(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_CLASSIC }))[0];
}

/** create_offer alone: an Open offer of class A with an empty escrow. */
export async function createOfferIxs(w: World, maker: KeyPairSigner, offerId: number, amount: bigint, price: bigint, expiresAt: bigint) {
  return [
    await getCreateOfferInstructionAsync({
      maker,
      shareClass: entity(w.runner.state, "classA") as Address,
      mint: entity(w.runner.state, "mintA") as Address,
      paymentMint: entity(w.runner.state, "paymentMint") as Address,
      tokenProgram: TOKEN_2022,
      offerId: BigInt(offerId),
      amount,
      price,
      expiresAt,
    }),
  ];
}

/** deposit_to_offer_escrow of `amount` into class A offer `offerId` (maker → escrow hook tail). */
export async function fundOfferIxs(w: World, maker: KeyPairSigner, offerId: number, amount: bigint) {
  const shareClass = entity(w.runner.state, "classA") as Address;
  const mint = entity(w.runner.state, "mintA") as Address;
  const offer = await findOfferPda(shareClass, BigInt(offerId));
  const [escrow] = await findCreateOfferEscrowPda({ offer });
  const makerShare = await shareAta(maker.address, mint);
  const fund = await getDepositToOfferEscrowInstructionAsync({
    maker,
    offer,
    mint,
    escrow,
    makerShareAccount: makerShare,
    tokenProgram: TOKEN_2022,
    amount,
  });
  const tail = await hookTransferMetas(w.rpc, mint, {
    sourceTokenAccount: makerShare,
    destTokenAccount: escrow,
    transferAuthority: maker.address,
    sourceOwner: maker.address,
    destOwner: offer,
  });
  return [withTail(fund, tail)];
}

/** create_offer + deposit_to_offer_escrow in one transaction (maker → escrow leg). */
export async function createAndFundOffer(w: World, maker: KeyPairSigner, offerId: number, amount: bigint, price: bigint, expiresAt: bigint) {
  const offer = await findOfferPda(entity(w.runner.state, "classA") as Address, BigInt(offerId));
  return {
    offer,
    ixs: [...(await createOfferIxs(w, maker, offerId, amount, price, expiresAt)), ...(await fundOfferIxs(w, maker, offerId, amount))],
  };
}

/** The escrow → maker leg shared by cancel_offer and expire_offer. */
export async function offerReturnTail(w: World, offer: Address) {
  const data = (await fetchOffer(w.rpc, offer, { commitment: "finalized" })).data;
  const makerShare = await shareAta(data.maker, data.mint);
  const tail = await hookTransferMetas(w.rpc, data.mint, {
    sourceTokenAccount: data.escrow,
    destTokenAccount: makerShare,
    transferAuthority: offer,
    sourceOwner: offer,
    destOwner: data.maker,
  });
  return { data, makerShare, tail };
}

export async function takeIxs(w: World, taker: KeyPairSigner, offer: Address) {
  const data = (await fetchOffer(w.rpc, offer, { commitment: "finalized" })).data;
  return buildTakeOfferInstructions(w.rpc, { taker, offerPda: offer, offer: data, paymentTokenProgram: TOKEN_CLASSIC });
}

export async function offerStatus(w: World, offer: Address): Promise<OfferStatus | null> {
  const account = await fetchMaybeOffer(w.rpc, offer, { commitment: "finalized" });
  return account.exists ? account.data.status : null;
}

export async function dealStatus(w: World, deal: Address): Promise<OtcDealStatus | null> {
  const account = await fetchMaybeOtcDeal(w.rpc, deal, { commitment: "finalized" });
  return account.exists ? account.data.status : null;
}

/** The e2e deals' lifetime: long enough for the group, inside the 90-day cap. */
const DEAL_TTL_S = BigInt(7 * 86_400);

export async function createDealIxs(w: World, dealId: number, seller: Address, buyer: Address, amount: bigint, price: bigint, expiresAt?: bigint) {
  const paymentMint = entity(w.runner.state, "paymentMint") as Address;
  return [
    await getCreateOtcDealInstructionAsync({
      authority: w.roles.admin,
      shareClass: entity(w.runner.state, "classA") as Address,
      mint: entity(w.runner.state, "mintA") as Address,
      paymentMint,
      paymentTokenProgram: TOKEN_CLASSIC,
      tokenProgram: TOKEN_2022,
      dealId: BigInt(dealId),
      buyer,
      seller,
      amount,
      price,
      paymentMintArg: paymentMint,
      // v1: every deal expires, at most 90 days out (DealExpiryOutOfRange).
      expiresAt: expiresAt ?? (await chainNow(w.rpc)) + DEAL_TTL_S,
    }),
  ];
}

/** cancel_otc_deal by the Admin (as /admin/otc builds it): both deposited legs return. */
export async function cancelDealIxs(w: World, deal: Address) {
  const { admin } = w.roles;
  const d = (await fetchOtcDeal(w.rpc, deal, { commitment: "finalized" })).data;
  const sellerShare = await shareAta(d.seller, d.mint);
  const buyerPayment = await paymentAtaOf(d.buyer, d.paymentMint);
  const base = await getCancelOtcDealInstructionAsync({
    authority: admin,
    deal,
    mint: d.mint,
    assetEscrow: d.assetEscrow,
    sellerShareAccount: sellerShare,
    paymentMint: d.paymentMint,
    paymentEscrow: d.paymentEscrow,
    buyerPaymentAccount: buyerPayment,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram: TOKEN_CLASSIC,
  });
  const tail = await hookTransferMetas(w.rpc, d.mint, {
    sourceTokenAccount: d.assetEscrow,
    destTokenAccount: sellerShare,
    transferAuthority: deal,
    sourceOwner: deal,
    destOwner: d.seller,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: d.seller, mint: d.mint, tokenProgram: TOKEN_2022 }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: d.buyer, mint: d.paymentMint, tokenProgram: TOKEN_CLASSIC }),
    withTail(base, tail),
  ];
}

/** deposit_otc_payment as /portfolio/deals builds it (lib/otc-transactions; settle leg: asset escrow → buyer). */
export async function depositPaymentIxs(w: World, buyer: KeyPairSigner, deal: Address) {
  const d = (await fetchOtcDeal(w.rpc, deal, { commitment: "finalized" })).data;
  return buildDepositOtcPaymentInstructions(w.rpc, {
    buyer,
    dealPda: deal,
    deal: d,
    paymentTokenProgram: TOKEN_CLASSIC,
  });
}

export async function runGroup3(w: World): Promise<"completed"> {
  const { admin, buyers } = w.roles;
  const [b1, b2, b3] = buyers;
  const shareClass = entity(w.runner.state, "classA") as Address;

  // 3.4a first: offer #3 expires while the rest runs.
  const offer3 = await findOfferPda(shareClass, BigInt(3));
  await w.runner.step(
    "3.4a",
    async () => {
      const expiresAt = await expiringDeadline(w, {
        key: "offer3ExpiresAt",
        step: "3.4a",
        seconds: EXPIRING_OFFER_S,
        exists: () => accountExists(w.rpc, offer3),
      });
      return { payer: b1, ixs: (await createAndFundOffer(w, b1, 3, BigInt(1), UNIT_PRICE, expiresAt)).ixs };
    },
    { done: () => accountExists(w.rpc, offer3) },
  );
  const offer3Expiry = BigInt(entity(w.runner.state, "offer3ExpiresAt"));

  // 3.7a/b (localnet) right away: deal #3 expires while the rest runs, with
  // the buyer's payment in its escrow.
  const [deal3] = await findDealPda({ shareClass, dealId: BigInt(3) });
  const blocking = w.runner.applies("3.7a");
  let deal3Expiry = BigInt(0);
  if (blocking) {
    await w.runner.step(
      "3.7a",
      async () => {
        const expiresAt = await expiringDeadline(w, {
          key: "deal3ExpiresAt",
          step: "3.7a",
          seconds: EXPIRING_DEAL_S,
          exists: () => accountExists(w.rpc, deal3),
        });
        return { payer: admin, ixs: await createDealIxs(w, 3, b1.address, b2.address, BigInt(1), UNIT_PRICE, expiresAt) };
      },
      { done: () => accountExists(w.rpc, deal3) },
    );
    deal3Expiry = BigInt(entity(w.runner.state, "deal3ExpiresAt"));
    await w.runner.step("3.7b", async () => ({ payer: b2, ixs: await depositPaymentIxs(w, b2, deal3) }), {
      done: async () => {
        const account = await fetchMaybeOtcDeal(w.rpc, deal3, { commitment: "finalized" });
        return !account.exists || account.data.paymentDepositedAmount > BigInt(0) || account.data.status !== OtcDealStatus.Open;
      },
      notRun: async () =>
        (await chainNow(w.rpc)) + BigInt(10) < deal3Expiry ? null : `deal #3 expired at ${deal3Expiry} before the deposit could be shown`,
    });
  }

  const offer1 = await findOfferPda(shareClass, BigInt(1));
  await w.runner.step(
    "3.1",
    async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, 1, BigInt(2), UNIT_PRICE * BigInt(3), BigInt(0))).ixs }),
    { done: () => accountExists(w.rpc, offer1) },
  );
  await w.runner.step("3.2", async () => ({ payer: b2, ixs: await takeIxs(w, b2, offer1) }), {
    done: async () => (await offerStatus(w, offer1)) === OfferStatus.Filled,
  });

  const offer2 = await findOfferPda(shareClass, BigInt(2));
  await w.runner.step(
    "3.3a",
    async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, 2, BigInt(1), UNIT_PRICE, BigInt(0))).ixs }),
    { done: () => accountExists(w.rpc, offer2) },
  );
  await w.runner.step(
    "3.3b",
    async () => {
      const { data, makerShare, tail } = await offerReturnTail(w, offer2);
      const cancel = await getCancelOfferInstructionAsync({
        maker: b1,
        offer: offer2,
        mint: data.mint,
        escrow: data.escrow,
        makerShareAccount: makerShare,
        shareTokenProgram: TOKEN_2022,
      });
      return { payer: b1, ixs: [withTail(cancel, tail)] };
    },
    { done: async () => (await offerStatus(w, offer2)) === OfferStatus.Cancelled },
  );
  await w.runner.step("3.3c", async () => ({ payer: b2, ixs: await takeIxs(w, b2, offer2) }));

  // Deals.
  const [deal1] = await findDealPda({ shareClass, dealId: BigInt(1) });
  w.runner.setEntity("deal1", deal1);
  await w.runner.step(
    "3.5a",
    async () => ({ payer: admin, ixs: await createDealIxs(w, 1, b1.address, b2.address, BigInt(1), UNIT_PRICE * BigInt(2)) }),
    { done: () => accountExists(w.rpc, deal1) },
  );
  const sellerDeposit = async (seller: KeyPairSigner) => {
    const d = (await fetchOtcDeal(w.rpc, deal1, { commitment: "finalized" })).data;
    return buildDepositOtcAssetInstructions(w.rpc, { seller, dealPda: deal1, deal: d, paymentTokenProgram: TOKEN_CLASSIC });
  };
  // B3's share account exists only if group 2 ran (2.4b); created here (in
  // the simulation only) so the refusal is the party check, not a missing
  // account, whichever groups ran before.
  await w.runner.step("3.5b", async () => ({
    payer: b3,
    ixs: [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: b3,
        owner: b3.address,
        mint: entity(w.runner.state, "mintA") as Address,
        tokenProgram: TOKEN_2022,
      }),
      ...(await sellerDeposit(b3)),
    ],
  }));
  await w.runner.step("3.5c", async () => ({ payer: b1, ixs: await sellerDeposit(b1) }), {
    done: async () => {
      const account = await fetchMaybeOtcDeal(w.rpc, deal1, { commitment: "finalized" });
      return !account.exists || account.data.assetDepositedAmount > BigInt(0) || account.data.status !== OtcDealStatus.Open;
    },
  });
  await w.runner.step("3.5d", async () => ({ payer: b2, ixs: await depositPaymentIxs(w, b2, deal1) }), {
    done: async () => {
      const status = await dealStatus(w, deal1);
      return status === null || status === OtcDealStatus.Completed;
    },
  });

  const [deal2] = await findDealPda({ shareClass, dealId: BigInt(2) });
  w.runner.setEntity("deal2", deal2);
  await w.runner.step(
    "3.6a",
    async () => ({ payer: admin, ixs: await createDealIxs(w, 2, b1.address, b2.address, BigInt(1), UNIT_PRICE) }),
    { done: () => accountExists(w.rpc, deal2) },
  );
  await w.runner.step("3.6b", async () => ({ payer: b2, ixs: await depositPaymentIxs(w, b2, deal2) }), {
    done: async () => {
      const account = await fetchMaybeOtcDeal(w.rpc, deal2, { commitment: "finalized" });
      return !account.exists || account.data.paymentDepositedAmount > BigInt(0) || account.data.status !== OtcDealStatus.Open;
    },
  });
  await w.runner.step("3.6c", async () => ({ payer: admin, ixs: await cancelDealIxs(w, deal2) }), {
    done: async () => {
      const status = await dealStatus(w, deal2);
      return status === null || status === OtcDealStatus.Cancelled;
    },
  });

  // 3.9: every deal expires at most 90 days out (6149), whatever the network.
  await w.runner.step("3.9", async () => ({
    payer: admin,
    ixs: await createDealIxs(w, 9, b1.address, b2.address, BigInt(1), UNIT_PRICE, (await chainNow(w.rpc)) + BigInt(OTC_DEAL_MAX_TTL_SECONDS) + BigInt(86_400)),
  }));

  if (blocking) {
    const ba = w.roles.blocklistAuthority;
    if (!ba) throw new ChainPlanError("3.8 needs the localnet blocklist authority key");
    const b2Entry = await findBlockEntryPda(b2.address);
    const b2Blocked = () => accountExists(w.rpc, b2Entry);
    // 3.8a: B2 (deal #3's buyer, the taker below) is blocked after its deposit.
    await w.runner.step("3.8a", async () => ({ payer: ba, ixs: [await getAddToBlocklistInstructionAsync({ authority: ba, wallet: b2.address })] }), {
      done: async () => (await b2Blocked()) || w.runner.passed("3.8d"),
    });
    const offer4 = await findOfferPda(shareClass, BigInt(4));
    await w.runner.step(
      "3.8b",
      async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, 4, BigInt(1), UNIT_PRICE, BigInt(0))).ixs }),
      { done: () => accountExists(w.rpc, offer4) },
    );
    await w.runner.step("3.8c", async () => ({ payer: b2, ixs: await takeIxs(w, b2, offer4) }), {
      notRun: async () => ((await b2Blocked()) ? null : "B2 is no longer blocked (3.8d ran)"),
    });
    // After deal #3's expiry: the permissionless expire must not refund the
    // blocked buyer (O-11); the Admin's cancel does.
    await waitForChainTime({ rpc: w.rpc, target: deal3Expiry + BigInt(2), sleep: w.sleep, signal: w.signal, log: w.log, label: "deal #3 expiry" });
    const deal3Open = async () => (await dealStatus(w, deal3)) === OtcDealStatus.Open;
    await w.runner.step(
      "3.7c",
      async () => {
        const d = (await fetchOtcDeal(w.rpc, deal3, { commitment: "finalized" })).data;
        return { payer: b3, ixs: await buildExpireOtcDealInstructions(w.rpc, { payer: b3, dealPda: deal3, deal: d, paymentTokenProgram: TOKEN_CLASSIC }) };
      },
      { notRun: async () => ((await deal3Open()) && (await b2Blocked()) ? null : "deal #3 is no longer open with its buyer blocked") },
    );
    await w.runner.step("3.7d", async () => ({ payer: admin, ixs: await cancelDealIxs(w, deal3) }), {
      done: async () => {
        const status = await dealStatus(w, deal3);
        return status === null || status === OtcDealStatus.Cancelled;
      },
    });
    await w.runner.step("3.8d", async () => ({ payer: ba, ixs: [await getRemoveFromBlocklistInstructionAsync({ authority: ba, wallet: b2.address })] }), {
      done: async () => !(await b2Blocked()),
    });
    await w.runner.step(
      "3.8e",
      async () => {
        const { data, makerShare, tail } = await offerReturnTail(w, offer4);
        const cancel = await getCancelOfferInstructionAsync({
          maker: b1,
          offer: offer4,
          mint: data.mint,
          escrow: data.escrow,
          makerShareAccount: makerShare,
          shareTokenProgram: TOKEN_2022,
        });
        return { payer: b1, ixs: [withTail(cancel, tail)] };
      },
      { done: async () => (await offerStatus(w, offer4)) === OfferStatus.Cancelled },
    );
  }

  // 3.4b/c after offer #3 expired.
  await waitForChainTime({ rpc: w.rpc, target: offer3Expiry + BigInt(2), sleep: w.sleep, signal: w.signal, log: w.log, label: "offer #3 expiry" });
  await w.runner.step("3.4b", async () => ({ payer: b2, ixs: await takeIxs(w, b2, offer3) }));
  await w.runner.step(
    "3.4c",
    async () => {
      const { data, makerShare, tail } = await offerReturnTail(w, offer3);
      const expire = await getExpireOfferInstructionAsync({
        payer: b2,
        offer: offer3,
        mint: data.mint,
        escrow: data.escrow,
        makerShareAccount: makerShare,
        shareTokenProgram: TOKEN_2022,
      });
      return { payer: b2, ixs: [withTail(expire, tail)] };
    },
    { done: async () => (await offerStatus(w, offer3)) === OfferStatus.Expired },
  );
  return "completed";
}
