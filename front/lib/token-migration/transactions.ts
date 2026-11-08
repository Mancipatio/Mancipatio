// Token migration (V1): the instructions the wallets sign. Node-safe (no
// React, no browser API), like lib/share-transfer.ts. Every one of them is a
// plain SPL Token / Token-2022 instruction (or a memo): none goes through a
// Manci program, so no pause bit of asset_registry stops them. The platform's
// switches are the routes (the module gate on the holder's precheck) and the
// campaign's status; the chain itself would accept a transfer at any time,
// which is why a deposit outside the window is recorded as irregular and
// refunded rather than refused.
//
// The deposit account is the associated token account of the deposit owner
// for the old mint, under the old mint's own token program. The owner may be
// a Squads vault, i.e. a program address off the ed25519 curve: deriving an
// ATA needs no curve check (spl-token's allowOwnerOffCurve), and the ATA
// program creates it for any owner.

import { AccountRole, address, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getBurnCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import { migrationMemoText, OLD_TOKEN_PROGRAMS } from "@/lib/token-migration/model";
import { U64_MAX } from "@/lib/token-migration/ratio";

function tokenProgram(value: string): Address {
  if (!OLD_TOKEN_PROGRAMS.includes(value)) throw new Error("The old token must be an SPL Token or Token-2022 mint.");
  return address(value);
}

function amountOk(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < BigInt(1) || amount > U64_MAX) throw new Error("The amount must be between 1 and u64::MAX base units.");
}

/** The associated token account of `owner` for `mint` under the mint's token program (off-curve owners allowed). */
export async function associatedTokenAccount(owner: Address | string, mint: Address | string, program: string): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: tokenProgram(program) });
  return ata;
}

/** The campaign's opening: create the deposit account, idempotently (the admin pays its rent). */
export async function buildOpenDepositAccount(input: {
  payer: TransactionSigner;
  depositOwner: Address | string;
  oldMint: Address | string;
  oldTokenProgram: string;
}): Promise<Instruction[]> {
  return [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.payer,
      owner: address(input.depositOwner),
      mint: address(input.oldMint),
      tokenProgram: tokenProgram(input.oldTokenProgram),
    }),
  ];
}

/** The holder's memo: one Memo v2 instruction with the holder as its signer (the memo program checks it). */
export function migrationMemoInstruction(signer: TransactionSigner, migrationId: string, lots: bigint): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer } as never],
    data: new TextEncoder().encode(migrationMemoText(migrationId, lots)),
  };
}

export type DepositInstructionsInput = {
  holder: TransactionSigner;
  depositOwner: Address | string;
  oldMint: Address | string;
  oldTokenProgram: string;
  decimals: number;
  migrationId: string;
  lots: bigint;
  /** lots × lot, base units. */
  amount: bigint;
};

/**
 * [create the deposit account (idempotent; a no-op once the campaign is
 * open), the memo, TransferChecked of exactly `amount` from the holder's
 * associated token account]. The memo comes right before the transfer, so a
 * deposit account that requires incoming memos (MemoTransfer) still accepts
 * it.
 */
export async function buildDepositInstructions(input: DepositInstructionsInput): Promise<{ instructions: Instruction[]; source: Address; destination: Address }> {
  amountOk(input.amount);
  const program = tokenProgram(input.oldTokenProgram);
  const mint = address(input.oldMint);
  const source = await associatedTokenAccount(input.holder.address, mint, program);
  const destination = await associatedTokenAccount(input.depositOwner, mint, program);
  const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: input.holder,
    owner: address(input.depositOwner),
    mint,
    tokenProgram: program,
  });
  const transfer = getTransferCheckedInstruction(
    { source, mint, destination, authority: input.holder, amount: input.amount, decimals: input.decimals },
    { programAddress: program },
  );
  return {
    instructions: [create, migrationMemoInstruction(input.holder, input.migrationId, input.lots), transfer],
    source,
    destination,
  };
}

/**
 * A refund: [create the holder's associated token account (idempotent; the
 * deposit owner pays), TransferChecked of exactly the deposit's amount back
 * to it]. Signed by the deposit owner; a Squads vault executes the same two
 * instructions through a proposal instead.
 */
export async function buildRefundInstructions(input: {
  depositOwner: TransactionSigner;
  holder: Address | string;
  oldMint: Address | string;
  oldTokenProgram: string;
  decimals: number;
  amount: bigint;
}): Promise<Instruction[]> {
  amountOk(input.amount);
  const program = tokenProgram(input.oldTokenProgram);
  const mint = address(input.oldMint);
  const source = await associatedTokenAccount(input.depositOwner.address, mint, program);
  const destination = await associatedTokenAccount(input.holder, mint, program);
  const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: input.depositOwner,
    owner: address(input.holder),
    mint,
    tokenProgram: program,
  });
  const transfer = getTransferCheckedInstruction(
    { source, mint, destination, authority: input.depositOwner, amount: input.amount, decimals: input.decimals },
    { programAddress: program },
  );
  return [create, transfer];
}

/** The burn of the collected old tokens: BurnChecked of `amount` from the deposit account, signed by its owner. */
export async function buildBurnInstructions(input: {
  depositOwner: TransactionSigner;
  oldMint: Address | string;
  oldTokenProgram: string;
  decimals: number;
  amount: bigint;
}): Promise<Instruction[]> {
  amountOk(input.amount);
  const program = tokenProgram(input.oldTokenProgram);
  const mint = address(input.oldMint);
  const account = await associatedTokenAccount(input.depositOwner.address, mint, program);
  return [
    getBurnCheckedInstruction(
      { account, mint, authority: input.depositOwner, amount: input.amount, decimals: input.decimals },
      { programAddress: program },
    ),
  ];
}
