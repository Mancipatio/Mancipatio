// Anchor a document fingerprint on chain (MAINNET-PLAN step 3).
//
// The Super Admin writes the SHA-256 of an off-chain document (first use: the
// certificate PDF for the state authorities, reference MANCI-2026-0001) into
// one Memo v2 transaction, so anyone can later check the hash and the time on
// an explorer. The memo is the UTF-8 text
//
//   "<reference> sha256:<64 lowercase hex>"
//
// (one space, nothing before or after), and it must be byte for byte the text
// the owner signed on the certificate. The only account of the memo
// instruction is the Super Admin's wallet as a SIGNER: the Memo program fails
// the instruction when a listed account did not sign, so the memo itself
// proves who wrote it. The page adds nothing else besides the usual compute
// budget the send path adds (lib/verified-solana-client). The wallet may add
// Lighthouse assertions of its own (Phantom does on mainnet); the
// verification tolerates those, and only those, within the bounds set out at
// LIGHTHOUSE_ASSERTION_KINDS below.
//
// After confirmation the page posts the signature to
// /api/admin/document-anchor, which re-reads the transaction from the server
// RPC once it is finalized and checks it with documentAnchorEvidence below
// before it appends the audit row (category "operator", ix_name
// "document_anchor").
//
// Node-safe and pure: the builder and the verification are shared by the
// page, the route and tests/document-anchor.test.ts.
import {
  AccountRole,
  address,
  getBase58Encoder,
  type AccountSignerMeta,
  type Instruction,
  type InstructionWithSigners,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@/lib/compute-budget";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import { LIGHTHOUSE_PROGRAM_ADDRESS } from "@/lib/wallet-changes";
import type { ChainTransaction } from "@/lib/chain-evidence";

export { MEMO_PROGRAM_ADDRESS };

/**
 * A reference label: a letter or digit first, then up to 63 of
 * `A-Z a-z 0-9 . _ : / -`. No spaces, and no "sha256:" in any letter case
 * anywhere in it: the memo puts "sha256:" before the hash, and a reader of
 * the memo must find it exactly once ("sha256:abc… sha256:<hash>" could be
 * read as either hash).
 */
export const DOCUMENT_ANCHOR_REFERENCE_PATTERN = /^(?![\s\S]*[Ss][Hh][Aa]256:)[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** The fingerprint as the memo carries it: exactly 64 lowercase hex characters. */
export const DOCUMENT_ANCHOR_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The audit row of a recorded anchor (lib/document-anchor-audit.ts; "operator" is a server-only category). */
export { DOCUMENT_ANCHOR_AUDIT } from "@/lib/document-anchor-audit";
/** The signed actions of the two routes (lib/siws-session.ts lists both as session actions). */
export const DOCUMENT_ANCHOR_RECORD_ACTION = "admin.documentAnchorRecord";
export const DOCUMENT_ANCHOR_LIST_ACTION = "admin.documentAnchorList";
/** How many recorded anchors the list returns (newest first). */
export const DOCUMENT_ANCHOR_LIST_LIMIT = 25;
/**
 * The start of the route's 503 while the server RPC does not show the
 * transaction as finalized yet: the page waits a moment and posts again.
 * Only a finalized transaction is recorded (a confirmed block could still be
 * dropped on a minority fork; finalization takes about 13 seconds more).
 */
export const DOCUMENT_ANCHOR_NOT_YET = "The network does not show this transaction as finalized yet";

/**
 * The Lighthouse instructions an anchor tolerates next to its memo, by their
 * first data byte: those that only assert (lighthouse-sdk 2.1.0: 2
 * AssertAccountData … 17 AssertBubblegumTreeConfigAccount).
 *
 * Lighthouse (LIGHTHOUSE_PROGRAM_ADDRESS, lib/wallet-changes) is the
 * assertion program Phantom adds to the transactions it signs on mainnet (its
 * transaction guard: an assertion reads accounts and fails the transaction
 * when they changed; it moves nothing). The page never adds one; the Super
 * Admin's earlier mainnet transactions from this site carry one before and
 * one after the app's instruction (for example 5RBDZ…: kind 6
 * AssertAccountInfoMulti on a writable account and on the fee payer, no inner
 * calls). A strict "memo and compute budget only" rule would refuse to record
 * a real anchor, so this is a deliberate exception: the verification
 * tolerates and counts a Lighthouse instruction next to the memo and the
 * compute budget when
 *   - its first data byte is in LIGHTHOUSE_ASSERTION_KINDS (never 0
 *     MemoryWrite or 1 MemoryClose, never an unknown one),
 *   - every account it names is the fee payer or a read-only, non-signer
 *     account of the transaction (the roles come from the message header,
 *     which the node must return; an assertion only reads, and Lighthouse
 *     declares its targets read-only, so in an anchor only the fee payer,
 *     writable because it pays the fee, can show up as writable),
 *   - it made no inner calls (the node must return innerInstructions, so the
 *     check cannot be skipped), and
 *   - the transaction holds at most DOCUMENT_ANCHOR_MAX_WALLET_GUARDS of them.
 * Any other program is refused. Compute Budget instructions pass with any
 * data and in any number: they name no account and move nothing, and the
 * runtime itself refuses a transaction that repeats one kind. The safety
 * does not rest on the kind list alone: the Super Admin is the only signer,
 * so no other account can be debited, and an instruction without inner calls
 * cannot move lamports from the System-owned wallet. The memo's evidential
 * value does not depend on the guards at all.
 *
 * Send to wallets accepts the same wallet guards under its own rules
 * (lib/wallet-changes judgeWalletRewrite), and the two differ on purpose
 * because they check at different moments. Send to wallets compares the
 * message the wallet signed with the one built BEFORE it journals and
 * broadcasts anything: there is no execution yet, so it must tell from the
 * bytes alone that a guard calls no other program (it leaves out kinds 16
 * and 17 and the log levels that log through the Noop program) and that it
 * fits (its position and accounts, and the compute limit and packet room
 * left for the guards). The anchor is a single send, which that comparison
 * does not cover, and this verification reads the FINALIZED transaction
 * after the fact, so it checks what actually ran instead: any inner call
 * from any guard refuses the anchor, whatever its kind or log level (an
 * assertion that calls another program, or a log through Noop, shows as
 * one), and the number of guards is a fixed cap, since an anchor needs no
 * more than Phantom's two. Only the program address is shared, so both
 * paths agree on which program is Lighthouse.
 *
 * Lighthouse is not a dependency of this app: the kind numbers are taken from
 * lighthouse-sdk 2.1.0. On mainnet the program is immutable (its program data
 * CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c has no upgrade authority, read
 * 2026-10-05), so the numbering cannot change there.
 */
export const LIGHTHOUSE_ASSERTION_KINDS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
/**
 * The most Lighthouse assertions an anchor may carry. Phantom adds two to the
 * Super Admin's mainnet transactions (one on a writable account, one on the
 * fee payer); an anchor has a single writable account, so four leaves room
 * without accepting an unbounded number of foreign instructions.
 */
export const DOCUMENT_ANCHOR_MAX_WALLET_GUARDS = 4;

/**
 * The largest file the panel hashes in the browser. The file is read into
 * memory whole (lib/storage-client sha256HexOfFile); a larger one is hashed
 * with `shasum -a 256` and its hash pasted.
 */
export const DOCUMENT_ANCHOR_MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Signatures of an anchor transaction: the Super Admin's, nothing else. */
export const DOCUMENT_ANCHOR_SIGNATURES = 1;
/** The network's base fee per signature, in lamports. */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = BigInt(5_000);
/**
 * The compute-unit limit the send path sets on an anchor: the simulation
 * gate's floor (lib/simulation-gate computeUnitLimitFromSimulation), since a
 * memo uses far less. The priority fee is this limit × the price.
 */
export const DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT = 200_000;

export type DocumentAnchor = { reference: string; sha256: string };

export class DocumentAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentAnchorError";
  }
}

/** Why `raw` is not a reference label, or null when it is one (exactly as typed: no trimming). */
export function documentAnchorReferenceError(raw: string): string | null {
  if (raw.length === 0) return "Enter a reference, for example MANCI-2026-0001.";
  if (raw.length > 64) return "The reference is at most 64 characters.";
  if (/\s/.test(raw)) return "The reference cannot contain spaces.";
  if (!/^[A-Za-z0-9]/.test(raw)) return "The reference starts with a letter or a digit.";
  if (/sha256:/i.test(raw)) return 'The reference cannot contain "sha256:": the memo adds it once, before the hash.';
  if (!DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(raw)) {
    return "The reference may only contain letters, digits and . _ : / -";
  }
  return null;
}

/**
 * A pasted SHA-256 as the memo carries it (lowercase), or null. Accepts
 * either case, surrounding spaces, an optional "sha256:" prefix, and a whole
 * `shasum -a 256` / `sha256sum` line ("<hash>  <file>", "<hash> *<file>"):
 * the hash is the first word when whitespace follows it. One hash only: the
 * output for several files (`shasum -a 256 a.pdf b.pdf`) is refused rather
 * than read as its first hash, whether its lines arrive as lines or, pasted
 * into a one-line field, joined (browsers drop or replace the line breaks):
 * a second run of 64 hex characters, or a line break, refuses it. Nothing
 * else (no spaces inside the hash, no 0x, not 63 or 65 characters).
 */
export function normalizeSha256Input(raw: string): string | null {
  const trimmed = raw.trim();
  if (holdsSeveralHashes(trimmed)) return null;
  const bare = trimmed.replace(/^sha256:/i, "");
  const line = /^([0-9a-fA-F]{64})\s+\S/.exec(bare);
  const hash = line ? line[1] : bare;
  return /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
}

function holdsSeveralHashes(trimmed: string): boolean {
  return /[\r\n]/.test(trimmed) || (trimmed.match(/[0-9a-fA-F]{64}/g) ?? []).length > 1;
}

/** Why a pasted hash is refused (null when it is empty or a valid one), for the panel. */
export function documentAnchorHashInputError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || normalizeSha256Input(raw) !== null) return null;
  if (holdsSeveralHashes(trimmed)) {
    return "Paste one hash: this holds more than one (the output for several files?). Paste only the hash of the document you anchor.";
  }
  return "Paste the 64-character SHA-256 in hex, or choose the file above.";
}

/** The exact memo text. Throws DocumentAnchorError unless both parts are already canonical. */
export function documentAnchorMemoText(anchor: DocumentAnchor): string {
  if (typeof anchor.reference !== "string" || !DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(anchor.reference)) {
    throw new DocumentAnchorError("Invalid document reference");
  }
  if (typeof anchor.sha256 !== "string" || !DOCUMENT_ANCHOR_SHA256_PATTERN.test(anchor.sha256)) {
    throw new DocumentAnchorError("The SHA-256 must be 64 lowercase hex characters");
  }
  return `${anchor.reference} sha256:${anchor.sha256}`;
}

/** The memo text as the bytes the instruction carries. */
export function documentAnchorMemoBytes(anchor: DocumentAnchor): Uint8Array {
  return new TextEncoder().encode(documentAnchorMemoText(anchor));
}

/**
 * The one Memo v2 instruction of an anchor: `signer` (the connected Super
 * Admin wallet, the same signer object the send passes as fee payer) is its
 * only account, as a signer, so the Memo program verifies the signature.
 */
export function documentAnchorInstruction(
  input: DocumentAnchor & { signer: TransactionSigner },
): Instruction & InstructionWithSigners {
  const data = documentAnchorMemoBytes(input);
  const account: AccountSignerMeta = { address: input.signer.address, role: AccountRole.READONLY_SIGNER, signer: input.signer };
  return { programAddress: address(MEMO_PROGRAM_ADDRESS), accounts: [account], data };
}

/** The fee the Super Admin pays: one base fee plus the priority fee at `microLamportsPerUnit`. */
export function documentAnchorFee(microLamportsPerUnit: bigint): { base: bigint; priority: bigint; total: bigint } {
  const base = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(DOCUMENT_ANCHOR_SIGNATURES);
  const priority = (BigInt(DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT) * microLamportsPerUnit) / BigInt(1_000_000);
  return { base, priority, total: base + priority };
}

/** Who may see the panel: the connected wallet is the on-chain Super Admin (Platform.admin). */
export function documentAnchorPanelVisible(wallet: string | null | undefined, superAdmin: string | null | undefined): boolean {
  return !!wallet && !!superAdmin && wallet === superAdmin;
}

// ── Verification (the route, after the send) ────────────────────────────────

export class DocumentAnchorEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentAnchorEvidenceError";
  }
}

function prove(ok: unknown, message: string): asserts ok {
  if (!ok) throw new DocumentAnchorEvidenceError(message);
}

export type DocumentAnchorExpectation = DocumentAnchor & {
  /** The transaction id (its first signature). */
  signature: string;
  /** The Super Admin wallet: the session's wallet, checked against Platform.admin by the route. */
  wallet: string;
};

export type DocumentAnchorEvidence = DocumentAnchor & {
  memo: string;
  signature: string;
  signer: string;
  slot: number;
  /** Unix seconds; null when the node does not know it. */
  blockTime: number | null;
  /** Wallet-added Lighthouse assertions next to the memo. */
  walletGuardInstructions: number;
};

function safeNumber(value: number | bigint, message: string): number {
  const n = Number(value);
  prove(Number.isSafeInteger(n) && n >= 0, message);
  return n;
}

/**
 * Checks a json-encoded transaction (getTransaction) against the anchor the
 * page says it sent. It must have succeeded, carry `signature` as its id, be
 * signed by `wallet` alone (the fee payer), and hold exactly one Memo v2
 * instruction whose only account is `wallet` and whose data is exactly the
 * expected memo text; besides it only compute-budget instructions and at
 * most DOCUMENT_ANCHOR_MAX_WALLET_GUARDS of the wallet's own Lighthouse
 * assertions (read-only accounts besides the fee payer, no inner calls) are
 * allowed. The node must return the account roles and the inner
 * instructions (json getTransaction returns both; the inner list may be
 * empty), or the guard checks could not be made. Throws
 * DocumentAnchorEvidenceError naming the first thing that does not match.
 */
export function documentAnchorEvidence(tx: ChainTransaction, expected: DocumentAnchorExpectation): DocumentAnchorEvidence {
  const expectedBytes = documentAnchorMemoBytes(expected);
  prove(tx.meta && tx.meta.err === null, "The transaction did not complete successfully");
  const message = tx.transaction.message;
  prove(tx.transaction.signatures[0] === expected.signature, "The transaction signature does not match");
  const signerCount = Number(message.header.numRequiredSignatures);
  prove(
    signerCount === DOCUMENT_ANCHOR_SIGNATURES && tx.transaction.signatures.length === DOCUMENT_ANCHOR_SIGNATURES,
    "An anchor is signed by the Super Admin wallet alone",
  );
  prove(message.accountKeys[0] === expected.wallet, "The fee payer is not the Super Admin wallet");
  const keys = [
    ...message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const keyAt = (i: number | bigint) => {
    const n = Number(i);
    prove(Number.isSafeInteger(n) && n >= 0 && n < keys.length, "Invalid transaction account index");
    return keys[n];
  };

  // The account roles: the static keys are the writable signers, the
  // read-only signers, the writable non-signers and the read-only
  // non-signers, in that order; then the loaded writable, then the loaded
  // read-only keys. The fee payer (index 0) must be writable.
  const staticCount = message.accountKeys.length;
  const readonlySigned = Number(message.header.numReadonlySignedAccounts);
  const readonlyUnsigned = Number(message.header.numReadonlyUnsignedAccounts);
  prove(
    Number.isSafeInteger(readonlySigned) && readonlySigned >= 0 && readonlySigned < signerCount &&
      Number.isSafeInteger(readonlyUnsigned) && readonlyUnsigned >= 0 && readonlyUnsigned <= staticCount - signerCount,
    "The node did not return the transaction's account roles",
  );
  const loadedWritable = tx.meta.loadedAddresses?.writable?.length ?? 0;
  const isWritable = (n: number) =>
    n < staticCount
      ? n < signerCount - readonlySigned || (n >= signerCount && n < staticCount - readonlyUnsigned)
      : n < staticCount + loadedWritable;
  /** The fee payer, or an account the transaction neither writes nor has sign. */
  const readOnlyOrFeePayer = (i: number | bigint) => {
    keyAt(i);
    const n = Number(i);
    return n === 0 || (n >= signerCount && !isWritable(n));
  };

  const bytesOf = (data: string, what: string): ReadonlyUint8Array => {
    try {
      return getBase58Encoder().encode(data);
    } catch {
      throw new DocumentAnchorEvidenceError(`The ${what} data cannot be read`);
    }
  };
  const innerGroups = tx.meta.innerInstructions;
  prove(Array.isArray(innerGroups), "The node did not return the transaction's inner instructions");
  const madeInnerCalls = (index: number) =>
    innerGroups.some((group) => Number(group.index) === index && group.instructions.length > 0);

  let memoIndex = -1;
  let walletGuardInstructions = 0;
  message.instructions.forEach((ix, i) => {
    const program = keyAt(ix.programIdIndex);
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) return;
    if (program === LIGHTHOUSE_PROGRAM_ADDRESS) {
      const kind = bytesOf(ix.data, "guard instruction")[0];
      prove(
        kind !== undefined && LIGHTHOUSE_ASSERTION_KINDS.has(kind) && !madeInnerCalls(i),
        "The transaction carries a Lighthouse instruction that is not an assertion",
      );
      prove(
        ix.accounts.every(readOnlyOrFeePayer),
        "A Lighthouse instruction names a writable or signing account other than the fee payer",
      );
      walletGuardInstructions += 1;
      prove(
        walletGuardInstructions <= DOCUMENT_ANCHOR_MAX_WALLET_GUARDS,
        `The transaction carries more than ${DOCUMENT_ANCHOR_MAX_WALLET_GUARDS} Lighthouse instructions`,
      );
      return;
    }
    prove(program === MEMO_PROGRAM_ADDRESS, `The transaction carries an instruction the anchor does not have (program ${program})`);
    prove(memoIndex === -1, "The transaction carries more than one memo");
    memoIndex = i;
  });
  prove(memoIndex !== -1, "The transaction carries no memo");

  const memoIx = message.instructions[memoIndex];
  const accounts = memoIx.accounts.map(keyAt);
  prove(
    accounts.length === 1 && accounts[0] === expected.wallet,
    "The memo is not signed by the Super Admin wallet (it must be its only account)",
  );
  const data = bytesOf(memoIx.data, "memo");
  const sameText = data.length === expectedBytes.length && expectedBytes.every((b, i) => data[i] === b);
  prove(sameText, "The memo text is not the expected anchor text");
  prove(!madeInnerCalls(memoIndex), "The memo instruction made inner calls");

  const slot = safeNumber(tx.slot, "Invalid transaction slot");
  const blockTime = tx.blockTime === undefined || tx.blockTime === null ? null : safeNumber(tx.blockTime, "Invalid block time");
  return {
    reference: expected.reference,
    sha256: expected.sha256,
    memo: documentAnchorMemoText(expected),
    signature: expected.signature,
    signer: expected.wallet,
    slot,
    blockTime,
    walletGuardInstructions,
  };
}

// ── The recorded anchors (route ⇄ page) ─────────────────────────────────────

export type DocumentAnchorRecord = DocumentAnchor & {
  /** The audit row. */
  id: string;
  signature: string;
  signer: string;
  slot: number | null;
  blockTime: number | null;
  /** The commitment the server read it at (the route records "finalized" only). */
  commitment: string | null;
  recordedAt: string;
};

/** The view of one audit row (null when it is not a complete anchor row). */
export function documentAnchorRecordFromRow(row: {
  id?: unknown;
  created_at?: unknown;
  actor_wallet?: unknown;
  tx_signature?: unknown;
  metadata?: unknown;
}): DocumentAnchorRecord | null {
  const m = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  const reference = typeof m.reference === "string" ? m.reference : null;
  const sha256 = typeof m.sha256 === "string" ? m.sha256 : null;
  if (
    typeof row.id !== "string" || typeof row.tx_signature !== "string" || typeof row.actor_wallet !== "string" ||
    !reference || !sha256 || !DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(reference) || !DOCUMENT_ANCHOR_SHA256_PATTERN.test(sha256)
  ) {
    return null;
  }
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  return {
    id: row.id,
    reference,
    sha256,
    signature: row.tx_signature,
    signer: row.actor_wallet,
    slot: int(m.slot),
    blockTime: int(m.block_time),
    commitment: typeof m.commitment === "string" ? m.commitment : null,
    recordedAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}
