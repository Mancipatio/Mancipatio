/**
 * G2: a sale is bound by its SaleApproval (design-6.3 §A G2): the gross and
 * the price range cap open_sale, a sold-out sale refuses the next unit, an
 * expired approval cannot open a sale, a non-Admin cannot approve, and a sale
 * that has not started refuses purchases. The approval that must expire is
 * created first so the wait overlaps the other steps.
 */
import type { Address } from "@solana/kit";
import {
  fetchMaybeSaleApproval,
  findSaleApprovalPda,
  getRevokeSaleApprovalInstructionAsync,
} from "@/lib/generated/asset_registry";
import { chainNow, waitForChainTime } from "../clock";
import { entity } from "../state";
import { ONE_DAY, type World } from "../world";
import { UNIT_PRICE, approveSaleIxs, buyIxs, openSaleIxs, saleApprovalExists, saleExists } from "./g1";

const SALE2_TOTAL = BigInt(5);
const EXPIRING_APPROVAL_S = BigInt(75);

export async function runGroup2(w: World): Promise<"completed"> {
  const { admin, issuer, buyers } = w.roles;
  const [b1, , b3] = buyers;

  // 2.5a first: its approval expires while 2.1–2.7 run.
  const t0 = await chainNow(w.rpc);
  if (!w.runner.state.entities.approval3ExpiresAt) w.runner.setEntity("approval3ExpiresAt", t0 + EXPIRING_APPROVAL_S);
  const approval3Expiry = BigInt(entity(w.runner.state, "approval3ExpiresAt"));
  await w.runner.step(
    "2.5a",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classA", saleId: 3, maxGross: UNIT_PRICE, minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: approval3Expiry }),
    }),
    { done: () => saleApprovalExists(w, "classA", 3) },
  );

  const now = await chainNow(w.rpc);
  const week = now + BigInt(7) * ONE_DAY;
  await w.runner.step(
    "2.1",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, {
        classKey: "classA",
        saleId: 2,
        maxGross: UNIT_PRICE * SALE2_TOTAL,
        minPrice: UNIT_PRICE,
        maxPrice: UNIT_PRICE,
        expiresAt: now + ONE_DAY,
      }),
    }),
    { done: () => saleApprovalExists(w, "classA", 2) },
  );
  await w.runner.step("2.2", async () => ({
    payer: issuer,
    ixs: await openSaleIxs(w, { classKey: "classA", saleId: 2, price: UNIT_PRICE, total: SALE2_TOTAL + BigInt(1), startTs: now, endTs: week }),
  }));
  await w.runner.step("2.3", async () => ({
    payer: issuer,
    ixs: await openSaleIxs(w, { classKey: "classA", saleId: 2, price: UNIT_PRICE * BigInt(2), total: BigInt(2), startTs: now, endTs: week }),
  }));
  await w.runner.step(
    "2.4a",
    async () => ({
      payer: issuer,
      ixs: await openSaleIxs(w, { classKey: "classA", saleId: 2, price: UNIT_PRICE, total: SALE2_TOTAL, startTs: now, endTs: week }),
    }),
    { done: () => saleExists(w, "classA", 2) },
  );
  await w.runner.step("2.4b", async () => ({ payer: b3, ixs: await buyIxs(w, b3, "classA", 2, SALE2_TOTAL) }));
  await w.runner.step("2.4c", async () => ({ payer: b3, ixs: await buyIxs(w, b3, "classA", 2, BigInt(1)) }));

  // 2.6: approve_sale needs the signer's Admin record.
  await w.runner.step("2.6", async () => ({
    payer: b1,
    ixs: await approveSaleIxs(w, {
      signer: b1,
      classKey: "classA",
      saleId: 6,
      maxGross: UNIT_PRICE,
      minPrice: UNIT_PRICE,
      maxPrice: UNIT_PRICE,
      expiresAt: now + ONE_DAY,
    }),
  }));

  // 2.7: a sale that starts in an hour.
  await w.runner.step(
    "2.7a",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classA", saleId: 5, maxGross: UNIT_PRICE * BigInt(10), minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: now + ONE_DAY }),
    }),
    { done: () => saleApprovalExists(w, "classA", 5) },
  );
  await w.runner.step(
    "2.7b",
    async () => ({
      payer: issuer,
      ixs: await openSaleIxs(w, {
        classKey: "classA",
        saleId: 5,
        price: UNIT_PRICE,
        total: BigInt(10),
        startTs: now + BigInt(3_600),
        endTs: week,
      }),
    }),
    { done: () => saleExists(w, "classA", 5) },
  );
  await w.runner.step("2.7c", async () => ({ payer: b1, ixs: await buyIxs(w, b1, "classA", 5, BigInt(1)) }));

  // 2.5b/c after the approval expired.
  await waitForChainTime({ rpc: w.rpc, target: approval3Expiry + BigInt(2), sleep: w.sleep, signal: w.signal, log: w.log, label: "approval #3 expiry" });
  await w.runner.step("2.5b", async () => ({
    payer: issuer,
    ixs: await openSaleIxs(w, { classKey: "classA", saleId: 3, price: UNIT_PRICE, total: BigInt(1), startTs: approval3Expiry - BigInt(10), endTs: week }),
  }));
  const [approval3] = await findSaleApprovalPda({ shareClass: entity(w.runner.state, "classA") as Address, saleId: BigInt(3) });
  await w.runner.step(
    "2.5c",
    async () => ({
      payer: admin,
      ixs: [await getRevokeSaleApprovalInstructionAsync({ authority: admin, saleApproval: approval3, approvedBy: admin.address })],
    }),
    {
      done: async () => {
        const account = await fetchMaybeSaleApproval(w.rpc, approval3, { commitment: "finalized" });
        return !account.exists;
      },
    },
  );
  return "completed";
}
