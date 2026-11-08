// Token migration (V1) evidence (lib/token-migration/evidence.ts): what a
// finalized transaction proves about a deposit, a delivery, a refund and a
// burn, from the token balances the network reports, and how a proven
// deposit is classified (accepted, or irregular with the first reason that
// applies). Synthetic json transactions, built the way getTransaction
// returns them.
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { ChainTransaction } from "@/lib/chain-evidence";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import {
  burnEvidence,
  ChainEvidenceError,
  classifyDeposit,
  deliveryEvidence,
  depositEvidence,
  MEMO_V1_PROGRAM_ADDRESS,
  refundEvidence,
  type DepositTerms,
} from "@/lib/token-migration/evidence";
import { migrationMemoText, TOKEN_PROGRAM_2022, TOKEN_PROGRAM_CLASSIC } from "@/lib/token-migration/model";

const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const B = (v: number | string) => BigInt(v);
const b58 = getBase58Decoder();

const HOLDER = key(1);
const OTHER = key(2);
const HOLDER_ATA = key(3);
const DEPOSIT_ATA = key(4);
const OLD_MINT = key(5);
const NEW_MINT = key(6);
const TREASURY_ATA = key(7);
const HOLDER_NEW_ATA = key(8);
const OTHER_NEW_ATA = key(9);
const DEPOSIT_OWNER = key(10);
const OTHER_ATA = key(11);
const SIG = "5".repeat(88);
const MIGRATION = "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const LOT = B(5_000);
const WINDOW = { windowOpensAt: "2027-01-01T00:00:00Z", windowClosesAt: "2027-03-17T00:00:00Z" };
const IN_WINDOW = Date.parse("2027-02-01T00:00:00Z") / 1000;

type Ix = { program: string; accounts: string[]; data: Uint8Array };
type Bal = { account: string; mint: string; owner?: string; amount: number | bigint };

function chainTx(spec: {
  signers: string[];
  instructions: Ix[];
  inner?: { index: number; instructions: Ix[] }[];
  pre: Bal[];
  post: Bal[];
  blockTime?: number | null;
  err?: unknown;
  signature?: string;
  loadedWritable?: string[];
}): ChainTransaction {
  const loaded = spec.loadedWritable ?? [];
  const keys: string[] = [...spec.signers];
  const all = () => [...keys, ...loaded];
  const idx = (k: string) => {
    const at = all().indexOf(k);
    if (at >= 0) return at;
    keys.push(k);
    return all().indexOf(k);
  };
  const compile = (ix: Ix) => ({ programIdIndex: idx(ix.program), accounts: ix.accounts.map(idx), data: b58.decode(ix.data) });
  const instructions = spec.instructions.map(compile);
  const inner = (spec.inner ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(compile) }));
  const bal = (b: Bal) => ({ accountIndex: idx(b.account), mint: b.mint, ...(b.owner ? { owner: b.owner } : {}), uiTokenAmount: { amount: b.amount.toString(), decimals: 6 } });
  const pre = spec.pre.map(bal);
  const post = spec.post.map(bal);
  return {
    slot: 777,
    blockTime: spec.blockTime === undefined ? IN_WINDOW : spec.blockTime,
    transaction: {
      signatures: [spec.signature ?? SIG],
      message: { header: { numRequiredSignatures: spec.signers.length }, accountKeys: keys, instructions },
    },
    meta: {
      err: spec.err ?? null,
      loadedAddresses: { writable: loaded, readonly: [] },
      innerInstructions: inner,
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  };
}

const memo = (text: string, program = MEMO_PROGRAM_ADDRESS): Ix => ({ program, accounts: [HOLDER], data: new TextEncoder().encode(text) });
function transferChecked(source: string, destination: string, authority: string, amount: bigint, program = TOKEN_PROGRAM_CLASSIC): Ix {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = 6;
  return { program, accounts: [source, OLD_MINT, destination, authority], data };
}
function burn(amount: bigint, checked: boolean, program = TOKEN_PROGRAM_CLASSIC): Ix {
  const data = new Uint8Array(checked ? 10 : 9);
  data[0] = checked ? 15 : 8;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  if (checked) data[9] = 6;
  return { program, accounts: [DEPOSIT_ATA, OLD_MINT, DEPOSIT_OWNER], data };
}

/** A holder's 2-lot deposit, as the holder page builds it. */
function deposit(over: Partial<Parameters<typeof chainTx>[0]> = {}) {
  return chainTx({
    signers: [HOLDER],
    instructions: [memo(migrationMemoText(MIGRATION, B(2))), transferChecked(HOLDER_ATA, DEPOSIT_ATA, HOLDER, B(10_000))],
    pre: [{ account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 12_345 }],
    post: [
      { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 2_345 },
      { account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 10_000 },
    ],
    ...over,
  });
}
const expectation = { depositAta: DEPOSIT_ATA, oldMint: OLD_MINT, holder: HOLDER as string | null };
const terms = (over: Partial<DepositTerms> = {}): DepositTerms => ({
  migrationId: MIGRATION,
  status: "open",
  lot: LOT,
  excludedWallets: [],
  ...WINDOW,
  ...over,
});

describe("depositEvidence", () => {
  it("proves the holder's deposit: amount, source owner, signature, memo, slot and time", () => {
    const facts = depositEvidence(deposit(), SIG, expectation);
    expect(facts).toEqual({
      holder: HOLDER,
      amount: B(10_000),
      signedByHolder: true,
      memo: { kind: "migration", migrationId: MIGRATION, lots: B(2) },
      slot: B(777),
      blockTime: IN_WINDOW,
    });
    expect(classifyDeposit(facts, terms())).toEqual({ status: "accepted", lots: B(2), reasonCode: null });
    // The reconcile attributes it to the same owner without being told.
    expect(depositEvidence(deposit(), SIG, { ...expectation, holder: null }).holder).toBe(HOLDER);
  });

  it("reads keys from an address lookup table and a memo inside a multisig's CPI, v1 memos included", () => {
    const viaAlt = depositEvidence(deposit({ loadedWritable: [DEPOSIT_ATA] }), SIG, expectation);
    expect(viaAlt.amount).toBe(B(10_000));
    const viaCpi = depositEvidence(deposit({
      instructions: [transferChecked(HOLDER_ATA, DEPOSIT_ATA, HOLDER, B(10_000))],
      inner: [{ index: 0, instructions: [memo(migrationMemoText(MIGRATION, B(2)), MEMO_V1_PROGRAM_ADDRESS)] }],
    }), SIG, expectation);
    expect(viaCpi.memo).toEqual({ kind: "migration", migrationId: MIGRATION, lots: B(2) });
  });

  it.each([
    ["a failed transaction", deposit({ err: { InstructionError: [1, "Custom"] } }), /did not complete/],
    ["another signature", deposit({ signature: "6".repeat(88) }), /signature does not match/],
    ["nothing into the deposit account", deposit({
      post: [{ account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 12_345 }, { account: OTHER_ATA, mint: OLD_MINT, owner: OTHER, amount: 0 }],
    }), /put no tokens into/],
    ["an outgoing transfer (a refund)", chainTx({
      signers: [DEPOSIT_OWNER],
      instructions: [transferChecked(DEPOSIT_ATA, HOLDER_ATA, DEPOSIT_OWNER, B(10_000))],
      pre: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 10_000 }, { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 0 }],
      post: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 0 }, { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 10_000 }],
    }), /put no tokens into/],
    ["several source wallets", deposit({
      pre: [{ account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 5_000 }, { account: OTHER_ATA, mint: OLD_MINT, owner: OTHER, amount: 5_000 }],
      post: [
        { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 0 },
        { account: OTHER_ATA, mint: OLD_MINT, owner: OTHER, amount: 0 },
        { account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 10_000 },
      ],
    }), /several wallets/],
    ["tokens also moved elsewhere", deposit({
      pre: [{ account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 20_000 }],
      post: [
        { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 0 },
        { account: OTHER_ATA, mint: OLD_MINT, owner: OTHER, amount: 10_000 },
        { account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 10_000 },
      ],
    }), /another account/],
    ["a fee on the way", deposit({
      post: [
        { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 2_345 },
        { account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 9_900 },
      ],
    }), /do not match/],
    ["a node without owners", deposit({
      pre: [{ account: HOLDER_ATA, mint: OLD_MINT, amount: 12_345 }],
      post: [{ account: HOLDER_ATA, mint: OLD_MINT, amount: 2_345 }, { account: DEPOSIT_ATA, mint: OLD_MINT, amount: 10_000 }],
    }), /who owns the source/],
  ])("proves nothing for %s", (_name, tx, message) => {
    expect(() => depositEvidence(tx, SIG, expectation)).toThrow(ChainEvidenceError);
    expect(() => depositEvidence(tx, SIG, expectation)).toThrow(message);
  });

  it("refuses a deposit the claiming wallet did not make", () => {
    expect(() => depositEvidence(deposit(), SIG, { ...expectation, holder: OTHER })).toThrow(/did not come from your wallet/);
  });

  it("ignores balances of other mints", () => {
    const tx = deposit();
    tx.meta!.preTokenBalances = [...tx.meta!.preTokenBalances!, { accountIndex: 0, mint: NEW_MINT, owner: HOLDER, uiTokenAmount: { amount: "5", decimals: 0 } }];
    expect(depositEvidence(tx, SIG, expectation).amount).toBe(B(10_000));
  });
});

describe("classifyDeposit: the first reason that applies", () => {
  const facts = () => depositEvidence(deposit(), SIG, expectation);

  it("a cancelled campaign takes no deposit; an excluded wallet is refunded", () => {
    expect(classifyDeposit(facts(), terms({ status: "cancelled" }))).toMatchObject({ status: "irregular", reasonCode: "not_open" });
    expect(classifyDeposit(facts(), terms({ excludedWallets: [HOLDER] }))).toMatchObject({ status: "irregular", reasonCode: "excluded_wallet" });
    expect(classifyDeposit(facts(), terms({ status: "closed" }))).toMatchObject({ status: "accepted" });
  });

  it("the block time must fall inside [opens, closes)", () => {
    const at = (iso: string) => ({ ...facts(), blockTime: Date.parse(iso) / 1000 });
    expect(classifyDeposit(at("2026-12-31T23:59:59Z"), terms())).toMatchObject({ reasonCode: "outside_window" });
    expect(classifyDeposit(at("2027-01-01T00:00:00Z"), terms())).toMatchObject({ status: "accepted" });
    expect(classifyDeposit(at("2027-03-16T23:59:59Z"), terms())).toMatchObject({ status: "accepted" });
    expect(classifyDeposit(at("2027-03-17T00:00:00Z"), terms())).toMatchObject({ reasonCode: "outside_window" });
    expect(classifyDeposit({ ...facts(), blockTime: null }, terms())).toMatchObject({ reasonCode: "outside_window" });
  });

  it("the source owner must sign (a delegate's transfer is refunded)", () => {
    const delegated = depositEvidence(deposit({
      signers: [OTHER],
      instructions: [memo(migrationMemoText(MIGRATION, B(2))), transferChecked(HOLDER_ATA, DEPOSIT_ATA, OTHER, B(10_000))],
    }), SIG, { ...expectation, holder: null });
    expect(delegated.signedByHolder).toBe(false);
    expect(classifyDeposit(delegated, terms())).toMatchObject({ reasonCode: "not_signed_by_holder" });
  });

  it("only a whole number of lots, with the memo naming this campaign and exactly those lots", () => {
    expect(classifyDeposit({ ...facts(), amount: B(7_500) }, terms())).toMatchObject({ reasonCode: "not_lot_multiple" });
    expect(classifyDeposit({ ...facts(), amount: B(4_999) }, terms())).toMatchObject({ reasonCode: "not_lot_multiple" });
    expect(classifyDeposit({ ...facts(), amount: B(15_000) }, terms())).toMatchObject({ reasonCode: "memo_mismatch", lots: B(3) });
    expect(classifyDeposit({ ...facts(), memo: { kind: "none" } }, terms())).toMatchObject({ reasonCode: "memo_mismatch" });
    expect(classifyDeposit({ ...facts(), memo: { kind: "ambiguous" } }, terms())).toMatchObject({ reasonCode: "memo_mismatch" });
    expect(classifyDeposit(facts(), terms({ migrationId: "00000000-0000-4000-8000-000000000000" }))).toMatchObject({ reasonCode: "memo_mismatch" });
  });

  it("two migration memos, or a malformed one, are ambiguous", () => {
    const two = depositEvidence(deposit({
      instructions: [memo(migrationMemoText(MIGRATION, B(2))), memo(migrationMemoText(MIGRATION, B(1))), transferChecked(HOLDER_ATA, DEPOSIT_ATA, HOLDER, B(10_000))],
    }), SIG, expectation);
    expect(two.memo).toEqual({ kind: "ambiguous" });
    const malformed = depositEvidence(deposit({
      instructions: [memo(`manci:migration:v1:${MIGRATION}:0`), transferChecked(HOLDER_ATA, DEPOSIT_ATA, HOLDER, B(10_000))],
    }), SIG, expectation);
    expect(malformed.memo).toEqual({ kind: "ambiguous" });
    const unrelated = depositEvidence(deposit({
      instructions: [memo("hello"), transferChecked(HOLDER_ATA, DEPOSIT_ATA, HOLDER, B(10_000))],
    }), SIG, expectation);
    expect(unrelated.memo).toEqual({ kind: "none" });
  });
});

describe("deliveryEvidence", () => {
  const recipients = new Map([
    [HOLDER, { ata: HOLDER_NEW_ATA, units: B(1) }],
    [OTHER, { ata: OTHER_NEW_ATA, units: B(2) }],
  ]);
  function delivery(over: { post?: Bal[]; pre?: Bal[] } = {}) {
    return chainTx({
      signers: [key(20)],
      instructions: [{ program: TOKEN_PROGRAM_2022, accounts: [TREASURY_ATA, NEW_MINT, HOLDER_NEW_ATA, key(20)], data: new Uint8Array([12]) }],
      pre: over.pre ?? [
        { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 1_000 },
        { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 5 },
      ],
      post: over.post ?? [
        { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 997 },
        { account: HOLDER_NEW_ATA, mint: NEW_MINT, owner: HOLDER, amount: 1 },
        { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 7 },
      ],
    });
  }
  const expected = { newMint: NEW_MINT, treasuryAta: TREASURY_ATA, recipients };

  it("proves each holder received exactly its units from the treasury (no signer required: a Squads treasury signs inside a CPI)", () => {
    expect(deliveryEvidence(delivery(), SIG, expected)).toEqual({ total: B(3), slot: B(777) });
  });

  it.each([
    ["a holder short", [
      { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 998 },
      { account: HOLDER_NEW_ATA, mint: NEW_MINT, owner: HOLDER, amount: 0 },
      { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 7 },
    ], /did not receive exactly/],
    ["an account of another owner", [
      { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 997 },
      { account: HOLDER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 1 },
      { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 7 },
    ], /does not belong/],
    ["units from somewhere else", [
      { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 1_000 },
      { account: HOLDER_NEW_ATA, mint: NEW_MINT, owner: HOLDER, amount: 1 },
      { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 7 },
    ], /treasury's units did not decrease/],
    ["another movement in the same transaction", [
      { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 997 },
      { account: HOLDER_NEW_ATA, mint: NEW_MINT, owner: HOLDER, amount: 1 },
      { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 7 },
      { account: key(21), mint: NEW_MINT, owner: key(22), amount: 3 },
    ], /elsewhere/],
  ])("refuses %s", (_name, post, message) => {
    const pre = [
      { account: TREASURY_ATA, mint: NEW_MINT, owner: key(20), amount: 1_000 },
      { account: OTHER_NEW_ATA, mint: NEW_MINT, owner: OTHER, amount: 5 },
    ];
    expect(() => deliveryEvidence(delivery({ pre, post: post as Bal[] }), SIG, expected)).toThrow(message);
  });

  it("refuses an empty delivery", () => {
    expect(() => deliveryEvidence(delivery(), SIG, { ...expected, recipients: new Map() })).toThrow(/No deposits/);
  });
});

describe("refundEvidence", () => {
  const refund = (holderGets: number, owner = HOLDER) => chainTx({
    signers: [DEPOSIT_OWNER],
    instructions: [transferChecked(DEPOSIT_ATA, HOLDER_ATA, DEPOSIT_OWNER, B(10_000))],
    pre: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 30_000 }],
    post: [
      { account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 30_000 - holderGets },
      { account: HOLDER_ATA, mint: OLD_MINT, owner, amount: holderGets },
    ],
  });
  const expected = { oldMint: OLD_MINT, depositAta: DEPOSIT_ATA, holder: HOLDER, amount: B(10_000) };

  it("proves the deposit's exact amount went back to the wallet that deposited it", () => {
    expect(refundEvidence(refund(10_000), SIG, expected)).toEqual({ slot: B(777) });
  });
  it("refuses a partial refund, one to another wallet, and a zero amount", () => {
    expect(() => refundEvidence(refund(9_999), SIG, expected)).toThrow(/exactly this deposit's amount/);
    expect(() => refundEvidence(refund(10_000, OTHER), SIG, expected)).toThrow(/did not go back/);
    expect(() => refundEvidence(refund(10_000), SIG, { ...expected, amount: B(0) })).toThrow(/at least one/);
  });
});

describe("burnEvidence", () => {
  const burnTx = (ixs: { top?: Ix[]; inner?: Ix[] }, after = 0, extra: Bal[] = []) => chainTx({
    signers: [key(30)],
    instructions: ixs.top ?? [{ program: key(31), accounts: [DEPOSIT_ATA], data: new Uint8Array([1]) }],
    inner: ixs.inner ? [{ index: 0, instructions: ixs.inner }] : [],
    pre: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 20_000 }, ...extra],
    post: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: after }, ...extra],
  });
  const expected = { oldMint: OLD_MINT, tokenProgram: TOKEN_PROGRAM_CLASSIC, depositAta: DEPOSIT_ATA };

  it("proves a Burn at the top level and a BurnChecked inside a multisig's CPI", () => {
    expect(burnEvidence(burnTx({ top: [burn(B(20_000), false)] }), SIG, expected)).toEqual({ burned: B(20_000), slot: B(777) });
    expect(burnEvidence(burnTx({ inner: [burn(B(20_000), true)] }), SIG, expected).burned).toBe(B(20_000));
  });

  it("refuses a decrease without a burn, a transfer, a burn of another program and a partial account", () => {
    expect(() => burnEvidence(burnTx({}), SIG, expected)).toThrow(/No burn instruction/);
    const moved = chainTx({
      signers: [DEPOSIT_OWNER],
      instructions: [transferChecked(DEPOSIT_ATA, HOLDER_ATA, DEPOSIT_OWNER, B(20_000))],
      pre: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 20_000 }],
      post: [{ account: DEPOSIT_ATA, mint: OLD_MINT, owner: DEPOSIT_OWNER, amount: 0 }, { account: HOLDER_ATA, mint: OLD_MINT, owner: HOLDER, amount: 20_000 }],
    });
    expect(() => burnEvidence(moved, SIG, expected)).toThrow(/not a burn/);
    expect(() => burnEvidence(burnTx({ top: [burn(B(20_000), true, TOKEN_PROGRAM_2022)] }), SIG, expected)).toThrow(/No burn instruction/);
    expect(() => burnEvidence(burnTx({ top: [burn(B(5_000), true)] }), SIG, expected)).toThrow(/No burn instruction/);
    expect(() => burnEvidence(burnTx({ top: [burn(B(20_000), true)] }, 20_000), SIG, expected)).toThrow(/did not decrease/);
  });
});
