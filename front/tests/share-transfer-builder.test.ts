// lib/share-transfer buildShareTransfer: the two instructions of "Send to
// holder" carry exactly the accounts Token-2022 resolves from the mint's
// ExtraAccountMetaList (the program's `build_metas`), the recipient account
// is created idempotently in the same transaction, the transfer is
// transfer_checked at 0 decimals, and the whole send fits one packet.
//
// The list is encoded from the program's definition (tests/fixtures), its
// Open form pinned to the real devnet bytes, then resolved the way Token-2022
// resolves it (lib/extra-account-metas) against token-account data carrying
// the owners. Offline; the RPC stub only answers the hook config read.
import { describe, expect, it } from "vitest";
import {
  AccountRole,
  compileTransaction,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  getTransferCheckedInstructionDataDecoder,
} from "@solana-program/token-2022";
import {
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  getTransferHookConfigEncoder,
  findConfigPda,
} from "@/lib/generated/transfer_hook";
import { hookTransferMetas, type HookTailConfig } from "@/lib/hook-metas";
import { buildShareTransfer, tokenAccountOf, TOKEN_2022 } from "@/lib/share-transfer";
import { findExtraMetasPda } from "@/lib/pdas";
import { decodeExtraAccountMetaList, resolveExtraAccountMetas } from "@/lib/extra-account-metas";
import { SEND_OVERHEAD_INSTRUCTIONS, TRANSACTION_SIZE_LIMIT, setComputeUnitLimitInstruction, setComputeUnitPriceInstruction, transactionSize } from "@/lib/compute-budget";
import { buildMetasFixture, fakeTokenAccountData, toHex } from "./fixtures/extra-account-metas";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const SYSTEM = "11111111111111111111111111111111";
const HOOK = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy";

/** The real devnet Open list (51 B), read from E98RYAUp5NTCgSBzoJeYa1eXbLarLYUiYKo7DmvaB6e. */
const DEVNET_OPEN_LIST_HEX =
  "692565c54bfb661a" + "27000000" + "01000000" + "01" + "0107626c6f636b6564" + "04002020" + "00".repeat(19) + "00" + "00";

const KYC: HookTailConfig = {
  restrictionMode: RestrictionMode.KycGated,
  kycRegistry: { __option: "Some", value: REGISTRY },
};
const OPEN: HookTailConfig = { restrictionMode: RestrictionMode.Open, kycRegistry: { __option: "None" } };

async function parties(): Promise<{ from: KeyPairSigner; to: Address }> {
  return { from: await generateKeyPairSigner(), to: (await generateKeyPairSigner()).address };
}

/** What Token-2022 resolves from the list for this transfer. */
async function resolvedFromList(list: Uint8Array, from: Address, to: Address): Promise<Address[]> {
  const source = await tokenAccountOf(from, MINT);
  const destination = await tokenAccountOf(to, MINT);
  const data = new Map<string, Uint8Array>([
    [source, fakeTokenAccountData(MINT, from)],
    [destination, fakeTokenAccountData(MINT, to)],
  ]);
  return resolveExtraAccountMetas(decodeExtraAccountMetaList(list), {
    hookProgram: TRANSFER_HOOK_PROGRAM_ADDRESS,
    accounts: [source, MINT, destination, from, await findExtraMetasPda(MINT)],
    accountData: (address) => data.get(address) ?? null,
  });
}

const accountsOf = (ix: Instruction) => (ix.accounts ?? []).map((a) => a.address);

describe("the ExtraAccountMetaList fixture is the program's build_metas", () => {
  it("Open encodes to the real devnet 51 bytes", () => {
    const open = buildMetasFixture("open");
    expect(open).toHaveLength(51);
    expect(toHex(open)).toBe(DEVNET_OPEN_LIST_HEX);
  });

  it("KycGated is exactly 261 bytes: 8 + 4 + 4 + 35 × 7", () => {
    const list = buildMetasFixture("kyc-gated", REGISTRY);
    expect(list).toHaveLength(261);
    const metas = decodeExtraAccountMetaList(list);
    expect(metas.map((m) => (m.kind === "fixed" ? "fixed" : m.programIndex === null ? "hook-pda" : `pda@${m.programIndex}`))).toEqual([
      "hook-pda", "hook-pda", "fixed", "fixed", "pda@8", "pda@8", "pda@8",
    ]);
    expect(metas.every((m) => !m.isSigner && !m.isWritable)).toBe(true);
  });
});

describe("buildShareTransfer", () => {
  it("KycGated: [srcAta W, mint R, dstAta W, from signer] + the 7 resolved metas + list + hook program, all read-only", async () => {
    const { from, to } = await parties();
    const { instructions, sourceTokenAccount, destinationTokenAccount } = await buildShareTransfer({
      mint: MINT, from, to, amount: BigInt(5_000), decimals: 0, hookConfig: KYC,
    });
    expect(instructions).toHaveLength(2);
    const transfer = instructions[1];
    expect(transfer.programAddress).toBe(TOKEN_2022);
    const accounts = transfer.accounts!;
    expect(accounts).toHaveLength(13);
    expect(accountsOf(transfer).slice(0, 4)).toEqual([sourceTokenAccount, MINT, destinationTokenAccount, from.address]);
    expect(accounts.slice(0, 4).map((a) => a.role)).toEqual([
      AccountRole.WRITABLE, AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.READONLY_SIGNER,
    ]);
    const resolved = await resolvedFromList(buildMetasFixture("kyc-gated", REGISTRY), from.address, to);
    expect(accountsOf(transfer).slice(4, 11)).toEqual(resolved);
    expect(accountsOf(transfer).slice(11)).toEqual([await findExtraMetasPda(MINT), HOOK]);
    expect(accounts.slice(4).every((a) => a.role === AccountRole.READONLY)).toBe(true);
    // idx 6 and 7 of the hook's Execute: the config PDA and the registry from the config.
    expect(resolved[1]).toBe((await findConfigPda({ mint: MINT }))[0]);
    expect(resolved[2]).toBe(REGISTRY);
  });

  it("Open: the 1 resolved meta (sender's BlockEntry) + list + hook program", async () => {
    const { from, to } = await parties();
    const { instructions } = await buildShareTransfer({ mint: MINT, from, to, amount: BigInt(1), decimals: 0, hookConfig: OPEN });
    const transfer = instructions[1];
    expect(transfer.accounts).toHaveLength(7);
    expect(accountsOf(transfer).slice(4, 5)).toEqual(await resolvedFromList(buildMetasFixture("open"), from.address, to));
    expect(accountsOf(transfer).slice(5)).toEqual([await findExtraMetasPda(MINT), HOOK]);
  });

  it("carries the same tail hookTransferMetas reads from the chain", async () => {
    const { from, to } = await parties();
    const config = Buffer.from(
      getTransferHookConfigEncoder().encode({
        mint: MINT, shareClass: MINT, blocklist: MINT,
        restrictionMode: RestrictionMode.KycGated, kycRegistry: REGISTRY, version: 1, bump: 255,
      }),
    ).toString("base64");
    const rpc = {
      getAccountInfo: () => ({
        send: async () => ({
          context: { slot: BigInt(1) },
          value: { data: [config, "base64"], executable: false, lamports: BigInt(1), owner: HOOK, space: BigInt(0) },
        }),
      }),
    } as unknown as Parameters<typeof hookTransferMetas>[0];
    const { instructions, sourceTokenAccount, destinationTokenAccount } = await buildShareTransfer({
      mint: MINT, from, to, amount: BigInt(3), decimals: 0, hookConfig: KYC,
    });
    const tail = await hookTransferMetas(rpc, MINT, {
      sourceTokenAccount, destTokenAccount: destinationTokenAccount,
      sourceOwner: from.address, transferAuthority: from.address, destOwner: to,
    });
    expect(instructions[1].accounts!.slice(4)).toEqual(tail);
  });

  it("first creates the recipient's Token-2022 account, idempotently, paid by the sender", async () => {
    const { from, to } = await parties();
    const { instructions, destinationTokenAccount } = await buildShareTransfer({
      mint: MINT, from, to, amount: BigInt(1), decimals: 0, hookConfig: KYC,
    });
    const create = instructions[0];
    expect(create.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(Array.from(create.data!)).toEqual([1]); // CreateIdempotent
    expect(accountsOf(create)).toEqual([from.address, destinationTokenAccount, to, MINT, SYSTEM, TOKEN_2022]);
    expect(create.accounts![0].role).toBe(AccountRole.WRITABLE_SIGNER);
  });

  it("a separate payer pays the account's rent", async () => {
    const { from, to } = await parties();
    const payer = await generateKeyPairSigner();
    const { instructions } = await buildShareTransfer({ mint: MINT, from, to, amount: BigInt(1), decimals: 0, hookConfig: OPEN, payer });
    expect(accountsOf(instructions[0])[0]).toBe(payer.address);
  });

  it("is transfer_checked at 0 decimals with the amount", async () => {
    const { from, to } = await parties();
    const { instructions } = await buildShareTransfer({ mint: MINT, from, to, amount: BigInt(5_000), decimals: 0, hookConfig: KYC });
    const data = getTransferCheckedInstructionDataDecoder().decode(instructions[1].data!);
    expect(data.discriminator).toBe(12);
    expect([data.amount, data.decimals]).toEqual([BigInt(5_000), 0]);
  });

  it("refuses another decimals value, an amount below 1 and a send to oneself", async () => {
    const { from, to } = await parties();
    const base = { mint: MINT, from, to, amount: BigInt(1), decimals: 0, hookConfig: KYC };
    await expect(buildShareTransfer({ ...base, decimals: 6 })).rejects.toThrow(/0 decimals/);
    await expect(buildShareTransfer({ ...base, amount: BigInt(0) })).rejects.toThrow(/at least 1/);
    await expect(buildShareTransfer({ ...base, to: from.address })).rejects.toThrow(/sending wallet itself/);
  });
});

describe("packet size", () => {
  it("the full KycGated send with the account creation fits 1232 bytes with the send path's compute budget", async () => {
    const { from, to } = await parties();
    const { instructions } = await buildShareTransfer({ mint: MINT, from, to, amount: BigInt(5_000), decimals: 0, hookConfig: KYC });
    expect(transactionSize(from.address, [...SEND_OVERHEAD_INSTRUCTIONS, ...instructions])).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
    // And the compiled wire bytes, signature included, as the wallet signs them.
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(from, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: SYSTEM as Blockhash, lastValidBlockHeight: BigInt(1) }, m),
      (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(1_400_000), setComputeUnitPriceInstruction(BigInt(2_000_000)), ...instructions], m),
    );
    const wire = Buffer.from(getBase64EncodedWireTransaction(compileTransaction(message)), "base64");
    // 736 bytes when written (signature included).
    expect(wire.length).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
  });
});
