// lib/treasury-mint runTreasuryMint says BEFORE the reservation is signed
// what the send path would refuse after it (F048): KYC-only mode and the
// 0x02 pause (lib/pause-gate, the same words) and a key without the Mint
// capability. Nothing is reserved then — no signature, no reservation row,
// none of the release prompts a refused reservation used to cost (one every
// 15 s for up to 3 minutes). With the gate open the reservation comes before
// the send (the order tests/tokenize-shares.test.ts pins), and a send that
// never left the browser releases it once its blockhash can no longer land.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import type { WalletSession } from "@solana/client";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  permission: vi.fn(),
  signer: null as unknown,
}));
vi.mock("@/lib/sale-approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sale-approvals")>()),
  reserveTreasuryMint: mocks.reserve,
  releaseWhenExpired: mocks.release,
}));
vi.mock("@/lib/issuer-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issuer-permissions")>()),
  resolveIssuerPermission: mocks.permission,
}));
vi.mock("@/lib/wallet-signer", () => ({ walletSigner: () => mocks.signer }));

import { AssetRegistryInstruction, findAdminRecordPda } from "@/lib/generated/asset_registry";
import { PAUSE_PRIMARY, PAUSE_SECONDARY } from "@/lib/pause-flags";
import { clearPauseFlagsCache, KycOnlyFlowError, PausedFlowError, readPauseFlags } from "@/lib/pause-gate";
import { assertTreasuryMintAllowed, runTreasuryMint, TreasuryMintError } from "@/lib/treasury-mint";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

type Input = Parameters<typeof runTreasuryMint>[0];

/** An RPC that answers the blockhash read and nothing else (a Platform read fails: the gate then fails open). */
function stubRpc() {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: BigInt(100) } }),
    }),
  };
}

const addr = async (): Promise<Address> => (await generateKeyPairSigner()).address;

async function setup(rpc: object, send: Input["send"]) {
  const signer = await generateKeyPairSigner();
  mocks.signer = signer;
  mocks.permission.mockResolvedValue((await findAdminRecordPda({ authority: signer.address }))[0]);
  const session = { account: { address: signer.address } } as unknown as WalletSession;
  const onStage = vi.fn();
  const input: Input = {
    session,
    rpc: rpc as never,
    send,
    sc: { mint: await addr(), asset: await addr() },
    scPda: await addr(),
    issuerPda: await addr(),
    amount: BigInt(100),
    amountEur: 500,
    reason: "Treasury top-up for OTC",
    repause: false,
    onStage,
  };
  return { input, onStage };
}

async function rejection(input: Input): Promise<unknown> {
  try {
    await runTreasuryMint(input);
  } catch (err) {
    return err;
  }
  throw new Error("runTreasuryMint resolved");
}

const walletClosed: Input["send"] = async () => {
  throw new Error("wallet closed");
};

beforeEach(() => {
  clearPauseFlagsCache();
  mocks.reserve.mockReset().mockResolvedValue({ reservation_id: "res-1", amount_eur: 500, subject: "issuer:x", capacity: {} });
  mocks.release.mockReset().mockResolvedValue(null);
  mocks.permission.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearPauseFlagsCache();
});

describe("assertTreasuryMintAllowed", () => {
  it("KYC-only mode refuses without reading the chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "on");
    const read = vi.fn(async () => 0);
    const err = await assertTreasuryMintAllowed({}, { read }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KycOnlyFlowError);
    expect((err as KycOnlyFlowError).instruction).toBe(AssetRegistryInstruction.MintToTreasury);
    expect(read).not.toHaveBeenCalled();
  });

  it("the 0x02 pause refuses with the gate's words; another bit, no flags or an unreadable Platform let it through", async () => {
    const err = await assertTreasuryMintAllowed({}, { read: async () => PAUSE_PRIMARY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PausedFlowError);
    expect(err).toMatchObject({ bit: PAUSE_PRIMARY, instruction: AssetRegistryInstruction.MintToTreasury });
    expect((err as Error).message).toMatch(/paused on Manci \(emergency pause\)\. Nothing was sent to your wallet\./);
    await expect(assertTreasuryMintAllowed({}, { read: async () => PAUSE_SECONDARY })).resolves.toBeUndefined();
    await expect(assertTreasuryMintAllowed({}, { read: async () => 0 })).resolves.toBeUndefined();
    await expect(assertTreasuryMintAllowed({}, { read: async () => null })).resolves.toBeUndefined();
  });
});

describe("runTreasuryMint", () => {
  it("(i) KYC-only mode: nothing reserved, nothing signed, nothing released", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "on");
    const send = vi.fn(walletClosed);
    const { input, onStage } = await setup(stubRpc(), send);
    const err = await rejection(input);
    expect(err).toBeInstanceOf(TreasuryMintError);
    expect((err as TreasuryMintError).sent).toBe(false);
    expect((err as TreasuryMintError).cause).toBeInstanceOf(KycOnlyFlowError);
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
  });

  it("(ii) the 0x02 pause: the same, with the pause's words", async () => {
    const rpc = stubRpc();
    // The gate's cache, as a page's banner primes it; the panel clears it right before the click.
    await readPauseFlags(rpc, { read: async () => PAUSE_PRIMARY });
    const send = vi.fn(walletClosed);
    const { input } = await setup(rpc, send);
    const err = await rejection(input);
    expect(err).toBeInstanceOf(TreasuryMintError);
    expect((err as TreasuryMintError).sent).toBe(false);
    expect((err as TreasuryMintError).cause).toBeInstanceOf(PausedFlowError);
    expect((err as TreasuryMintError).cause).toMatchObject({ bit: PAUSE_PRIMARY });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("a key without the Mint capability reserves nothing either (nothing would release that for 30 minutes)", async () => {
    const rpc = stubRpc();
    await readPauseFlags(rpc, { read: async () => 0 });
    const send = vi.fn(walletClosed);
    const { input } = await setup(rpc, send);
    mocks.permission.mockRejectedValue(new Error("This key has no Mint capability"));
    const err = await rejection(input);
    expect(err).toBeInstanceOf(TreasuryMintError);
    expect((err as Error).message).toMatch(/no Mint capability/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("(iii) gate open: the permission, then the reservation, then the send; a send that never left is released once its blockhash expires", async () => {
    const rpc = stubRpc();
    await readPauseFlags(rpc, { read: async () => PAUSE_SECONDARY });
    const send = vi.fn(walletClosed);
    const { input, onStage } = await setup(rpc, send);
    const err = await rejection(input);
    expect(err).toBeInstanceOf(TreasuryMintError);
    expect((err as TreasuryMintError).sent).toBe(false);
    expect((err as Error).message).toBe("wallet closed");
    expect(mocks.permission).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledWith(input.session, {
      share_class: input.scPda,
      amount_units: "100",
      amount_eur: 500,
      reason: "Treasury top-up for OTC",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.permission.mock.invocationCallOrder[0]).toBeLessThan(mocks.reserve.mock.invocationCallOrder[0]);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(input.session, "res-1", BigInt(100));
    expect(onStage.mock.calls.map((c) => c[0])).toEqual(["reserve", "sign"]);
  });

  it("an unreadable Platform refuses nothing (the program decides), as the gate does", async () => {
    const send = vi.fn(walletClosed);
    const { input } = await setup(stubRpc(), send);
    await rejection(input);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the order in the source: the gate and the permission before the reservation, the reservation before the build and the send; refused status reads are retried", () => {
    const lib = src("lib/treasury-mint.ts");
    const at = (s: string) => {
      const i = lib.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at("await assertTreasuryMintAllowed(rpc);")).toBeLessThan(at("resolveIssuerPermission(rpc, input.issuerPda"));
    expect(at("resolveIssuerPermission(rpc, input.issuerPda")).toBeLessThan(at("await reserveTreasuryMint(session, {"));
    expect(at("await reserveTreasuryMint(session, {")).toBeLessThan(at("await buildTreasuryMintIxs({"));
    expect(at("await buildTreasuryMintIxs({")).toBeLessThan(at("await input.send("));
    expect(lib).toContain("waitForSignature(rpc, sig, { timeoutMs: input.confirmTimeoutMs ?? 60_000, retryReads: true })");
  });
});
