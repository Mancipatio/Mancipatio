// lib/certificates/payload.ts and signature.ts: what a certificate says and
// how its signature is checked. The payload is built from the chain facts
// and the admin's details (u64 amounts as strings, exact percentages, a fixed
// statement per kind), the admin's text is cleaned and refused when it could
// read differently from what is signed, the wallet's signature verifies only
// for its signer and this exact number and hash (raw text or a Ledger's
// off-chain envelope), and the public projection never carries the holder's
// name or identification number.
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, sha256HexOfText } from "@/lib/certificates/canonical";
import {
  CERTIFICATE_SCHEMA,
  CertificateInputError,
  CertificatePayloadError,
  buildCertificatePayload,
  certificateListItem,
  certificateMessage,
  certificateText,
  certificateVerifyPath,
  certificateTokenSymbol,
  normalizeCertificateNumber,
  normalizeCertificateSha256,
  parseCertificatePayload,
  parseCertificateRequest,
  parseUnitsFor100Percent,
  percentOf,
  previewCompany,
  previewScale,
  publicCertificateView,
  type CertificateRow,
} from "@/lib/certificates/payload";
import { certificateSignatureFormat, signatureFromBase58 } from "@/lib/certificates/signature";
import { readCertificateFile } from "@/lib/certificates/public-check";
import {
  COMPANY,
  EVIDENCE_TX,
  HOLDER,
  MINT,
  SHARE_CLASS,
  buildInput,
  certificateSigner,
  chainFacts,
  fixedAddress,
  fixturePayload,
} from "./helpers/certificate-fixtures";

describe("percentages", () => {
  it("are exact decimals while they fit 8 places, rounded half up beyond, BigInt only", () => {
    expect(percentOf(BigInt(250), BigInt(10_000))).toEqual({ percent: "2.5", rounded: false });
    expect(percentOf(BigInt(1), BigInt(10_000))).toEqual({ percent: "0.01", rounded: false });
    expect(percentOf(BigInt(10_000), BigInt(10_000))).toEqual({ percent: "100", rounded: false });
    expect(percentOf(BigInt(0), BigInt(10_000))).toEqual({ percent: "0", rounded: false });
    expect(percentOf(BigInt(1), BigInt(1_000_000))).toEqual({ percent: "0.0001", rounded: false });
    expect(percentOf(BigInt(1), BigInt(3))).toEqual({ percent: "33.33333333", rounded: true });
    expect(percentOf(BigInt(2), BigInt(3))).toEqual({ percent: "66.66666667", rounded: true });
    // u64 scale, far beyond Number's precision.
    expect(percentOf(BigInt("9223372036854775807"), BigInt("18446744073709551614"))).toEqual({ percent: "50", rounded: false });
    expect(() => percentOf(BigInt(1), BigInt(0))).toThrow(CertificateInputError);
  });
});

describe("the payload", () => {
  it("states a holding: units, percent of the company, slot, and the facts it rests on", async () => {
    const { payload, canonical, sha256 } = await fixturePayload();
    expect(payload.schema).toBe(CERTIFICATE_SCHEMA);
    expect(payload.holding).toEqual({
      units: "250",
      percent_of_company: "2.5",
      percent_of_company_rounded: false,
      slot: "380123456",
      commitment: "finalized",
    });
    expect(payload.supply).toBeNull();
    expect(payload.share_class).toMatchObject({ max_supply: "1750", units_for_100_percent: "10000", unit_percent: "0.01", mint: MINT });
    expect(payload.asset).toMatchObject({ asset_id: "MANCI-2026", symbol: "MANCI0" });
    expect(payload.chain_evidence).toMatchObject({
      asset_registry_program: "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS",
      transfer_hook_program: "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy",
      transactions: [],
    });
    expect(payload.statement).toContain(`the wallet ${HOLDER} held 250 units of MANCI0`);
    expect(payload.statement).toContain("10,000 units stand for 100 % of that company, so the units held stand for 2.5 % of it.");
    expect(payload.statement).toContain("at slot 380123456 on 2026-11-08 at 10:15:30 UTC");
    expect(payload.statement).toContain("Primer d.o.o. Beograd, registration number 12345678, Ulica Đure Đakovića 1");
    // A test network says so first; the payload is canonical and hashes to its stored hash.
    expect(payload.statement.startsWith("TEST NETWORK:")).toBe(true);
    expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
    expect(await sha256HexOfText(canonical)).toBe(sha256);
    expect(parseCertificatePayload(canonical)).toEqual(payload);
  });

  it("names the mainnet operator and drops the test-network warning on mainnet", async () => {
    const { payload } = await fixturePayload({ network: "mainnet" });
    expect(payload.operator).toMatchObject({ legal_name: "Manci International Ltd.", registration_number: "2219023" });
    expect(payload.statement.startsWith("Manci International Ltd., the operator of the Manci platform, certifies that")).toBe(true);
    expect(payload.statement).not.toContain("TEST NETWORK");
  });

  it("states an issuance: cap, units issued to date, units in circulation", async () => {
    const { payload } = await fixturePayload({ kind: "issuance" });
    expect(payload.holder).toBeNull();
    expect(payload.holding).toBeNull();
    expect(payload.supply).toMatchObject({
      max_supply_percent: "17.5",
      lifetime_minted: "500",
      circulating: "250",
      circulating_percent: "2.5",
      slot: "380123457",
    });
    expect(payload.statement).toContain("a maximum supply of 1,750 units (17.5 % of the company), 500 units issued to date and 250 units in circulation");
    const uncapped = buildCertificatePayload(buildInput({ kind: "issuance", chain: chainFacts("issuance", { maxSupply: null }) }));
    expect(uncapped.share_class.max_supply).toBeNull();
    expect(uncapped.statement).toContain("no maximum supply");
  });

  it("puts a holder's name and ID number in the payload and its statement only when the admin typed them", async () => {
    const named = await fixturePayload({ holder: { wallet: HOLDER, name: "Petar Petrović", idNumber: "ID-TEST-0001" } });
    expect(named.payload.holder).toEqual({ wallet: HOLDER, name: "Petar Petrović", id_number: "ID-TEST-0001" });
    expect(named.payload.statement).toContain("(holder: Petar Petrović, identification number ID-TEST-0001, as given to the operator)");
    const anonymous = await fixturePayload();
    expect(anonymous.payload.holder).toEqual({ wallet: HOLDER, name: null, id_number: null });
    expect(anonymous.payload.statement).not.toContain("(holder:");
    const idOnly = await fixturePayload({ holder: { wallet: HOLDER, name: null, idNumber: "ID-TEST-0002" } });
    expect(idOnly.payload.statement).toContain("(holder: identification number ID-TEST-0002, as given to the operator)");
  });

  it("depends on every fact: another salt, unit count or wallet gives another hash", async () => {
    const base = await fixturePayload();
    const salted = await fixturePayload({ salt: "f".repeat(32) });
    const more = await fixturePayload({ chain: chainFacts("holding", { units: BigInt(251) }) });
    expect(new Set([base.sha256, salted.sha256, more.sha256]).size).toBe(3);
  });

  it("refuses facts that do not make a certificate", () => {
    const refuse = (over: Parameters<typeof buildInput>[0], message: RegExp) =>
      expect(() => buildCertificatePayload(buildInput(over))).toThrow(message);
    refuse({ chain: chainFacts("holding", { units: BigInt(0) }) }, /holds no units/);
    refuse({ chain: chainFacts("holding", { units: BigInt(10_001) }) }, /more units than the scale/);
    refuse({ unitsFor100Percent: BigInt(1_000) }, /maximum supply \(1,750\) is more than the scale/);
    refuse({ unitsFor100Percent: BigInt(0) }, /scale/);
    refuse({ number: "MC-26-1" }, /Invalid certificate number/);
    refuse({ salt: "xyz" }, /salt/);
    refuse({ kind: "issuance", holder: { wallet: HOLDER, name: null, idNumber: null } }, /names no holder/);
  });

  it("records each evidence transaction with its slot and note", async () => {
    const { payload } = await fixturePayload({ evidence: [{ signature: EVIDENCE_TX, slot: "370000000", note: "Transfer of 500 units" }] });
    expect(payload.chain_evidence.transactions).toEqual([{ signature: EVIDENCE_TX, slot: "370000000", note: "Transfer of 500 units" }]);
  });
});

describe("the admin's input", () => {
  it("cleans text (NFC, one space) and refuses invisible characters that would print differently", () => {
    expect(certificateText("  Strahinjic\u0301a   Bana\n73 ", "Address", 3, 300)).toBe("Strahinjića Bana 73");
    expect(() => certificateText("Mancipatio\u202e d.o.o.", "Name", 2, 200)).toThrow(/invisible/);
    expect(() => certificateText("Manci\u200bpatio", "Name", 2, 200)).toThrow(/invisible/);
    expect(() => certificateText("x", "Name", 2, 200)).toThrow(/at least 2/);
    expect(() => certificateText("y".repeat(201), "Name", 2, 200)).toThrow(/at most 200/);
    expect(() => certificateText(5, "Name", 2, 200)).toThrow(/required/);
  });

  it("narrows a create request field by field", () => {
    const params = {
      kind: "holding",
      share_class: SHARE_CLASS,
      wallet: HOLDER,
      company: COMPANY,
      units_for_100_percent: "10,000",
      holder_name: " Petar   Petrović ",
      holder_id_number: "",
      evidence: [{ signature: EVIDENCE_TX, note: "Transfer" }],
    };
    expect(parseCertificateRequest(params, true)).toEqual({
      kind: "holding",
      shareClass: SHARE_CLASS,
      wallet: HOLDER,
      company: COMPANY,
      unitsFor100Percent: BigInt(10_000),
      holderName: "Petar Petrović",
      holderIdNumber: null,
      evidence: [{ signature: EVIDENCE_TX, note: "Transfer" }],
    });
    expect(() => parseCertificateRequest({ ...params, kind: "loan" }, true)).toThrow(/kind/);
    expect(() => parseCertificateRequest({ ...params, wallet: "nope" }, true)).toThrow(/wallet/);
    expect(() => parseCertificateRequest({ ...params, company: { legal_name: "X" } }, true)).toThrow(/legal name/);
    expect(() => parseCertificateRequest({ ...params, units_for_100_percent: undefined }, true)).toThrow(/100 %/);
    expect(() => parseCertificateRequest({ ...params, evidence: [{ signature: EVIDENCE_TX }, { signature: EVIDENCE_TX }] }, true)).toThrow(/twice/);
    expect(() => parseCertificateRequest({ ...params, evidence: [{ signature: "abc" }] }, true)).toThrow(/signature/);
    // An issuance names no holder; a preview may leave the company and the scale to the prefill.
    expect(() => parseCertificateRequest({ ...params, kind: "issuance" }, true)).toThrow(/names no holder/);
    expect(parseCertificateRequest({ kind: "issuance", share_class: SHARE_CLASS }, false)).toMatchObject({
      kind: "issuance", wallet: null, company: null, unitsFor100Percent: null, holderName: null,
    });
  });

  it("merges a preview's typed company and scale with the prefill, field by field", () => {
    const prefill = { legal_name: "Prefilled d.o.o.", registration_number: "123", address: "Prefilled street 1" };
    expect(previewCompany({ legal_name: "Typed d.o.o.", registration_number: " ", address: "" }, prefill)).toEqual({
      legal_name: "Typed d.o.o.", registration_number: "123", address: "Prefilled street 1",
    });
    expect(previewCompany(undefined, prefill)).toEqual(prefill);
    expect(() => previewCompany({ legal_name: "Typed d.o.o." }, { ...prefill, address: "" })).toThrow(/registered address/);
    expect(previewScale("", "10000")).toBe(BigInt(10_000));
    expect(previewScale("1000000", "10000")).toBe(BigInt(1_000_000));
    expect(() => previewScale(undefined, null)).toThrow(/100 %/);
  });

  it("reads the scale as a whole number of units", () => {
    expect(parseUnitsFor100Percent("1 000 000")).toBe(BigInt(1_000_000));
    expect(parseUnitsFor100Percent(10_000)).toBe(BigInt(10_000));
    for (const bad of ["0", "-5", "1.5", "1e6", "", "18446744073709551616"]) {
      expect(() => parseUnitsFor100Percent(bad), bad).toThrow(CertificateInputError);
    }
  });

  it("reads a typed SHA-256 (either case, a sha256: prefix, a shasum line) and derives the mint's symbol as the program does", () => {
    const sha = "ab".repeat(32);
    expect(normalizeCertificateSha256(`  SHA256:${sha.toUpperCase()} `)).toBe(sha);
    expect(normalizeCertificateSha256(`${sha}  MC-2026-0001.json`)).toBe(sha);
    for (const bad of ["", sha.slice(1), `${sha}0`, `0x${sha}`, `${sha}\n${sha}`]) expect(normalizeCertificateSha256(bad), bad).toBeNull();
    expect(certificateTokenSymbol("MANCI", 0)).toBe("MANCI0");
    // 10 UTF-8 bytes at most, never half a character ("Đ" is two bytes).
    expect(certificateTokenSymbol("ĐĐĐĐĐ", 7)).toBe("ĐĐĐĐĐ");
    expect(certificateTokenSymbol("ABCDEFGHI", 12)).toBe("ABCDEFGHI1");
  });

  it("reads a typed number the way it is stored", () => {
    expect(normalizeCertificateNumber(" mc-2026-1 ")).toBe("MC-2026-0001");
    expect(normalizeCertificateNumber("MC-2026-0042")).toBe("MC-2026-0042");
    expect(normalizeCertificateNumber("MC-2026-12345")).toBe("MC-2026-12345");
    for (const bad of ["MC-2026-0", "MANCI-2026-0001", "MC-26-0001", "MC-2026-1234567", ""]) expect(normalizeCertificateNumber(bad), bad).toBeNull();
    expect(certificateVerifyPath("MC-2026-0001")).toBe("/certificates/verify?number=MC-2026-0001");
  });
});

describe("the signed message and its signature", () => {
  it("is three lines: the version, the number, the SHA-256", () => {
    const sha = "a".repeat(64);
    expect(certificateMessage("MC-2026-0001", sha)).toBe(`Manci certificate v1\nNumber: MC-2026-0001\nSHA-256: ${sha}`);
    expect(() => certificateMessage("MC-2026-0001", sha.toUpperCase())).toThrow(/lowercase/);
    expect(() => certificateMessage("MANCI-2026-0001", sha)).toThrow(/number/);
  });

  it("verifies for the signer, this number and this hash only, raw or in an off-chain envelope", async () => {
    const wallet = await certificateSigner();
    const other = await certificateSigner();
    const { sha256 } = await fixturePayload({ signer: wallet.address });
    const message = certificateMessage("MC-2026-0001", sha256);
    const raw = await wallet.sign("MC-2026-0001", sha256);
    expect(signatureFromBase58(raw)).toHaveLength(64);
    expect(await certificateSignatureFormat(message, wallet.address, raw)).toBe("raw");
    // A Ledger behind Phantom signs the off-chain envelope instead: accepted, and reported as such.
    const envelope = await wallet.sign("MC-2026-0001", sha256, "offchain-v0");
    expect(await certificateSignatureFormat(message, wallet.address, envelope)).toBe("offchain-v0");
    const legacy = await wallet.sign("MC-2026-0001", sha256, "offchain-v0-legacy");
    expect(await certificateSignatureFormat(message, wallet.address, legacy, "offchain-v0-legacy")).toBe("offchain-v0-legacy");
    // Another signer, another number, a tampered payload (another hash), garbage.
    expect(await certificateSignatureFormat(message, other.address, raw)).toBeNull();
    expect(await certificateSignatureFormat(message, wallet.address, await other.sign("MC-2026-0001", sha256))).toBeNull();
    expect(await certificateSignatureFormat(certificateMessage("MC-2026-0002", sha256), wallet.address, raw)).toBeNull();
    const tampered = await fixturePayload({ signer: wallet.address, chain: chainFacts("holding", { units: BigInt(2_500) }) });
    expect(await certificateSignatureFormat(certificateMessage("MC-2026-0001", tampered.sha256), wallet.address, raw)).toBeNull();
    expect(await certificateSignatureFormat(message, wallet.address, "not-base58!")).toBeNull();
    expect(await certificateSignatureFormat(message, "not an address", raw)).toBeNull();
  });
});

describe("the public projection", () => {
  async function storedRow(over: Partial<CertificateRow> = {}) {
    const wallet = await certificateSigner();
    const { canonical, sha256 } = await fixturePayload({
      signer: wallet.address,
      holder: { wallet: HOLDER, name: "Petar Petrović", idNumber: "ID-TEST-0001" },
    });
    const row: CertificateRow = {
      id: "00000000-0000-4000-8000-000000000001",
      network: "devnet",
      number: "MC-2026-0001",
      kind: "holding",
      status: "anchored",
      asset_pda: "HzjgBogwPPMzj5m2CgGLyPUv5Qz27TmvbFy9MWbevuv6",
      share_class_pda: SHARE_CLASS,
      holder_wallet: HOLDER,
      payload_canonical: canonical,
      payload_sha256: sha256,
      signer: wallet.address,
      signature: await wallet.sign("MC-2026-0001", sha256),
      signature_format: "raw",
      signed_at: "2026-11-08T10:16:00.000Z",
      anchor_tx: EVIDENCE_TX,
      anchor_slot: 380_124_000,
      anchor_block_time: "2026-11-08T10:17:00.000Z",
      anchored_at: "2026-11-08T10:17:30.000Z",
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
      created_by: wallet.address,
      created_at: "2026-11-08T10:15:30.123Z",
      updated_at: "2026-11-08T10:17:30.000Z",
      ...over,
    };
    return row;
  }
  const checks = { signatureValid: true, hashConsistent: true, providedSha256: null };

  it("never carries the holder's name or ID number, the statement, the reason or the people behind the row", async () => {
    const row = await storedRow({ status: "revoked", revoked_at: "2026-11-09T08:00:00.000Z", revoked_by: fixedAddress(30), revoke_reason: "Holder Petar asked; ID ID-TEST-0001" });
    const view = publicCertificateView(row, checks);
    const text = JSON.stringify(view);
    for (const secret of ["Petar", "Petrovi", "ID-TEST-0001", "statement", "revoke_reason", "revoked_by", "created_by", fixedAddress(30), "salt", row.payload_canonical]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(view).toMatchObject({ found: true, status: "revoked", revoked_at: "2026-11-09T08:00:00.000Z", holder_wallet: HOLDER });
  });

  it("shows a valid, anchored certificate with its facts and says whether a given hash matches", async () => {
    const row = await storedRow();
    expect(publicCertificateView(row, { ...checks, providedSha256: row.payload_sha256 })).toMatchObject({
      found: true,
      number: "MC-2026-0001",
      status: "valid",
      anchored: true,
      kind: "holding",
      holding: { units: "250", percent_of_company: "2.5" },
      company: COMPANY,
      anchor: { tx: EVIDENCE_TX, slot: 380_124_000 },
      hash_matches: true,
      signature_valid: true,
    });
    expect(publicCertificateView(row, { ...checks, providedSha256: "0".repeat(64) }).hash_matches).toBe(false);
  });

  it("answers not found for a draft or a draft discarded before it was signed, and invalid when a re-check fails", async () => {
    const draft = await storedRow({ status: "draft", signature: null, signature_format: null, signed_at: null, anchor_tx: null, anchored_at: null });
    expect(publicCertificateView(draft, checks)).toEqual({ found: false, number: "MC-2026-0001", hash_matches: null });
    const discarded = { ...draft, status: "revoked" as const, revoked_at: "2026-11-09T08:00:00.000Z" };
    expect(publicCertificateView(discarded, checks).found).toBe(false);
    const row = await storedRow();
    expect(publicCertificateView(row, { ...checks, signatureValid: false })).toMatchObject({ status: "invalid" });
    expect(publicCertificateView(row, { ...checks, hashConsistent: false })).toMatchObject({ status: "invalid" });
  });

  it("lists a row without its payload", async () => {
    const row = await storedRow();
    const item = certificateListItem(row);
    expect(item).toMatchObject({ number: "MC-2026-0001", asset_label: "MANCI 17.5% · MANCI0 · class 0", issued_at: "2026-11-08T10:15:30.123Z" });
    expect(item && "payload_canonical" in item).toBe(false);
    expect(JSON.stringify(item)).not.toContain("Petar");
  });
});

describe("the holder's JSON file on the verification page", () => {
  it("hashes the exact bytes and the canonical content, so a reformatted copy still matches", async () => {
    const { canonical, sha256 } = await fixturePayload();
    const exact = await readCertificateFile(new File([canonical], "MC-2026-0001.json", { type: "application/json" }));
    expect(exact).toMatchObject({ rawSha256: sha256, canonicalSha256: sha256, number: "MC-2026-0001" });
    const pretty = await readCertificateFile(new File([JSON.stringify(JSON.parse(canonical), null, 2)], "copy.json"));
    expect(pretty.rawSha256).not.toBe(sha256);
    expect(pretty.canonicalSha256).toBe(sha256);
    const edited = await readCertificateFile(new File([canonical.replace('"units":"250"', '"units":"2500"')], "edited.json"));
    expect(edited.canonicalSha256).not.toBe(sha256);
    await expect(readCertificateFile(new File(["not json"], "x.json"))).rejects.toThrow(/does not parse/);
    await expect(readCertificateFile(new File(["x".repeat(70_000)], "big.json"))).rejects.toThrow(/64 KB/);
  });
});

describe("a stored payload", () => {
  it("parses only canonical v1 payloads of the right shape", async () => {
    const { canonical } = await fixturePayload();
    expect(() => parseCertificatePayload(canonical.replace('"schema":', ' "schema":'))).toThrow(CertificatePayloadError);
    const wrongSchema = await canonicalDigest({ ...JSON.parse(canonical), schema: "manci.certificate.v2" });
    expect(() => parseCertificatePayload(wrongSchema.canonical)).toThrow(/unknown schema/);
    const noHolding = await canonicalDigest({ ...JSON.parse(canonical), holding: null });
    expect(() => parseCertificatePayload(noHolding.canonical)).toThrow(/holding/);
  });
});
