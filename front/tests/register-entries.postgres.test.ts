// Migration 0086 (register entries) against an isolated PostgreSQL built from
// the real migration chain: default-deny RLS, the insert checks (status,
// decision date, document hash, linked conversion), the lifecycle guard
// (recorded -> voided only, immutable content, voided is final, no deletes)
// and the dossier link that may only be detached.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const q = (sql: string) => db.query(sql);

const CLASS = "C1assC1assC1assC1assC1assC1assC1assC1ass1";
const OTHER_CLASS = "C2assC2assC2assC2assC2assC2assC2assC2ass2";
const ASSET = "AssetAssetAssetAssetAssetAssetAssetAsset1";
const MINT = "MintMintMintMintMintMintMintMintMintMint1";
const HOLDER = "Ho1derHo1derHo1derHo1derHo1derHo1derHo1d";
const ADMIN = "AdminAdminAdminAdminAdminAdminAdminAdmin1";
const TX = "5".repeat(88);
const OTHER_TX = "6".repeat(88);
const SHA = "a".repeat(64);
const CONVERTED = "c0000000-0000-4000-8000-000000000001";
const DEPOSITED = "c0000000-0000-4000-8000-000000000002";
const MAINNET_CONVERTED = "c0000000-0000-4000-8000-000000000003";
const CLIENT = "d0000000-0000-4000-8000-000000000001";
const OTHER_CLIENT = "d0000000-0000-4000-8000-000000000002";

/** An INSERT of one entry; `extra` overrides or adds columns (raw SQL values). */
function insertEntry(extra: Record<string, string> = {}): string {
  const columns: Record<string, string> = {
    share_class_pda: `'${CLASS}'`,
    asset_pda: `'${ASSET}'`,
    units: "250",
    percent_bps: "250",
    decision_ref: "'BD 12345/2026'",
    decision_date: "'2026-10-09'",
    decision_doc_sha256: `'${SHA}'`,
    created_by: `'${ADMIN}'`,
    ...extra,
  };
  return `insert into public.register_entries (${Object.keys(columns).join(",")}) values (${Object.values(columns).join(",")}) returning id`;
}

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0086 register entries on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      q(`insert into public.clients (id, type, display_name) values ('${CLIENT}', 'investor', 'Holder'), ('${OTHER_CLIENT}', 'investor', 'Someone else')`);
      q(`insert into public.conversion_requests (id, holder_wallet, client_id, share_class_pda, mint, asset_pda, amount, status, outcome_tx)
         values ('${CONVERTED}', '${HOLDER}', '${CLIENT}', '${CLASS}', '${MINT}', '${ASSET}', 250, 'converted', '${TX}'),
                ('${DEPOSITED}', '${HOLDER}', '${CLIENT}', '${CLASS}', '${MINT}', '${ASSET}', 100, 'deposited', null)`);
      // A converted request of another network (stored before the guard, like 0056's row).
      q(`alter table public.conversion_requests disable trigger manci_network_guard;
         insert into public.conversion_requests (id, network, holder_wallet, share_class_pda, mint, amount, status, outcome_tx)
         values ('${MAINNET_CONVERTED}', 'mainnet', '${HOLDER}', '${CLASS}', '${MINT}', 250, 'converted', '${OTHER_TX}');
         alter table public.conversion_requests enable trigger manci_network_guard;`);
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("is default-deny for the browser roles; the service role reads, records and voids but never deletes", () => {
    expect(q("select relrowsecurity from pg_class where oid='public.register_entries'::regclass")).toBe("t");
    expect(q("select count(*) from pg_policies where schemaname='public' and tablename='register_entries'")).toBe("0");
    for (const role of ["anon", "authenticated"]) {
      expect(() => q(`set role ${role}; select * from public.register_entries`)).toThrow(/permission denied/);
      expect(() => q(`set role ${role}; ${insertEntry()}`)).toThrow(/permission denied/);
    }
    const id = q(`set role service_role; ${insertEntry()}`);
    expect(q(`set role service_role; select network||'|'||status||'|'||registry||'|'||percent_bps from public.register_entries where id='${id}'`))
      .toBe("devnet|recorded|APR|250.0000");
    expect(() => q(`set role service_role; delete from public.register_entries where id='${id}'`)).toThrow(/permission denied/);
    // Even the owner cannot delete: the guard refuses.
    expect(() => q(`delete from public.register_entries where id='${id}'`)).toThrow(/never deleted/);
    q(`set role service_role; update public.register_entries set status='voided', void_reason='Test row', voided_by='${ADMIN}' where id='${id}'`);
  });

  it("refuses a voided insert, a future decision, a bad hash and out-of-range units or percent", () => {
    expect(() => q(insertEntry({ status: "'voided'", void_reason: "'x'", voided_by: `'${ADMIN}'`, voided_at: "now()" }))).toThrow(/recorded first/);
    expect(() => q(insertEntry({ decision_date: "current_date + 5" }))).toThrow(/in the future/);
    expect(() => q(insertEntry({ decision_doc_sha256: `'${"0".repeat(64)}'` }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ decision_doc_sha256: `'${"A".repeat(64)}'` }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ units: "0" }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ units: "18446744073709551616" }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ percent_bps: "0" }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ percent_bps: "10000.0001" }))).toThrow(/check constraint|numeric field overflow/);
    expect(() => q(insertEntry({ realize_tx: "'not-a-signature'" }))).toThrow(/check constraint/);
    expect(() => q(insertEntry({ decision_ref: "'   '" }))).toThrow(/check constraint/);
    // Four decimals of a basis point are kept exactly (1 unit of 1,000,000 = 0.01 bps).
    const id = q(insertEntry({ units: "1234", percent_bps: "12.34" }));
    expect(q(`select percent_bps::text from public.register_entries where id='${id}'`)).toBe("12.3400");
    q(`update public.register_entries set status='voided', void_reason='Test row', voided_by='${ADMIN}' where id='${id}'`);
  });

  it("links only a converted request of the same network and class, with its realize signature", () => {
    expect(() => q(insertEntry({ conversion_request_id: `'${DEPOSITED}'` }))).toThrow(/must be converted/);
    expect(() => q(insertEntry({ conversion_request_id: `'${MAINNET_CONVERTED}'` }))).toThrow(/must be converted/);
    expect(() => q(insertEntry({ conversion_request_id: `'${CONVERTED}'`, share_class_pda: `'${OTHER_CLASS}'` }))).toThrow(/must be converted/);
    expect(() => q(insertEntry({ conversion_request_id: "'c0000000-0000-4000-8000-0000000000ff'" }))).toThrow(/must be converted/);
    expect(() => q(insertEntry({ conversion_request_id: `'${CONVERTED}'`, realize_tx: `'${OTHER_TX}'` }))).toThrow(/outcome_tx/);
    const id = q(insertEntry({ conversion_request_id: `'${CONVERTED}'`, realize_tx: `'${TX}'`, holder_client_id: `'${CLIENT}'` }));
    expect(q(`select conversion_request_id||'|'||realize_tx||'|'||holder_client_id from public.register_entries where id='${id}'`))
      .toBe(`${CONVERTED}|${TX}|${CLIENT}`);
    // One recorded entry per request; voiding frees it for a corrected one.
    expect(() => q(insertEntry({ conversion_request_id: `'${CONVERTED}'` }))).toThrow(/register_entries_conversion_once/);
    q(`update public.register_entries set status='voided', void_reason='Wrong percent', voided_by='${ADMIN}' where id='${id}'`);
    const corrected = q(insertEntry({ conversion_request_id: `'${CONVERTED}'`, realize_tx: `'${TX}'` }));
    expect(q(`select status from public.register_entries where id='${corrected}'`)).toBe("recorded");
    // A linked request can no longer be deleted.
    expect(() => q(`delete from public.conversion_requests where id='${CONVERTED}'`)).toThrow(/foreign key/);
    q(`update public.register_entries set status='voided', void_reason='Test row', voided_by='${ADMIN}' where id='${corrected}'`);
  });

  it("keeps the content immutable: only recorded -> voided, with a reason, the actor and the database's time", () => {
    const id = q(insertEntry({ holder_client_id: `'${CLIENT}'`, created_at: "'2001-01-01'" }));
    // The database stamps the creation time, not the caller.
    expect(q(`select created_at > now() - interval '1 minute' from public.register_entries where id='${id}'`)).toBe("t");
    for (const change of ["units=251", "percent_bps=251", "decision_ref='BD 1/2026'", "decision_date='2026-10-01'",
      `decision_doc_sha256='${"b".repeat(64)}'`, "registry='Other'", "note='edited'", `realize_tx='${TX}'`,
      `share_class_pda='${OTHER_CLASS}'`, "created_by='someone'", "created_at=now()"]) {
      expect(() => q(`set role service_role; update public.register_entries set ${change} where id='${id}'`), change).toThrow(/immutable/);
    }
    expect(() => q(`set role service_role; update public.register_entries set holder_client_id='${OTHER_CLIENT}' where id='${id}'`)).toThrow(/cannot be changed/);
    expect(() => q(`set role service_role; update public.register_entries set status='voided', voided_by='${ADMIN}' where id='${id}'`)).toThrow(/check constraint|needs a reason/);
    expect(() => q(`set role service_role; update public.register_entries set status='voided', void_reason='  ', voided_by='${ADMIN}' where id='${id}'`)).toThrow(/check constraint|needs a reason/);
    expect(() => q(`set role service_role; update public.register_entries set void_reason='early' where id='${id}'`)).toThrow(/check constraint|belong to a voided/);
    q(`set role service_role; update public.register_entries set status='voided', void_reason='Recorded twice', voided_by='${ADMIN}', voided_at='2001-01-01' where id='${id}'`);
    expect(q(`select status||'|'||void_reason||'|'||voided_by||'|'||(voided_at > now() - interval '1 minute') from public.register_entries where id='${id}'`))
      .toBe(`voided|Recorded twice|${ADMIN}|true`);
    // Voided is final: no un-void, no new reason.
    expect(() => q(`set role service_role; update public.register_entries set status='recorded', void_reason=null, voided_by=null, voided_at=null where id='${id}'`)).toThrow(/final/);
    expect(() => q(`set role service_role; update public.register_entries set void_reason='Other reason' where id='${id}'`)).toThrow(/final/);
    // The dossier link can still be detached (the foreign key's ON DELETE SET NULL).
    q(`set role service_role; update public.register_entries set holder_client_id=null where id='${id}'`);
    expect(q(`select holder_client_id is null from public.register_entries where id='${id}'`)).toBe("t");
  });

  it("detaches a deleted dossier from recorded and voided entries alike", () => {
    const client = "d0000000-0000-4000-8000-0000000000aa";
    q(`insert into public.clients (id, type, display_name) values ('${client}', 'investor', 'Gone')`);
    const recorded = q(insertEntry({ holder_client_id: `'${client}'` }));
    const voided = q(insertEntry({ holder_client_id: `'${client}'` }));
    q(`update public.register_entries set status='voided', void_reason='Test row', voided_by='${ADMIN}' where id='${voided}'`);
    q(`delete from public.clients where id='${client}'`);
    expect(q(`select count(*) from public.register_entries where id in ('${recorded}','${voided}') and holder_client_id is null`)).toBe("2");
    expect(q(`select status from public.register_entries where id='${recorded}'`)).toBe("recorded");
    q(`update public.register_entries set status='voided', void_reason='Test row', voided_by='${ADMIN}' where id='${recorded}'`);
  });

  it("carries the network guard and the deployment default", () => {
    expect(q("select pg_get_expr(adbin, adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid='public.register_entries'::regclass and a.attname='network'"))
      .toBe("deployment_network()");
    expect(() => q(insertEntry({ network: "'mainnet'" }))).toThrow(/mainnet/);
    expect(q("select count(*) from pg_trigger where tgrelid='public.register_entries'::regclass and tgname='manci_network_guard'")).toBe("1");
  });
});
