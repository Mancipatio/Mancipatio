// e2e §5 (P1 at rotation): the KYC provider (KycRegistry.authority) and the
// platform admin (Platform.admin) are separate on-chain roles. The UI must
// resolve the live registry from chain — not derive it from Platform.admin —
// and must gate passport actions on the registry authority only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, getBase64Decoder, type Address } from "@solana/kit";

const calls = vi.hoisted(() => ({ platform: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  return {
    ...original,
    findPlatformPda: async () => ["platform-pda"],
    fetchMaybePlatform: calls.platform,
  };
});

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getKycRegistryEncoder,
} from "@/lib/generated/asset_registry";
import {
  KYC_AUTHORITY_CACHE_TTL_MS,
  invalidateKycAuthorityContext,
  kycGates,
  listKycRegistries,
  loadKycAuthorityContext,
  passportAuthorityFor,
  selectKycRegistry,
  waitForKycRegistry,
  type KycAuthorityContext,
  type KycRegistryRecord,
} from "@/lib/kyc-authority";

const PROVIDER = address("11111111111111111111111111111111");
const NEW_ADMIN = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const STRANGER = address("So11111111111111111111111111111111111111112");
const REG_PDA = address("ComputeBudget111111111111111111111111111111");

function registryOf(authority: Address, entries = 3): KycRegistryRecord {
  return {
    address: REG_PDA,
    registry: {
      discriminator: new Uint8Array(8),
      authority,
      approvedJurisdictions: new Uint8Array(128),
      blockedJurisdictions: new Uint8Array(128),
      entriesCount: BigInt(entries),
      version: 1,
      bump: 255,
    },
  };
}

function rpcWith(accounts: { pubkey: string; owner: string; bytes: Uint8Array }[]) {
  const getProgramAccounts = vi.fn(() => ({
    send: async () =>
      accounts.map((a) => ({
        pubkey: a.pubkey,
        account: { owner: a.owner, data: [getBase64Decoder().decode(a.bytes), "base64"] },
      })),
  }));
  return { rpc: { getProgramAccounts } as never, getProgramAccounts };
}

function encoded(authority: Address, entries = 3): Uint8Array {
  return new Uint8Array(
    getKycRegistryEncoder().encode({
      authority,
      approvedJurisdictions: new Uint8Array(128),
      blockedJurisdictions: new Uint8Array(128),
      entriesCount: entries,
      version: 1,
      bump: 255,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("kycGates", () => {
  it("never lets the platform admin role imply the KYC provider role", () => {
    const g = kycGates(NEW_ADMIN, PROVIDER, NEW_ADMIN);
    expect(g).toEqual({ isKycProvider: false, isPlatformAdmin: true, providerIsPlatformAdmin: false });
  });

  it("keeps passport rights with the original provider after admin rotation", () => {
    const g = kycGates(PROVIDER, PROVIDER, NEW_ADMIN);
    expect(g.isKycProvider).toBe(true);
    expect(g.isPlatformAdmin).toBe(false);
  });

  it("grants both gates only when provider and admin are the same key", () => {
    expect(kycGates(PROVIDER, PROVIDER, PROVIDER)).toEqual({
      isKycProvider: true,
      isPlatformAdmin: true,
      providerIsPlatformAdmin: true,
    });
    expect(kycGates(STRANGER, PROVIDER, NEW_ADMIN).isKycProvider).toBe(false);
  });

  it("closes both gates when the wallet or the registry is unknown", () => {
    expect(kycGates(null, PROVIDER, NEW_ADMIN)).toMatchObject({ isKycProvider: false, isPlatformAdmin: false });
    expect(kycGates(PROVIDER, null, NEW_ADMIN).isKycProvider).toBe(false);
    expect(kycGates(PROVIDER, undefined, undefined).isPlatformAdmin).toBe(false);
  });
});

describe("selectKycRegistry", () => {
  it("prefers the registry owned by the current platform admin", () => {
    const a = registryOf(PROVIDER);
    const b = { ...registryOf(NEW_ADMIN), address: STRANGER };
    expect(selectKycRegistry([a, b], NEW_ADMIN)).toEqual({ registry: b, ambiguous: false, pinnedMissing: false });
  });

  it("keeps the only registry after the platform admin rotated away", () => {
    const a = registryOf(PROVIDER);
    expect(selectKycRegistry([a], NEW_ADMIN)).toEqual({ registry: a, ambiguous: false, pinnedMissing: false });
  });

  it("reports ambiguity instead of guessing between foreign registries", () => {
    const a = registryOf(PROVIDER);
    const b = { ...registryOf(STRANGER), address: STRANGER };
    expect(selectKycRegistry([a, b], NEW_ADMIN)).toEqual({ registry: null, ambiguous: true, pinnedMissing: false });
    expect(selectKycRegistry([], NEW_ADMIN)).toEqual({ registry: null, ambiguous: false, pinnedMissing: false });
  });
});

describe("live registry resolution", () => {
  it("scans KycRegistry accounts with the discriminator filter and decodes them", async () => {
    const { rpc, getProgramAccounts } = rpcWith([
      { pubkey: REG_PDA, owner: ASSET_REGISTRY_PROGRAM_ADDRESS, bytes: encoded(PROVIDER, 7) },
    ]);
    const list = await listKycRegistries(rpc);
    expect(list).toHaveLength(1);
    expect(list[0].address).toBe(REG_PDA);
    expect(list[0].registry.authority).toBe(PROVIDER);
    expect(list[0].registry.entriesCount).toBe(BigInt(7));
    const opts = (getProgramAccounts.mock.calls[0] as unknown as [string, { filters: { memcmp: { offset: bigint } }[] }])[1];
    expect(opts.filters[0].memcmp.offset).toBe(BigInt(0));
  });

  it("rejects accounts owned by another program", async () => {
    const { rpc } = rpcWith([{ pubkey: REG_PDA, owner: STRANGER, bytes: encoded(PROVIDER) }]);
    await expect(listKycRegistries(rpc)).rejects.toThrow(/owner/);
  });

  it("does not derive the registry from Platform.admin after rotation", async () => {
    calls.platform.mockResolvedValue({ exists: true, data: { admin: NEW_ADMIN } });
    const { rpc } = rpcWith([
      { pubkey: REG_PDA, owner: ASSET_REGISTRY_PROGRAM_ADDRESS, bytes: encoded(PROVIDER) },
    ]);
    const ctx = await loadKycAuthorityContext(rpc);
    expect(ctx.platformAdmin).toBe(NEW_ADMIN);
    expect(ctx.registry?.address).toBe(REG_PDA);
    expect(ctx.registry?.registry.authority).toBe(PROVIDER);
    expect(ctx.ambiguous).toBe(false);
    // The rotated admin gets no passport rights; the original provider keeps them.
    expect(kycGates(NEW_ADMIN, ctx.registry?.registry.authority, ctx.platformAdmin).isKycProvider).toBe(false);
    expect(kycGates(PROVIDER, ctx.registry?.registry.authority, ctx.platformAdmin).isKycProvider).toBe(true);
  });

  it("reports no registry when the platform is uninitialised and none exists", async () => {
    calls.platform.mockResolvedValue({ exists: false });
    const { rpc } = rpcWith([]);
    const ctx = await loadKycAuthorityContext(rpc);
    expect(ctx).toEqual({ platformAdmin: null, registry: null, registries: [], ambiguous: false, pinned: null, pinnedMissing: false });
  });
});

describe("passportAuthorityFor (issue/revoke surfaces)", () => {
  const rotated: KycAuthorityContext = {
    platformAdmin: NEW_ADMIN,
    registry: registryOf(PROVIDER),
    registries: [registryOf(PROVIDER)],
    ambiguous: false,
    pinned: null,
    pinnedMissing: false,
  };

  it("targets the LIVE registry PDA, never one derived from the connected wallet", () => {
    // Post-rotation Super Admin: the registry PDA seeded by NEW_ADMIN does not
    // exist on-chain, so the surface must point at REG_PDA and close the gate.
    const a = passportAuthorityFor(NEW_ADMIN, rotated);
    expect(a.registryAddress).toBe(REG_PDA);
    expect(a.registryAuthority).toBe(PROVIDER);
    expect(a.isKycProvider).toBe(false);
    expect(a.isPlatformAdmin).toBe(true);
  });

  it("keeps the panel and signer authority with the original provider after rotation", () => {
    const a = passportAuthorityFor(PROVIDER, rotated);
    expect(a.isKycProvider).toBe(true);
    expect(a.isPlatformAdmin).toBe(false);
    // The signer authority passed to buildIssuePassport/buildRevokePassport
    // is the registry's own authority, not Platform.admin.
    expect(a.registryAuthority).toBe(PROVIDER);
  });

  it("closes everything while the context is unloaded, failed or empty", () => {
    for (const ctx of [undefined, null, { platformAdmin: NEW_ADMIN, registry: null, registries: [], ambiguous: false }]) {
      const a = passportAuthorityFor(PROVIDER, ctx as KycAuthorityContext | null | undefined);
      expect(a.registryAddress).toBeNull();
      expect(a.registryAuthority).toBeNull();
      expect(a.isKycProvider).toBe(false);
    }
  });

  it("surfaces ambiguity instead of picking a registry", () => {
    const a = passportAuthorityFor(PROVIDER, { ...rotated, registry: null, ambiguous: true, pinnedMissing: false });
    expect(a.ambiguous).toBe(true);
    expect(a.registryAddress).toBeNull();
    expect(a.isKycProvider).toBe(false);
  });
});

describe("registry scan cost and freshness", () => {
  it("scans at the client's confirmed commitment so a just-created registry is visible", async () => {
    const { rpc, getProgramAccounts } = rpcWith([]);
    await listKycRegistries(rpc);
    const opts = (getProgramAccounts.mock.calls[0] as unknown as [string, { commitment: string }])[1];
    expect(opts.commitment).toBe("confirmed");
  });

  it("rejects an account whose discriminator does not match KycRegistry", async () => {
    const bytes = encoded(PROVIDER);
    bytes[0] ^= 0xff;
    const { rpc } = rpcWith([{ pubkey: REG_PDA, owner: ASSET_REGISTRY_PROGRAM_ADDRESS, bytes }]);
    await expect(listKycRegistries(rpc)).rejects.toThrow(/discriminator/);
  });

  it("shares one scan between callers within the TTL and rescans after it", async () => {
    calls.platform.mockResolvedValue({ exists: true, data: { admin: PROVIDER } });
    const { rpc, getProgramAccounts } = rpcWith([
      { pubkey: REG_PDA, owner: ASSET_REGISTRY_PROGRAM_ADDRESS, bytes: encoded(PROVIDER) },
    ]);
    let t = 1_000_000;
    const now = () => t;
    const [a, b] = await Promise.all([
      loadKycAuthorityContext(rpc, { now }),
      loadKycAuthorityContext(rpc, { now }),
    ]);
    expect(a).toBe(b);
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    await loadKycAuthorityContext(rpc, { now });
    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    t += KYC_AUTHORITY_CACHE_TTL_MS;
    await loadKycAuthorityContext(rpc, { now });
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on fresh / invalidate and evicts a failed scan", async () => {
    calls.platform.mockResolvedValue({ exists: true, data: { admin: PROVIDER } });
    const { rpc, getProgramAccounts } = rpcWith([]);
    await loadKycAuthorityContext(rpc);
    await loadKycAuthorityContext(rpc, { fresh: true });
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    invalidateKycAuthorityContext(rpc);
    await loadKycAuthorityContext(rpc);
    expect(getProgramAccounts).toHaveBeenCalledTimes(3);

    const failing = { getProgramAccounts: vi.fn(() => ({ send: async () => { throw new Error("rate limited"); } })) };
    await expect(loadKycAuthorityContext(failing as never)).rejects.toThrow(/rate limited/);
    await expect(loadKycAuthorityContext(failing as never)).rejects.toThrow(/rate limited/);
    expect(failing.getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("polls fresh scans after create until the registry shows up", async () => {
    calls.platform.mockResolvedValue({ exists: true, data: { admin: PROVIDER } });
    let visible = false;
    const getProgramAccounts = vi.fn(() => ({
      send: async () =>
        visible
          ? [{ pubkey: REG_PDA, account: { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: [getBase64Decoder().decode(encoded(PROVIDER)), "base64"] } }]
          : [],
    }));
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length >= 2) visible = true;
    });
    const ctx = await waitForKycRegistry({ getProgramAccounts } as never, { attempts: 5, delayMs: 1, sleep });
    expect(ctx.registry?.address).toBe(REG_PDA);
    expect(getProgramAccounts).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempts run out without a registry", async () => {
    calls.platform.mockResolvedValue({ exists: true, data: { admin: PROVIDER } });
    const { rpc, getProgramAccounts } = rpcWith([]);
    const ctx = await waitForKycRegistry(rpc, { attempts: 3, sleep: async () => {} });
    expect(ctx.registry).toBeNull();
    expect(getProgramAccounts).toHaveBeenCalledTimes(3);
  });
});
