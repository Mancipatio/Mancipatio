/**
 * G4: conversion and delivery (design-6.3 §A G4, v1.0.0-rc). Both run as a
 * DeliveryEscrow custody vault: the retired ConversionPending type is
 * refused (6142); the class gets its conversion target; a delivery deadline
 * must lie between now + 24 h and now + 365 days (6148). The beneficiary
 * alone deposits (6084 for anyone else); realize burns only with the
 * beneficiary's passport in the pinned registry (without one the entry
 * account is missing: 3012), and a holder without a passport gets the
 * deposit back through return_custody_vault. Localnet adds the beneficiary's
 * own return: refused before the deadline (6052), open after it (a warp).
 *
 * KYC registry: localnet uses the platform registry R0 (G0; its authority
 * is the KYC authority K1); devnet creates the run's own registry
 * R_e2e = PDA(Ke) in 4.0 with the Admin co-signing, so the user's wallet is
 * never needed. approve_holder is paid by the Admin with the KYC authority
 * co-signing (it pays the entry's rent).
 */
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import {
  fetchMaybeShareClass,
  findKycRegistryPda,
  getSetConvertibleToInstruction,
} from "@/lib/generated/asset_registry";
import { DELIVERY_ESCROW_MAX_DEADLINE_SECONDS, DELIVERY_ESCROW_MIN_DEADLINE_SECONDS } from "@/lib/deadline-bounds";
import { ISSUER_CAPABILITIES, resolveIssuerPermission } from "@/lib/issuer-permissions";
import { jurisdictionBitmap } from "@/lib/jurisdiction-bitmap";
import { DEFAULT_APPROVED_JURISDICTIONS, buildCreateRegistry, buildIssuePassport, getEntryPda } from "@/lib/passport";
import { ChainPlanError } from "../../safety";
import { chainNow } from "../clock";
import {
  VaultState,
  VaultType,
  depositIxs,
  deposited,
  loadVault,
  openVaultIxs,
  realizeIxs,
  returnIxs,
  triggerIxs,
  vaultIn,
  vaultPda,
} from "../custody";
import { fundInstructions, topUp } from "../fixtures";
import { entity } from "../state";
import { CLOCK_GUARD_S, ONE_DAY, accountExists, defaultJurisdiction, reachChainTime, sha256Bytes, type World } from "../world";

const HOUR = BigInt(3_600);
/** A delivery deadline one hour past the 24-hour minimum. */
export const DELIVERY_DEADLINE_S = BigInt(DELIVERY_ESCROW_MIN_DEADLINE_SECONDS) + HOUR;
/** SOL the devnet KYC key needs for its registry and a few entries. */
const DEVNET_KYC_LAMPORTS = BigInt(50_000_000);

export const VAULT_V1 = 1;
export const VAULT_V2 = 2;
export const VAULT_V3 = 3;
/** Never opened: the retired type is refused. */
const VAULT_RETIRED = 99;
const VAULT_OUT_OF_RANGE = 98;

/**
 * The registry the e2e passports live in: R0 (the platform registry G0
 * bootstrapped) on localnet, the run's own R_e2e on devnet.
 */
export async function e2eRegistry(w: World): Promise<Address> {
  if (w.network === "localnet") return entity(w.runner.state, "kycRegistry") as Address;
  const kyc = w.roles.kycAuthority;
  if (!kyc) throw new ChainPlanError("G4 needs the run's KYC authority key");
  const [registry] = await findKycRegistryPda({ authority: kyc.address });
  return registry;
}

/**
 * approve_holder on the e2e registry: the KYC authority signs (and pays the
 * entry); the step's payer pays the fee. `authority` overrides the signer
 * (G8: the registry's former or new key).
 */
export async function approveHolderIxs(
  w: World,
  holder: Address,
  expiry: bigint,
  registry?: Address,
  authority?: KeyPairSigner,
): Promise<Instruction[]> {
  const kyc = authority ?? w.roles.kycAuthority;
  if (!kyc) throw new ChainPlanError("approve_holder needs the KYC authority key");
  return [
    await buildIssuePassport({
      authoritySigner: kyc,
      registry: registry ?? (await e2eRegistry(w)),
      holder,
      jurisdiction: defaultJurisdiction(),
      accreditationLevel: 0,
      expiry,
      providerId: 1,
      externalRefHash: sha256Bytes(`manci-e2e:${w.runId}:passport:${holder}:${expiry}`),
    }),
  ];
}

export async function runGroup4(w: World): Promise<"completed"> {
  const { admin, issuer: issuerKey, buyers, funder } = w.roles;
  const [b1, b2, b3] = buyers;
  const classA = entity(w.runner.state, "classA") as Address;
  const classB = entity(w.runner.state, "classB") as Address;

  // 4.0 (devnet): the run's own registry R_e2e = PDA(Ke), the Admin co-signing.
  if (w.runner.applies("4.0")) {
    const kyc = w.roles.kycAuthority;
    if (!kyc) throw new ChainPlanError("4.0 needs the run's KYC authority key");
    const registry = await e2eRegistry(w);
    w.runner.setEntity("e2eKycRegistry", registry);
    await w.runner.step(
      "4.0",
      async () => {
        const fund = await topUp(w.rpc, kyc.address, DEVNET_KYC_LAMPORTS);
        return {
          payer: admin,
          ixs: [
            ...fundInstructions(funder, fund ? [fund] : []),
            await buildCreateRegistry({
              authoritySigner: kyc,
              adminSigner: admin,
              approvedJurisdictions: jurisdictionBitmap([...DEFAULT_APPROVED_JURISDICTIONS]),
              blockedJurisdictions: jurisdictionBitmap([]),
            }),
          ],
        };
      },
      { done: () => accountExists(w.rpc, registry) },
    );
  }
  const registry = await e2eRegistry(w);

  // 4.1: ConversionPending is retired (conversions are DeliveryEscrow vaults).
  await w.runner.step("4.1", async () => ({
    payer: admin,
    ixs: await openVaultIxs(w, { classKey: "classA", vaultId: VAULT_RETIRED, vaultType: VaultType.ConversionPending, amount: BigInt(1), deadline: BigInt(0) }),
  }));

  // 4.2: the conversion target (the issuer's CONVERSION permission, or its Admin record on devnet).
  const issuer = entity(w.runner.state, "issuer") as Address;
  await w.runner.step(
    "4.2",
    async () => ({
      payer: issuerKey,
      ixs: [
        getSetConvertibleToInstruction({
          authority: issuerKey,
          adminRecord: await resolveIssuerPermission(w.rpc, issuer, issuerKey.address, ISSUER_CAPABILITIES.Conversion),
          issuer,
          asset: entity(w.runner.state, "asset") as Address,
          shareClass: classA,
          targetShareClass: classB,
        }),
      ],
    }),
    {
      done: async () => {
        const account = await fetchMaybeShareClass(w.rpc, classA, { commitment: "finalized" });
        return account.exists && account.data.convertibleTo.__option === "Some" && account.data.convertibleTo.value === classB;
      },
    },
  );

  // 4.3: the delivery deadline bounds (v1: now + 24 h .. now + 365 days).
  for (const [id, offset] of [
    ["4.3a", HOUR],
    ["4.3b", BigInt(DELIVERY_ESCROW_MAX_DEADLINE_SECONDS) + ONE_DAY],
  ] as const) {
    await w.runner.step(id, async () => ({
      payer: admin,
      ixs: await openVaultIxs(w, {
        classKey: "classA",
        vaultId: VAULT_OUT_OF_RANGE,
        vaultType: VaultType.DeliveryEscrow,
        amount: BigInt(1),
        deadline: (await chainNow(w.rpc)) + offset,
        beneficiary: b1.address,
        registry,
      }),
    }));
  }

  // V1: B1 converts two units, first without a passport, then with one.
  const v1 = await vaultPda(w, "classA", VAULT_V1);
  w.runner.setEntity("vaultV1", v1);
  await w.runner.step(
    "4.4",
    async () => ({
      payer: admin,
      ixs: await openVaultIxs(w, {
        classKey: "classA",
        vaultId: VAULT_V1,
        vaultType: VaultType.DeliveryEscrow,
        amount: BigInt(2),
        deadline: (await chainNow(w.rpc)) + DELIVERY_DEADLINE_S,
        beneficiary: b1.address,
        registry,
      }),
    }),
    { done: () => accountExists(w.rpc, v1) },
  );
  await w.runner.step("4.5", async () => ({ payer: b2, ixs: await depositIxs(w, b2, v1, BigInt(1)) }), {
    notRun: async () => ((await vaultIn(w, v1, [VaultState.Active])()) ? null : "vault V1 no longer accepts deposits (4.7 ran)"),
  });
  await w.runner.step("4.6", async () => ({ payer: b1, ixs: await depositIxs(w, b1, v1, BigInt(2)) }), {
    done: deposited(w, v1, BigInt(2)),
  });
  await w.runner.step("4.7", async () => ({ payer: admin, ixs: await triggerIxs(w, v1) }), {
    done: vaultIn(w, v1, [VaultState.Triggered, VaultState.Realized]),
  });
  const b1Entry = await getEntryPda(registry, b1.address);
  await w.runner.step("4.8", async () => ({ payer: admin, ixs: await realizeIxs(w, v1) }), {
    notRun: async () => ((await accountExists(w.rpc, b1Entry)) ? "B1 already has a passport (4.9 ran)" : null),
  });
  await w.runner.step(
    "4.9",
    async () => ({ payer: admin, ixs: await approveHolderIxs(w, b1.address, (await chainNow(w.rpc)) + BigInt(365) * ONE_DAY, registry) }),
    { done: () => accountExists(w.rpc, b1Entry) },
  );
  await w.runner.step("4.10", async () => ({ payer: admin, ixs: await realizeIxs(w, v1) }), {
    done: vaultIn(w, v1, [VaultState.Realized]),
  });

  // V2: B3 has no passport — realize is refused and the deposit goes back.
  const v2 = await vaultPda(w, "classA", VAULT_V2);
  w.runner.setEntity("vaultV2", v2);
  await w.runner.step(
    "4.11a",
    async () => ({
      payer: admin,
      ixs: await openVaultIxs(w, {
        classKey: "classA",
        vaultId: VAULT_V2,
        vaultType: VaultType.DeliveryEscrow,
        amount: BigInt(1),
        deadline: (await chainNow(w.rpc)) + DELIVERY_DEADLINE_S,
        beneficiary: b3.address,
        registry,
      }),
    }),
    { done: () => accountExists(w.rpc, v2) },
  );
  await w.runner.step("4.11b", async () => ({ payer: b3, ixs: await depositIxs(w, b3, v2, BigInt(1)) }), {
    done: deposited(w, v2, BigInt(1)),
  });
  await w.runner.step("4.11c", async () => ({ payer: admin, ixs: await triggerIxs(w, v2) }), {
    done: vaultIn(w, v2, [VaultState.Triggered, VaultState.Returned]),
  });
  await w.runner.step("4.11d", async () => ({ payer: admin, ixs: await realizeIxs(w, v2) }), {
    notRun: async () => ((await vaultIn(w, v2, [VaultState.Triggered])()) ? null : "vault V2 is no longer Triggered (4.11e ran)"),
  });
  await w.runner.step("4.11e", async () => ({ payer: admin, ixs: await returnIxs(w, v2, admin) }), {
    done: vaultIn(w, v2, [VaultState.Returned]),
  });

  if (!w.runner.applies("4.12a")) return "completed";
  // V3 (localnet): the beneficiary's own return opens only at the deadline.
  const v3 = await vaultPda(w, "classA", VAULT_V3);
  w.runner.setEntity("vaultV3", v3);
  await w.runner.step(
    "4.12a",
    async () => ({
      payer: admin,
      ixs: await openVaultIxs(w, {
        classKey: "classA",
        vaultId: VAULT_V3,
        vaultType: VaultType.DeliveryEscrow,
        amount: BigInt(1),
        deadline: (await chainNow(w.rpc)) + DELIVERY_DEADLINE_S,
        beneficiary: b1.address,
        registry,
      }),
    }),
    { done: () => accountExists(w.rpc, v3) },
  );
  await w.runner.step("4.12b", async () => ({ payer: b1, ixs: await depositIxs(w, b1, v3, BigInt(1)) }), {
    done: deposited(w, v3, BigInt(1)),
  });
  // null once V3 is returned (or gone): nothing left to show.
  const v3Deadline = async () => {
    const data = await loadVault(w, v3);
    return data && data.state !== VaultState.Returned ? data.deadline : null;
  };
  await w.runner.step("4.12c", async () => ({ payer: b1, ixs: await returnIxs(w, v3, b1) }), {
    notRun: async () => {
      const deadline = await v3Deadline();
      if (deadline === null) return "vault V3 was already returned (4.12d ran)";
      return (await chainNow(w.rpc)) + CLOCK_GUARD_S < deadline ? null : `vault V3's deadline ${deadline} has passed (chain time)`;
    },
  });
  const deadline = await v3Deadline();
  if (deadline !== null) {
    const blocked = await reachChainTime(w, deadline + BigInt(1), "vault V3 deadline");
    if (blocked) {
      w.runner.markNotRun("4.12d", blocked);
      return "completed";
    }
  }
  await w.runner.step("4.12d", async () => ({ payer: b1, ixs: await returnIxs(w, v3, b1) }), {
    done: vaultIn(w, v3, [VaultState.Returned]),
  });
  return "completed";
}
