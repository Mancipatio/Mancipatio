// The simulator's roster, seeded identities and TEST documents
// (scripts/sim/lib/identity.ts, docs.ts): counts, the owner's review split,
// every field within the route limits (the application through the real
// narrowApplication), the documents' formats, watermarks and size limits,
// and the funding transactions fitting one packet.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  compileTransaction,
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Address,
  type Blockhash,
} from "@solana/kit";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({}) }));

import { narrowApplication } from "@/app/api/applications/_lib";
import { isDefaultApprovedJurisdiction } from "@/lib/passport";
import { mintPaymentInstructions, fundInstructions } from "@/scripts/chain/lib/e2e/fixtures";
import { buildMessage } from "@/scripts/chain/lib/tx";
import {
  DOC_MAX_BYTES,
  DOC_MIN_BYTES,
  E2E_PAYMENT_MINT,
  FUND_BATCH,
  MINT_BATCH,
  UPLOAD_MAX_BYTES,
  VERCEL_BODY_CAP,
} from "@/scripts/sim/lib/constants";
import { PNG_SIGNATURE, crc32, docFormat, edgeFile, simDocument } from "@/scripts/sim/lib/docs";
import { applicationContent, buildRoster, hasDossier, kybParams, kycParams, person, simLegalId } from "@/scripts/sim/lib/identity";

const RUN = "a1b2c3";
const roster = buildRoster();

describe("roster", () => {
  it("keeps the first 100 plans of 3de3386 byte for byte (no one is renumbered by cohort X)", () => {
    const first = createHash("sha256").update(JSON.stringify(roster.slice(0, 100))).digest("hex");
    expect(first).toBe("6cbd976ce9dc95a869960d2603718d0636bae918f070dc1efbe3c348bfa65304");
  });

  it("appends the two transfer pairs as u101–u104 in wave 6, without dossiers", () => {
    expect(roster).toHaveLength(104);
    const x = roster.slice(100);
    expect(x.map((p) => [p.label, p.cohort, p.variant, p.xpair, p.wave, p.review])).toEqual([
      ["u101", "X", "xfer-hub", 1, 6, "none"],
      ["u102", "X", "xfer-peer", 1, 6, "none"],
      ["u103", "X", "xfer-buyer", 2, 6, "none"],
      ["u104", "X", "xfer-peer", 2, 6, "none"],
    ]);
    expect(x.some(hasDossier)).toBe(false);
    expect(roster.filter((p) => p.wave === 6)).toEqual(x);
    expect(roster.slice(0, 100).every((p) => p.cohort !== "X" && p.wave <= 5)).toBe(true);
  });

  it("has the design's 100 users and cohort sizes", () => {
    expect(roster.filter((p) => p.cohort !== "X")).toHaveLength(100);
    const count = (f: (p: (typeof roster)[number]) => boolean) => roster.filter(f).length;
    expect(count((p) => p.cohort === "K")).toBe(30);
    expect(count((p) => p.cohort === "I")).toBe(35);
    expect(count((p) => p.variant === "buyer-kyc")).toBe(20);
    expect(count((p) => p.variant === "buyer-nokyc")).toBe(15);
    expect(count((p) => p.cohort === "T")).toBe(12);
    expect(count((p) => p.cohort === "B")).toBe(15);
    expect(count((p) => p.variant.startsWith("company"))).toBe(10);
    expect(count((p) => p.variant === "founder")).toBe(5);
    expect(count((p) => p.cohort === "E")).toBe(8);
    expect(count((p) => p.variant === "kyc-reject-doc")).toBe(3);
    expect(count((p) => p.variant === "kyc-stop-after-one")).toBe(2);
    expect(count((p) => p.variant === "kyc-invalid-first")).toBe(1);
    expect(count((p) => p.variant === "company-needs-changes")).toBe(2);
    expect(count((p) => p.variant === "company-over-cap")).toBe(1);
    expect(count((p) => p.cohort === "X")).toBe(4);
    expect(new Set(roster.map((p) => p.label)).size).toBe(104);
  });

  it("puts one of each kind in the pilot and ~19 users in each wave", () => {
    const pilot = roster.filter((p) => p.wave === 0);
    expect(pilot.map((p) => p.variant)).toEqual(["kyc", "buyer-kyc", "buyer-nokyc", "company", "edge"]);
    for (let w = 1; w <= 5; w++) {
      const size = roster.filter((p) => p.wave === w).length;
      expect(size).toBeGreaterThanOrEqual(17);
      expect(size).toBeLessThanOrEqual(21);
    }
  });

  it("keeps every trader pair in one wave", () => {
    for (let pair = 1; pair <= 6; pair++) {
      const members = roster.filter((p) => p.pair === pair);
      expect(members.map((p) => p.variant).sort()).toEqual(["maker", "taker"]);
      expect(new Set(members.map((p) => p.wave)).size).toBe(1);
    }
  });

  it("asks the owner for about 70/10/10/10 over the 65 dossiers, with fixed choices", () => {
    const dossiers = roster.filter(hasDossier);
    expect(dossiers).toHaveLength(65);
    const by = (r: string) => dossiers.filter((p) => p.review === r).length;
    expect(by("approve")).toBeGreaterThanOrEqual(43);
    expect(by("approve")).toBeLessThanOrEqual(47);
    for (const r of ["reject", "more_info", "leave"]) {
      expect(by(r)).toBeGreaterThanOrEqual(5);
      expect(by(r)).toBeLessThanOrEqual(8);
    }
    expect(roster.filter((p) => p.variant === "kyc-reject-doc").every((p) => p.review === "reject")).toBe(true);
    expect(roster.filter((p) => p.variant === "kyc-stop-after-one").every((p) => p.review === "leave")).toBe(true);
    expect(roster.filter((p) => p.wave === 0 && hasDossier(p)).every((p) => p.review === "approve")).toBe(true);
    expect(roster.filter((p) => !hasDossier(p)).every((p) => p.review === "none")).toBe(true);
  });

  it("is deterministic", () => {
    expect(buildRoster()).toEqual(roster);
  });
});

describe("seeded identities", () => {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^\+?[0-9 ()-]{5,32}$/;

  it("stays inside every verification.submit limit, SIM- names and simNNN@example.com", () => {
    for (const p of roster) {
      const who = person(RUN, p.n);
      const nnn = String(p.n).padStart(3, "0");
      expect(who.displayName.startsWith(`SIM-${nnn} `)).toBe(true);
      expect(who.displayName.length).toBeLessThanOrEqual(100);
      expect(who.email).toBe(`sim${nnn}@example.com`);
      expect(EMAIL_RE.test(who.email)).toBe(true);
      expect(PHONE_RE.test(who.phone)).toBe(true);
      const kyc = kycParams(who);
      expect(kyc.legal_name).toSatisfy((v: string) => v.length >= 2 && v.length <= 200);
      expect(kyc.date_of_birth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const age = (Date.now() - Date.parse(`${kyc.date_of_birth}T00:00:00Z`)) / (365.25 * 86_400_000);
      expect(age).toBeGreaterThan(18);
      expect(age).toBeLessThan(120);
      expect(isDefaultApprovedJurisdiction(kyc.residence_country as number)).toBe(true);
      expect(kyc.nationality).toSatisfy((v: number) => Number.isInteger(v) && v >= 1 && v <= 999);
      expect((kyc.address_line as string).length).toBeGreaterThanOrEqual(3);
      expect((kyc.city as string).length).toBeGreaterThanOrEqual(1);
      expect((kyc.postal_code as string).length).toBeLessThanOrEqual(20);
      const kyb = kybParams(who);
      expect(isDefaultApprovedJurisdiction(kyb.company_country as number)).toBe(true);
      expect(kyb.company_website).toMatch(/^https?:\/\/[^\s]+\.[^\s]+$/i);
      expect((kyb.company_reg_number as string).length).toBeLessThanOrEqual(64);
      expect(new TextEncoder().encode(simLegalId(RUN, p.n)).length).toBeLessThanOrEqual(32);
      expect(JSON.stringify(kyb).length).toBeLessThan(8_192);
    }
  });

  it("builds applications the real narrowApplication accepts (and refuses the over-cap one)", () => {
    for (const p of roster.filter((x) => x.cohort === "B")) {
      const app = narrowApplication(applicationContent(RUN, person(RUN, p.n)));
      expect(app.raise_type).toBe("mature");
      expect(app.founder_email?.endsWith("@example.com")).toBe(true);
    }
    expect(() => narrowApplication(applicationContent(RUN, person(RUN, 4), 3_500_000))).toThrow();
  });

  it("is deterministic per run id", () => {
    expect(person(RUN, 17)).toEqual(person(RUN, 17));
    expect(person(RUN, 17).dateOfBirth === person("zzzzzz", 17).dateOfBirth && person(RUN, 17).city === person("zzzzzz", 17).city && person(RUN, 18).displayName === person("zzzzzz", 18).displayName).toBe(false);
  });
});

function pngChunks(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString("latin1");
    const data = buf.subarray(at + 8, at + 8 + length);
    expect(buf.readUInt32BE(at + 8 + length)).toBe(crc32(buf.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

describe("TEST documents", () => {
  const kinds = ["passport", "proof_of_address", "selfie", "incorporation", "board_resolution"];

  it("are valid PNG / PDF files of 20–150 KB with an explicit MIME type", () => {
    for (const n of [1, 2, 17, 64]) {
      for (const kind of kinds) {
        const doc = simDocument({ runId: RUN, n, kind, round: 1, reject: false });
        expect(doc.bytes.length).toBeGreaterThanOrEqual(DOC_MIN_BYTES);
        expect(doc.bytes.length).toBeLessThanOrEqual(DOC_MAX_BYTES + 64);
        expect(doc.bytes.length).toBeLessThan(UPLOAD_MAX_BYTES);
        expect(["image/png", "application/pdf"]).toContain(doc.type);
        expect(doc.type).toBe(docFormat(kind, n) === "png" ? "image/png" : "application/pdf");
        expect(doc.name).toContain(kind);
      }
    }
  });

  it("stamps PNGs visibly and in their metadata", () => {
    const doc = simDocument({ runId: RUN, n: 17, kind: "selfie", round: 2, reject: true });
    const chunks = pngChunks(doc.bytes);
    expect(chunks[0].type).toBe("IHDR");
    expect(chunks.at(-1)!.type).toBe("IEND");
    const text = chunks.filter((c) => c.type === "tEXt").map((c) => c.data.toString("latin1")).join("\n");
    expect(text).toContain("TEST DOCUMENT - NOT A REAL ID");
    expect(text).toContain("SIM-017 SELFIE");
    expect(text).toContain(`RUN ${RUN.toUpperCase()} V2`);
    expect(text).toContain("PLEASE REJECT");
    // The pixels carry the stamp: red text on the light background.
    const width = chunks[0].data.readUInt32BE(0);
    const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
    const row = raw.subarray(40 * (width * 3 + 1) + 1, 41 * (width * 3 + 1));
    let red = 0;
    for (let x = 30; x < width - 30; x++) if (row[x * 3] > 150 && row[x * 3 + 1] < 60) red += 1;
    expect(red).toBeGreaterThan(20);
  });

  it("writes PDFs with a correct xref and the watermark on the page", () => {
    const doc = simDocument({ runId: RUN, n: 2, kind: "proof_of_address", round: 1, reject: false });
    const text = Buffer.from(doc.bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("TEST DOCUMENT \\226 NOT A REAL ID");
    expect(text).toContain("SIM-002 PROOF OF ADDRESS");
    expect(text).not.toContain("PLEASE REJECT");
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBe(7);
    entries.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it("are deterministic, and a replacement round differs", () => {
    const a = simDocument({ runId: RUN, n: 5, kind: "passport", round: 1, reject: false });
    expect(simDocument({ runId: RUN, n: 5, kind: "passport", round: 1, reject: false }).bytes).toEqual(a.bytes);
    expect(Buffer.from(simDocument({ runId: RUN, n: 5, kind: "passport", round: 2, reject: false }).bytes).equals(Buffer.from(a.bytes))).toBe(false);
  });

  it("stay near the design's ~25 MB for the whole roster", () => {
    let total = 0;
    for (const p of roster.filter(hasDossier)) {
      const kinds = p.variant.startsWith("company") ? ["incorporation", "board_resolution", "passport", "proof_of_address"] : ["passport", "proof_of_address", "selfie"];
      for (const kind of kinds) total += simDocument({ runId: RUN, n: p.n, kind, round: 1, reject: p.review === "reject" }).bytes.length;
    }
    expect(total).toBeLessThan(30 * 1024 * 1024);
    expect(total).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("builds the edge cohort's invalid files", () => {
    expect(edgeFile("txt", RUN, 9).type).toBe("text/plain");
    expect(edgeFile("heic", RUN, 9).type).toBe("image/heic");
    expect(edgeFile("empty", RUN, 9).bytes).toHaveLength(0);
    const big = edgeFile("oversize", RUN, 9);
    expect(big.type).toBe("application/pdf");
    expect(big.bytes.length).toBeGreaterThan(VERCEL_BODY_CAP);
    expect(big.bytes.length).toBeLessThan(UPLOAD_MAX_BYTES);
  });
});

describe("funding transactions", () => {
  const blockhash = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: BigInt(100) };
  const wireBytes = (ixs: Parameters<typeof buildMessage>[0]["ixs"], payer: ReturnType<typeof createNoopSigner>) =>
    Buffer.from(getBase64EncodedWireTransaction(compileTransaction(buildMessage({ feePayer: payer, ixs, blockhash, cuLimit: 200_000, cuPrice: BigInt(1_000) }))), "base64").length;

  it(`fits ${FUND_BATCH} SOL transfers in one packet`, async () => {
    const payer = createNoopSigner((await generateKeyPairSigner()).address);
    const targets = await Promise.all(Array.from({ length: FUND_BATCH }, async () => ({ to: (await generateKeyPairSigner()).address, lamports: BigInt(30_000_000) })));
    expect(wireBytes(fundInstructions(payer, targets), payer)).toBeLessThanOrEqual(1_232);
  });

  it(`fits ${MINT_BATCH} payment-token mints (ATA + mint each) in one packet`, async () => {
    const payer = createNoopSigner((await generateKeyPairSigner()).address);
    const owners = await Promise.all(Array.from({ length: MINT_BATCH }, async () => (await generateKeyPairSigner()).address));
    const ixs = await mintPaymentInstructions({ payer, mintAuthority: payer, mint: E2E_PAYMENT_MINT as Address, owners, amount: BigInt(500_000_000) });
    expect(wireBytes(ixs, payer)).toBeLessThanOrEqual(1_232);
  });
});
