// 0087 certificates on an isolated PostgreSQL with the whole migration chain:
// the per-network yearly number allocator (consecutive under concurrency,
// four digits then more, the year checked against the database clock), the
// row's own integrity (the hash is the hash of the stored canonical bytes,
// the columns say what the payload says), the lifecycle guard (born a draft;
// draft -> signed -> anchored, any -> revoked; nothing signed changes; the
// database stamps the times; revoked is final; only a draft can be deleted),
// default-deny for the browser roles, the counter table closed even to the
// service role, and the network guard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";
import { HOLDER, fixedAddress, fixturePayload } from "./helpers/certificate-fixtures";

const db = new LocalPostgres();
const SIGNER = fixedAddress(23);
const SIGNATURE = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const ANCHOR = "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ";
const ADMIN = fixedAddress(24);

/** Inserts a draft of `number` as the service role and returns its id. */
async function insertDraft(number: string, over: { sha256?: string; network?: string; kind?: "holding" | "issuance"; holder?: string | null } = {}) {
  const kind = over.kind ?? "holding";
  const { canonical, sha256 } = await fixturePayload({ number, kind, signer: SIGNER });
  const holder = over.holder === undefined ? (kind === "holding" ? HOLDER : null) : over.holder;
  return db.query(
    `set role service_role;
     insert into public.certificates (network, number, kind, asset_pda, share_class_pda, holder_wallet, payload_canonical, payload_sha256, signer, created_by)
     values (:'network', :'number', :'kind', :'asset', :'share_class', nullif(:'holder', ''), :'canonical', :'sha256', :'signer', :'signer')
     returning id`,
    {
      network: over.network ?? "devnet",
      number,
      kind,
      asset: JSON.parse(canonical).asset.asset_pda,
      share_class: JSON.parse(canonical).share_class.share_class_pda,
      holder: holder ?? "",
      canonical,
      sha256: over.sha256 ?? sha256,
      signer: SIGNER,
    },
  );
}
const asService = (sql: string, vars?: Record<string, string>) => db.query(`set role service_role; ${sql}`, vars);
const statusOf = (id: string) => db.query(`select status from public.certificates where id = :'id'`, { id });

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0087 certificates on isolated PostgreSQL", () => {
  let year = 0;
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      year = Number(db.query("select extract(year from (now() at time zone 'UTC'))::integer"));
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("keeps both tables away from the browser roles and the counter away from the service role", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.query(`set role ${role}; select * from public.certificates`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; select * from public.certificate_counters`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; select public.allocate_certificate_number(${year})`)).toThrow(/permission denied/);
    }
    expect(() => asService("select * from public.certificate_counters")).toThrow(/permission denied/);
    expect(() => asService(`insert into public.certificate_counters (year, last_value) values (${year}, 5000)`)).toThrow(/permission denied/);
    expect(db.query("select relrowsecurity from pg_class where oid = 'public.certificates'::regclass")).toBe("t");
    expect(db.query("select relrowsecurity from pg_class where oid = 'public.certificate_counters'::regclass")).toBe("t");
  });

  it("allocates consecutive numbers per year, four digits first, and refuses a year far from the database clock", () => {
    expect(asService(`select public.allocate_certificate_number(${year})`)).toBe(`MC-${year}-0001`);
    expect(asService(`select public.allocate_certificate_number(${year})`)).toBe(`MC-${year}-0002`);
    // The year after starts its own series (accepted within a year of the clock).
    expect(asService(`select public.allocate_certificate_number(${year + 1})`)).toBe(`MC-${year + 1}-0001`);
    expect(() => asService(`select public.allocate_certificate_number(${year + 2})`)).toThrow(/Invalid certificate year/);
    expect(() => asService("select public.allocate_certificate_number(2025)")).toThrow(/Invalid certificate year/);
    expect(() => asService("select public.allocate_certificate_number(null)")).toThrow(/Invalid certificate year/);
    // Past 9999 the number grows a digit instead of being cut (lpad would cut it).
    db.query(`update public.certificate_counters set last_value = 9999 where year = ${year + 1}`);
    expect(asService(`select public.allocate_certificate_number(${year + 1})`)).toBe(`MC-${year + 1}-10000`);
    expect(db.query(`select network from public.certificate_counters where year = ${year}`)).toBe("devnet");
  });

  it("gives concurrent callers distinct, consecutive numbers", async () => {
    db.query(`delete from public.certificate_counters where year = ${year}`);
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () => db.queryAsync(`set role service_role; select public.allocate_certificate_number(${year})`)),
    );
    expect(new Set(numbers).size).toBe(12);
    expect([...numbers].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `MC-${year}-${String(i + 1).padStart(4, "0")}`));
  });

  it("stores a draft only when the hash is of the stored bytes and the columns match the payload", async () => {
    const id = await insertDraft("MC-2026-0101");
    expect(statusOf(id)).toBe("draft");
    expect(db.query(`select network || '|' || created_by from public.certificates where id = :'id'`, { id })).toBe(`devnet|${SIGNER}`);
    await expect(insertDraft("MC-2026-0102", { sha256: "0".repeat(64) })).rejects.toThrow(/certificates_payload_hash/);
    // The payload says MC-2026-0103; a row claiming another number is refused.
    const { canonical, sha256 } = await fixturePayload({ number: "MC-2026-0103", signer: SIGNER });
    expect(() =>
      asService(
        `insert into public.certificates (number, kind, asset_pda, share_class_pda, holder_wallet, payload_canonical, payload_sha256, signer, created_by)
         values ('MC-2026-0104', 'holding', :'asset', :'share_class', :'holder', :'canonical', :'sha256', :'signer', :'signer')`,
        {
          asset: JSON.parse(canonical).asset.asset_pda,
          share_class: JSON.parse(canonical).share_class.share_class_pda,
          holder: HOLDER,
          canonical,
          sha256,
          signer: SIGNER,
        },
      ),
    ).toThrow(/certificates_payload_columns/);
    // A holding names its wallet.
    await expect(insertDraft("MC-2026-0105", { holder: null })).rejects.toThrow(/certificates_payload_columns|certificates_kind_holder/);
    // One number per network.
    await expect(insertDraft("MC-2026-0101")).rejects.toThrow(/certificates_number_unique/);
  });

  it("is born a draft: a row cannot be inserted already signed", async () => {
    const { canonical, sha256 } = await fixturePayload({ number: "MC-2026-0110", signer: SIGNER });
    expect(() =>
      asService(
        `insert into public.certificates (number, kind, status, asset_pda, share_class_pda, holder_wallet, payload_canonical, payload_sha256, signer, signature, signature_format, signed_at, created_by)
         values ('MC-2026-0110', 'holding', 'signed', :'asset', :'share_class', :'holder', :'canonical', :'sha256', :'signer', :'signature', 'raw', now(), :'signer')`,
        {
          asset: JSON.parse(canonical).asset.asset_pda,
          share_class: JSON.parse(canonical).share_class.share_class_pda,
          holder: HOLDER,
          canonical,
          sha256,
          signer: SIGNER,
          signature: SIGNATURE,
        },
      ),
    ).toThrow(/created as a draft/);
  });

  it("moves draft -> signed -> anchored -> revoked, stamping each time, and refuses every other move", async () => {
    const id = await insertDraft("MC-2026-0120");
    const vars = { id, signature: SIGNATURE, anchor: ANCHOR, admin: ADMIN };
    // No status kept, no step back, no skipping, no signing without a signature.
    expect(() => asService(`update public.certificates set status = 'draft' where id = :'id'`, vars)).toThrow(/cannot move from draft to draft/);
    expect(() => asService(`update public.certificates set status = 'anchored', anchor_tx = :'anchor' where id = :'id'`, vars)).toThrow(/cannot move from draft to anchored/);
    expect(() => asService(`update public.certificates set status = 'signed' where id = :'id'`, vars)).toThrow(/needs its signature/);

    // The signed_at a caller sends is replaced by the database's clock.
    asService(`update public.certificates set status = 'signed', signature = :'signature', signature_format = 'raw', signed_at = '2000-01-01' where id = :'id'`, vars);
    expect(statusOf(id)).toBe("signed");
    expect(db.query(`select signed_at > now() - interval '1 minute' from public.certificates where id = :'id'`, vars)).toBe("t");

    // Nothing signed changes any more.
    const { canonical, sha256 } = await fixturePayload({ number: "MC-2026-0120", signer: SIGNER, salt: "f".repeat(32) });
    expect(() => asService(`update public.certificates set status = 'anchored', anchor_tx = :'anchor', payload_canonical = :'canonical', payload_sha256 = :'sha256' where id = :'id'`, { ...vars, canonical, sha256 }))
      .toThrow(/payload is immutable/);
    expect(() => asService(`update public.certificates set status = 'anchored', anchor_tx = :'anchor', signature = :'anchor' where id = :'id'`, vars))
      .toThrow(/signature never changes/);
    expect(() => asService(`update public.certificates set status = 'draft', signature = null, signature_format = null, signed_at = null where id = :'id'`, vars))
      .toThrow(/cannot move from signed to draft/);
    expect(() => asService(`update public.certificates set status = 'anchored' where id = :'id'`, vars)).toThrow(/needs the anchor transaction/);

    asService(`update public.certificates set status = 'anchored', anchor_tx = :'anchor', anchor_slot = 380123999, anchor_block_time = now() where id = :'id'`, vars);
    expect(statusOf(id)).toBe("anchored");
    expect(db.query(`select anchored_at is not null from public.certificates where id = :'id'`, vars)).toBe("t");
    expect(() => asService(`update public.certificates set status = 'revoked', revoked_by = :'admin', revoke_reason = 'Issued in error', anchor_tx = :'signature' where id = :'id'`, vars))
      .toThrow(/anchor never changes/);
    expect(() => asService(`update public.certificates set status = 'revoked' where id = :'id'`, vars)).toThrow(/needs who and why/);

    asService(`update public.certificates set status = 'revoked', revoked_by = :'admin', revoke_reason = 'Issued in error' where id = :'id'`, vars);
    expect(db.query(`select status || '|' || (revoked_at is not null) || '|' || anchor_tx from public.certificates where id = :'id'`, vars))
      .toBe(`revoked|true|${ANCHOR}`);
    // Revoked is final.
    expect(() => asService(`update public.certificates set revoke_reason = 'Another reason' where id = :'id'`, vars)).toThrow(/revoked certificate is final/);
  });

  it("revokes a draft (a discarded number stays on record) and deletes only drafts", async () => {
    const draft = await insertDraft("MC-2026-0130");
    const discarded = await insertDraft("MC-2026-0131");
    const signed = await insertDraft("MC-2026-0132");
    asService(`update public.certificates set status = 'signed', signature = :'signature', signature_format = 'raw' where id = :'id'`, { id: signed, signature: SIGNATURE });
    asService(`update public.certificates set status = 'revoked', revoked_by = :'admin', revoke_reason = 'Discarded draft' where id = :'id'`, { id: discarded, admin: ADMIN });
    expect(statusOf(discarded)).toBe("revoked");
    expect(() => asService(`update public.certificates set status = 'revoked', revoked_by = :'admin', revoke_reason = 'no' where id = :'id'`, { id: signed, admin: ADMIN }))
      .toThrow(/revoke_reason_check|check constraint/);
    expect(() => asService(`delete from public.certificates where id = :'id'`, { id: signed })).toThrow(/Only a draft certificate can be deleted/);
    expect(() => asService(`delete from public.certificates where id = :'id'`, { id: discarded })).toThrow(/Only a draft certificate can be deleted/);
    asService(`delete from public.certificates where id = :'id'`, { id: draft });
    expect(db.query(`select count(*) from public.certificates where id = :'id'`, { id: draft })).toBe("0");
  });

  it("refuses a row of another network (0071 guard) and an issuance that names a holder", async () => {
    await expect(insertDraft("MC-2026-0140", { network: "mainnet" })).rejects.toThrow(/mainnet/);
    await expect(insertDraft("MC-2026-0141", { kind: "issuance", holder: HOLDER })).rejects.toThrow(/certificates_payload_columns|certificates_kind_holder/);
    const issuance = await insertDraft("MC-2026-0142", { kind: "issuance" });
    expect(db.query(`select kind || '|' || coalesce(holder_wallet, 'none') from public.certificates where id = :'id'`, { id: issuance })).toBe("issuance|none");
  });
});
