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
// proves who wrote it. The transaction carries nothing else besides the usual
// compute budget the send path adds (lib/verified-solana-client).
//
// After confirmation the page posts the signature to
// /api/admin/document-anchor, which re-reads the transaction from the server
// RPC and checks it with documentAnchorEvidence below before it appends the
// audit row (category "operator", ix_name "document_anchor").
//
// Node-safe and pure: the builder, the parser and the verification are shared
// by the page, the route and tests/document-anchor.test.ts.
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
import type { ChainTransaction } from "@/lib/chain-evidence";

export { MEMO_PROGRAM_ADDRESS };

/** A reference label: a letter or digit first, then up to 63 of `A-Z a-z 0-9 . _ : / -`. No spaces. */
export const DOCUMENT_ANCHOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** The fingerprint as the memo carries it: exactly 64 lowercase hex characters. */
export const DOCUMENT_ANCHOR_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEMO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,63}) sha256:([0-9a-f]{64})$/;

/** The audit row of a recorded anchor (lib/server/audit.ts; "operator" is a server-only category). */
export const DOCUMENT_ANCHOR_AUDIT = { category: "operator", ixName: "document_anchor" } as const;
/** The signed actions of the two routes (lib/siws-session.ts lists both as session actions). */
export const DOCUMENT_ANCHOR_RECORD_ACTION = "admin.documentAnchorRecord";
export const DOCUMENT_ANCHOR_LIST_ACTION = "admin.documentAnchorList";
/** How many recorded anchors the list returns (newest first). */
export const DOCUMENT_ANCHOR_LIST_LIMIT = 25;
/**
 * The start of the route's 503 while the server RPC does not show the
 * transaction as confirmed yet: the page waits a moment and posts again.
 */
export const DOCUMENT_ANCHOR_NOT_YET = "The network does not show this transaction as confirmed yet";

/**
 * Lighthouse, the assertion program Phantom adds to the transactions it
 * signs on mainnet (its transaction guard: an assertion reads accounts and
 * fails the transaction when they changed; it moves nothing). The Super
 * Admin's earlier mainnet transactions from this site carry one before and
 * one after the app's instruction, so the verification tolerates it next to
 * the memo and the compute budget, and counts it, but only an assertion
 * (first data byte in LIGHTHOUSE_ASSERTION_KINDS: never 0 MemoryWrite or
 * 1 MemoryClose, never an unknown one) with no inner calls. The same rule as
 * the Send to wallets check of wallet changes. Any other program is refused.
 */
export const LIGHTHOUSE_PROGRAM_ADDRESS = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** Lighthouse instructions that only assert (lighthouse-sdk 2.1.0: 2 AssertAccountData … 17 AssertBubblegumTreeConfigAccount). */
export const LIGHTHOUSE_ASSERTION_KINDS: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

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
  if (!DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(raw)) {
    return "The reference may only contain letters, digits and . _ : / -";
  }
  return null;
}

/**
 * A pasted SHA-256 as the memo carries it (lowercase), or null. Accepts
 * either case, surrounding spaces and an optional "sha256:" prefix; nothing
 * else (no spaces inside, no 0x, not 63 or 65 characters).
 */
export function normalizeSha256Input(raw: string): string | null {
  const trimmed = raw.trim().replace(/^sha256:/i, "");
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null;
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

/**
 * The anchor a memo carries, or null when the bytes (or text) are not
 * exactly "<reference> sha256:<64 lowercase hex>" in valid UTF-8.
 */
export function parseDocumentAnchorMemo(data: ReadonlyUint8Array | Uint8Array | string): DocumentAnchor | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data as Uint8Array);
    } catch {
      return null;
    }
  }
  const match = MEMO_PATTERN.exec(text);
  return match ? { reference: match[1], sha256: match[2] } : null;
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
 * expected memo text; besides it only compute-budget instructions and the
 * wallet's own Lighthouse assertions are allowed. Throws
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

  const bytesOf = (data: string, what: string): ReadonlyUint8Array => {
    try {
      return getBase58Encoder().encode(data);
    } catch {
      throw new DocumentAnchorEvidenceError(`The ${what} data cannot be read`);
    }
  };
  const innerGroups = tx.meta.innerInstructions ?? [];
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
      walletGuardInstructions += 1;
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
  /** The commitment the server read it at ("finalized" or "confirmed"). */
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
