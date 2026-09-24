/**
 * G3: OTC without KYC (design-6.3 §A G3). Offers: create + fund, take (the
 * app's buildTakeOfferInstructions), cancel then a refused take, an expired
 * offer refused then expired permissionlessly. Admin deals: a wrong-party
 * deposit is refused, seller + buyer deposits settle, a payment-only deal is
 * cancelled with a refund. Instruction shapes mirror the app pages (hook tail
 * per transfer leg); the offer that must expire is created first.
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
  getDepositOtcPaymentInstructionAsync,
  getDepositToOfferEscrowInstructionAsync,
  getExpireOfferInstructionAsync,
} from "@/lib/generated/asset_registry";
import { hookTransferMetas } from "@/lib/hook-metas";
import { buildDepositOtcAssetInstructions, buildTakeOfferInstructions } from "@/lib/otc-transactions";
import { findOfferPda } from "@/lib/pdas";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { chainNow, waitForChainTime } from "../clock";
import { entity } from "../state";
import { accountExists, type World } from "../world";
import { UNIT_PRICE } from "./g1";

const EXPIRING_OFFER_S = BigInt(75);

function withTail(ix: Instruction, tail: { address: Address; role: number }[]): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ...tail] } as Instruction;
}

async function shareAta(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022 }))[0];
}

async function paymentAtaOf(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_CLASSIC }))[0];
}

/** create_offer + deposit_to_offer_escrow in one transaction (maker → escrow leg). */
async function createAndFundOffer(w: World, maker: KeyPairSigner, offerId: number, amount: bigint, price: bigint, expiresAt: bigint) {
  const shareClass = entity(w.runner.state, "classA") as Address;
  const mint = entity(w.runner.state, "mintA") as Address;
  const paymentMint = entity(w.runner.state, "paymentMint") as Address;
  const offer = await findOfferPda(shareClass, BigInt(offerId));
  const [escrow] = await findCreateOfferEscrowPda({ offer });
  const makerShare = await shareAta(maker.address, mint);
  const create = await getCreateOfferInstructionAsync({
    maker,
    shareClass,
    mint,
    paymentMint,
    tokenProgram: TOKEN_2022,
    offerId: BigInt(offerId),
    amount,
    price,
    expiresAt,
  });
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
  return { offer, ixs: [create, withTail(fund, tail)] };
}

/** The escrow → maker leg shared by cancel_offer and expire_offer. */
async function offerReturnTail(w: World, offer: Address) {
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

async function takeIxs(w: World, taker: KeyPairSigner, offer: Address) {
  const data = (await fetchOffer(w.rpc, offer, { commitment: "finalized" })).data;
  return buildTakeOfferInstructions(w.rpc, { taker, offerPda: offer, offer: data, paymentTokenProgram: TOKEN_CLASSIC });
}

async function offerStatus(w: World, offer: Address): Promise<OfferStatus | null> {
  const account = await fetchMaybeOffer(w.rpc, offer, { commitment: "finalized" });
  return account.exists ? account.data.status : null;
}

async function dealStatus(w: World, deal: Address): Promise<OtcDealStatus | null> {
  const account = await fetchMaybeOtcDeal(w.rpc, deal, { commitment: "finalized" });
  return account.exists ? account.data.status : null;
}

async function createDealIxs(w: World, dealId: number, seller: Address, buyer: Address, amount: bigint, price: bigint) {
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
      expiresAt: BigInt(0),
    }),
  ];
}

/** deposit_otc_payment as /portfolio/deals builds it (settle leg: asset escrow → buyer). */
async function depositPaymentIxs(w: World, buyer: KeyPairSigner, deal: Address) {
  const d = (await fetchOtcDeal(w.rpc, deal, { commitment: "finalized" })).data;
  const buyerShare = await shareAta(buyer.address, d.mint);
  const sellerPayment = await paymentAtaOf(d.seller, d.paymentMint);
  const base = await getDepositOtcPaymentInstructionAsync({
    buyer,
    deal,
    mint: d.mint,
    paymentMint: d.paymentMint,
    buyerPaymentAccount: await paymentAtaOf(buyer.address, d.paymentMint),
    paymentEscrow: d.paymentEscrow,
    assetEscrow: d.assetEscrow,
    buyerShareAccount: buyerShare,
    sellerPaymentAccount: sellerPayment,
    shareTokenProgram: TOKEN_2022,
    paymentTokenProgram: TOKEN_CLASSIC,
  });
  const tail = await hookTransferMetas(w.rpc, d.mint, {
    sourceTokenAccount: d.assetEscrow,
    destTokenAccount: buyerShare,
    transferAuthority: deal,
    sourceOwner: deal,
    destOwner: buyer.address,
  });
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: buyer.address, mint: d.mint, tokenProgram: TOKEN_2022 }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: d.seller, mint: d.paymentMint, tokenProgram: TOKEN_CLASSIC }),
    withTail(base, tail),
  ];
}

export async function runGroup3(w: World): Promise<"completed"> {
  const { admin, buyers } = w.roles;
  const [b1, b2] = buyers;
  const shareClass = entity(w.runner.state, "classA") as Address;

  // 3.4a first: offer #3 expires while the rest runs.
  const t0 = await chainNow(w.rpc);
  if (!w.runner.state.entities.offer3ExpiresAt) w.runner.setEntity("offer3ExpiresAt", t0 + EXPIRING_OFFER_S);
  const offer3Expiry = BigInt(entity(w.runner.state, "offer3ExpiresAt"));
  const offer3 = await findOfferPda(shareClass, BigInt(3));
  await w.runner.step(
    "3.4a",
    async () => ({ payer: b1, ixs: (await createAndFundOffer(w, b1, 3, BigInt(1), UNIT_PRICE, offer3Expiry)).ixs }),
    { done: () => accountExists(w.rpc, offer3) },
  );

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
  await w.runner.step("3.5b", async () => ({ payer: b2, ixs: await sellerDeposit(b2) }));
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
  await w.runner.step(
    "3.6c",
    async () => {
      const d = (await fetchOtcDeal(w.rpc, deal2, { commitment: "finalized" })).data;
      const sellerShare = await shareAta(d.seller, d.mint);
      const buyerPayment = await paymentAtaOf(d.buyer, d.paymentMint);
      const base = await getCancelOtcDealInstructionAsync({
        authority: admin,
        deal: deal2,
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
        transferAuthority: deal2,
        sourceOwner: deal2,
        destOwner: d.seller,
      });
      return {
        payer: admin,
        ixs: [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: d.seller, mint: d.mint, tokenProgram: TOKEN_2022 }),
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: d.buyer, mint: d.paymentMint, tokenProgram: TOKEN_CLASSIC }),
          withTail(base, tail),
        ],
      };
    },
    {
      done: async () => {
        const status = await dealStatus(w, deal2);
        return status === null || status === OtcDealStatus.Cancelled;
      },
    },
  );

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
