import { beforeEach, expect, it, vi } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), token: vi.fn() }));
vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeToken: mocks.token,
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeEscrowIdentity: mocks.identity,
}));
vi.mock("@/lib/transaction-builders", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMintTokenProgram: async () =>
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  VestingSeriesStatus,
  findCreateVestingSeriesIdentityPda,
  getRegisterVestingEscrowIdentityInstructionAsync,
  getWithdrawUnvestedInstruction,
  getWithdrawVestingSurplusInstruction,
  type VestingSeries,
} from "@/lib/generated/asset_registry";
import { loadVestingEscrow } from "@/lib/vesting-escrow";
const authority = address("11111111111111111111111111111111"),
  mint = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  tokenProgram = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  seriesPda = ASSET_REGISTRY_PROGRAM_ADDRESS,
  escrow = address("GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy"),
  rpc = {} as Parameters<typeof loadVestingEscrow>[0];
const series = {
  authority,
  tokenMint: mint,
  escrow,
  totalAllocated: BigInt(100),
  totalReleased: BigInt(30),
  deposited: BigInt(200),
  status: VestingSeriesStatus.Active,
} as VestingSeries;
beforeEach(() => {
  mocks.identity.mockResolvedValue({ exists: false });
  mocks.token.mockResolvedValue({
    exists: true,
    programAddress: tokenProgram,
    data: {
      mint,
      owner: seriesPda,
      amount: BigInt(90),
      extensions: { __option: "Some", value: [{ __kind: "ImmutableOwner" }] },
    },
  });
});
it("reserves unreleased allocations, reads actual balance and does not invent legacy refund history", async () => {
  const state = await loadVestingEscrow(rpc, seriesPda, series);
  expect(state.identity).toBeNull();
  expect(state.reserved).toBe(BigInt(70));
  expect(state.surplus).toBe(BigInt(20));
  expect(
    (
      await loadVestingEscrow(rpc, seriesPda, {
        ...series,
        status: VestingSeriesStatus.Draft,
      })
    ).surplus,
  ).toBe(BigInt(0));
  expect(
    (
      await loadVestingEscrow(rpc, seriesPda, {
        ...series,
        status: VestingSeriesStatus.Cancelled,
      })
    ).surplus,
  ).toBe(BigInt(0));
});
it("rejects spoofed identity/refund ownership and escrow token owners", async () => {
  mocks.identity.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: {
      refundOwner: mint,
      ownDeposited: BigInt(0),
      ownRefunded: BigInt(0),
    },
  });
  await expect(loadVestingEscrow(rpc, seriesPda, series)).rejects.toThrow(
    "identity",
  );
  mocks.identity.mockResolvedValue({ exists: false });
  mocks.token.mockResolvedValue({
    exists: true,
    programAddress: tokenProgram,
    data: { mint, owner: authority, amount: BigInt(999) },
  });
  await expect(loadVestingEscrow(rpc, seriesPda, series)).rejects.toThrow(
    "owner or mint",
  );
});
it("builds legacy attach and both withdrawal instructions with the same canonical identity PDA", async () => {
  const signer = createNoopSigner(authority),
    [identity] = await findCreateVestingSeriesIdentityPda({
      series: seriesPda,
    }),
    attach = await getRegisterVestingEscrowIdentityInstructionAsync({
      payer: signer,
      series: seriesPda,
    });
  expect(attach.accounts[2].address).toBe(identity);
  const args = {
      authority: signer,
      series: seriesPda,
      tokenMint: mint,
      escrow,
      authorityTokenAccount: authority,
      tokenProgram,
      identity,
    },
    cancelled = getWithdrawUnvestedInstruction(args),
    surplus = getWithdrawVestingSurplusInstruction(args);
  expect(cancelled.accounts.map((a) => a.address)).toEqual(
    surplus.accounts.map((a) => a.address),
  );
  expect(surplus.accounts[6].address).toBe(identity);
  expect(surplus.data).not.toEqual(cancelled.data);
});
