// lib/server/passport-state.ts — the server half of "revoke the passport
// before erasing a dossier": every KycRegistry is checked, only an Approved
// and unexpired entry is live, and any RPC failure fails closed (503).
// Also pins the browser half (lib/client-privacy.ts erasurePassportCheck).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  registries: [] as Array<{ address: string }>,
  entries: {} as Record<string, { exists: boolean; programAddress?: string; data?: { status: number; expiry: bigint } }>,
  fail: false,
  reads: [] as string[],
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
    fetchMaybeKycEntry: vi.fn(async (_rpc: unknown, pda: string) => {
      mocks.reads.push(pda);
      return mocks.entries[pda] ?? { exists: false };
    }),
  };
});

import { ASSET_REGISTRY_PROGRAM_ADDRESS, KycStatus } from "@/lib/generated/asset_registry";
import { assertNoLivePassport, walletHasLivePassport } from "@/lib/server/passport-state";
import { KYC_STATUS_APPROVED, erasurePassportCheck } from "@/lib/client-privacy";

const WALLET = "C1ientWa11etC1ientWa11etC1ientWa1";
const NOW = 1_800_000_000;
const entry = (status: KycStatus, expiry: number) => ({
  exists: true,
  programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
  data: { status, expiry: BigInt(expiry) },
});

beforeEach(() => {
  mocks.registries = [{ address: "RegA" }];
  mocks.entries = {};
  mocks.fail = false;
  mocks.reads = [];
});

describe("walletHasLivePassport", () => {
  it("is live only for an Approved entry whose expiry is still ahead", async () => {
    expect(await walletHasLivePassport(WALLET, NOW)).toBe(false);
    mocks.entries[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    expect(await walletHasLivePassport(WALLET, NOW)).toBe(true);
    mocks.entries[`RegA:${WALLET}`] = entry(KycStatus.Approved, NOW);
    expect(await walletHasLivePassport(WALLET, NOW)).toBe(false);
    mocks.entries[`RegA:${WALLET}`] = entry(KycStatus.Revoked, NOW + 60);
    expect(await walletHasLivePassport(WALLET, NOW)).toBe(false);
  });

  it("checks every registry, so an ambiguous set cannot hide a live entry", async () => {
    mocks.registries = [{ address: "RegA" }, { address: "RegB" }];
    mocks.entries[`RegB:${WALLET}`] = entry(KycStatus.Approved, NOW + 60);
    expect(await walletHasLivePassport(WALLET, NOW)).toBe(true);
    expect(mocks.reads).toEqual([`RegA:${WALLET}`, `RegB:${WALLET}`]);
  });

  it("rejects an entry owned by another program", async () => {
    mocks.entries[`RegA:${WALLET}`] = { ...entry(KycStatus.Approved, NOW + 60), programAddress: "11111111111111111111111111111111" };
    await expect(walletHasLivePassport(WALLET, NOW)).rejects.toThrow(/owner/);
  });
});

describe("assertNoLivePassport", () => {
  it("refuses a live passport (409) and fails closed when the chain cannot be read (503)", async () => {
    mocks.entries[`RegA:${WALLET}`] = entry(KycStatus.Approved, Math.floor(Date.now() / 1000) + 3600);
    await expect(assertNoLivePassport(WALLET)).rejects.toMatchObject({ status: 409 });
    mocks.fail = true;
    await expect(assertNoLivePassport(WALLET)).rejects.toMatchObject({ status: 503 });
  });

  it("passes a wallet without a live entry, and a dossier without a wallet without asking the chain", async () => {
    await expect(assertNoLivePassport(WALLET)).resolves.toBeUndefined();
    mocks.fail = true;
    await expect(assertNoLivePassport(null)).resolves.toBeUndefined();
  });
});

describe("erasurePassportCheck (admin page gate)", () => {
  const ready = { wallet: WALLET, kycCtx: { ambiguous: false, registry: {} }, passportLoading: false, passportError: false, nowSec: NOW };

  it("matches the on-chain enum", () => {
    expect(KYC_STATUS_APPROVED).toBe(KycStatus.Approved);
  });

  it("offers Anonymize only after a finished lookup found no live passport", () => {
    expect(erasurePassportCheck({ ...ready, passport: null })).toBe("none");
    expect(erasurePassportCheck({ ...ready, passport: { status: KycStatus.Revoked, expiry: NOW + 60 } })).toBe("none");
    expect(erasurePassportCheck({ ...ready, passport: { status: KycStatus.Approved, expiry: NOW } })).toBe("none");
    expect(erasurePassportCheck({ ...ready, passport: { status: KycStatus.Approved, expiry: BigInt(NOW + 60) } })).toBe("live");
    expect(erasurePassportCheck({ ...ready, wallet: null, passport: undefined })).toBe("none");
    expect(erasurePassportCheck({ ...ready, kycCtx: { ambiguous: false, registry: null }, passport: undefined })).toBe("none");
  });

  it("fails closed while loading and when a read failed", () => {
    expect(erasurePassportCheck({ ...ready, kycCtx: undefined, passport: undefined })).toBe("loading");
    expect(erasurePassportCheck({ ...ready, passport: undefined })).toBe("loading");
    expect(erasurePassportCheck({ ...ready, passportLoading: true, passport: null })).toBe("loading");
    expect(erasurePassportCheck({ ...ready, passportError: true, passport: null })).toBe("unknown");
    expect(erasurePassportCheck({ ...ready, kycCtx: null, passport: undefined })).toBe("unknown");
    expect(erasurePassportCheck({ ...ready, kycCtx: { ambiguous: true, registry: null }, passport: undefined })).toBe("unknown");
  });
});
