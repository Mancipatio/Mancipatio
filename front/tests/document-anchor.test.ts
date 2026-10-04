// The document anchor (lib/document-anchor.ts): the memo text and its Memo v2
// instruction (the Super Admin as its only, signer account), the reference
// and hash rules, the fee shown before signing, and the verification the
// record route runs on the transaction it reads back — the builder's own
// compiled transaction and the shape Phantom signs on mainnet pass it; a
// wrong signer, a wrong text, an extra instruction, a missing inner
// instruction list, too many guards or a failed transaction do not.
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT,
  DOCUMENT_ANCHOR_MAX_WALLET_GUARDS,
  DOCUMENT_ANCHOR_REFERENCE_PATTERN,
  DocumentAnchorError,
  DocumentAnchorEvidenceError,
  MEMO_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  documentAnchorEvidence,
  documentAnchorFee,
  documentAnchorInstruction,
  documentAnchorMemoText,
  documentAnchorPanelVisible,
  documentAnchorRecordFromRow,
  documentAnchorReferenceError,
  normalizeSha256Input,
} from "@/lib/document-anchor";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "@/lib/compute-budget";
import { computeUnitLimitFromSimulation } from "@/lib/simulation-gate";
import type { ChainTransaction } from "@/lib/chain-evidence";
import { buildTx, type Ix } from "./helpers/chain-tx";

// The first use: the certificate PDF for the state authorities.
const REFERENCE = "MANCI-2026-0001";
const SHA = "a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7";
const MEMO = `${REFERENCE} sha256:${SHA}`;
const SA = "8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9";
const OTHER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const SYSTEM = "11111111111111111111111111111111";
const LEGACY_MEMO = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("memo text and instruction", () => {
  it("is exactly '<reference> sha256:<64 lowercase hex>' — the text signed on the certificate", () => {
    expect(documentAnchorMemoText({ reference: REFERENCE, sha256: SHA })).toBe(
      "MANCI-2026-0001 sha256:a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7",
    );
  });

  it("has the Memo v2 program, the signer as its only account (a signer), and the UTF-8 text as data", () => {
    const signer = createNoopSigner(SA as Address);
    const ix = documentAnchorInstruction({ reference: REFERENCE, sha256: SHA, signer });
    expect(ix.programAddress).toBe(MEMO_PROGRAM_ADDRESS);
    expect(MEMO_PROGRAM_ADDRESS).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    expect(ix.accounts).toHaveLength(1);
    expect(ix.accounts![0].address).toBe(SA);
    expect(ix.accounts![0].role).toBe(AccountRole.READONLY_SIGNER);
    expect((ix.accounts![0] as { signer?: unknown }).signer).toBe(signer);
    expect(new TextDecoder().decode(ix.data)).toBe(MEMO);
  });

  it("refuses a hash that is not already 64 lowercase hex, and an invalid reference", () => {
    const bad = [
      { reference: REFERENCE, sha256: SHA.toUpperCase() },
      { reference: REFERENCE, sha256: SHA.slice(0, 63) },
      { reference: REFERENCE, sha256: `${SHA}0` },
      { reference: REFERENCE, sha256: `${SHA.slice(0, 63)}g` },
      { reference: REFERENCE, sha256: `0x${SHA.slice(2)}` },
      { reference: `${REFERENCE} `, sha256: SHA },
      { reference: "", sha256: SHA },
    ];
    for (const anchor of bad) {
      expect(() => documentAnchorMemoText(anchor)).toThrow(DocumentAnchorError);
      expect(() => documentAnchorInstruction({ ...anchor, signer: createNoopSigner(SA as Address) })).toThrow(DocumentAnchorError);
    }
  });

  it("compiles into a one-signer transaction: the memo account is the fee payer, nothing else is added", () => {
    const signer = createNoopSigner(SA as Address);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: BigInt(1) }, m),
      (m) => appendTransactionMessageInstructions(
        [setComputeUnitLimitInstruction(200_000), setComputeUnitPriceInstruction(BigInt(100_000)), documentAnchorInstruction({ reference: REFERENCE, sha256: SHA, signer })],
        m,
      ),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(compileTransaction(message).messageBytes);
    expect(compiled.header.numSignerAccounts).toBe(1);
    expect(compiled.staticAccounts[0]).toBe(SA);
    // The bytes the wallet signs, as getTransaction (json) returns them: the verification accepts them.
    const tx: ChainTransaction = {
      slot: 321,
      blockTime: 1_791_000_000,
      transaction: {
        signatures: [SIG],
        message: {
          header: { numRequiredSignatures: compiled.header.numSignerAccounts },
          accountKeys: compiled.staticAccounts,
          instructions: compiled.instructions.map((ix) => ({
            programIdIndex: ix.programAddressIndex,
            accounts: ix.accountIndices ?? [],
            data: getBase58Decoder().decode(ix.data ?? new Uint8Array()),
          })),
        },
      },
      meta: { err: null, innerInstructions: [] },
    };
    const evidence = documentAnchorEvidence(tx, { signature: SIG, wallet: SA, reference: REFERENCE, sha256: SHA });
    expect(evidence).toMatchObject({ reference: REFERENCE, sha256: SHA, memo: MEMO, signer: SA, slot: 321, blockTime: 1_791_000_000, walletGuardInstructions: 0 });
  });
});

describe("reference labels", () => {
  it("accepts a letter or digit first, then up to 63 of A-Z a-z 0-9 . _ : / -", () => {
    for (const ok of ["MANCI-2026-0001", "a", "7", "A.b_c:d/e-f", "x".repeat(64), "doc/2026:v1.2_final-A"]) {
      expect(DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(ok)).toBe(true);
      expect(documentAnchorReferenceError(ok)).toBeNull();
    }
  });

  it("refuses everything else, saying why", () => {
    expect(documentAnchorReferenceError("")).toMatch(/Enter a reference/);
    expect(documentAnchorReferenceError("x".repeat(65))).toMatch(/at most 64/);
    expect(documentAnchorReferenceError("MANCI 2026")).toMatch(/spaces/);
    expect(documentAnchorReferenceError("MANCI\n")).toMatch(/spaces/);
    expect(documentAnchorReferenceError("-MANCI")).toMatch(/starts with a letter or a digit/);
    expect(documentAnchorReferenceError(".MANCI")).toMatch(/starts with a letter or a digit/);
    expect(documentAnchorReferenceError("MANCI#1")).toMatch(/only contain/);
    expect(documentAnchorReferenceError("MANČI")).toMatch(/only contain/);
    for (const bad of ["", "x".repeat(65), "MANCI 2026", "-MANCI", "MANCI#1", "MANČI", "MANCI\n"]) {
      expect(DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("pasted hashes", () => {
  it("lowercases either case and drops surrounding spaces and a sha256: prefix", () => {
    expect(normalizeSha256Input(SHA)).toBe(SHA);
    expect(normalizeSha256Input(SHA.toUpperCase())).toBe(SHA);
    expect(normalizeSha256Input(`  ${SHA}\n`)).toBe(SHA);
    expect(normalizeSha256Input(`sha256:${SHA}`)).toBe(SHA);
    expect(normalizeSha256Input(`SHA256:${SHA.toUpperCase()}`)).toBe(SHA);
  });

  it("takes the hash from a whole shasum -a 256 / sha256sum line", () => {
    expect(normalizeSha256Input(`${SHA}  MANCI-2026-0001.pdf`)).toBe(SHA);
    expect(normalizeSha256Input(`${SHA.toUpperCase()} *certificate final.pdf\n`)).toBe(SHA);
    expect(normalizeSha256Input(`${SHA}\tfile.pdf`)).toBe(SHA);
  });

  it("refuses the wrong length, non-hex, 0x and inner spaces", () => {
    for (const bad of [
      "",
      SHA.slice(0, 63),
      `${SHA}a`,
      `0x${SHA}`,
      `${SHA.slice(0, 32)} ${SHA.slice(32)}`,
      `${SHA.slice(0, 63)}z`,
      `${SHA.slice(0, 63)}  file.pdf`,
      `${SHA}a  file.pdf`,
      `file.pdf  ${SHA}`,
    ]) {
      expect(normalizeSha256Input(bad)).toBeNull();
    }
  });
});

describe("fee and visibility", () => {
  it("is one base fee plus the priority fee on the send path's compute-unit floor", () => {
    expect(DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT).toBe(computeUnitLimitFromSimulation(5_000));
    expect(documentAnchorFee(BigInt(100_000))).toEqual({ base: BigInt(5_000), priority: BigInt(20_000), total: BigInt(25_000) });
    expect(documentAnchorFee(BigInt(0)).total).toBe(BASE_FEE_LAMPORTS_PER_SIGNATURE);
  });

  it("shows the panel only to the on-chain Super Admin", () => {
    expect(documentAnchorPanelVisible(SA, SA)).toBe(true);
    expect(documentAnchorPanelVisible(OTHER, SA)).toBe(false);
    expect(documentAnchorPanelVisible(null, SA)).toBe(false);
    expect(documentAnchorPanelVisible(SA, null)).toBe(false);
    expect(documentAnchorPanelVisible("", "")).toBe(false);
  });
});

// ── The route's verification ────────────────────────────────────────────────

const cb = (byte: number): Ix => ({ program: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array([byte, 0, 0, 0, 0]) });
const memoIx = (text = MEMO, accounts = [SA], program = MEMO_PROGRAM_ADDRESS): Ix => ({ program, accounts, data: utf8(text) });
// Phantom's guard on the fee payer as signed on mainnet (5RBDZ…, the last
// instruction): kind 6 AssertAccountInfoMulti, 26 bytes. Another first byte
// swaps the kind (0 MemoryWrite and 1 MemoryClose write; 18+ are unknown).
const PHANTOM_FEE_PAYER_GUARD = [6, 4, 3, 0, 96, 146, 99, 59, 0, 0, 0, 0, 4, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const guard = (kind = 6): Ix => ({ program: LIGHTHOUSE, accounts: [SA], data: new Uint8Array([kind, ...PHANTOM_FEE_PAYER_GUARD.slice(1)]) });

// Mainnet 5RBDZ… as getTransaction (json) returns it (public RPC, read
// 2026-10-05), with the app's asset_registry instruction swapped for the
// anchor memo: ComputeBudget limit and price, Lighthouse kind 6 (37 bytes) on
// a writable account, the instruction, Lighthouse kind 6 (26 bytes) on the
// fee payer; one signer; no inner calls (an empty array).
const WRITABLE = "FJaWxqhSxjYsH8yMqc76H769vL8kapaFvEWB37yxom4Z";
function phantomShape(memoText = MEMO): ChainTransaction {
  return {
    slot: 453_356_383,
    blockTime: 1_791_143_700,
    transaction: {
      signatures: [SIG],
      message: {
        header: { numRequiredSignatures: 1 },
        accountKeys: [SA, WRITABLE, COMPUTE_BUDGET_PROGRAM_ADDRESS, LIGHTHOUSE, MEMO_PROGRAM_ADDRESS],
        instructions: [
          { programIdIndex: 2, accounts: [], data: "Fj2Eoy" },
          { programIdIndex: 2, accounts: [], data: "3gJqkocMWaMm" },
          { programIdIndex: 3, accounts: [1], data: "ChELNXPQQ6LCtFKJTCZT4mZvDQN7eAFB3iJDqdH4p4ziG8Mce3" },
          { programIdIndex: 4, accounts: [0], data: getBase58Decoder().decode(utf8(memoText)) },
          { programIdIndex: 3, accounts: [0], data: "Bgfmmp1dHLVKzg3Ho4g8nQwUtHThJxss6HV" },
        ],
      },
    },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] },
  };
}
const expected = { signature: SIG, wallet: SA, reference: REFERENCE, sha256: SHA };

function anchorTx(
  over: { payer?: string; signers?: number; instructions?: Ix[]; inner?: Ix[]; innerAt?: string; err?: unknown; blockTime?: number | null } = {},
) {
  const instructions = over.instructions ?? [cb(2), cb(3), memoIx()];
  const innerAt = instructions.findIndex((ix) => ix.program === (over.innerAt ?? MEMO_PROGRAM_ADDRESS));
  return buildTx({
    signature: SIG,
    payer: over.payer ?? SA,
    signers: over.signers,
    instructions: instructions.map((ix, i) => ({ ix, inner: i === innerAt ? over.inner : undefined })),
    err: over.err,
    blockTime: over.blockTime,
  }).tx as unknown as ChainTransaction;
}

const refused = (tx: ChainTransaction, pattern: RegExp, exp = expected) => {
  expect(() => documentAnchorEvidence(tx, exp)).toThrow(DocumentAnchorEvidenceError);
  expect(() => documentAnchorEvidence(tx, exp)).toThrow(pattern);
};

describe("documentAnchorEvidence", () => {
  it("accepts the anchor: compute budget + one memo signed by the Super Admin, with the exact text", () => {
    const evidence = documentAnchorEvidence(anchorTx(), expected);
    expect(evidence).toEqual({
      reference: REFERENCE, sha256: SHA, memo: MEMO, signature: SIG, signer: SA, slot: 100, blockTime: 1_700_000_000, walletGuardInstructions: 0,
    });
    expect(documentAnchorEvidence(anchorTx({ blockTime: null }), expected).blockTime).toBeNull();
  });

  it("tolerates the wallet's Lighthouse assertions around the memo, and counts them", () => {
    expect(LIGHTHOUSE_PROGRAM_ADDRESS).toBe(LIGHTHOUSE);
    const evidence = documentAnchorEvidence(anchorTx({ instructions: [cb(2), cb(3), guard(), memoIx(), guard(10)] }), expected);
    expect(evidence.walletGuardInstructions).toBe(2);
  });

  it("accepts the shape Phantom signs on mainnet (5RBDZ…, memo swapped in), byte for byte", () => {
    expect(documentAnchorEvidence(phantomShape(), expected)).toEqual({
      reference: REFERENCE, sha256: SHA, memo: MEMO, signature: SIG, signer: SA, slot: 453_356_383, blockTime: 1_791_143_700, walletGuardInstructions: 2,
    });
    refused(phantomShape(`MANCI-2026-0002 sha256:${SHA}`), /memo text is not/);
  });

  it("refuses when the node leaves out the inner instructions (the no-inner-call checks could not be made)", () => {
    for (const innerInstructions of [undefined, null]) {
      const tx = phantomShape();
      refused({ ...tx, meta: { ...tx.meta!, innerInstructions } }, /did not return the transaction's inner instructions/);
    }
  });

  it("refuses more Lighthouse instructions than an anchor needs", () => {
    expect(DOCUMENT_ANCHOR_MAX_WALLET_GUARDS).toBe(4);
    const four = [guard(), guard(), memoIx(), guard(), guard()];
    expect(documentAnchorEvidence(anchorTx({ instructions: [cb(2), ...four] }), expected).walletGuardInstructions).toBe(4);
    refused(anchorTx({ instructions: [cb(2), ...four, guard()] }), /more than 4 Lighthouse instructions/);
  });

  it("refuses a Lighthouse instruction that writes, is unknown, is empty or makes inner calls", () => {
    for (const kind of [0, 1, 18, 255]) {
      refused(anchorTx({ instructions: [cb(2), guard(kind), memoIx()] }), /Lighthouse instruction that is not an assertion/);
    }
    refused(
      anchorTx({ instructions: [cb(2), { program: LIGHTHOUSE, accounts: [SA], data: new Uint8Array() }, memoIx()] }),
      /Lighthouse instruction that is not an assertion/,
    );
    refused(
      anchorTx({ instructions: [cb(2), guard(), memoIx()], innerAt: LIGHTHOUSE, inner: [{ program: SYSTEM, accounts: [SA], data: new Uint8Array([0]) }] }),
      /Lighthouse instruction that is not an assertion/,
    );
  });

  it("refuses a wrong signer", () => {
    // Another fee payer.
    refused(anchorTx({ payer: OTHER, instructions: [cb(2), memoIx(MEMO, [OTHER])] }), /fee payer is not the Super Admin/);
    // The Super Admin pays, but the memo names another account.
    refused(anchorTx({ instructions: [cb(2), memoIx(MEMO, [OTHER])] }), /not signed by the Super Admin wallet/);
    // A memo without a signer account proves nobody.
    refused(anchorTx({ instructions: [cb(2), memoIx(MEMO, [])] }), /not signed by the Super Admin wallet/);
    // A second signer.
    refused(anchorTx({ signers: 2, instructions: [cb(2), memoIx(MEMO, [SA, OTHER])] }), /signed by the Super Admin wallet alone/);
    // The session is another wallet than the one that signed.
    refused(anchorTx(), /fee payer is not the Super Admin/, { ...expected, wallet: OTHER });
  });

  it("refuses a wrong text", () => {
    refused(anchorTx({ instructions: [cb(2), memoIx(`${REFERENCE} sha256:${SHA.toUpperCase()}`)] }), /memo text is not/);
    refused(anchorTx({ instructions: [cb(2), memoIx(`${REFERENCE} sha256:${SHA}\n`)] }), /memo text is not/);
    refused(anchorTx({ instructions: [cb(2), memoIx(`MANCI-2026-0002 sha256:${SHA}`)] }), /memo text is not/);
    refused(anchorTx({ instructions: [cb(2), memoIx(`${REFERENCE} sha256:${"0".repeat(64)}`)] }), /memo text is not/);
    // The page claims another hash than the one on chain.
    refused(anchorTx(), /memo text is not/, { ...expected, sha256: "b".repeat(64) });
  });

  it("refuses an extra instruction, a second memo, the legacy memo program, and no memo", () => {
    refused(anchorTx({ instructions: [cb(2), memoIx(), { program: SYSTEM, accounts: [SA, OTHER], data: new Uint8Array([2, 0, 0, 0]) }] }), /instruction the anchor does not have \(program 1111/);
    refused(anchorTx({ instructions: [cb(2), memoIx(), memoIx()] }), /more than one memo/);
    refused(anchorTx({ instructions: [cb(2), memoIx(MEMO, [SA], LEGACY_MEMO)] }), /instruction the anchor does not have/);
    refused(anchorTx({ instructions: [cb(2), cb(3)] }), /carries no memo/);
    refused(anchorTx({ inner: [{ program: SYSTEM, accounts: [SA], data: new Uint8Array([0]) }] }), /inner calls/);
  });

  it("refuses a failed transaction and a signature that is not the transaction's", () => {
    refused(anchorTx({ err: { InstructionError: [2, "MissingRequiredSignature"] } }), /did not complete successfully/);
    const noMeta = { ...anchorTx(), meta: null } as ChainTransaction;
    refused(noMeta, /did not complete successfully/);
    refused(anchorTx(), /signature does not match/, { ...expected, signature: "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ" });
  });
});

describe("documentAnchorRecordFromRow", () => {
  it("reads a recorded anchor and skips incomplete rows", () => {
    const row = {
      id: "row-1", created_at: "2026-10-05T10:00:00Z", actor_wallet: SA, tx_signature: SIG,
      metadata: { reference: REFERENCE, sha256: SHA, slot: 100, block_time: 1_700_000_000, commitment: "finalized" },
    };
    expect(documentAnchorRecordFromRow(row)).toEqual({
      id: "row-1", reference: REFERENCE, sha256: SHA, signature: SIG, signer: SA, slot: 100, blockTime: 1_700_000_000,
      commitment: "finalized", recordedAt: "2026-10-05T10:00:00Z",
    });
    expect(documentAnchorRecordFromRow({ ...row, metadata: { ...row.metadata, sha256: SHA.toUpperCase() } })).toBeNull();
    expect(documentAnchorRecordFromRow({ ...row, tx_signature: null })).toBeNull();
    expect(documentAnchorRecordFromRow({ ...row, metadata: null })).toBeNull();
  });
});
