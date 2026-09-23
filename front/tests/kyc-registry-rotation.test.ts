// 2C-1: the KYC registry is pinned BY ADDRESS (its authority rotates), plus
// the pure helpers behind the /admin/kyc registry panel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { address, getBase64Decoder, type Address } from "@solana/kit";

const calls = vi.hoisted(() => ({ platform: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  return { ...original, findPlatformPda: async () => ["platform-pda"], fetchMaybePlatform: calls.platform };
});

import { ASSET_REGISTRY_PROGRAM_ADDRESS, getKycRegistryEncoder } from "@/lib/generated/asset_registry";
import { loadKycAuthorityContext, selectKycRegistry, type KycRegistryRecord } from "@/lib/kyc-authority";
import { configuredKycRegistry, parseKycRegistryPin } from "@/lib/kyc-registry-pin";
import {
  bitmapCodeStrings,
  jurisdictionDiff,
  kycRegistryActions,
  kycTransferState,
  proposedKycAuthorityError,
  toggleJurisdiction,
} from "@/lib/kyc-registry-rotation";
import { jurisdictionBitmap } from "@/lib/passport";

const SEED_AUTHORITY = address("11111111111111111111111111111111");
const ROTATED = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ADMIN = address("So11111111111111111111111111111111111111112");
const PINNED = address("5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku");
const OTHER = address("ComputeBudget111111111111111111111111111111");

function record(addr: Address, authority: Address): KycRegistryRecord {
  return {
    address: addr,
    registry: {
      discriminator: new Uint8Array(8),
      authority,
      approvedJurisdictions: new Uint8Array(128),
      blockedJurisdictions: new Uint8Array(128),
      entriesCount: BigInt(1),
      version: 1,
      bump: 254,
    },
  };
}

function encoded(authority: Address): Uint8Array {
  return new Uint8Array(
    getKycRegistryEncoder().encode({
      authority,
      approvedJurisdictions: new Uint8Array(128),
      blockedJurisdictions: new Uint8Array(128),
      entriesCount: 1,
      version: 1,
      bump: 254,
    }),
  );
}

function rpcWithAccount(account: { owner: string; bytes: Uint8Array } | null) {
  const getProgramAccounts = vi.fn(() => ({ send: async () => [] }));
  const getAccountInfo = vi.fn(() => ({
    send: async () => ({
      value: account
        ? {
            data: [getBase64Decoder().decode(account.bytes), "base64"],
            executable: false,
            lamports: BigInt(1),
            owner: account.owner,
            space: BigInt(account.bytes.length),
          }
        : null,
    }),
  }));
  return { rpc: { getProgramAccounts, getAccountInfo } as never, getProgramAccounts, getAccountInfo };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.platform.mockResolvedValue({ exists: true, data: { admin: ADMIN } });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NEXT_PUBLIC_KYC_REGISTRY pin", () => {
  it("parses blank as no pin and a valid address as the pin", () => {
    expect(parseKycRegistryPin(undefined)).toBeNull();
    expect(parseKycRegistryPin("   ")).toBeNull();
    expect(parseKycRegistryPin(` ${PINNED} `)).toBe(PINNED);
  });

  it("throws on an invalid configured value (fail closed)", () => {
    expect(() => parseKycRegistryPin("not-an-address")).toThrow(/NEXT_PUBLIC_KYC_REGISTRY/);
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", "garbage");
    expect(() => configuredKycRegistry()).toThrow();
  });
});

describe("selectKycRegistry with a pin", () => {
  const seeded = record(OTHER, ADMIN);
  const rotated = record(PINNED, ROTATED);

  it("the pin beats the platform-admin heuristic", () => {
    expect(selectKycRegistry([seeded, rotated], ADMIN, PINNED)).toEqual({
      registry: rotated,
      ambiguous: false,
      pinnedMissing: false,
    });
  });

  it("a missing pin reports pinnedMissing and never falls back", () => {
    expect(selectKycRegistry([seeded], ADMIN, PINNED)).toEqual({
      registry: null,
      ambiguous: false,
      pinnedMissing: true,
    });
  });

  it("without a pin the heuristic is unchanged", () => {
    expect(selectKycRegistry([rotated, seeded], ADMIN)).toEqual({
      registry: seeded,
      ambiguous: false,
      pinnedMissing: false,
    });
  });
});

describe("loadKycAuthorityContext with a pin", () => {
  it("reads only the pinned account (no getProgramAccounts) and keeps a rotated authority", async () => {
    const { rpc, getProgramAccounts, getAccountInfo } = rpcWithAccount({
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      bytes: encoded(ROTATED),
    });
    const ctx = await loadKycAuthorityContext(rpc, { pinned: PINNED });
    expect(getProgramAccounts).not.toHaveBeenCalled();
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(ctx.registry?.address).toBe(PINNED);
    expect(ctx.registry?.registry.authority).toBe(ROTATED);
    expect(ctx).toMatchObject({ pinned: PINNED, pinnedMissing: false, ambiguous: false });
  });

  it("a pin with no account is pinnedMissing, with no scan", async () => {
    const { rpc, getProgramAccounts } = rpcWithAccount(null);
    const ctx = await loadKycAuthorityContext(rpc, { pinned: PINNED });
    expect(getProgramAccounts).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({ registry: null, pinned: PINNED, pinnedMissing: true });
  });

  it("rejects a pinned account that is not a KycRegistry", async () => {
    const foreign = rpcWithAccount({ owner: SEED_AUTHORITY, bytes: encoded(ROTATED) });
    await expect(loadKycAuthorityContext(foreign.rpc, { pinned: PINNED })).rejects.toThrow(/not owned/);
    const wrongDisc = encoded(ROTATED);
    wrongDisc[0] ^= 0xff;
    const bad = rpcWithAccount({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, bytes: wrongDisc });
    await expect(loadKycAuthorityContext(bad.rpc, { pinned: PINNED })).rejects.toThrow(/not a KycRegistry/);
  });

  it("an invalid env pin rejects the load", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", "garbage");
    const { rpc } = rpcWithAccount(null);
    await expect(loadKycAuthorityContext(rpc, { fresh: true })).rejects.toThrow(/NEXT_PUBLIC_KYC_REGISTRY/);
  });
});

describe("registry panel helpers", () => {
  it("validates the proposed authority like validate_new_authority", () => {
    expect(proposedKycAuthorityError("", ROTATED)).toBeNull();
    expect(proposedKycAuthorityError("nope", ROTATED)).toMatch(/valid/);
    expect(proposedKycAuthorityError(SEED_AUTHORITY, ROTATED)).toMatch(/default/);
    expect(proposedKycAuthorityError(ROTATED, ROTATED)).toMatch(/already/);
    expect(proposedKycAuthorityError(ADMIN, ROTATED)).toBeNull();
  });

  it("derives the pending state exactly as accept checks it", () => {
    const live = { target: PINNED, currentAuthority: ROTATED, newAuthority: ADMIN, proposedBy: ROTATED };
    expect(kycTransferState(PINNED, ROTATED, null)).toEqual({ kind: "none" });
    expect(kycTransferState(PINNED, ROTATED, live)).toEqual({ kind: "live", newAuthority: ADMIN });
    expect(kycTransferState(PINNED, ADMIN, live)).toEqual({ kind: "stale", newAuthority: ADMIN });
    expect(kycTransferState(OTHER, ROTATED, live)).toEqual({ kind: "none" });
  });

  it("gates actions on on-chain roles only", () => {
    const live = kycTransferState(PINNED, ROTATED, {
      target: PINNED, currentAuthority: ROTATED, newAuthority: ADMIN, proposedBy: ROTATED,
    });
    expect(kycRegistryActions(ROTATED, ROTATED, live)).toEqual({
      canPropose: true, canCancel: true, canAccept: false, canEditJurisdictions: true,
    });
    expect(kycRegistryActions(ADMIN, ROTATED, live)).toEqual({
      canPropose: false, canCancel: false, canAccept: true, canEditJurisdictions: false,
    });
    expect(kycRegistryActions(ADMIN, ROTATED, { kind: "stale", newAuthority: ADMIN }).canAccept).toBe(false);
    expect(kycRegistryActions(null, ROTATED, live)).toEqual({
      canPropose: false, canCancel: false, canAccept: false, canEditJurisdictions: false,
    });
  });

  it("toggles a code so it is never both approved and blocked", () => {
    const start = { approved: new Set(["688"]), blocked: new Set<string>() };
    const blocked = toggleJurisdiction(start.approved, start.blocked, "688", "blocked");
    expect([...blocked.approved]).toEqual([]);
    expect([...blocked.blocked]).toEqual(["688"]);
    const cleared = toggleJurisdiction(blocked.approved, blocked.blocked, "688", "blocked");
    expect(cleared.blocked.size).toBe(0);
  });

  it("diffs the maps and round-trips bitmap codes", () => {
    const current = { approved: jurisdictionBitmap([40, 688]), blocked: jurisdictionBitmap([]) };
    const next = { approved: jurisdictionBitmap([40, 276]), blocked: jurisdictionBitmap([688]) };
    expect(jurisdictionDiff(current, next)).toEqual({
      approvedAdded: [276],
      approvedRemoved: [688],
      blockedAdded: [688],
      blockedRemoved: [],
      unchanged: false,
    });
    expect(jurisdictionDiff(current, current).unchanged).toBe(true);
    expect([...bitmapCodeStrings(jurisdictionBitmap([40, 999]))]).toEqual(["040", "999"]);
  });
});
