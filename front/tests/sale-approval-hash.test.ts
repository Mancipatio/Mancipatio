// The application hash an Admin commits on-chain with approve_sale
// (SaleApproval.application_hash) is sha256 over the CANONICAL JSON of the
// stored snapshot: keys sorted, u64 values as decimal strings. Pinned to a
// fixed expected value so a change to the snapshot or its encoding cannot go
// unnoticed (every existing on-chain approval would stop verifying).
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  applicationSnapshot,
  canonicalSnapshotJson,
  manualSnapshot,
  snapshotHash,
  type SaleApprovalTerms,
} from "@/lib/server/sale-capacity";

const TERMS: SaleApprovalTerms = {
  shareClass: "ShareC1ass111111111111111111111111111111111",
  saleId: BigInt(3),
  issuer: "Issuer111111111111111111111111111111111111",
  paymentMint: "EURCmint11111111111111111111111111111111111",
  maxGrossRaise: BigInt(250_000_000_000),
  minPricePerUnit: BigInt(1_000_000),
  maxPricePerUnit: BigInt(1_200_000),
  raiseType: "mature",
  cliffMonths: 0,
  vestingMonths: 0,
  expiresAt: BigInt(1_790_000_000),
};
const APP = {
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b",
  network: "devnet",
  applicant_wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  revision_count: 2,
  reviewed_at: "2026-09-20T10:00:00.000Z",
  company_name: "Acme d.o.o.",
  raise_type: "mature",
  raise_amount: 250000,
  equity_offered: 12.5,
  cliff_months: 0,
  vesting_months: 0,
};
const EXPECTED_JSON =
  '{"applicant_wallet":"7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2","application_id":"0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b",' +
  '"application_raise_type":"mature","cliff_months":"0","company_name":"Acme d.o.o.","equity_offered":"12.5",' +
  '"expires_at":"1790000000","issuer":"Issuer111111111111111111111111111111111111","kind":"application",' +
  '"max_gross_raise":"250000000000","max_price_per_unit":"1200000","min_price_per_unit":"1000000","network":"devnet",' +
  '"payment_mint":"EURCmint11111111111111111111111111111111111","raise_amount":"250000","raise_type":"mature",' +
  '"reviewed_at":"2026-09-20T10:00:00.000Z","revision_count":"2","sale_cliff_months":"0","sale_id":"3","sale_vesting_months":"0",' +
  '"share_class":"ShareC1ass111111111111111111111111111111111","v":1,"vesting_months":"0"}';
/** `printf '%s' "$EXPECTED_JSON" | shasum -a 256` */
const EXPECTED_HASH = "27ac2d306f902cf52c7153503163c82fdd1fd1e23581ff77405cd013c1d1d606";

describe("sale approval application hash", () => {
  it("canonicalizes the reviewed application and the approved terms", () => {
    const snapshot = applicationSnapshot(APP, TERMS);
    expect(canonicalSnapshotJson(snapshot)).toBe(EXPECTED_JSON);
    const hash = snapshotHash(snapshot);
    expect(hash.hex).toBe(EXPECTED_HASH);
    expect(hash.bytes).toHaveLength(32);
    expect(Buffer.from(hash.bytes).toString("hex")).toBe(EXPECTED_HASH);
  });

  it("is independent of key order and recomputable from the stored snapshot", () => {
    const snapshot = applicationSnapshot(APP, TERMS);
    const reversed = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(snapshotHash(reversed).hex).toBe(EXPECTED_HASH);
    // What the database returns (jsonb reorders keys) hashes the same.
    expect(snapshotHash(JSON.parse(JSON.stringify(reversed))).hex).toBe(EXPECTED_HASH);
  });

  it("changes with any committed term", () => {
    const base = snapshotHash(applicationSnapshot(APP, TERMS)).hex;
    expect(snapshotHash(applicationSnapshot(APP, { ...TERMS, maxGrossRaise: BigInt(250_000_000_001) })).hex).not.toBe(base);
    expect(snapshotHash(applicationSnapshot({ ...APP, revision_count: 3 }, TERMS)).hex).not.toBe(base);
    expect(snapshotHash(applicationSnapshot({ ...APP, cliff_months: 1 }, TERMS)).hex).not.toBe(base);
  });

  it("commits a manual (super-admin) approval's reason", () => {
    const snapshot = manualSnapshot("devnet", "Platform SPV bridge round", TERMS);
    expect(snapshot).toMatchObject({ v: 1, kind: "manual", reason: "Platform SPV bridge round", sale_id: "3" });
    expect(snapshotHash(snapshot).hex).not.toBe(EXPECTED_HASH);
  });

  it("refuses values that have no single canonical text", () => {
    expect(() => canonicalSnapshotJson({ amount: 0.1 })).toThrow(/decimal strings/);
    expect(canonicalSnapshotJson({ b: BigInt(2), a: [1, null], c: undefined })).toBe('{"a":[1,null],"b":"2"}');
  });
});
