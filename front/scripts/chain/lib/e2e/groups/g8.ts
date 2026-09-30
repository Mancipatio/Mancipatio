/**
 * G8 (localnet): rotations and recoveries (design-6.3 §A G8, v1.0.0-rc
 * timelocks and upgrade-authority recoveries).
 *
 * - KYC registry authority K1 → K2 (propose / cancel / propose / accept): the
 *   old key is refused (6001), the new one approves on the same address;
 * - issuer authority on a throwaway issuer Ia → Ib, then Ib → an Admin key is
 *   refused at accept (6112);
 * - protocol treasury: the Super Admin sets it; an Admin (6001) and the
 *   default address (6120) are refused;
 * - blocklist authority BA1 → BA2: the old key is refused in the hook (6004);
 * - issuer recovery (7 days) on the e2e issuer: refused inside the timelock
 *   (6131), cancelled by the issuer, proposed again, executed after a warp,
 *   then a sale follows the recovered key (sync_sale_authority);
 * - an Admin grant: refused inside its 48 h (6150), executed after them; the
 *   new Admin approves a sale and is removed, after which that approval
 *   cannot open a sale (3012); the Super Admin's own record cannot be
 *   removed (6114);
 * - Super Admin rotation SA1 → SA2 (48 h): refused inside the timelock
 *   (6150), and after it while an upgrade-authority recovery is pending
 *   (6155);
 * - upgrade-authority recoveries (7 days): the Super Admin (SA1 → SA3) and
 *   the blocklist authority (BA2 → BA3), each cancelled by the live holder
 *   and proposed again; while the blocklist recovery is pending a rotation is
 *   refused (hook 6020); executed after the warp, the old keys are refused;
 * - the recovered SA3 rotates to SA2 after a second warp (48 h).
 *
 * Keys that are not matrix roles (K2, SA2, SA3, BA2–BA4, A2, Ia, Ib, I2)
 * sign their own instructions with the deployer paying the fee. The issuer
 * recovery executes before the Super Admin recovery: a recovery proposed by
 * SA1 executes only while SA1 is the Super Admin.
 */
import type { Address, KeyPairSigner } from "@solana/kit";
import {
  fetchMaybeAdmin,
  fetchMaybeAuthorityProposal,
  fetchMaybeIssuer,
  fetchMaybeIssuerRecovery,
  fetchMaybeKycRegistry,
  fetchMaybePendingAdmin,
  fetchMaybePlatformRecovery,
  fetchMaybeSale,
  fetchPlatform,
  findAdminRecordPda,
  findIssuerPda,
  findPlatformPda,
  getAcceptPlatformAdminInstructionAsync,
  getRegisterIssuerInstructionAsync,
  getRemoveAdminInstructionAsync,
  getSetProtocolTreasuryInstructionAsync,
  getSyncSaleAuthorityInstruction,
} from "@/lib/generated/asset_registry";
import {
  fetchMaybeBlocklistAuthority,
  fetchMaybeBlocklistAuthorityProposal,
  fetchMaybeBlocklistRecovery,
  findBlocklistAuthorityPda,
  getAcceptBlocklistAuthorityInstructionAsync,
  getAddToBlocklistInstructionAsync,
  getRemoveFromBlocklistInstructionAsync,
} from "@/lib/generated/transfer_hook";
import { buildAddAdmin, buildProposeAdmin } from "@/lib/admin-grants";
import {
  buildAcceptIssuerAuthority,
  buildCancelIssuerAuthorityTransfer,
  buildCancelIssuerRecovery,
  buildExecuteIssuerRecovery,
  buildProposeIssuerAuthority,
  buildProposeIssuerRecovery,
  findIssuerRecoveryPda,
  findIssuerTransferPda,
} from "@/lib/issuer-authority";
import { buildAcceptOperationalAuthority, buildCancelOperationalAuthority, buildProposeOperationalAuthority } from "@/lib/operational-authority";
import { buildAcceptKycAuthority, buildCancelKycAuthorityTransfer, buildProposeKycAuthority } from "@/lib/passport";
import { PAUSE_ONBOARDING } from "@/lib/pause-flags";
import { findAuthorityProposalPda, findBlockEntryPda, findBlocklistAuthorityProposalPda, findBlocklistRecoveryPda, findPendingAdminPda, findPlatformRecoveryPda, findSalePda } from "@/lib/pdas";
import { buildCancelRoleRecovery, buildExecuteRoleRecovery, buildProposeRoleRecovery } from "@/lib/role-recovery";
import { ChainPlanError } from "../../safety";
import { chainNow } from "../clock";
import { fundInstructions, topUp } from "../fixtures";
import { loadOrCreateRoleKey } from "../keys";
import { entity } from "../state";
import { ONE_DAY, accountExists, defaultJurisdiction, reachChainTime, sha256Bytes, type World } from "../world";
import { UNIT_PRICE, approveSaleIxs, openSaleIxs, saleApprovalExists, saleEnd } from "./g1";
import { approveHolderIxs } from "./g4";
import { pauseFlags, setPauseIxs } from "./g5";

const KEY_SOL = BigInt(1_000_000_000);
const SALE_40 = 40;

type Keys = Record<"k2" | "sa2" | "sa3" | "ba2" | "ba3" | "ba4" | "a2" | "ia" | "ib" | "i2" | "t2", KeyPairSigner>;

async function g8Keys(w: World): Promise<Keys> {
  const names = ["k2", "sa2", "sa3", "ba2", "ba3", "ba4", "a2", "ia", "ib", "i2", "t2"] as const;
  const out = {} as Keys;
  for (const name of names) out[name] = await loadOrCreateRoleKey(w.config.dir, `g8-${name}`);
  return out;
}

async function platformAdmin(w: World): Promise<Address> {
  const [platform] = await findPlatformPda();
  return (await fetchPlatform(w.rpc, platform, { commitment: "finalized" })).data.admin;
}

async function blocklistAuthority(w: World): Promise<Address | null> {
  const [pda] = await findBlocklistAuthorityPda();
  const account = await fetchMaybeBlocklistAuthority(w.rpc, pda, { commitment: "finalized" });
  return account.exists ? account.data.authority : null;
}

async function isAdmin(w: World, key: Address): Promise<boolean> {
  const [record] = await findAdminRecordPda({ authority: key });
  return (await fetchMaybeAdmin(w.rpc, record, { commitment: "finalized" })).exists;
}

export async function runGroup8(w: World): Promise<"completed"> {
  const { funder, admin, issuer: issuerKey, buyers } = w.roles;
  const [, b2, , b4] = buyers;
  const sa1 = w.roles.superAdmin;
  const ba1 = w.roles.blocklistAuthority;
  const k1 = w.roles.kycAuthority;
  if (!sa1 || !ba1 || !k1) throw new ChainPlanError("G8 needs the localnet Super Admin, BlocklistAuthority and KYC authority keys");
  const k = await g8Keys(w);
  for (const [name, key] of Object.entries(k)) w.runner.setEntity(`g8Key.${name}`, key.address);

  await w.runner.step(
    "8.0",
    async () => {
      const targets = (await Promise.all(Object.entries(k).filter(([n]) => n !== "t2").map(([, key]) => topUp(w.rpc, key.address, KEY_SOL)))).filter(
        (t) => t !== null,
      );
      return { payer: funder, ixs: fundInstructions(funder, targets) };
    },
    {
      done: async () =>
        (await Promise.all(Object.entries(k).filter(([n]) => n !== "t2").map(([, key]) => topUp(w.rpc, key.address, KEY_SOL / BigInt(2))))).every(
          (t) => t === null,
        ),
    },
  );

  // 8.1: the KYC registry authority K1 → K2 (the registry address stays).
  const registry = entity(w.runner.state, "kycRegistry") as Address;
  const registryAuthority = async () => {
    const account = await fetchMaybeKycRegistry(w.rpc, registry, { commitment: "finalized" });
    return account.exists ? account.data.authority : null;
  };
  const kycProposalTo = async () => {
    const pda = await findAuthorityProposalPda(registry);
    const account = await fetchMaybeAuthorityProposal(w.rpc, pda, { commitment: "finalized" });
    return account.exists ? account.data.newAuthority : null;
  };
  const kycRotated = async () => (await registryAuthority()) === k.k2.address;
  await w.runner.step("8.1a", async () => ({ payer: k1, ixs: [await buildProposeKycAuthority({ authoritySigner: k1, registry, newAuthority: k.k2.address })] }), {
    done: async () => (await kycRotated()) || w.runner.passed("8.1b") || (await kycProposalTo()) === k.k2.address,
  });
  await w.runner.step("8.1b", async () => ({ payer: k1, ixs: [await buildCancelKycAuthorityTransfer({ authoritySigner: k1, registry })] }), {
    done: async () => (await kycRotated()) || w.runner.passed("8.1c"),
  });
  await w.runner.step("8.1c", async () => ({ payer: k1, ixs: [await buildProposeKycAuthority({ authoritySigner: k1, registry, newAuthority: k.k2.address })] }), {
    done: async () => (await kycRotated()) || (await kycProposalTo()) === k.k2.address,
  });
  await w.runner.step("8.1d", async () => ({ payer: funder, ixs: [await buildAcceptKycAuthority({ newAuthoritySigner: k.k2, registry })] }), {
    done: kycRotated,
  });
  const expiry = (await chainNow(w.rpc)) + BigInt(365) * ONE_DAY;
  await w.runner.step("8.1e", async () => ({ payer: k1, ixs: await approveHolderIxs(w, b4.address, expiry, registry, k1) }));
  await w.runner.step("8.1f", async () => ({ payer: funder, ixs: await approveHolderIxs(w, b4.address, expiry, registry, k.k2) }));

  // 8.2: issuer authority rotation on a throwaway issuer (Ia → Ib; Ib → an Admin key is refused).
  const legalId = new Uint8Array(32);
  legalId.set(new TextEncoder().encode(`MANCI-E2E-${w.runId}-R`));
  const [issuerR] = await findIssuerPda({ legalEntityId: legalId });
  w.runner.setEntity("issuerR", issuerR);
  const issuerAuthority = async (issuer: Address) => {
    const account = await fetchMaybeIssuer(w.rpc, issuer, { commitment: "finalized" });
    return account.exists ? account.data.authority : null;
  };
  const issuerProposalTo = async (issuer: Address) => {
    const account = await fetchMaybeAuthorityProposal(w.rpc, await findIssuerTransferPda(issuer), { commitment: "finalized" });
    return account.exists ? account.data.newAuthority : null;
  };
  await w.runner.step(
    "8.2a",
    async () => ({
      payer: funder,
      ixs: [await getRegisterIssuerInstructionAsync({ authority: k.ia, legalEntityId: legalId, jurisdiction: defaultJurisdiction(), kybDocHash: sha256Bytes(`manci-e2e:${w.runId}:kyb:R`) })],
    }),
    { done: () => accountExists(w.rpc, issuerR) },
  );
  const rotatedToIb = async () => (await issuerAuthority(issuerR)) === k.ib.address;
  await w.runner.step("8.2b", async () => ({ payer: funder, ixs: [await buildProposeIssuerAuthority({ authoritySigner: k.ia, issuer: issuerR, newAuthority: k.ib.address })] }), {
    done: async () => (await rotatedToIb()) || w.runner.passed("8.2c") || (await issuerProposalTo(issuerR)) === k.ib.address,
  });
  await w.runner.step("8.2c", async () => ({ payer: funder, ixs: [await buildCancelIssuerAuthorityTransfer({ authoritySigner: k.ia, issuer: issuerR })] }), {
    done: async () => (await rotatedToIb()) || w.runner.passed("8.2d"),
  });
  await w.runner.step("8.2d", async () => ({ payer: funder, ixs: [await buildProposeIssuerAuthority({ authoritySigner: k.ia, issuer: issuerR, newAuthority: k.ib.address })] }), {
    done: async () => (await rotatedToIb()) || (await issuerProposalTo(issuerR)) === k.ib.address,
  });
  await w.runner.step(
    "8.2e",
    async () => ({ payer: funder, ixs: [await buildAcceptIssuerAuthority({ newAuthoritySigner: k.ib, issuer: issuerR, currentAuthority: k.ia.address })] }),
    { done: rotatedToIb },
  );
  await w.runner.step("8.2f", async () => ({ payer: funder, ixs: [await buildProposeIssuerAuthority({ authoritySigner: k.ib, issuer: issuerR, newAuthority: admin.address })] }), {
    done: async () => (await issuerProposalTo(issuerR)) === admin.address,
  });
  await w.runner.step("8.2g", async () => ({
    payer: admin,
    ixs: [await buildAcceptIssuerAuthority({ newAuthoritySigner: admin, issuer: issuerR, currentAuthority: k.ib.address })],
  }));

  // 8.3: the protocol treasury (Super Admin only, never the default address).
  const [platformPda] = await findPlatformPda();
  const treasury = async () => (await fetchPlatform(w.rpc, platformPda, { commitment: "finalized" })).data.protocolTreasury;
  await w.runner.step("8.3a", async () => ({ payer: sa1, ixs: [await getSetProtocolTreasuryInstructionAsync({ superAdmin: sa1, newTreasury: k.t2.address })] }), {
    done: async () => (await treasury()) === k.t2.address,
  });
  await w.runner.step("8.3b", async () => ({ payer: admin, ixs: [await getSetProtocolTreasuryInstructionAsync({ superAdmin: admin, newTreasury: admin.address })] }));
  await w.runner.step("8.3c", async () => ({
    payer: sa1,
    ixs: [await getSetProtocolTreasuryInstructionAsync({ superAdmin: sa1, newTreasury: "11111111111111111111111111111111" as Address })],
  }), {
    notRun: async () => ((await platformAdmin(w)) === sa1.address ? null : "SA1 is no longer the Super Admin"),
  });

  // 8.4: the blocklist authority BA1 → BA2 (no timelock).
  const baIs = (key: KeyPairSigner) => async () => (await blocklistAuthority(w)) === key.address;
  await w.runner.step("8.4a", async () => ({ payer: ba1, ixs: [await buildProposeOperationalAuthority(w.rpc, "blocklist", ba1, k.ba2.address)] }), {
    done: async () => (await blocklistAuthority(w)) !== ba1.address || (await blocklistProposalTo(w)) === k.ba2.address,
  });
  await w.runner.step("8.4b", async () => ({ payer: funder, ixs: [await buildAcceptOperationalAuthority(w.rpc, "blocklist", k.ba2)] }), {
    done: async () => (await blocklistAuthority(w)) !== ba1.address,
  });
  const b4Entry = await findBlockEntryPda(b4.address);
  await w.runner.step("8.4c", async () => ({ payer: ba1, ixs: [await getAddToBlocklistInstructionAsync({ authority: ba1, wallet: b2.address })] }));
  await w.runner.step("8.4d", async () => ({ payer: funder, ixs: [await getAddToBlocklistInstructionAsync({ authority: k.ba2, wallet: b4.address })] }), {
    done: async () => (await accountExists(w.rpc, b4Entry)) || w.runner.passed("8.4e"),
  });
  await w.runner.step("8.4e", async () => ({ payer: funder, ixs: [await getRemoveFromBlocklistInstructionAsync({ authority: k.ba2, wallet: b4.address })] }), {
    done: async () => !(await accountExists(w.rpc, b4Entry)),
  });

  // 8.5a–d: issuer recovery on the e2e issuer (7 days), cancelled by the issuer, proposed again.
  const issuer = entity(w.runner.state, "issuer") as Address;
  const recoveryPda = await findIssuerRecoveryPda(issuer);
  const issuerRecoveryTo = async () => {
    const account = await fetchMaybeIssuerRecovery(w.rpc, recoveryPda, { commitment: "finalized" });
    return account.exists ? account.data : null;
  };
  const recovered = async () => (await issuerAuthority(issuer)) === k.i2.address;
  await w.runner.step("8.5a", async () => ({ payer: sa1, ixs: [await buildProposeIssuerRecovery({ superAdminSigner: sa1, issuer, newAuthority: k.i2.address })] }), {
    done: async () => (await recovered()) || w.runner.passed("8.5c") || (await issuerRecoveryTo()) !== null,
  });
  await w.runner.step("8.5b", async () => ({ payer: funder, ixs: [await executeIssuerRecoveryIxs(w, k.i2, issuer)] }), {
    notRun: async () => ((await issuerRecoveryTo()) ? null : "no issuer recovery is pending (8.5c ran)"),
  });
  await w.runner.step("8.5c", async () => ({ payer: issuerKey, ixs: [await buildCancelIssuerRecovery({ cancellerSigner: issuerKey, issuer, proposer: sa1.address })] }), {
    done: async () => (await recovered()) || w.runner.passed("8.5d"),
  });
  await w.runner.step("8.5d", async () => ({ payer: sa1, ixs: [await buildProposeIssuerRecovery({ superAdminSigner: sa1, issuer, newAuthority: k.i2.address })] }), {
    done: async () => (await recovered()) || (await issuerRecoveryTo()) !== null,
  });

  // 8.6a/b: an Admin grant is staged; its 48 h are not over.
  const pendingA2 = await findPendingAdminPda(k.a2.address);
  const a2Staged = async () => (await fetchMaybePendingAdmin(w.rpc, pendingA2, { commitment: "finalized" })).exists;
  await w.runner.step("8.6a", async () => ({ payer: sa1, ixs: [await buildProposeAdmin(w.rpc, sa1, k.a2.address)] }), {
    done: async () => (await a2Staged()) || w.runner.passed("8.6c"),
  });
  await w.runner.step("8.6b", async () => ({ payer: funder, ixs: [await buildAddAdmin(w.rpc, k.a2)] }), {
    notRun: async () => ((await a2Staged()) ? null : "the Admin grant is no longer staged (8.6c ran)"),
  });

  // 8.7a/b: Super Admin rotation SA1 → SA2 (48 h).
  const platformProposalTo = async () => {
    const account = await fetchMaybeAuthorityProposal(w.rpc, await findAuthorityProposalPda(platformPda), { commitment: "finalized" });
    return account.exists ? account.data : null;
  };
  await w.runner.step("8.7a", async () => ({ payer: sa1, ixs: [await buildProposeOperationalAuthority(w.rpc, "platform", sa1, k.sa2.address)] }), {
    done: async () => (await platformAdmin(w)) !== sa1.address || (await platformProposalTo())?.newAuthority === k.sa2.address,
  });
  await w.runner.step("8.7b", async () => ({ payer: funder, ixs: [await acceptPlatformAdminIxs(w, k.sa2)] }), {
    notRun: async () => ((await platformAdmin(w)) === sa1.address ? null : "SA1 is no longer the Super Admin"),
  });

  // 8.8a–c: the upgrade authority proposes a Super Admin recovery; SA1 cancels it; proposed again.
  const platformRecoveryPda = await findPlatformRecoveryPda();
  const platformRecovery = async () => (await fetchMaybePlatformRecovery(w.rpc, platformRecoveryPda, { commitment: "finalized" })).exists;
  const sa1Live = async () => (await platformAdmin(w)) === sa1.address;
  await w.runner.step("8.8a", async () => ({ payer: funder, ixs: [await buildProposeRoleRecovery(w.rpc, "platform", funder, k.sa3.address)] }), {
    done: async () => !(await sa1Live()) || w.runner.passed("8.8b") || (await platformRecovery()),
  });
  await w.runner.step("8.8b", async () => ({ payer: sa1, ixs: [await buildCancelRoleRecovery(w.rpc, "platform", sa1)] }), {
    done: async () => !(await sa1Live()) || w.runner.passed("8.8c"),
  });
  await w.runner.step("8.8c", async () => ({ payer: funder, ixs: [await buildProposeRoleRecovery(w.rpc, "platform", funder, k.sa3.address)] }), {
    done: async () => !(await sa1Live()) || (await platformRecovery()),
  });

  // 8.9a–f: the blocklist recovery (BA2 → BA3) blocks a rotation while it is pending.
  const blocklistRecovery = async () => (await fetchMaybeBlocklistRecovery(w.rpc, await findBlocklistRecoveryPda(), { commitment: "finalized" })).exists;
  const ba2Live = baIs(k.ba2);
  await w.runner.step("8.9a", async () => ({ payer: funder, ixs: [await buildProposeRoleRecovery(w.rpc, "blocklist", funder, k.ba3.address)] }), {
    done: async () => !(await ba2Live()) || w.runner.passed("8.9e") || (await blocklistRecovery()),
  });
  await w.runner.step("8.9b", async () => ({ payer: funder, ixs: [await buildProposeOperationalAuthority(w.rpc, "blocklist", k.ba2, k.ba4.address)] }), {
    done: async () => !(await ba2Live()) || w.runner.passed("8.9d") || (await blocklistProposalTo(w)) === k.ba4.address,
  });
  await w.runner.step(
    "8.9c",
    async () => ({ payer: funder, ixs: [await getAcceptBlocklistAuthorityInstructionAsync({ newAuthority: k.ba4 })] }),
    { notRun: async () => ((await blocklistRecovery()) && (await blocklistProposalTo(w)) === k.ba4.address ? null : "the rotation or the recovery is no longer staged") },
  );
  await w.runner.step("8.9d", async () => ({ payer: funder, ixs: [await buildCancelOperationalAuthority(w.rpc, "blocklist", k.ba2)] }), {
    done: async () => !(await ba2Live()) || (await blocklistProposalTo(w)) === null,
  });
  await w.runner.step("8.9e", async () => ({ payer: funder, ixs: [await buildCancelRoleRecovery(w.rpc, "blocklist", k.ba2)] }), {
    done: async () => !(await ba2Live()) || w.runner.passed("8.9f"),
  });
  await w.runner.step("8.9f", async () => ({ payer: funder, ixs: [await buildProposeRoleRecovery(w.rpc, "blocklist", funder, k.ba3.address)] }), {
    done: async () => !(await ba2Live()) || (await blocklistRecovery()),
  });

  // One warp past every 7-day recovery (and the 48 h grant) proposed above.
  const etas: bigint[] = [];
  const ir = await issuerRecoveryTo();
  if (ir) etas.push(ir.eta);
  const pr = await fetchMaybePlatformRecovery(w.rpc, platformRecoveryPda, { commitment: "finalized" });
  if (pr.exists) etas.push(pr.data.eta);
  const br = await fetchMaybeBlocklistRecovery(w.rpc, await findBlocklistRecoveryPda(), { commitment: "finalized" });
  if (br.exists) etas.push(br.data.eta);
  const grant = await fetchMaybePendingAdmin(w.rpc, pendingA2, { commitment: "finalized" });
  if (grant.exists) etas.push(grant.data.eta);
  const recoveryIds = ["8.6c", "8.6d", "8.6e", "8.6f", "8.6g", "8.7c", "8.5e", "8.5f", "8.8d", "8.8e", "8.9g", "8.9h", "8.7d", "8.7e", "8.7f", "8.7g", "8.7h"];
  if (etas.length) {
    const target = etas.reduce((a, b) => (a > b ? a : b)) + BigInt(1);
    const blocked = await reachChainTime(w, target, "the 7-day recoveries and the 48 h Admin grant");
    if (blocked) {
      for (const id of recoveryIds) w.runner.markNotRun(id, blocked);
      return "completed";
    }
  }

  // 8.6c–g: the grant executes; the new Admin's approval dies with its record.
  await w.runner.step("8.6c", async () => ({ payer: funder, ixs: [await buildAddAdmin(w.rpc, k.a2)] }), {
    done: async () => (await isAdmin(w, k.a2.address)) || w.runner.passed("8.6e"),
  });
  const now = await chainNow(w.rpc);
  await w.runner.step(
    "8.6d",
    async () => ({
      payer: funder,
      ixs: await approveSaleIxs(w, { signer: k.a2, classKey: "classA", saleId: SALE_40, maxGross: UNIT_PRICE, minPrice: UNIT_PRICE, maxPrice: UNIT_PRICE, expiresAt: now + ONE_DAY }),
    }),
    { done: () => saleApprovalExists(w, "classA", SALE_40) },
  );
  await w.runner.step("8.6e", async () => ({ payer: sa1, ixs: [await getRemoveAdminInstructionAsync({ superAdmin: sa1, admin: k.a2.address })] }), {
    done: async () => !(await isAdmin(w, k.a2.address)),
  });
  await w.runner.step("8.6f", async () => {
    const at = await chainNow(w.rpc);
    return {
      payer: issuerKey,
      ixs: await openSaleIxs(w, { classKey: "classA", saleId: SALE_40, price: UNIT_PRICE, total: BigInt(1), startTs: at, endTs: saleEnd(w, at), approvedBy: k.a2.address }),
    };
  }, {
    notRun: async () => ((await issuerAuthority(issuer)) === issuerKey.address ? null : "the e2e issuer key was recovered (8.5e ran)"),
  });
  await w.runner.step("8.6g", async () => ({ payer: sa1, ixs: [await getRemoveAdminInstructionAsync({ superAdmin: sa1, admin: sa1.address })] }), {
    notRun: async () => ((await sa1Live()) ? null : "SA1 is no longer the Super Admin"),
  });

  // 8.7c: after the 48 h, the rotation is still refused while the recovery is pending.
  await w.runner.step("8.7c", async () => ({ payer: funder, ixs: [await acceptPlatformAdminIxs(w, k.sa2)] }), {
    notRun: async () => ((await sa1Live()) && (await platformRecovery()) ? null : "the Super Admin recovery is no longer pending against SA1"),
  });

  // 8.5e/f: the issuer recovery executes while its proposer SA1 is still the Super Admin.
  await w.runner.step("8.5e", async () => ({ payer: funder, ixs: [await executeIssuerRecoveryIxs(w, k.i2, issuer)] }), { done: recovered });
  const sale1 = await findSalePda(entity(w.runner.state, "classA") as Address, BigInt(1));
  await w.runner.step(
    "8.5f",
    async () => ({
      payer: funder,
      ixs: [getSyncSaleAuthorityInstruction({ sale: sale1, shareClass: entity(w.runner.state, "classA") as Address, asset: entity(w.runner.state, "asset") as Address, issuer })],
    }),
    {
      done: async () => {
        const sale = await fetchMaybeSale(w.rpc, sale1, { commitment: "finalized" });
        return sale.exists && sale.data.authority === k.i2.address;
      },
    },
  );

  // 8.8d/e: the Super Admin recovery (SA1 → SA3).
  await w.runner.step("8.8d", async () => ({ payer: funder, ixs: [await buildExecuteRoleRecovery(w.rpc, "platform", k.sa3)] }), {
    done: async () => !(await sa1Live()),
  });
  await w.runner.step("8.8e", async () => ({ payer: sa1, ixs: await setPauseIxs(w, sa1, PAUSE_ONBOARDING, 0) }));

  // 8.9g/h: the blocklist recovery (BA2 → BA3).
  await w.runner.step("8.9g", async () => ({ payer: funder, ixs: [await buildExecuteRoleRecovery(w.rpc, "blocklist", k.ba3)] }), {
    done: baIs(k.ba3),
  });
  await w.runner.step("8.9h", async () => ({ payer: funder, ixs: [await getAddToBlocklistInstructionAsync({ authority: k.ba2, wallet: b2.address })] }));

  // 8.7d–h: the recovered SA3 rotates to SA2 after 48 h (a second warp).
  const sa2Live = async () => (await platformAdmin(w)) === k.sa2.address;
  await w.runner.step("8.7d", async () => ({ payer: funder, ixs: [await buildProposeOperationalAuthority(w.rpc, "platform", k.sa3, k.sa2.address)] }), {
    done: async () => {
      if (await sa2Live()) return true;
      const proposal = await platformProposalTo();
      return proposal !== null && proposal.newAuthority === k.sa2.address && proposal.currentAuthority === k.sa3.address;
    },
  });
  if (!(await sa2Live())) {
    const proposal = await platformProposalTo();
    if (!proposal) throw new ChainPlanError("8.7e: no Super Admin rotation is staged");
    const blocked = await reachChainTime(w, proposal.eta + BigInt(1), "the 48 h Super Admin rotation");
    if (blocked) {
      for (const id of ["8.7e", "8.7f", "8.7g", "8.7h"]) w.runner.markNotRun(id, blocked);
      return "completed";
    }
  }
  await w.runner.step("8.7e", async () => ({ payer: funder, ixs: [await acceptPlatformAdminIxs(w, k.sa2)] }), { done: sa2Live });
  await w.runner.step("8.7f", async () => ({ payer: funder, ixs: await setPauseIxs(w, k.sa3, PAUSE_ONBOARDING, 0) }));
  const onboardingPaused = async () => ((await pauseFlags(w)) & PAUSE_ONBOARDING) !== 0;
  await w.runner.step("8.7g", async () => ({ payer: funder, ixs: await setPauseIxs(w, k.sa2, PAUSE_ONBOARDING, 0) }), {
    done: async () => (await onboardingPaused()) || w.runner.passed("8.7h"),
  });
  await w.runner.step("8.7h", async () => ({ payer: funder, ixs: await setPauseIxs(w, k.sa2, 0, PAUSE_ONBOARDING) }), {
    done: async () => !(await onboardingPaused()) && w.runner.passed("8.7g"),
  });
  return "completed";
}

async function blocklistProposalTo(w: World): Promise<Address | null> {
  const account = await fetchMaybeBlocklistAuthorityProposal(w.rpc, await findBlocklistAuthorityProposalPda(), { commitment: "finalized" });
  return account.exists ? account.data.newAuthority : null;
}

/**
 * accept_platform_admin built directly (the app's builder refuses a pending
 * recovery before signing; the program's refusal is what 8.7b/c test).
 */
async function acceptPlatformAdminIxs(w: World, newAdmin: KeyPairSigner) {
  const [oldAdminRecord] = await findAdminRecordPda({ authority: await platformAdmin(w) });
  return getAcceptPlatformAdminInstructionAsync({ newAdmin, oldAdminRecord });
}

async function executeIssuerRecoveryIxs(w: World, newAuthority: KeyPairSigner, issuer: Address) {
  const account = await fetchMaybeIssuerRecovery(w.rpc, await findIssuerRecoveryPda(issuer), { commitment: "finalized" });
  const current = await fetchMaybeIssuer(w.rpc, issuer, { commitment: "finalized" });
  if (!account.exists || !current.exists) throw new ChainPlanError("no issuer recovery is staged for the e2e issuer");
  return buildExecuteIssuerRecovery({ newAuthoritySigner: newAuthority, issuer, currentAuthority: current.data.authority, proposer: account.data.proposedBy });
}

