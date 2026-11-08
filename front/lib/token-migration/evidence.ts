// Token migration (V1): what a finalized transaction proves. Pure and
// isomorphic (the server routes run it on getTransaction's json answer; the
// tests run it on synthetic transactions), in the style of
// lib/chain-evidence.ts: a claim that the chain does not show is never
// recorded, and "proof" is the token balances the network itself reports
// before and after the transaction (meta.preTokenBalances /
// meta.postTokenBalances), never an account key that merely appears.
//
// Four facts, one function each:
//   - a DEPOSIT: the campaign's deposit token account of the old mint grew,
//     the old tokens came from token accounts of ONE owner (the holder) by
//     exactly that amount, no other account of the old mint changed, and the
//     migration memo the holder signed (manci:migration:v1:<id>:<lots>);
//   - a DELIVERY: the treasury's token account of the share-class mint shrank
//     by exactly the units the listed deposits owe, and each holder's token
//     account (owned by that holder) grew by exactly its share; nothing else
//     of the share-class mint moved. Signers are not required: a treasury
//     held by a Squads vault executes through the multisig program (the vault
//     signs inside a CPI), and the balances prove the movement either way;
//   - a REFUND: the deposit account shrank by exactly one deposit's amount
//     and the depositing holder's accounts grew by exactly that, nothing else
//     moved (the deposit owner may be a Squads vault too);
//   - a BURN: the deposit account shrank, nothing else of the old mint moved,
//     and Burn / BurnChecked instructions of the old mint's token program on
//     the deposit account (top level or inside a multisig's CPI) account for
//     exactly that amount.
// A transaction that does more than its one job (moves the old mint
// somewhere else as well, pays several holders from several sources) is not
// proof of anything here: it is never recorded, and a transfer into the
// deposit account that cannot be attributed is returned by the deposit owner
// by hand (ops/runbook-mainnet.md §22).

import { getBase58Encoder } from "@solana/kit";
import { ChainEvidenceError, type ChainTransaction, type CompiledChainInstruction } from "@/lib/chain-evidence";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import { MIGRATION_MEMO_PREFIX, parseMigrationMemo, type IrregularReason, type ParsedMemo } from "@/lib/token-migration/model";

export { ChainEvidenceError };

/** The original SPL Memo program (v1); some wallets still write their memos with it. */
export const MEMO_V1_PROGRAM_ADDRESS = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

const ZERO = BigInt(0);

function requireProof(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ChainEvidenceError(message);
}

function index(value: number | bigint, length: number): number {
  const n = Number(value);
  requireProof(Number.isSafeInteger(n) && n >= 0 && n < length, "Invalid transaction account index");
  return n;
}

type Decoded = { program: string; accounts: string[]; data: Uint8Array };

/** The transaction's keys (loaded addresses included), its signers and an instruction decoder. */
function context(tx: ChainTransaction, signature: string) {
  requireProof(tx.meta && tx.meta.err === null, "Transaction did not complete successfully");
  requireProof(tx.transaction.signatures[0] === signature, "Transaction signature does not match");
  const meta = tx.meta;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const signerCount = Number(tx.transaction.message.header.numRequiredSignatures);
  requireProof(
    Number.isSafeInteger(signerCount) && signerCount > 0 && signerCount <= tx.transaction.message.accountKeys.length,
    "Invalid transaction signer metadata",
  );
  const base58 = getBase58Encoder();
  const decode = (ix: CompiledChainInstruction): Decoded => ({
    program: keys[index(ix.programIdIndex, keys.length)],
    accounts: ix.accounts.map((i) => keys[index(i, keys.length)]),
    data: new Uint8Array(base58.encode(ix.data)),
  });
  // Every instruction the transaction ran: top level, then each one's CPIs.
  const all = (): Decoded[] => [
    ...tx.transaction.message.instructions.map(decode),
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions.map(decode)),
  ];
  return { keys, signers: new Set(keys.slice(0, signerCount)), all };
}

export type BalanceChange = {
  account: string;
  /** The token account's owner as the node reports it (after the transaction, else before; null when it does not). */
  owner: string | null;
  /** The owner before and after, separately: a classic SPL account's owner can change inside the transaction. */
  preOwner: string | null;
  postOwner: string | null;
  pre: bigint;
  post: bigint;
};

function atomic(value: string): bigint {
  requireProof(/^\d+$/.test(value), "Invalid token balance amount");
  return BigInt(value);
}

/**
 * Every token account of `mint` the transaction touched, with its balance
 * before and after (an account created in the transaction starts at 0; one
 * closed in it ends at 0).
 */
export function mintBalanceChanges(tx: ChainTransaction, mint: string): BalanceChange[] {
  requireProof(tx.meta, "Transaction metadata is missing");
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const changes = new Map<string, BalanceChange>();
  const entry = (accountIndex: number | bigint) => {
    const account = keys[index(accountIndex, keys.length)];
    let change = changes.get(account);
    if (!change) {
      change = { account, owner: null, preOwner: null, postOwner: null, pre: ZERO, post: ZERO };
      changes.set(account, change);
    }
    return change;
  };
  for (const balance of tx.meta.preTokenBalances ?? []) {
    if (balance.mint !== mint) continue;
    const change = entry(balance.accountIndex);
    change.pre = atomic(balance.uiTokenAmount.amount);
    change.preOwner = balance.owner ?? null;
    change.owner = balance.owner ?? change.owner;
  }
  for (const balance of tx.meta.postTokenBalances ?? []) {
    if (balance.mint !== mint) continue;
    const change = entry(balance.accountIndex);
    change.post = atomic(balance.uiTokenAmount.amount);
    change.postOwner = balance.owner ?? null;
    change.owner = balance.owner ?? change.owner;
  }
  return [...changes.values()];
}

/** Refuses an account whose owner changed inside the transaction (attribution would follow the new owner). */
function sameOwner(ch: BalanceChange): void {
  requireProof(
    ch.preOwner === null || ch.postOwner === null || ch.preOwner === ch.postOwner,
    "A token account's owner changed inside this transaction, so it proves nothing here",
  );
}

function utf8(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

// ── Deposit ──────────────────────────────────────────────────────────────────

export type DepositExpectation = {
  /** The campaign's deposit token account (the deposit owner's ATA of the old mint). */
  depositAta: string;
  oldMint: string;
  /**
   * The wallet that claims the deposit (the holder's own record): it must be
   * the owner the tokens came from. Null for the operator's reconcile, which
   * attributes the deposit to that owner.
   */
  holder: string | null;
};

export type DepositFacts = {
  /** The owner of the token accounts the deposit came from. */
  holder: string;
  /** Base units the deposit account received. */
  amount: bigint;
  /** Whether that owner signed the transaction. */
  signedByHolder: boolean;
  /** The one migration memo of the transaction, or why there is none. */
  memo: { kind: "migration"; migrationId: string; lots: bigint } | { kind: "none" } | { kind: "ambiguous" };
  slot: bigint;
  /** Unix seconds; null when the node does not know it. */
  blockTime: number | null;
};

/**
 * The deposit a transaction proves, or THROWS ChainEvidenceError when it
 * proves none: it failed, it put nothing into the deposit account, the old
 * tokens came from several owners or moved elsewhere too, the amounts do not
 * balance (a fee on the way), or the claiming wallet is not the source.
 */
export function depositEvidence(tx: ChainTransaction, signature: string, expected: DepositExpectation): DepositFacts {
  const c = context(tx, signature);
  const changes = mintBalanceChanges(tx, expected.oldMint);
  const deposit = changes.find((ch) => ch.account === expected.depositAta);
  requireProof(deposit && deposit.post > deposit.pre, "This transaction put no tokens into the campaign's deposit account");
  sameOwner(deposit);
  const amount = deposit.post - deposit.pre;
  let sent = ZERO;
  const sources = new Set<string>();
  for (const ch of changes) {
    if (ch.account === expected.depositAta || ch.post === ch.pre) continue;
    requireProof(ch.post < ch.pre, "This transaction also moved the token into another account, so it is not a plain deposit (the deposit owner returns it by hand)");
    requireProof(ch.owner, "The network did not report who owns the source token account; try again later");
    sameOwner(ch);
    sources.add(ch.owner);
    sent += ch.pre - ch.post;
  }
  requireProof(sources.size === 1, sources.size === 0 ? "No source token account is shown for this deposit" : "The deposit came from several wallets, so it cannot be attributed (the deposit owner returns it by hand)");
  requireProof(sent === amount, "The amount sent and the amount received do not match (a fee on the way?)");
  const holder = [...sources][0];
  if (expected.holder !== null) {
    requireProof(holder === expected.holder, "This deposit did not come from your wallet");
  }

  const memos: ParsedMemo[] = [];
  for (const ix of c.all()) {
    if (ix.program !== MEMO_PROGRAM_ADDRESS && ix.program !== MEMO_V1_PROGRAM_ADDRESS) continue;
    const text = utf8(ix.data);
    if (text === null || !text.startsWith(MIGRATION_MEMO_PREFIX)) continue;
    memos.push(parseMigrationMemo(text));
  }
  let memo: DepositFacts["memo"] = { kind: "none" };
  if (memos.length === 1 && memos[0].kind === "migration") memo = memos[0];
  else if (memos.length > 0) memo = { kind: "ambiguous" };

  const blockTime = tx.blockTime === undefined || tx.blockTime === null ? null : Number(tx.blockTime);
  return {
    holder,
    amount,
    signedByHolder: c.signers.has(holder),
    memo,
    slot: BigInt(tx.slot),
    blockTime: blockTime !== null && Number.isSafeInteger(blockTime) ? blockTime : null,
  };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export type DeliveryExpectation = {
  /** The share-class mint (Token-2022). */
  newMint: string;
  /** The treasury wallet's token account of the share-class mint. */
  treasuryAta: string;
  /** Holder wallet → its token account of the share-class mint and the units the listed deposits owe it. */
  recipients: ReadonlyMap<string, { ata: string; units: bigint }>;
};

/** The delivery a transaction proves (its total), or THROWS ChainEvidenceError. */
export function deliveryEvidence(tx: ChainTransaction, signature: string, expected: DeliveryExpectation): { total: bigint; slot: bigint } {
  context(tx, signature);
  requireProof(expected.recipients.size > 0, "No deposits to deliver");
  const changes = new Map(mintBalanceChanges(tx, expected.newMint).map((ch) => [ch.account, ch]));
  let total = ZERO;
  const expectedAccounts = new Set<string>([expected.treasuryAta]);
  for (const [holder, { ata, units }] of expected.recipients) {
    requireProof(units > ZERO, "A delivery owes at least one unit per holder");
    expectedAccounts.add(ata);
    const ch = changes.get(ata);
    requireProof(ch && ch.post - ch.pre === units, `The holder ${holder} did not receive exactly ${units.toString()} units in this transaction`);
    requireProof(ch.owner === holder, `The receiving token account does not belong to ${holder}`);
    sameOwner(ch);
    total += units;
  }
  const treasury = changes.get(expected.treasuryAta);
  requireProof(treasury && treasury.pre - treasury.post === total, "The treasury's units did not decrease by exactly the units delivered");
  for (const ch of changes.values()) {
    if (expectedAccounts.has(ch.account)) continue;
    requireProof(ch.post === ch.pre, "This transaction also moved units of the class elsewhere, so it is not a plain delivery");
  }
  return { total, slot: BigInt(tx.slot) };
}

// ── Refund ───────────────────────────────────────────────────────────────────

export type RefundExpectation = {
  oldMint: string;
  depositAta: string;
  /** The wallet that made the deposit. */
  holder: string;
  /** The deposit's amount, base units. */
  amount: bigint;
};

/** The refund a transaction proves, or THROWS ChainEvidenceError. */
export function refundEvidence(tx: ChainTransaction, signature: string, expected: RefundExpectation): { slot: bigint } {
  context(tx, signature);
  requireProof(expected.amount > ZERO, "A refund returns at least one base unit");
  const changes = mintBalanceChanges(tx, expected.oldMint);
  const deposit = changes.find((ch) => ch.account === expected.depositAta);
  requireProof(deposit && deposit.pre - deposit.post === expected.amount, "The deposit account did not send back exactly this deposit's amount");
  let received = ZERO;
  for (const ch of changes) {
    if (ch.account === expected.depositAta || ch.post === ch.pre) continue;
    requireProof(ch.post > ch.pre && ch.owner === expected.holder, "The tokens did not go back to the wallet that deposited them");
    sameOwner(ch);
    received += ch.post - ch.pre;
  }
  requireProof(received === expected.amount, "The holder did not receive exactly this deposit's amount");
  return { slot: BigInt(tx.slot) };
}

// ── Burn ─────────────────────────────────────────────────────────────────────

export type BurnExpectation = {
  oldMint: string;
  /** The old mint's token program (classic SPL Token or Token-2022). */
  tokenProgram: string;
  depositAta: string;
};

/** The burn of collected old tokens a transaction proves (base units burned), or THROWS ChainEvidenceError. */
export function burnEvidence(tx: ChainTransaction, signature: string, expected: BurnExpectation): { burned: bigint; slot: bigint } {
  const c = context(tx, signature);
  const changes = mintBalanceChanges(tx, expected.oldMint);
  const deposit = changes.find((ch) => ch.account === expected.depositAta);
  requireProof(deposit && deposit.pre > deposit.post, "The deposit account's balance did not decrease");
  const decrease = deposit.pre - deposit.post;
  for (const ch of changes) {
    if (ch.account !== expected.depositAta) requireProof(ch.post === ch.pre, "This transaction also moved the token elsewhere: it is not a burn");
  }
  let burned = ZERO;
  for (const ix of c.all()) {
    if (ix.program !== expected.tokenProgram) continue;
    // Burn (8: amount u64) or BurnChecked (15: amount u64, decimals u8): [account, mint, authority, …].
    const burn = (ix.data[0] === 8 && ix.data.length === 9) || (ix.data[0] === 15 && ix.data.length === 10);
    if (!burn || ix.accounts[0] !== expected.depositAta || ix.accounts[1] !== expected.oldMint) continue;
    burned += new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true);
  }
  requireProof(burned > ZERO && burned === decrease, "No burn instruction on the deposit account accounts for the decrease");
  return { burned, slot: BigInt(tx.slot) };
}

// ── What a proven deposit earns ──────────────────────────────────────────────

export type DepositTerms = {
  migrationId: string;
  status: "open" | "closed" | "cancelled";
  lot: bigint;
  windowOpensAt: string;
  windowClosesAt: string;
  excludedWallets: readonly string[];
};

/** The reasons this classification decides (the cap and the sanctions screen are decided elsewhere). */
export type ClassifiedReason = Exclude<IrregularReason, "over_cap" | "compliance_hold">;

export type DepositVerdict =
  | { status: "accepted"; lots: bigint; reasonCode: null }
  | { status: "irregular"; lots: bigint; reasonCode: ClassifiedReason };

/**
 * Accepted (k lots earn k units) or irregular with the first reason that
 * applies, in the order a holder can act on: the campaign was not taking
 * deposits, the wallet is excluded, the block time is outside the window,
 * the source owner did not sign, the amount is not a whole number of lots,
 * and the memo does not name this campaign with exactly those lots. The
 * units cap ("over_cap") is decided by the database when the row is
 * inserted (record_token_migration_deposit, serialized per campaign), and a
 * sanctions hit ("compliance_hold") by the route, which screens the holder.
 */
export function classifyDeposit(facts: DepositFacts, terms: DepositTerms): DepositVerdict {
  const lots = facts.amount / terms.lot;
  const irregular = (reasonCode: ClassifiedReason): DepositVerdict => ({ status: "irregular", lots, reasonCode });
  if (terms.status === "cancelled") return irregular("not_open");
  if (terms.excludedWallets.includes(facts.holder)) return irregular("excluded_wallet");
  const at = facts.blockTime === null ? Number.NaN : facts.blockTime * 1000;
  if (!(at >= Date.parse(terms.windowOpensAt) && at < Date.parse(terms.windowClosesAt))) return irregular("outside_window");
  if (!facts.signedByHolder) return irregular("not_signed_by_holder");
  if (facts.amount < terms.lot || facts.amount % terms.lot !== ZERO) return irregular("not_lot_multiple");
  if (facts.memo.kind !== "migration" || facts.memo.migrationId !== terms.migrationId || facts.memo.lots !== lots) {
    return irregular("memo_mismatch");
  }
  return { status: "accepted", lots, reasonCode: null };
}
