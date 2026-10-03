// lib/open-sales-chain: the one browser reader of the 0x02 rules — every Open
// sale with its issuer (share class → asset → issuer, confirmed) and that
// issuer's IssuerFreeze (finalized). Then the scenario it exists for: the
// super admin froze issuer B to reopen 0x02 for sale A, A closed, and B's
// sale (still Open) must not keep 0x02 open nor hide any re-pause offer.
import { describe, expect, it } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  RaiseType,
  SaleStatus,
  getAssetEncoder,
  getIssuerFreezeEncoder,
  getSaleEncoder,
  getShareClassEncoder,
} from "@/lib/generated/asset_registry";
import { findIssuerFreezePda } from "@/lib/pdas";
import { freezeFromAccount, listOpenSalesWithFreezes } from "@/lib/open-sales-chain";
import { PAUSE_FLAGS_ALL, PAUSE_ISSUER_PROCEEDS, PAUSE_PRIMARY } from "@/lib/pause-flags";
import { closeFlowStep, mintRepausesPrimary, preClearCheck, primaryCloseRefusal, repausePlan } from "@/lib/public-sale";
import { liveSales } from "@/lib/sale-liveness";

const NOW = 1_790_000_000;
const DAY = 86_400;
const SYSTEM = "11111111111111111111111111111111" as Address;
const key = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));

type Stored = { owner: Address; data: Uint8Array };

const saleBytes = (shareClass: Address, over: { status?: SaleStatus; sold?: number; endTs?: number } = {}) =>
  new Uint8Array(
    getSaleEncoder().encode({
      shareClass,
      mint: key(90),
      paymentMint: key(91),
      proceeds: key(92),
      authority: key(93),
      saleId: 1,
      pricePerUnit: 1_000_000,
      totalForSale: 100,
      sold: over.sold ?? 10,
      startTs: NOW - DAY,
      endTs: over.endTs ?? NOW + 30 * DAY,
      status: over.status ?? SaleStatus.Open,
      raiseType: RaiseType.Mature,
      cliffMonths: 0,
      vestingMonths: 0,
      version: 2,
      bump: 255,
      saleApproval: key(94),
      applicationHash: new Uint8Array(32),
    }),
  );

const shareClassBytes = (asset: Address) =>
  new Uint8Array(
    getShareClassEncoder().encode({
      version: 2,
      bump: 255,
      asset,
      mint: key(95),
      classIndex: 0,
      classType: 0,
      rightsBitfield: 0,
      liqPrefMultiplierBps: 10_000,
      liqSeniority: 0,
      votingWeight: 1,
      convertibleTo: null,
      maxSupply: BigInt(1_000),
      circulatingSupply: BigInt(0),
      lockedSupply: BigInt(0),
      mintablePostLaunch: true,
      mintInitialized: true,
      supplyLocked: false,
      lifetimeMinted: BigInt(0),
      cumulativeCap: true,
    }),
  );

const assetBytes = (issuer: Address) =>
  new Uint8Array(
    getAssetEncoder().encode({
      version: 1,
      bump: 255,
      issuer,
      assetId: "asset",
      assetType: 0,
      name: "Asset",
      symbolPrefix: "AST",
      legalDocHash: new Uint8Array(32).fill(7),
      jurisdictionRules: { allowedCountries: new Uint8Array(128), maxHolders: 0, restrictedPeriodEnd: BigInt(0), allowP2p: true },
      status: 1,
      shareClassesCount: 1,
      extraKycRegistry: null,
    }),
  );

const freezeBytes = (issuer: Address) =>
  new Uint8Array(
    getIssuerFreezeEncoder().encode({ version: 1, bump: 255, issuer, frozenBy: key(96), frozenAt: BigInt(NOW - DAY), reasonHash: new Uint8Array(32).fill(1) }),
  );

function rpcAccount(a: Stored) {
  return {
    data: [Buffer.from(a.data).toString("base64"), "base64"] as const,
    executable: false,
    lamports: BigInt(1_000_000),
    owner: a.owner,
    space: BigInt(a.data.length),
    rentEpoch: BigInt(0),
  };
}

/** getProgramAccounts lists the Sale accounts (listOpenSales filters Open itself); getMultipleAccounts reads `accounts`. */
function fakeRpc(accounts: Map<Address, Stored>, sales: Address[], opts: { failAt?: "confirmed" | "finalized"; calls?: string[] } = {}) {
  const calls = opts.calls ?? [];
  return {
    getProgramAccounts: () => ({
      send: async () => {
        calls.push("getProgramAccounts");
        return sales.map((pubkey) => ({ pubkey, account: rpcAccount(accounts.get(pubkey)!) }));
      },
    }),
    getMultipleAccounts: (addresses: Address[], config?: { commitment?: string }) => ({
      send: async () => {
        calls.push(`getMultipleAccounts:${addresses.length}:${config?.commitment ?? ""}`);
        if (opts.failAt && config?.commitment === opts.failAt) throw new Error("429 Too Many Requests");
        return { value: addresses.map((a) => (accounts.has(a) ? rpcAccount(accounts.get(a)!) : null)) };
      },
    }),
  } as unknown as Parameters<typeof listOpenSalesWithFreezes>[0];
}

/** Issuer A (not frozen) with sale A, issuer B (frozen) with sale B, a closed sale C of issuer A. */
async function world() {
  const [issuerA, issuerB] = [key(1), key(2)];
  const [assetA, assetB] = [key(11), key(12)];
  const [classA, classB] = [key(21), key(22)];
  const [saleA, saleB, saleC] = [key(31), key(32), key(33)];
  const accounts = new Map<Address, Stored>([
    [saleA, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: saleBytes(classA) }],
    [saleB, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: saleBytes(classB) }],
    [saleC, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: saleBytes(classA, { status: SaleStatus.Closed }) }],
    [classA, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: shareClassBytes(assetA) }],
    [classB, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: shareClassBytes(assetB) }],
    [assetA, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: assetBytes(issuerA) }],
    [assetB, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: assetBytes(issuerB) }],
    [await findIssuerFreezePda(issuerB), { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: freezeBytes(issuerB) }],
  ]);
  return { accounts, sales: [saleA, saleB, saleC], issuerA, issuerB, classA, classB, saleA, saleB };
}

describe("listOpenSalesWithFreezes (lib/open-sales-chain)", () => {
  it("every Open sale with its issuer and that issuer's freeze: links at confirmed, the freezes at finalized", async () => {
    const w = await world();
    const calls: string[] = [];
    const sales = await listOpenSalesWithFreezes(fakeRpc(w.accounts, w.sales, { calls }));
    expect(sales.map((s) => [s.address, s.issuer, s.frozen])).toEqual([
      [w.saleA, w.issuerA, false],
      [w.saleB, w.issuerB, true],
    ]);
    expect(sales[0]).toMatchObject({ shareClass: w.classA, sold: BigInt(10), totalForSale: BigInt(100), endTs: BigInt(NOW + 30 * DAY) });
    // One read per step: the classes, the assets, the freezes (only the last at finalized).
    expect(calls).toEqual(["getProgramAccounts", "getMultipleAccounts:2:confirmed", "getMultipleAccounts:2:confirmed", "getMultipleAccounts:2:finalized"]);
  });

  it("no Open sale: nothing else is read", async () => {
    const calls: string[] = [];
    expect(await listOpenSalesWithFreezes(fakeRpc(new Map(), [], { calls }))).toEqual([]);
    expect(calls).toEqual(["getProgramAccounts"]);
  });

  it("a freeze or a link that cannot be read leaves `frozen` null (never false)", async () => {
    const w = await world();
    const failed = await listOpenSalesWithFreezes(fakeRpc(w.accounts, w.sales, { failAt: "finalized" }));
    expect(failed.map((s) => [s.issuer, s.frozen])).toEqual([
      [w.issuerA, null],
      [w.issuerB, null],
    ]);
    const noLinks = await listOpenSalesWithFreezes(fakeRpc(w.accounts, w.sales, { failAt: "confirmed" }));
    expect(noLinks.map((s) => [s.issuer, s.frozen])).toEqual([
      [null, null],
      [null, null],
    ]);
    // Class B missing: its sale's issuer is unknown; A is still read.
    const missing = new Map(w.accounts);
    missing.delete(w.classB);
    expect((await listOpenSalesWithFreezes(fakeRpc(missing, w.sales))).map((s) => s.frozen)).toEqual([false, null]);
  });

  it("only the registry's own freeze naming that issuer counts as frozen", async () => {
    const w = await world();
    const pda = await findIssuerFreezePda(w.issuerB);
    const at = (stored: Stored | undefined) =>
      freezeFromAccount(stored ? { ...rpcToEncoded(pda, stored), exists: true } : { address: pda, exists: false }, w.issuerB);
    expect(at(undefined)).toBe(false);
    expect(at({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: freezeBytes(w.issuerB) })).toBe(true);
    // Lamports sent to the PDA (system-owned), another issuer's freeze, or bytes that do not decode: unknown.
    expect(at({ owner: SYSTEM, data: new Uint8Array(0) })).toBeNull();
    expect(at({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: freezeBytes(w.issuerA) })).toBeNull();
    expect(at({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: new Uint8Array(3) })).toBeNull();
    expect(freezeFromAccount(undefined, w.issuerB)).toBeNull();
  });
});

function rpcToEncoded(address: Address, stored: Stored) {
  return { address, data: stored.data, executable: false, lamports: BigInt(1) as never, programAddress: stored.owner, space: BigInt(stored.data.length) };
}

describe("issuer B frozen to reopen 0x02 for sale A; A closed; B's sale still Open", () => {
  it("every 0x02 rule reads B's freeze: the pre-clear check passes, and every re-pause offer is shown", async () => {
    const w = await world();
    const all = await listOpenSalesWithFreezes(fakeRpc(w.accounts, w.sales));
    // Before A opened: B's frozen sale does not block the pre-clear check (A's own approval is live).
    const approval = { address: key(50), shareClass: w.classA, expiresAt: BigInt(NOW + DAY) };
    const others = all.filter((s) => s.address !== w.saleA);
    expect(preClearCheck({ openSales: others, approvals: [approval], thisApproval: approval.address, nowSec: NOW })).toMatchObject({
      clear: true,
      idleOpenSales: [{ address: w.saleB, state: "frozen" }],
    });
    // A ends and collects: its close sets 0x02 again too (B takes no buy).
    const collecting = PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY & ~PAUSE_ISSUER_PROCEEDS;
    expect(closeFlowStep({ flags: collecting, saleOpen: true, otherSales: others, nowSec: NOW })).toEqual({
      step: "close",
      repause: PAUSE_ISSUER_PROCEEDS | PAUSE_PRIMARY,
    });
    // A closed: only B is Open. /admin/launchpad offers 0x02 (0x20 stays clear for B's close), the guard lets it
    // through, the pre-clear panel's "Close again" too, and a treasury mint re-pauses.
    expect(liveSales(others, NOW, "re-pause")).toEqual([]);
    expect(repausePlan({ flags: collecting, sales: others, nowSec: NOW, liveApprovals: 0 })).toEqual({ mask: PAUSE_PRIMARY, warning: null });
    expect(primaryCloseRefusal(others, NOW)).toBeNull();
    expect(mintRepausesPrimary({ sales: others, nowSec: NOW, classLiveApprovals: 0 })).toBe(true);
    // The freeze lifted: B takes buys again, and every rule keeps 0x02 open for it.
    const lifted = others.map((s) => ({ ...s, frozen: false }));
    expect(repausePlan({ flags: collecting, sales: lifted, nowSec: NOW, liveApprovals: 0 }).mask).toBe(0);
    expect(primaryCloseRefusal(lifted, NOW)).toMatch(/1 Open sale can still take buys/);
    expect(mintRepausesPrimary({ sales: lifted, nowSec: NOW, classLiveApprovals: 0 })).toBe(false);
  });
});
