/**
 * G6: clawback into a burn-only quarantine vault (design-6.3 §A G6,
 * v1.0.0-rc). Both networks: clawback_from_holder is refused on an Open
 * class (6080), clawback_blocklisted_holder for a holder who is not blocked
 * (6137). Localnet adds both real paths:
 *
 * - Open class A: the BlocklistAuthority blocks B3 (its own transfers stop in
 *   the hook, 6003), the Admin claws units back, the block is lifted, the
 *   quarantine is triggered and realized (burn);
 * - KycGated class B: holders with passports buy; a revoked passport (B3) is
 *   clawed back at once; a valid one (B2) is refused (6079), and so is an
 *   expired one inside the 30-day grace (B4, 6079), which passes after it (a
 *   warp).
 */
import type { Address } from "@solana/kit";
import { findBlockEntryPda } from "@/lib/pdas";
import { buildRevokePassport, getEntryPda } from "@/lib/passport";
import { KycStatus, fetchMaybeKycEntry } from "@/lib/generated/asset_registry";
import { getAddToBlocklistInstructionAsync, getRemoveFromBlocklistInstructionAsync } from "@/lib/generated/transfer_hook";
import { KYC_EXPIRY_CLAWBACK_GRACE_SECONDS } from "@/lib/clawback-path";
import { ChainPlanError } from "../../safety";
import { chainNow } from "../clock";
import {
  VaultState,
  clawbackIxs,
  loadVault,
  openQuarantineIxs,
  realizeIxs,
  shareAta,
  triggerIxs,
  vaultIn,
  vaultPda,
  walletTransferIxs,
} from "../custody";
import { tokenBalance } from "../fixtures";
import { entity } from "../state";
import { CLOCK_GUARD_S, ONE_DAY, accountExists, expiringDeadline, reachChainTime, type World } from "../world";
import { UNIT_PRICE, approveSaleIxs, buyIxs, openSaleIxs, saleApprovalExists, saleEnd, saleExists, saleSold } from "./g1";
import { approveHolderIxs, e2eRegistry } from "./g4";

export const QUARANTINE_A = 10;
export const QUARANTINE_B = 11;
const SALE_B = 7;
/** B4's passport expires this soon after 6.5c, so the grace can start inside the group. */
const B4_PASSPORT_S = BigInt(180);

export async function runGroup6(w: World): Promise<"completed"> {
  const { admin, buyers } = w.roles;
  const [b1, b2, b3, b4] = buyers;
  const registry = await e2eRegistry(w);

  // 6.1–6.3: the negatives, against the quarantine vault QA of class A.
  const qa = await vaultPda(w, "classA", QUARANTINE_A);
  w.runner.setEntity("quarantineA", qa);
  await w.runner.step("6.1", async () => ({ payer: admin, ixs: await openQuarantineIxs(w, "classA", QUARANTINE_A) }), {
    done: () => accountExists(w.rpc, qa),
  });
  const qaActive = async () => ((await vaultIn(w, qa, [VaultState.Active])()) ? null : "quarantine QA is no longer Active (6.4e ran)");
  await w.runner.step(
    "6.2",
    async () => ({ payer: admin, ixs: await clawbackIxs(w, { path: "kyc", classKey: "classA", quarantine: qa, holder: b1.address, amount: BigInt(1), registry }) }),
    { notRun: qaActive },
  );
  await w.runner.step(
    "6.3",
    async () => ({ payer: admin, ixs: await clawbackIxs(w, { path: "blocklist", classKey: "classA", quarantine: qa, holder: b1.address, amount: BigInt(1) }) }),
    { notRun: qaActive },
  );
  if (!w.runner.applies("6.4a")) return "completed";

  // 6.4 (localnet): the blocklist path on the Open class A.
  const ba = w.roles.blocklistAuthority;
  const kyc = w.roles.kycAuthority;
  if (!ba || !kyc) throw new ChainPlanError("6.4–6.6 need the localnet BlocklistAuthority and KYC authority keys");
  const b3Entry = await findBlockEntryPda(b3.address);
  const b3Blocked = () => accountExists(w.rpc, b3Entry);
  const seized = async () => {
    const vault = await loadVault(w, qa);
    return vault === null || vault.state !== VaultState.Active || (await tokenBalance(w.rpc, vault.escrow)) > BigInt(0);
  };
  await w.runner.step("6.4a", async () => ({ payer: ba, ixs: [await getAddToBlocklistInstructionAsync({ authority: ba, wallet: b3.address })] }), {
    done: async () => (await b3Blocked()) || w.runner.passed("6.4d"),
  });
  await w.runner.step("6.4b", async () => ({ payer: b3, ixs: await walletTransferIxs(w, b3, b1.address, "classA", BigInt(1)) }), {
    notRun: async () => ((await b3Blocked()) ? null : "B3 is no longer blocked (6.4d ran)"),
  });
  await w.runner.step(
    "6.4c",
    async () => ({ payer: admin, ixs: await clawbackIxs(w, { path: "blocklist", classKey: "classA", quarantine: qa, holder: b3.address, amount: BigInt(2) }) }),
    { done: seized },
  );
  await w.runner.step("6.4d", async () => ({ payer: ba, ixs: [await getRemoveFromBlocklistInstructionAsync({ authority: ba, wallet: b3.address })] }), {
    done: async () => !(await b3Blocked()),
  });
  await w.runner.step("6.4e", async () => ({ payer: admin, ixs: await triggerIxs(w, qa) }), {
    done: vaultIn(w, qa, [VaultState.Triggered, VaultState.Realized]),
  });
  await w.runner.step("6.4f", async () => ({ payer: admin, ixs: await realizeIxs(w, qa) }), {
    done: vaultIn(w, qa, [VaultState.Realized]),
  });

  // 6.5: holders of the KycGated class B (sale #7): B2 refreshed, B3 and B4 approved (B4 briefly).
  const now = await chainNow(w.rpc);
  await w.runner.step(
    "6.5a",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, { classKey: "classB", saleId: SALE_B, maxGross: UNIT_PRICE * BigInt(10), minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: now + ONE_DAY }),
    }),
    { done: async () => (await saleApprovalExists(w, "classB", SALE_B)) || (await saleExists(w, "classB", SALE_B)) },
  );
  await w.runner.step(
    "6.5b",
    async () => ({
      payer: w.roles.issuer,
      ixs: await openSaleIxs(w, { classKey: "classB", saleId: SALE_B, price: UNIT_PRICE, total: BigInt(10), startTs: now, endTs: saleEnd(w, now) }),
    }),
    { done: () => saleExists(w, "classB", SALE_B) },
  );
  const b4Entry = await getEntryPda(registry, b4.address);
  await w.runner.step(
    "6.5c",
    async () => {
      const b4Expiry = await expiringDeadline(w, { key: "b4PassportExpiry", step: "6.5c", seconds: B4_PASSPORT_S, exists: () => accountExists(w.rpc, b4Entry) });
      const year = (await chainNow(w.rpc)) + BigInt(365) * ONE_DAY;
      return {
        payer: kyc,
        ixs: [
          ...(await approveHolderIxs(w, b2.address, year, registry)),
          ...(await approveHolderIxs(w, b3.address, year, registry)),
          ...(await approveHolderIxs(w, b4.address, b4Expiry, registry)),
        ],
      };
    },
    { done: () => accountExists(w.rpc, b4Entry) },
  );
  const b4Expiry = BigInt(entity(w.runner.state, "b4PassportExpiry"));
  await w.runner.step("6.5d", async () => ({ payer: b3, ixs: await buyIxs(w, b3, "classB", SALE_B, BigInt(2)) }), {
    done: () => saleSold(w, "classB", SALE_B, BigInt(2)),
  });
  await w.runner.step("6.5e", async () => ({ payer: b4, ixs: await buyIxs(w, b4, "classB", SALE_B, BigInt(2)) }), {
    done: () => saleSold(w, "classB", SALE_B, BigInt(4)),
    notRun: async () => ((await chainNow(w.rpc)) + CLOCK_GUARD_S < b4Expiry ? null : `B4's passport expired at ${b4Expiry} before its buy (chain time)`),
  });
  const b3KycEntry = await getEntryPda(registry, b3.address);
  await w.runner.step("6.5f", async () => ({ payer: kyc, ixs: [await buildRevokePassport({ authoritySigner: kyc, registry, holder: b3.address })] }), {
    done: async () => {
      const entry = await fetchMaybeKycEntry(w.rpc, b3KycEntry, { commitment: "finalized" });
      return entry.exists && entry.data.status === KycStatus.Revoked;
    },
  });

  // 6.6: the KYC path on class B into the quarantine QB.
  const qb = await vaultPda(w, "classB", QUARANTINE_B);
  w.runner.setEntity("quarantineB", qb);
  await w.runner.step("6.6a", async () => ({ payer: admin, ixs: await openQuarantineIxs(w, "classB", QUARANTINE_B) }), {
    done: () => accountExists(w.rpc, qb),
  });
  const mintB = entity(w.runner.state, "mintB") as Address;
  const holds = async (holder: Address) => (await tokenBalance(w.rpc, await shareAta(holder, mintB))) > BigInt(0);
  const kycClawback = (holder: Address) => async () => ({
    payer: admin,
    ixs: await clawbackIxs(w, { path: "kyc", classKey: "classB", quarantine: qb, holder, amount: BigInt(0), registry }),
  });
  const qbActive = async () => ((await vaultIn(w, qb, [VaultState.Active])()) ? null : "quarantine QB is no longer Active (6.6f ran)");
  await w.runner.step("6.6b", kycClawback(b3.address), { done: async () => !(await holds(b3.address)) });
  await w.runner.step("6.6c", kycClawback(b2.address), { notRun: qbActive });
  // B4's passport has expired, but the 30-day grace has not.
  const b4Grace = b4Expiry + BigInt(KYC_EXPIRY_CLAWBACK_GRACE_SECONDS);
  if (!w.runner.passed("6.6d")) {
    const blocked = await reachChainTime(w, b4Expiry + BigInt(1), "B4's passport expiry");
    if (blocked) w.runner.markNotRun("6.6d", blocked);
  }
  await w.runner.step("6.6d", kycClawback(b4.address), {
    notRun: async () => {
      const at = await chainNow(w.rpc);
      if (at <= b4Expiry) return `B4's passport has not expired yet (chain time ${at})`;
      if (at + CLOCK_GUARD_S >= b4Grace) return `the 30-day grace after B4's expiry ended at ${b4Grace} (chain time)`;
      return (await vaultIn(w, qb, [VaultState.Active])()) ? null : "quarantine QB is no longer Active (6.6f ran)";
    },
  });
  if (await holds(b4.address)) {
    const blocked = await reachChainTime(w, b4Grace + BigInt(1), "the 30-day grace after B4's passport expiry");
    if (blocked) {
      for (const id of ["6.6e", "6.6f", "6.6g"]) w.runner.markNotRun(id, blocked);
      return "completed";
    }
  }
  await w.runner.step("6.6e", kycClawback(b4.address), { done: async () => !(await holds(b4.address)) });
  await w.runner.step("6.6f", async () => ({ payer: admin, ixs: await triggerIxs(w, qb) }), {
    done: vaultIn(w, qb, [VaultState.Triggered, VaultState.Realized]),
  });
  await w.runner.step("6.6g", async () => ({ payer: admin, ixs: await realizeIxs(w, qb) }), {
    done: vaultIn(w, qb, [VaultState.Realized]),
  });
  return "completed";
}
