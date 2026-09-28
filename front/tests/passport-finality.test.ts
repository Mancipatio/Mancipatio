// lib/server/passport-state.ts passportFinality (sim gap G1): a passport
// request is marked approved only for a live KycEntry at finalized. "none"
// is answered from the confirmed view after a short bounded grace (the
// server's RPC may lag the browser's); a confirmed-only passport is polled at
// finalized until the timeout; RPC failures throw.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  registries: [] as Array<{ address: string }>,
  confirmed: {} as Record<string, { exists: boolean; programAddress?: string; data?: { status: number; expiry: bigint } }>,
  /** Confirmed reads before the entry shows up at confirmed (a lagging server RPC). */
  confirmedAfter: 0,
  confirmedReads: 0,
  finalized: {} as Record<string, { exists: boolean; programAddress?: string; data?: { status: number; expiry: bigint } }>,
  /** Finalized reads before the entry shows up at finalized. */
  finalizedAfter: 0,
  finalizedReads: 0,
  fail: false,
}));

vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/network-identity", () => ({ createNetworkVerifier: () => async () => {} }));
vi.mock("@/lib/kyc-authority", () => ({
  listKycRegistries: vi.fn(async () => {
    if (mocks.fail) throw new Error("rpc down");
    return mocks.registries;
  }),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  return {
    ...real,
    findKycEntryPda: vi.fn(async ({ kycRegistry, holder }: { kycRegistry: string; holder: string }) => [`${kycRegistry}:${holder}`, 255]),
    fetchMaybeKycEntry: vi.fn(async (_rpc: unknown, pda: string, config: { commitment: string }) => {
      if (config.commitment === "finalized") {
        mocks.finalizedReads += 1;
        if (mocks.finalizedReads <= mocks.finalizedAfter) return { exists: false };
        return mocks.finalized[pda] ?? { exists: false };
      }
      mocks.confirmedReads += 1;
      if (mocks.confirmedReads <= mocks.confirmedAfter) return { exists: false };
      return mocks.confirmed[pda] ?? { exists: false };
    }),
  };
});

import { ASSET_REGISTRY_PROGRAM_ADDRESS, KycStatus } from "@/lib/generated/asset_registry";
import { passportFinality } from "@/lib/server/passport-state";

const WALLET = "C1ientWa11etC1ientWa11etC1ientWa1";
const NOW = 1_800_000_000;
const entry = (status: KycStatus, expiry: number) => ({
  exists: true,
  programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
  data: { status, expiry: BigInt(expiry) },
});
const noWait = { nowSec: NOW, intervalMs: 1, timeoutMs: 50, sleep: async () => {} };

beforeEach(() => {
  mocks.registries = [{ address: "RegA" }];
  mocks.confirmed = {};
  mocks.finalized = {};
  mocks.finalizedAfter = 0;
  mocks.finalizedReads = 0;
  mocks.confirmedAfter = 0;
  mocks.confirmedReads = 0;
  mocks.fail = false;
});

describe("passportFinality", () => {
  it("answers none at once when no live entry exists even at confirmed", async () => {
    expect(await passportFinality(WALLET, noWait)).toBe("none");
    expect(mocks.finalizedReads).toBe(0);
    // An expired or revoked entry is not live either.
    mocks.confirmed[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW);
    expect(await passportFinality(WALLET, noWait)).toBe("none");
    mocks.confirmed[`RegA:${WALLET}`] = entry(KycStatus.Revoked, NOW + 60);
    expect(await passportFinality(WALLET, noWait)).toBe("none");
  });

  it("gives a passport the server's RPC does not see yet a short, bounded grace before none", async () => {
    mocks.confirmed[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    mocks.finalized[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    mocks.confirmedAfter = 2; // the server's RPC is two reads behind the browser's
    const sleep = vi.fn(async () => {});
    expect(await passportFinality(WALLET, { ...noWait, sleep })).toBe("finalized");
    expect(mocks.confirmedReads).toBe(3);
    // Nothing was issued: none after exactly noneAttempts reads, 1 s apart by default.
    mocks.confirmed = {};
    mocks.confirmedReads = 0;
    mocks.confirmedAfter = 0;
    mocks.finalizedReads = 0;
    const waits: number[] = [];
    expect(await passportFinality(WALLET, { nowSec: NOW, sleep: async (ms) => { waits.push(ms); } })).toBe("none");
    expect(mocks.confirmedReads).toBe(5);
    expect(waits).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(mocks.finalizedReads).toBe(0);
  });

  it("waits for a just-confirmed passport to be finalized", async () => {
    mocks.confirmed[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    mocks.finalized[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    mocks.finalizedAfter = 3;
    const sleep = vi.fn(async () => {});
    expect(await passportFinality(WALLET, { ...noWait, timeoutMs: 60_000, sleep })).toBe("finalized");
    expect(mocks.finalizedReads).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("gives up with not-finalized after the timeout", async () => {
    mocks.confirmed[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    expect(await passportFinality(WALLET, { ...noWait, timeoutMs: 0 })).toBe("not-finalized");
  });

  it("throws on RPC failure and on an entry owned by another program", async () => {
    mocks.fail = true;
    await expect(passportFinality(WALLET, noWait)).rejects.toThrow("rpc down");
    mocks.fail = false;
    mocks.confirmed[`RegA:${WALLET}`] = { ...entry(KycStatus.Approved, NOW + 60), programAddress: "Other111111111111111111111111111111111111111" };
    await expect(passportFinality(WALLET, noWait)).rejects.toThrow("Unexpected KYC entry owner");
    await expect(passportFinality("not a wallet", noWait)).rejects.toThrow();
  });
});
