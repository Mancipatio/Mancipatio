// The cap table's chain reader (lib/server/cap-table-chain.ts) against a
// fake RPC that serves real account bytes (the generated encoders): the
// asset and issuer identity checks, the share classes with a mint (the
// conversion marker is skipped), the mint supply, the custody vaults of a
// class with their escrow balances, and the holder list classified by owner
// (treasury, custody vault, registry escrow, other program, wallet). Every
// RPC failure is a 503; an address that is not the program's asset a 404.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddressDecoder, getBase58Decoder, type Address } from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";

vi.mock("server-only", () => ({}));
const rpc = vi.hoisted(() => ({
  accounts: new Map<string, { owner: string; data: Uint8Array }>(),
  /** jsonParsed token accounts: address → { mint, owner, amount }. */
  tokens: new Map<string, { mint: string; owner: string; amount: string }>(),
  fail: null as null | string,
  calls: [] as string[],
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => fakeRpc() }));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetStatus,
  AssetType,
  findAssetPda,
  findIssuerPda,
  getAssetEncoder,
  getCustodyVaultDiscriminatorBytes,
  getCustodyVaultEncoder,
  getIssuerEncoder,
  getShareClassEncoder,
  KybStatus,
  RealizeAction,
  ShareClassType,
  VaultState,
  VaultType,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda, findShareClassPda } from "@/lib/pdas";
import { readAssetChain, readEntryShareClass } from "@/lib/server/cap-table-chain";
import { SiwsError } from "@/lib/server/siws-error";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";
const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)) as Address;
const AUTHORITY = key(1);
const MINT = key(2);
const ALICE = key(3);
const BOB = key(4);
const OTC_DEAL = key(5);
const AMM_POOL = key(6);
const OTHER_PROGRAM = key(7);
const ESCROW_1 = key(8);
const ESCROW_2 = key(9);
const TOKEN_ACCOUNTS = [key(20), key(21), key(22), key(23), key(24), key(25), key(26)];
const LEGAL_ENTITY = new Uint8Array(32).fill(0x4d);
const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

function fakeRpc() {
  const call = <T,>(name: string, value: () => T) => {
    rpc.calls.push(name);
    return { send: async () => { if (rpc.fail === name) throw new Error(`${name} timed out`); return value(); } };
  };
  const base64 = (address: string) => {
    const a = rpc.accounts.get(address);
    return a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: a.owner, space: BigInt(a.data.length), rentEpoch: BigInt(0) } : null;
  };
  const parsed = (address: string) => {
    const t = rpc.tokens.get(address);
    return t ? { data: { parsed: { type: "account", info: { mint: t.mint, owner: t.owner, tokenAmount: { amount: t.amount, decimals: 0 } } }, program: "spl-token-2022", space: BigInt(165) }, executable: false, lamports: BigInt(1), owner: TOKEN_2022, space: BigInt(165) } : null;
  };
  return {
    getAccountInfo: (address: string) => call("getAccountInfo", () => ({ context: { slot: BigInt(1) }, value: base64(address) })),
    getMultipleAccounts: (addresses: string[], config: { encoding: string }) => call(`getMultipleAccounts:${config.encoding}`, () => ({
      context: { slot: BigInt(1) },
      value: addresses.map((a) => (config.encoding === "jsonParsed" ? parsed(a) : base64(a))),
    })),
    getProgramAccounts: (program: string, config: { filters: Array<{ memcmp: { offset: bigint; bytes: string } }> }) => call(`getProgramAccounts:${program}`, () => {
      const filters = config.filters;
      if (program === ASSET_REGISTRY_PROGRAM_ADDRESS) {
        // The custody vault scan: discriminator at 0, share class at 8.
        expect(filters[0].memcmp).toMatchObject({ offset: BigInt(0), bytes: b58(new Uint8Array(getCustodyVaultDiscriminatorBytes())) });
        const shareClass = filters[1].memcmp.bytes;
        return [...rpc.accounts.entries()]
          .filter(([, a]) => a.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && b58(a.data.slice(0, 8)) === b58(new Uint8Array(getCustodyVaultDiscriminatorBytes())) && b58(a.data.slice(8, 40)) === shareClass)
          .map(([pubkey]) => ({ pubkey, account: base64(pubkey) }));
      }
      expect(program).toBe(TOKEN_2022);
      const mint = filters[0].memcmp.bytes;
      return [...rpc.tokens.entries()].filter(([, t]) => t.mint === mint).map(([pubkey]) => ({ pubkey, account: parsed(pubkey) }));
    }),
  };
}

let ISSUER: Address, ASSET: Address, CLASS_0: Address, CLASS_1: Address, VAULT_1: Address, VAULT_2: Address;

function shareClass(classIndex: number, over: Record<string, unknown> = {}) {
  return new Uint8Array(getShareClassEncoder().encode({
    asset: ASSET, mint: MINT, classIndex, classType: ShareClassType.Common, rightsBitfield: 0, liqPrefMultiplierBps: 10_000,
    liqSeniority: 0, votingWeight: 1, convertibleTo: null, maxSupply: BigInt(10_000), circulatingSupply: BigInt(9_750),
    lockedSupply: BigInt(0), mintablePostLaunch: false, mintInitialized: true, supplyLocked: true, version: 2, bump: 255,
    lifetimeMinted: BigInt(10_000), cumulativeCap: false, ...over,
  }));
}
function vault(vaultId: number, escrow: Address, state: VaultState) {
  return new Uint8Array(getCustodyVaultEncoder().encode({
    shareClass: CLASS_0, mint: MINT, escrow, vaultId: BigInt(vaultId), authority: AUTHORITY, vaultType: VaultType.DeliveryEscrow,
    realizeAction: RealizeAction.BurnAndAttest, amount: BigInt(100), state, deadline: BigInt(0), metadataHash: new Uint8Array(32).fill(1),
    beneficiary: ALICE, version: 2, bump: 255, deposited: BigInt(100), kycRegistry: key(30),
  }));
}

beforeEach(async () => {
  rpc.accounts.clear();
  rpc.tokens.clear();
  rpc.fail = null;
  rpc.calls.length = 0;
  [ISSUER] = await findIssuerPda({ legalEntityId: LEGAL_ENTITY });
  [ASSET] = await findAssetPda({ issuer: ISSUER, assetId: "MANCI-2026" });
  CLASS_0 = await findShareClassPda(ASSET, 0);
  CLASS_1 = await findShareClassPda(ASSET, 1);
  VAULT_1 = await findCustodyVaultPda(CLASS_0, BigInt(1));
  VAULT_2 = await findCustodyVaultPda(CLASS_0, BigInt(2));
  const registry = (data: Uint8Array) => ({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data });
  rpc.accounts.set(ISSUER, registry(new Uint8Array(getIssuerEncoder().encode({
    authority: AUTHORITY, legalEntityId: LEGAL_ENTITY, jurisdiction: 688, kybStatus: KybStatus.Verified,
    kybDocHash: new Uint8Array(32), assetsCount: BigInt(1), version: 1, bump: 255,
  }))));
  rpc.accounts.set(ASSET, registry(new Uint8Array(getAssetEncoder().encode({
    issuer: ISSUER, assetId: "MANCI-2026", assetType: AssetType.Equity, name: "Mancipatio d.o.o.", symbolPrefix: "MANCI",
    legalDocHash: new Uint8Array(32), jurisdictionRules: { allowedCountries: new Uint8Array(128), maxHolders: 0, restrictedPeriodEnd: BigInt(0), allowP2p: true },
    status: AssetStatus.Active, shareClassesCount: 2, extraKycRegistry: null, version: 1, bump: 255,
  }))));
  rpc.accounts.set(CLASS_0, registry(shareClass(0)));
  // The conversion marker: capped at 0, no mint.
  rpc.accounts.set(CLASS_1, registry(shareClass(1, { mint: SYSTEM, maxSupply: BigInt(0), circulatingSupply: BigInt(0), lifetimeMinted: BigInt(0), mintInitialized: false })));
  rpc.accounts.set(MINT, { owner: TOKEN_2022, data: new Uint8Array(getMintEncoder().encode({
    mintAuthority: CLASS_0, supply: BigInt(9_750), decimals: 0, isInitialized: true, freezeAuthority: null, extensions: null,
  })) });
  rpc.accounts.set(VAULT_1, registry(vault(1, ESCROW_1, VaultState.Realized)));
  rpc.accounts.set(VAULT_2, registry(vault(2, ESCROW_2, VaultState.Active)));
  // Owners: the registry escrow and another program's account; Bob is a funded wallet, Alice has no account.
  rpc.accounts.set(OTC_DEAL, registry(new Uint8Array(64)));
  rpc.accounts.set(AMM_POOL, { owner: OTHER_PROGRAM, data: new Uint8Array(64) });
  rpc.accounts.set(BOB, { owner: SYSTEM, data: new Uint8Array(0) });
  const token = (i: number, owner: string, amount: number) => rpc.tokens.set(TOKEN_ACCOUNTS[i], { mint: MINT, owner, amount: String(amount) });
  token(0, AUTHORITY, 9_000);
  token(1, ALICE, 300);
  token(2, ALICE, 100);
  token(3, BOB, 150);
  token(5, OTC_DEAL, 50);
  token(6, AMM_POOL, 50);
  // The vault escrows are token accounts of the mint too (owner: the vault PDA).
  rpc.tokens.set(ESCROW_1, { mint: MINT, owner: VAULT_1, amount: "0" });
  rpc.tokens.set(ESCROW_2, { mint: MINT, owner: VAULT_2, amount: "100" });
  // Another mint's account never counts.
  rpc.tokens.set(key(27), { mint: key(28), owner: ALICE, amount: "5" });
});

describe("readAssetChain", () => {
  it("reads the asset, its minted classes, the supply, the custody vaults and the classified holders", async () => {
    const chain = await readAssetChain(ASSET, { holders: true });
    expect(chain.identity).toEqual({ asset_pda: ASSET, asset_id: "MANCI-2026", name: "Mancipatio d.o.o.", symbol: "MANCI", issuer_pda: ISSUER });
    expect(chain.issuerAuthority).toBe(AUTHORITY);
    expect(chain.classes).toHaveLength(1);
    const c = chain.classes[0];
    expect(c).toMatchObject({
      shareClassPda: CLASS_0, classIndex: 0, mint: MINT, maxSupply: BigInt(10_000), cumulativeCap: false,
      lifetimeMinted: BigInt(10_000), circulatingSupply: BigInt(9_750), lockedSupply: BigInt(0), mintSupply: BigInt(9_750),
    });
    expect(c.custodyVaults).toEqual([
      { pda: VAULT_1, vaultId: "1", kind: "delivery_escrow", state: "realized", escrow: ESCROW_1, escrowUnits: BigInt(0) },
      { pda: VAULT_2, vaultId: "2", kind: "delivery_escrow", state: "active", escrow: ESCROW_2, escrowUnits: BigInt(100) },
    ]);
    const holders = Object.fromEntries(c.holders!.map((h) => [h.owner, [h.kind, h.units]]));
    expect(holders).toEqual({
      [AUTHORITY]: ["treasury", BigInt(9_000)],
      [ALICE]: ["wallet", BigInt(400)],
      [BOB]: ["wallet", BigInt(150)],
      [VAULT_2]: ["custody", BigInt(100)],
      [OTC_DEAL]: ["escrow", BigInt(50)],
      [AMM_POOL]: ["program", BigInt(50)],
    });
  });

  it("the public read skips the holder scan", async () => {
    const chain = await readAssetChain(ASSET, { holders: false });
    expect(chain.classes[0].holders).toBeNull();
    expect(rpc.calls).not.toContain(`getProgramAccounts:${TOKEN_2022}`);
  });

  it("reads a v1 custody vault (no deposit ledger) with those fields zeroed", async () => {
    const v2 = rpc.accounts.get(VAULT_2)!;
    rpc.accounts.set(VAULT_2, { ...v2, data: v2.data.slice(0, v2.data.length - 40) });
    const chain = await readAssetChain(ASSET, { holders: false });
    expect(chain.classes[0].custodyVaults[1]).toMatchObject({ pda: VAULT_2, state: "active", escrowUnits: BigInt(100) });
  });

  it("an address that is not this program's asset at its derived address is a 404", async () => {
    await expect(readAssetChain(ISSUER, { holders: true })).rejects.toMatchObject({ status: 404 });
    await expect(readAssetChain(key(40), { holders: true })).rejects.toMatchObject({ status: 404 });
    // An asset account copied to another address fails the derivation.
    rpc.accounts.set(key(41), rpc.accounts.get(ASSET)!);
    await expect(readAssetChain(key(41), { holders: true })).rejects.toMatchObject({ status: 404 });
    await expect(readAssetChain("not-an-address", { holders: true })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a share-class mint that is not a Token-2022 mint", async () => {
    rpc.accounts.set(MINT, { ...rpc.accounts.get(MINT)!, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    await expect(readAssetChain(ASSET, { holders: false })).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    "getAccountInfo", "getMultipleAccounts:base64", `getProgramAccounts:${ASSET_REGISTRY_PROGRAM_ADDRESS}`,
    "getMultipleAccounts:jsonParsed", `getProgramAccounts:${TOKEN_2022}`,
  ])("fails closed (503) when %s fails", async (name) => {
    rpc.fail = name;
    const err = await readAssetChain(ASSET, { holders: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiwsError);
    expect(err).toMatchObject({ status: 503, message: "On-chain supply data unavailable — try again" });
  });
});

describe("readEntryShareClass", () => {
  it("returns the asset and the cap of a minted class at its derived address", async () => {
    expect(await readEntryShareClass(CLASS_0)).toEqual({ assetPda: ASSET, maxSupply: BigInt(10_000) });
  });

  it("refuses the marker (no mint), a non-class and a malformed address", async () => {
    await expect(readEntryShareClass(CLASS_1)).rejects.toMatchObject({ status: 409 });
    await expect(readEntryShareClass(ASSET)).rejects.toMatchObject({ status: 400 });
    await expect(readEntryShareClass(key(42))).rejects.toMatchObject({ status: 400 });
    await expect(readEntryShareClass("nope")).rejects.toMatchObject({ status: 400 });
    rpc.fail = "getAccountInfo";
    await expect(readEntryShareClass(CLASS_0)).rejects.toMatchObject({ status: 503 });
  });
});
