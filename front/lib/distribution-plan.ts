// "Send to wallets": the rows packed into as few transactions as fit, each
// test-run on the network before any wallet opens (design §3, S5).
//
// A row is [create the recipient's token account (only when it is missing),
// transfer_checked + the hook's account tail]. Rows are packed whole, never
// split, up to the working limit of 1200 B (the 1232 B packet minus the
// send path's 32 B reserve), measured WITH the two compute-budget
// instructions the send path puts in front. Measured: 8 rows with account
// creation, 15 without, 3 on a KycGated class (its tail names the
// recipient's KycEntry). No lookup table (the 64-account lock limit and the
// create/extend/wait cost outweigh it for recipients new every time).
//
// Phantom on mainnet adds Lighthouse assertions to what it signs, which
// lib/wallet-changes judgeWalletRewrite accepts: on a transfer, one on the
// fee payer's balance and one on the sender's token account, 83 B with the
// Lighthouse program key (the one-row "Send to holder" it signed: a 471 B
// message became 554 B; its treasury mint took 6, 527 → 775 B). The fee
// payer's alone takes 62 B with the key, so a pack over about 1170 B (a
// full pack: 8 new rows are about 1196 B) has no room even for it; whether
// Phantom then signs it unguarded is not yet seen. Guarded transactions are
// not independent (the fee payer's guard holds only until another of them
// lands), so they are never sent several at once: lib/verified-solana-client
// signs them one by one, each once the previous one is confirmed.
//
// Each transaction carries an index table (row → its first instruction and
// count), so a simulation refusal at instruction k names its row exactly;
// that row is dropped with the refusal's words and the rest are repacked.
//
// Node-safe (no React, no browser API): tests/distribution-plan.test.ts.
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { SEND_OVERHEAD_INSTRUCTIONS, TRANSACTION_SIZE_LIMIT, transactionSize } from "@/lib/compute-budget";
import { SEND_RESERVE_BYTES } from "@/lib/issuer-authority";
import type { HookTailConfig } from "@/lib/hook-metas";
import { buildShareTransfer } from "@/lib/share-transfer";
import type { SimulationRefusedError } from "@/lib/simulation-gate";

/** The working size limit of one transaction (bytes). */
export const DISTRIBUTION_TX_LIMIT = TRANSACTION_SIZE_LIMIT - SEND_RESERVE_BYTES;
/** Transactions signed with one wallet prompt: they share one blockhash (about 60–90 s to land). */
export const MAX_TRANSACTIONS_PER_PROMPT = 8;
/** Rent of a Token-2022 account with ImmutableOwner and the transfer-hook extension (175 B), in lamports. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = BigInt(2_108_880);
/** The network's base fee per signature, in lamports. */
export const BASE_FEE_LAMPORTS = BigInt(5_000);

export type RowInstructions = {
  /** The row's key (the recipient wallet). */
  row: string;
  instructions: Instruction[];
  createsAccount: boolean;
};

/**
 * One row's instructions exactly as the wallet signs them. The account
 * creation is left out when the recipient's token account already exists
 * (52 B instead of 94 B per row); a send that finds it closed in between is
 * refused by the simulation, never half-sent.
 */
export async function rowInstructions(input: {
  mint: Address;
  sender: TransactionSigner;
  wallet: Address;
  amount: bigint;
  decimals: number;
  hookConfig: HookTailConfig | null;
  accountExists: boolean;
}): Promise<RowInstructions> {
  const built = await buildShareTransfer({
    mint: input.mint,
    from: input.sender,
    to: input.wallet,
    amount: input.amount,
    decimals: input.decimals,
    hookConfig: input.hookConfig,
  });
  const [create, transfer] = built.instructions;
  return {
    row: input.wallet,
    instructions: input.accountExists ? [transfer] : [create, transfer],
    createsAccount: !input.accountExists,
  };
}

export type IndexEntry = { row: string; firstIx: number; count: number };

export type PackedTransaction = {
  instructions: Instruction[];
  /** Which instructions belong to which row. */
  index: IndexEntry[];
  /** Serialized size with the send path's compute-budget instructions. */
  size: number;
};

/** Serialized size of `instructions` once the send path adds its compute-budget instructions. */
export function sentSize(feePayer: Address, instructions: readonly Instruction[]): number {
  return transactionSize(feePayer, [...SEND_OVERHEAD_INSTRUCTIONS, ...instructions]);
}

/**
 * Packs rows in order, whole, into transactions of at most `limit` bytes.
 * Throws when one row alone does not fit (it never should).
 */
export function packRows(
  rows: readonly RowInstructions[],
  opts: { feePayer: Address; limit?: number },
): PackedTransaction[] {
  const limit = opts.limit ?? DISTRIBUTION_TX_LIMIT;
  const out: PackedTransaction[] = [];
  let current: PackedTransaction | null = null;
  for (const r of rows) {
    if (current) {
      const prev: PackedTransaction = current;
      const instructions: Instruction[] = [...prev.instructions, ...r.instructions];
      const size = sentSize(opts.feePayer, instructions);
      if (size <= limit) {
        current = {
          instructions,
          index: [...prev.index, { row: r.row, firstIx: prev.instructions.length, count: r.instructions.length }],
          size,
        };
        continue;
      }
      out.push(prev);
    }
    const size = sentSize(opts.feePayer, r.instructions);
    if (size > limit) throw new Error(`One transfer alone is ${size} bytes, over the ${limit}-byte limit.`);
    current = { instructions: [...r.instructions], index: [{ row: r.row, firstIx: 0, count: r.instructions.length }], size };
  }
  if (current) out.push(current);
  return out;
}

/**
 * The row an instruction index belongs to (the index counts the app's own
 * instructions, as SimulationRefusedError.instructionIndex does), or null.
 */
export function rowForInstruction(tx: Pick<PackedTransaction, "index">, instructionIndex: number | null): string | null {
  if (instructionIndex === null || instructionIndex < 0) return null;
  const entry = tx.index.find((e) => instructionIndex >= e.firstIx && instructionIndex < e.firstIx + e.count);
  return entry?.row ?? null;
}

export type DroppedRow = { row: string; reason: string };

export type DistributionPlan = {
  transactions: PackedTransaction[];
  dropped: DroppedRow[];
};

/**
 * Packs, test-runs every transaction (`simulate`: the gate's own
 * simulation, null when it would succeed), drops each row a refusal points
 * at with the refusal's plain words (its `reason`, else its detail), and repacks the rest — until every
 * transaction passes or `maxRounds` is spent. A refusal that is not one
 * instruction's (the fee payer cannot pay, the transaction is too large)
 * fails the whole plan: no row is to blame.
 */
export async function planWithSimulation(
  rows: readonly RowInstructions[],
  opts: {
    feePayer: Address;
    simulate: (
      instructions: readonly Instruction[],
    ) => Promise<(Pick<SimulationRefusedError, "instructionIndex" | "detail" | "message"> & { reason?: string }) | null>;
    limit?: number;
    maxRounds?: number;
  },
): Promise<DistributionPlan> {
  const maxRounds = opts.maxRounds ?? 6;
  const dropped: DroppedRow[] = [];
  let pending = [...rows];
  for (let round = 0; round < maxRounds; round++) {
    if (pending.length === 0) return { transactions: [], dropped };
    const transactions = packRows(pending, { feePayer: opts.feePayer, limit: opts.limit });
    const refused = new Map<string, string>();
    for (const tx of transactions) {
      const refusal = await opts.simulate(tx.instructions);
      if (!refusal) continue;
      const row = rowForInstruction(tx, refusal.instructionIndex);
      if (row === null) throw new Error(refusal.message);
      // The row's reason in plain words (the refusal's hint), not where it happened in the transaction.
      refused.set(row, refusal.reason ?? refusal.detail);
    }
    if (refused.size === 0) return { transactions, dropped };
    for (const [row, reason] of refused) dropped.push({ row, reason });
    pending = pending.filter((r) => !refused.has(r.row));
  }
  throw new Error("The network kept refusing transfers of this list; nothing was sent. Check the rows and try again.");
}

/** Transactions in groups signed with one wallet prompt each. */
export function promptGroups<T>(transactions: readonly T[], size = MAX_TRANSACTIONS_PER_PROMPT): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < transactions.length; i += size) groups.push(transactions.slice(i, i + size));
  return groups;
}

/**
 * SOL the sender needs for the sends: the rent of every new token account
 * plus each transaction's base fee and the most its priority fee can be
 * (limit × price, price in micro-lamports per compute unit).
 */
export function lamportsNeeded(input: {
  newAccounts: number;
  transactions: number;
  computeUnitLimit?: number;
  microLamportsPerUnit?: bigint;
}): bigint {
  const priority =
    input.computeUnitLimit !== undefined && input.microLamportsPerUnit !== undefined
      ? (BigInt(input.computeUnitLimit) * input.microLamportsPerUnit) / BigInt(1_000_000)
      : BigInt(0);
  return (
    TOKEN_ACCOUNT_RENT_LAMPORTS * BigInt(input.newAccounts) +
    (BASE_FEE_LAMPORTS + priority) * BigInt(input.transactions)
  );
}

/**
 * SOL the sender needs BEFORE the shortfall is created (checked first, so a
 * wallet that cannot pay for the transfers never mints tokens it then
 * cannot send): the transfers' rent and fees as lamportsNeeded counts them,
 * plus the mint transaction's fee and, when the treasury has no token
 * account yet, its rent (the mint creates it). `transactions` is the
 * packing estimate of the transfers.
 */
export function solBeforeMint(input: {
  newAccounts: number;
  transactions: number;
  treasuryAccountMissing: boolean;
  computeUnitLimit?: number;
  microLamportsPerUnit?: bigint;
}): bigint {
  return lamportsNeeded({
    newAccounts: input.newAccounts + (input.treasuryAccountMissing ? 1 : 0),
    transactions: input.transactions + 1,
    computeUnitLimit: input.computeUnitLimit,
    microLamportsPerUnit: input.microLamportsPerUnit,
  });
}

/** How the next group of transactions is signed. */
export type PromptMode = "auto" | "per-transaction";

/**
 * The mode for the groups after one was sent: once a group fell back to one
 * prompt per transaction (the wallet cannot sign several, or a batch
 * outlasted its blockhash), every later group goes one by one too — the
 * wallet is not asked for a batch it already could not sign.
 */
export function nextPromptMode(mode: PromptMode, result: { mode: "batch" | "per-transaction" }): PromptMode {
  return result.mode === "per-transaction" ? "per-transaction" : mode;
}
