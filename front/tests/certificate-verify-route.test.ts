// POST /api/certificates/verify — the public check behind /certificates/verify.
// Unsigned and open in KYC-only mode (this suite also runs with the mode on:
// vitest.config.ts KYC_ONLY_OPEN_SUITES). It answers "not found" for what was
// never issued, re-verifies the stored hash and signature before it says
// "valid", says whether a given hash matches, and never returns the holder's
// name or ID number, the statement that repeats them, or the revocation
// reason. Burst and shared rate limits, a small body cap. Supabase is in
// memory; the shared limiter is mocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";
import { COMPANY, EVIDENCE_TX, HOLDER, certificateSigner, fixturePayload } from "./helpers/certificate-fixtures";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
const limiter = vi.hoisted(() => ({ answer: "ok" as "ok" | "limited" | "unavailable", keys: [] as string[] }));
vi.mock("@/lib/server/shared-rate-limit", () => ({
  consumeSharedRateLimit: vi.fn(async (key: string) => {
    limiter.keys.push(key);
    return limiter.answer;
  }),
}));

import { POST } from "@/app/api/certificates/verify/route";

const NAME = "Petar Petrović";
const ID_NUMBER = "ID-TEST-0001";
let ipCounter = 0;

async function verify(body: unknown, ip = `198.51.100.${++ipCounter % 250}`) {
  const res = await POST(new Request("https://www.manci.io/api/certificates/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: res.status, cache: res.headers.get("cache-control"), text: await res.clone().text(), body: (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}

/** A certificate stored as the routes leave it, signed by a fresh wallet. */
async function store(over: Record<string, unknown> = {}, kind: "holding" | "issuance" = "holding") {
  const wallet = await certificateSigner();
  const number = typeof over.number === "string" ? over.number : "MC-2026-0001";
  const { canonical, sha256 } = await fixturePayload({
    number,
    kind,
    signer: wallet.address,
    ...(kind === "holding" ? { holder: { wallet: HOLDER, name: NAME, idNumber: ID_NUMBER } } : {}),
  });
  const row = {
    id: crypto.randomUUID(),
    network: "devnet",
    number,
    kind,
    status: "anchored",
    payload_canonical: canonical,
    payload_sha256: sha256,
    signer: wallet.address,
    signature: await wallet.sign(number, sha256),
    signature_format: "raw",
    signed_at: "2026-11-08T10:16:00.000Z",
    anchor_tx: EVIDENCE_TX,
    anchor_slot: 380_124_000,
    anchor_block_time: "2026-11-08T10:17:00.000Z",
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    created_by: wallet.address,
    ...over,
  };
  db.ref!.rows("certificates").push(row);
  return row;
}

beforeEach(() => {
  db.ref = memorySupabase();
  limiter.answer = "ok";
  limiter.keys = [];
});

describe("POST /api/certificates/verify", () => {
  it("answers a valid, anchored certificate with its public facts, re-verified, and never the holder's personal data", async () => {
    const row = await store({ revoke_reason: null });
    const res = await verify({ number: "mc-2026-1" });
    expect(res.status).toBe(200);
    expect(res.cache).toBe("no-store");
    expect(res.body.data).toMatchObject({
      found: true,
      number: "MC-2026-0001",
      status: "valid",
      anchored: true,
      kind: "holding",
      network: "devnet",
      company: COMPANY,
      asset: { asset_id: "MANCI-2026", symbol: "MANCI0" },
      share_class: { units_for_100_percent: "10000", unit_percent: "0.01" },
      holding: { units: "250", percent_of_company: "2.5", slot: "380123456" },
      holder_wallet: HOLDER,
      signer: row.signer,
      signature: row.signature,
      signature_format: "raw",
      signature_valid: true,
      payload_sha256: row.payload_sha256,
      anchor: { tx: EVIDENCE_TX, slot: 380_124_000 },
      hash_matches: null,
    });
    for (const secret of ["Petar", "Petrovi", ID_NUMBER, "statement", "salt", "created_by", "revoke_reason"]) {
      expect(res.text, secret).not.toContain(secret);
    }
  });

  it("says whether a given hash matches, accepting a shasum line", async () => {
    const row = await store();
    const match = await verify({ number: "MC-2026-0001", sha256: `${row.payload_sha256.toUpperCase()}  MC-2026-0001.json` });
    expect(match.body.data).toMatchObject({ found: true, hash_matches: true });
    const other = await verify({ number: "MC-2026-0001", sha256: "0".repeat(64) });
    expect(other.body.data).toMatchObject({ found: true, hash_matches: false });
    expect((await verify({ number: "MC-2026-0001", sha256: "abc" })).status).toBe(400);
  });

  it("answers not found for an unknown number, a draft, and a draft discarded before signing", async () => {
    expect((await verify({ number: "MC-2026-0009" })).body.data).toEqual({ found: false, number: "MC-2026-0009", hash_matches: null });
    await store({ number: "MC-2026-0002", status: "draft", signature: null, signature_format: null, signed_at: null, anchor_tx: null, anchor_slot: null, anchor_block_time: null });
    expect((await verify({ number: "MC-2026-0002" })).body.data).toMatchObject({ found: false });
    await store({ number: "MC-2026-0003", status: "revoked", signature: null, signature_format: null, signed_at: null, anchor_tx: null, revoked_at: "2026-11-09T08:00:00.000Z", revoke_reason: "Discarded draft" });
    const discarded = await verify({ number: "MC-2026-0003" });
    expect(discarded.body.data).toMatchObject({ found: false });
    expect(discarded.text).not.toContain("Discarded");
  });

  it("answers revoked with the date for a signed certificate, without the reason", async () => {
    await store({ status: "revoked", revoked_at: "2026-11-09T08:00:00.000Z", revoked_by: HOLDER, revoke_reason: `Holder ${NAME} asked` });
    const res = await verify({ number: "MC-2026-0001" });
    expect(res.body.data).toMatchObject({ found: true, status: "revoked", revoked_at: "2026-11-09T08:00:00.000Z" });
    expect(res.text).not.toContain("asked");
    expect(res.text).not.toContain("Petar");
  });

  it("answers invalid, never valid, when the stored hash or signature does not check out", async () => {
    const row = await store();
    row.payload_canonical = row.payload_canonical.replace('"units":"250"', '"units":"2500"');
    expect((await verify({ number: "MC-2026-0001" })).body.data).toMatchObject({ found: true, status: "invalid" });
    const other = await certificateSigner();
    const forged = await store({ number: "MC-2026-0004" });
    forged.signature = await other.sign("MC-2026-0004", forged.payload_sha256);
    expect((await verify({ number: "MC-2026-0004" })).body.data).toMatchObject({ found: true, status: "invalid", signature_valid: false });
  });

  it("shows an issuance certificate's supply", async () => {
    await store({ number: "MC-2026-0005" }, "issuance");
    expect((await verify({ number: "MC-2026-0005" })).body.data).toMatchObject({
      found: true, kind: "issuance", holder_wallet: null, holding: null,
      supply: { circulating: "250", lifetime_minted: "500", max_supply_percent: "17.5" },
    });
  });

  it("refuses a bad number, a non-JSON body and an oversized body before reading anything", async () => {
    expect((await verify({ number: "MANCI-2026-0001" })).status).toBe(400);
    expect((await verify({})).status).toBe(400);
    expect((await verify("not json")).status).toBe(400);
    expect((await verify({ number: "MC-2026-0001", pad: "x".repeat(4_000) })).status).toBe(413);
    expect(limiter.keys).toEqual([]);
  });

  it("limits bursts per address and honours the shared limit, going on when the shared limiter is unavailable", async () => {
    await store();
    const ip = "203.0.113.7";
    for (let i = 0; i < 20; i++) expect((await verify({ number: "MC-2026-0001" }, ip)).status).toBe(200);
    expect((await verify({ number: "MC-2026-0001" }, ip)).status).toBe(429);
    limiter.answer = "limited";
    expect((await verify({ number: "MC-2026-0001" })).status).toBe(429);
    limiter.answer = "unavailable";
    expect((await verify({ number: "MC-2026-0001" })).status).toBe(200);
    expect(limiter.keys.every((key) => key.startsWith("certificate-verify:"))).toBe(true);
  });

  it("stays open in KYC-only mode: no area or module gate, no signature", () => {
    const source = readFileSync(join(process.cwd(), "app/api/certificates/verify/route.ts"), "utf8");
    expect(source).not.toMatch(/requireArea\(|requireModule\(|verifySigned\(/);
  });
});
