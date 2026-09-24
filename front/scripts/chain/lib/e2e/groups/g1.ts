/**
 * G1: issuer → KYB → asset → two classes → mints → sale approval → sale →
 * a purchase without KYC on the Open class (design-6.3 §A G1). Localnet adds
 * the non-Admin issuer's refused treasury mint (1.11) and the KycGated class:
 * a purchase without a passport is refused, with one it lands (1.12).
 *
 * Devnet checkpoint C1: verify_issuer_kyb needs the Super Admin, the user's
 * wallet. The runner prints what to click and polls the Issuer account.
 */
import type { Address, KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  AssetStatus,
  AssetType,
  KybStatus,
  RaiseType,
  ShareClassType,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  fetchMaybeSale,
  fetchMaybeShareClass,
  fetchSale,
  findAssetPda,
  findIssuerPda,
  findMintPda,
  findSaleApprovalPda,
  getActivateAssetInstructionAsync,
  getAddShareClassInstructionAsync,
  getApproveSaleInstructionAsync,
  getCreateAssetInstructionAsync,
  getInitializeShareClassMintInstructionAsync,
  getMintToTreasuryInstructionAsync,
  getOpenSaleInstructionAsync,
  getRegisterIssuerInstructionAsync,
  getSetIssuerPermissionsInstructionAsync,
  getVerifyIssuerKybInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeTransferHookConfig,
  findConfigPda,
  findExtraAccountMetaListPda,
  getUpdateTransferHookConfigInstructionAsync,
} from "@/lib/generated/transfer_hook";
import { findIssuerPermissionsAddress, ISSUER_CAPABILITIES, resolveIssuerPermission } from "@/lib/issuer-permissions";
import { buildIssuePassport, getEntryPda } from "@/lib/passport";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { buildDocumentedPurchase } from "@/lib/purchase-builder";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { ChainPlanError } from "../../safety";
import { waitForCheckpoint } from "../checkpoint";
import { chainNow } from "../clock";
import {
  PAYMENT_UNIT,
  createPaymentMintInstructions,
  fundInstructions,
  mintPaymentInstructions,
  paymentAta,
  tokenBalance,
  topUp,
} from "../fixtures";
import { entity } from "../state";
import { ONE_DAY, accountExists, defaultJurisdiction, legalEntityId, sha256Bytes, type World } from "../world";

/** Voting, dividend, convertible and transferable (constants.rs RIGHT_*). */
const RIGHTS_A = 1 | 2 | 8 | 32;
/** Voting, dividend and transferable. */
const RIGHTS_B = 1 | 2 | 32;
const PAYMENT_PER_BUYER = BigInt(1_000) * PAYMENT_UNIT;
export const UNIT_PRICE = PAYMENT_UNIT;
export const SALE1_TOTAL = BigInt(100);
const HOUR = BigInt(3_600);

/**
 * A sale's end: two hours on devnet, so e2e sales do not linger on the
 * public marketplace (devnet shares the app with real users); a week on the
 * private localnet.
 */
export function saleEnd(w: World, start: bigint): bigint {
  return start + (w.network === "devnet" ? BigInt(2) * HOUR : BigInt(7) * ONE_DAY);
}

export function saleTerms(salePda: Address, asset: Address, runId: string, saleId: number) {
  const digest = Buffer.from(sha256Bytes(`manci-e2e:${runId}:sale:${saleId}`)).toString("hex");
  return {
    versionId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    sha256: digest,
    sale: salePda,
    asset,
    url: "https://manci.io/e2e",
    verifiedAt: new Date(0).toISOString(),
  };
}

async function lamportsTargets(w: World): Promise<{ to: Address; lamports: bigint }[]> {
  const { admin, issuer, buyers } = w.roles;
  const buyerSol = BigInt(w.network === "devnet" ? 40_000_000 : 5_000_000_000);
  const wanted: [Address, bigint][] = buyers.map((b) => [b.address, buyerSol]);
  if (w.network === "localnet") {
    wanted.push([admin.address, BigInt(10_000_000_000)], [issuer.address, BigInt(10_000_000_000)]);
  }
  const out = await Promise.all(wanted.map(([to, lamports]) => topUp(w.rpc, to, lamports)));
  return out.filter((t) => t !== null);
}

/** The Admin record (devnet: the issuer is an Admin) or the IssuerPermissions PDA (localnet). */
async function issuerPermission(w: World, issuer: Address, capability: number): Promise<Address> {
  return resolveIssuerPermission(w.rpc, issuer, w.roles.issuer.address, capability);
}

export async function openSaleIxs(
  w: World,
  input: {
    classKey: "classA" | "classB";
    saleId: number;
    price: bigint;
    total: bigint;
    startTs: bigint;
    endTs: bigint;
  },
) {
  const issuer = entity(w.runner.state, "issuer") as Address;
  const asset = entity(w.runner.state, "asset") as Address;
  const shareClass = entity(w.runner.state, input.classKey) as Address;
  const mint = entity(w.runner.state, input.classKey === "classA" ? "mintA" : "mintB") as Address;
  const paymentMint = entity(w.runner.state, "paymentMint") as Address;
  return [
    await getOpenSaleInstructionAsync({
      authority: w.roles.issuer,
      issuer,
      asset,
      shareClass,
      mint,
      paymentMint,
      paymentTokenProgram: TOKEN_CLASSIC,
      approvedBy: w.roles.admin.address,
      saleId: BigInt(input.saleId),
      pricePerUnit: input.price,
      totalForSale: input.total,
      startTs: input.startTs,
      endTs: input.endTs,
      raiseType: RaiseType.Mature,
      cliffMonths: 0,
      vestingMonths: 0,
    }),
  ];
}

export async function approveSaleIxs(
  w: World,
  input: {
    signer?: KeyPairSigner;
    classKey: "classA" | "classB";
    saleId: number;
    maxGross: bigint;
    minPrice: bigint;
    maxPrice: bigint;
    expiresAt: bigint;
  },
) {
  const issuer = entity(w.runner.state, "issuer") as Address;
  const asset = entity(w.runner.state, "asset") as Address;
  const shareClass = entity(w.runner.state, input.classKey) as Address;
  return [
    await getApproveSaleInstructionAsync({
      authority: input.signer ?? w.roles.admin,
      issuer,
      asset,
      shareClass,
      paymentMint: entity(w.runner.state, "paymentMint") as Address,
      saleId: BigInt(input.saleId),
      maxGrossRaise: input.maxGross,
      minPricePerUnit: input.minPrice,
      maxPricePerUnit: input.maxPrice,
      raiseType: RaiseType.Mature,
      expiresAt: input.expiresAt,
      applicationHash: sha256Bytes(`manci-e2e:${w.runId}:approval:${input.saleId}`),
      cliffMonths: 0,
      vestingMonths: 0,
    }),
  ];
}

export async function saleApprovalExists(w: World, classKey: "classA" | "classB", saleId: number): Promise<boolean> {
  const [approval] = await findSaleApprovalPda({ shareClass: entity(w.runner.state, classKey) as Address, saleId: BigInt(saleId) });
  return accountExists(w.rpc, approval);
}

export async function saleExists(w: World, classKey: "classA" | "classB", saleId: number): Promise<boolean> {
  return accountExists(w.rpc, await findSalePda(entity(w.runner.state, classKey) as Address, BigInt(saleId)));
}

/**
 * A buy's `done` probe: the sale has sold at least `units` (each e2e sale
 * has one buying step, so this survives later transfers of the shares).
 */
export async function saleSold(w: World, classKey: "classA" | "classB", saleId: number, units: bigint): Promise<boolean> {
  const sale = await fetchMaybeSale(w.rpc, await findSalePda(entity(w.runner.state, classKey) as Address, BigInt(saleId)), {
    commitment: "finalized",
  });
  return sale.exists && sale.data.sold >= units;
}

/** A documented purchase (the app's builder): ATAs, terms memo, buy + receiver-KYC tail. */
export async function buyIxs(w: World, buyer: KeyPairSigner, classKey: "classA" | "classB", saleId: number, amount: bigint) {
  const salePda = await findSalePda(entity(w.runner.state, classKey) as Address, BigInt(saleId));
  const sale = await fetchSale(w.rpc, salePda, { commitment: "finalized" });
  const built = await buildDocumentedPurchase(w.rpc, {
    buyer,
    sale: sale.data,
    amount,
    terms: saleTerms(salePda, entity(w.runner.state, "asset") as Address, w.runId, saleId),
  });
  return [...built.preparationInstructions, ...built.purchaseInstructions];
}

export async function runGroup1(w: World): Promise<"completed" | "awaiting"> {
  const { funder, admin, issuer: issuerKey, superAdmin, buyers, paymentMint } = w.roles;
  const [b1, b2, b3, b4] = buyers;

  await w.runner.step("1.0", async () => ({ payer: funder, ixs: fundInstructions(funder, await lamportsTargets(w)) }), {
    done: async () => (await lamportsTargets(w)).length === 0,
  });

  w.runner.setEntity("paymentMint", paymentMint.address);
  await w.runner.step(
    "1.1a",
    async () => ({
      payer: funder,
      ixs: await createPaymentMintInstructions({ rpc: w.rpc, payer: funder, mint: paymentMint, authority: funder.address }),
    }),
    { done: () => accountExists(w.rpc, paymentMint.address) },
  );
  const funded = async (owners: Address[]) =>
    (await Promise.all(owners.map(async (o) => tokenBalance(w.rpc, await paymentAta(o, paymentMint.address))))).every((b) => b > BigInt(0));
  const mintTo = (owners: Address[]) => async () => ({
    payer: funder,
    ixs: await mintPaymentInstructions({ payer: funder, mintAuthority: funder, mint: paymentMint.address, owners, amount: PAYMENT_PER_BUYER }),
  });
  await w.runner.step("1.1b", mintTo([b1.address, b2.address]), { done: () => funded([b1.address, b2.address]) });
  await w.runner.step("1.1c", mintTo([b3.address, b4.address, issuerKey.address]), {
    done: () => funded([b3.address, b4.address, issuerKey.address]),
  });

  const legalId = legalEntityId(w.runId);
  const [issuer] = await findIssuerPda({ legalEntityId: legalId });
  w.runner.setEntity("issuer", issuer);
  await w.runner.step(
    "1.2",
    async () => ({
      payer: issuerKey,
      ixs: [
        await getRegisterIssuerInstructionAsync({
          authority: issuerKey,
          legalEntityId: legalId,
          jurisdiction: defaultJurisdiction(),
          kybDocHash: sha256Bytes(`manci-e2e:${w.runId}:kyb`),
        }),
      ],
    }),
    { done: () => accountExists(w.rpc, issuer) },
  );

  const kybVerified = async () => {
    const account = await fetchMaybeIssuer(w.rpc, issuer, { commitment: "finalized" });
    return account.exists && account.data.kybStatus === KybStatus.Verified;
  };
  if (w.network === "devnet") {
    if (!w.runner.passed("1.3")) {
      if (!(await kybVerified())) {
        const code = new TextDecoder().decode(legalId).replace(/\0+$/, "");
        w.log(
          `ACTION REQUIRED C1: Super Admin → /admin/issuers → Pending → legal ID ${code} (issuer ${issuer}, authority ${issuerKey.address}) → Verify KYB`,
        );
        const verified = await waitForCheckpoint({
          check: kybVerified,
          waitMs: w.config.checkpointWaitMin * 60_000,
          sleep: w.sleep,
          signal: w.signal,
        });
        if (!verified) return "awaiting";
      }
      w.runner.markPassed("1.3", "KYB verified by the Super Admin in the browser (checkpoint C1)");
    }
  } else {
    await w.runner.step(
      "1.3",
      async () => ({ payer: superAdmin!, ixs: [await getVerifyIssuerKybInstructionAsync({ admin: superAdmin!, issuer, approved: true })] }),
      { done: kybVerified },
    );
  }

  const assetId = `e2e-${w.runId}`;
  const [asset] = await findAssetPda({ issuer, assetId });
  w.runner.setEntity("asset", asset);
  await w.runner.step(
    "1.4a",
    async () => ({
      payer: issuerKey,
      ixs: [
        await getCreateAssetInstructionAsync({
          authority: issuerKey,
          issuer,
          assetId,
          assetType: AssetType.Equity,
          name: `Manci e2e ${w.runId}`,
          symbolPrefix: "E2E",
          legalDocHash: sha256Bytes(`manci-e2e:${w.runId}:asset`),
          jurisdictionRules: {
            allowedCountries: new Uint8Array(128),
            maxHolders: 0,
            restrictedPeriodEnd: BigInt(0),
            allowP2p: true,
          },
        }),
      ],
    }),
    { done: () => accountExists(w.rpc, asset) },
  );

  const classes = [
    { step: "1.4b", key: "classA" as const, index: 0, type: ShareClassType.Common, rights: RIGHTS_A },
    { step: "1.4c", key: "classB" as const, index: 1, type: ShareClassType.PreferredA, rights: RIGHTS_B },
  ];
  for (const c of classes) {
    const shareClass = await findShareClassPda(asset, c.index);
    w.runner.setEntity(c.key, shareClass);
    await w.runner.step(
      c.step,
      async () => ({
        payer: issuerKey,
        ixs: [
          await getAddShareClassInstructionAsync({
            authority: issuerKey,
            issuer,
            asset,
            shareClass,
            classIndex: c.index,
            classType: c.type,
            rightsBitfield: c.rights,
            liqPrefMultiplierBps: 10_000,
            liqSeniority: 0,
            votingWeight: 1,
            maxSupply: null,
            mintablePostLaunch: true,
          }),
        ],
      }),
      { done: () => accountExists(w.rpc, shareClass) },
    );
  }

  const capabilities = ISSUER_CAPABILITIES.Mint | ISSUER_CAPABILITIES.Metadata | ISSUER_CAPABILITIES.Conversion;
  await w.runner.step(
    "1.5",
    async () => ({
      payer: superAdmin!,
      ixs: [
        await getSetIssuerPermissionsInstructionAsync({
          superAdmin: superAdmin!,
          issuer,
          permissions: await findIssuerPermissionsAddress(issuer, issuerKey.address),
          capabilities,
        }),
      ],
    }),
    { done: async () => accountExists(w.rpc, await findIssuerPermissionsAddress(issuer, issuerKey.address)) },
  );

  for (const [step, key, mintKey] of [["1.6a", "classA", "mintA"], ["1.6b", "classB", "mintB"]] as const) {
    const shareClass = entity(w.runner.state, key) as Address;
    const [mint] = await findMintPda({ shareClass });
    w.runner.setEntity(mintKey, mint);
    await w.runner.step(
      step,
      async () => {
        const [hookConfig] = await findConfigPda({ mint });
        const [metaList] = await findExtraAccountMetaListPda({ mint });
        return {
          payer: issuerKey,
          ixs: [
            await getInitializeShareClassMintInstructionAsync({
              authority: issuerKey,
              adminRecord: await issuerPermission(w, issuer, ISSUER_CAPABILITIES.Mint),
              issuer,
              asset,
              shareClass,
              mint,
              hookConfig,
              extraAccountMetaList: metaList,
              transferHookProgram: TRANSFER_HOOK_PROGRAM_ADDRESS,
              tokenProgram: TOKEN_2022,
            }),
          ],
        };
      },
      {
        done: async () => {
          const account = await fetchMaybeShareClass(w.rpc, shareClass, { commitment: "finalized" });
          return account.exists && account.data.mintInitialized;
        },
      },
    );
  }

  await w.runner.step(
    "1.7",
    async () => ({ payer: admin, ixs: [await getActivateAssetInstructionAsync({ authority: admin, issuer, asset })] }),
    {
      done: async () => {
        const account = await fetchMaybeAsset(w.rpc, asset, { commitment: "finalized" });
        return account.exists && account.data.status === AssetStatus.Active;
      },
    },
  );

  const now = await chainNow(w.rpc);
  await w.runner.step(
    "1.8",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, {
        classKey: "classA",
        saleId: 1,
        maxGross: UNIT_PRICE * SALE1_TOTAL,
        minPrice: UNIT_PRICE,
        maxPrice: UNIT_PRICE,
        expiresAt: now + ONE_DAY,
      }),
    }),
    { done: () => saleApprovalExists(w, "classA", 1) },
  );
  await w.runner.step(
    "1.9",
    async () => ({
      payer: issuerKey,
      ixs: await openSaleIxs(w, { classKey: "classA", saleId: 1, price: UNIT_PRICE, total: SALE1_TOTAL, startTs: now, endTs: saleEnd(w, now) }),
    }),
    { done: () => saleExists(w, "classA", 1) },
  );
  w.runner.setEntity("sale1", await findSalePda(entity(w.runner.state, "classA") as Address, BigInt(1)));
  await w.runner.step("1.10", async () => ({ payer: b1, ixs: await buyIxs(w, b1, "classA", 1, BigInt(10)) }), {
    done: () => saleSold(w, "classA", 1, BigInt(10)),
  });

  if (w.network !== "localnet") return "completed";

  // 1.11: a non-Admin issuer holding the MINT capability may not mint to a wallet.
  await w.runner.step("1.11", async () => {
    const mint = entity(w.runner.state, "mintA") as Address;
    const [destination] = await findAssociatedTokenPda({ owner: issuerKey.address, mint, tokenProgram: TOKEN_2022 });
    return {
      payer: issuerKey,
      ixs: [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: issuerKey, owner: issuerKey.address, mint, tokenProgram: TOKEN_2022 }),
        await getMintToTreasuryInstructionAsync({
          authority: issuerKey,
          adminRecord: await issuerPermission(w, issuer, ISSUER_CAPABILITIES.Mint),
          issuer,
          asset,
          shareClass: entity(w.runner.state, "classA") as Address,
          destination,
          amount: BigInt(1),
        }),
      ],
    };
  });

  // 1.12: the KycGated class.
  const registry = entity(w.runner.state, "kycRegistry") as Address;
  const mintB = entity(w.runner.state, "mintB") as Address;
  const ba = w.roles.blocklistAuthority!;
  await w.runner.step(
    "1.12a",
    async () => ({
      payer: ba,
      ixs: [
        await getUpdateTransferHookConfigInstructionAsync({
          authority: ba,
          mint: mintB,
          kycRegistryAccount: registry,
          restrictionMode: RestrictionMode.KycGated,
          kycRegistry: registry,
        }),
      ],
    }),
    {
      done: async () => {
        const [config] = await findConfigPda({ mint: mintB });
        const account = await fetchMaybeTransferHookConfig(w.rpc, config, { commitment: "finalized" });
        return account.exists && account.data.restrictionMode === RestrictionMode.KycGated;
      },
    },
  );
  const later = await chainNow(w.rpc);
  await w.runner.step(
    "1.12b",
    async () => ({
      payer: admin,
      ixs: await approveSaleIxs(w, {
        classKey: "classB",
        saleId: 4,
        maxGross: UNIT_PRICE * SALE1_TOTAL,
        minPrice: UNIT_PRICE,
        maxPrice: UNIT_PRICE,
        expiresAt: later + ONE_DAY,
      }),
    }),
    { done: () => saleApprovalExists(w, "classB", 4) },
  );
  await w.runner.step(
    "1.12c",
    async () => ({
      payer: issuerKey,
      ixs: await openSaleIxs(w, { classKey: "classB", saleId: 4, price: UNIT_PRICE, total: SALE1_TOTAL, startTs: later, endTs: saleEnd(w, later) }),
    }),
    { done: () => saleExists(w, "classB", 4) },
  );
  await w.runner.step("1.12d", async () => ({ payer: b2, ixs: await buyIxs(w, b2, "classB", 4, BigInt(3)) }));
  const kyc = w.roles.kycAuthority;
  if (!kyc) throw new ChainPlanError("1.12 needs the localnet KYC authority");
  await w.runner.step(
    "1.12e",
    async () => ({
      payer: kyc,
      ixs: [
        await buildIssuePassport({
          authoritySigner: kyc,
          registry,
          holder: b2.address,
          jurisdiction: defaultJurisdiction(),
          accreditationLevel: 0,
          expiry: (await chainNow(w.rpc)) + BigInt(30) * ONE_DAY,
          providerId: 1,
          externalRefHash: sha256Bytes(`manci-e2e:${w.runId}:passport:${b2.address}`),
        }),
      ],
    }),
    { done: async () => accountExists(w.rpc, await getEntryPda(registry, b2.address)) },
  );
  // 1.12d (the refused buy) sold nothing, so any sale on #4 is 1.12f's.
  await w.runner.step("1.12f", async () => ({ payer: b2, ixs: await buyIxs(w, b2, "classB", 4, BigInt(3)) }), {
    done: () => saleSold(w, "classB", 4, BigInt(3)),
  });
  void b3;
  void b4;
  return "completed";
}
