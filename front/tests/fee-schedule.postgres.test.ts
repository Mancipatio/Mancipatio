// 0089 on isolated PostgreSQL: the fee schedule's lifecycle (draft ->
// published only through publish_fee_schedule -> retired; published rows
// never edited; only drafts deleted) and the charges ledger's (only against
// the published, in-effect price of its kind; due -> invoiced -> paid or
// waived; amount and reference immutable; never deleted; one open charge
// per reference), plus the privileges and the network guard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0089_fee_schedule.sql"), "utf8");
const db = new LocalPostgres();

/** A new draft of `kind` (conversion by default); returns its id. */
function draft(kind = "conversion", extra: { effective_from?: string; label?: string } = {}): string {
  return db.query(
    `insert into public.fee_schedule(kind,payer,fixed_eur,rate_bps,min_eur,public_label,created_by,effective_from)
     values (:'kind', case when :'kind' = 'conversion' then 'holder' else 'issuer' end, 0, 100, 150, :'label', 'admin-wallet',
             nullif(:'effective', '')::timestamptz) returning id`,
    { kind, label: extra.label ?? `Fee ${kind}`, effective: extra.effective_from ?? "" },
  );
}
const revision = (id: string) => db.query("select updated_at::text from public.fee_schedule where id = :'id'", { id });
/** publish_fee_schedule as the routes call it; returns the published row's status. */
function publish(id: string, expected = revision(id), network = "devnet"): string {
  return db.query(
    "set role service_role; select status from public.publish_fee_schedule(:'id'::uuid, :'network', 'super-admin', :'expected'::timestamptz)",
    { id, expected, network },
  );
}
const status = (id: string) => db.query("select status from public.fee_schedule where id = :'id'", { id });
/** A charge against `schedule`; returns its id. */
function charge(schedule: string, extra: { kind?: string; ref?: string; payer?: string } = {}): string {
  return db.query(
    `set role service_role; insert into public.fee_charges(kind,schedule_id,payer_client_id,ref_type,ref_id,base_amount_eur,amount_eur,created_by)
     values (:'kind', :'schedule'::uuid, nullif(:'payer','')::uuid, 'other', :'ref', 10000, 150, 'admin-wallet') returning id`,
    { schedule, kind: extra.kind ?? "conversion", ref: extra.ref ?? `REF-${Math.random().toString(36).slice(2, 10)}`, payer: extra.payer ?? "" },
  );
}
const chargeField = (id: string, field: string) => db.query(`select ${field}::text from public.fee_charges where id = :'id'`, { id });

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0089 fee schedule and charges on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("keeps both tables private to the browser roles; the service role never deletes a charge", () => {
    for (const table of ["fee_schedule", "fee_charges"]) {
      expect(db.query(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
      expect(db.query(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${table}'`)).toBe("0");
      for (const role of ["anon", "authenticated"]) {
        expect(() => db.query(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
        expect(() => db.query(`set role ${role}; insert into public.${table}(kind) values ('conversion')`)).toThrow(/permission denied/);
      }
    }
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.query(`set role ${role}; select public.publish_fee_schedule(gen_random_uuid(), 'devnet', 'x', now())`))
        .toThrow(/permission denied/);
    }
    expect(db.query("set role service_role; select count(*) from public.fee_schedule")).toBe("0");
    expect(() => db.query("set role service_role; delete from public.fee_charges")).toThrow(/permission denied/);
  });

  it("starts every price as a draft of this network and stamps the database clock", () => {
    expect(() => db.query(
      "insert into public.fee_schedule(kind,payer,public_label,created_by,status) values ('conversion','holder','Conversion','admin','published')",
    )).toThrow(/starts as a draft/);
    const id = db.query(
      `insert into public.fee_schedule(kind,payer,public_label,created_by,published_by,published_at,created_at)
       values ('otc','seller','OTC','admin','spoofed', now(), '2000-01-01') returning id`,
    );
    expect(db.query("select network||'|'||status||'|'||coalesce(published_by,'-')||'|'||(published_at is null)||'|'||(created_at > '2020-01-01') from public.fee_schedule where id = :'id'", { id }))
      .toBe("devnet|draft|-|true|true");
    db.query("delete from public.fee_schedule where id = :'id'", { id });
  });

  it("refuses malformed prices", () => {
    const insert = (columns: string, values: string) =>
      db.query(`insert into public.fee_schedule(kind,payer,public_label,created_by,${columns}) values ('conversion','holder','Fee','admin',${values})`);
    expect(() => insert("min_eur,max_eur", "200,100")).toThrow(/check constraint/);
    expect(() => insert("rate_bps", "10001")).toThrow(/check constraint/);
    expect(() => insert("fixed_eur", "-1")).toThrow(/check constraint/);
    expect(() => insert("collection", "'card'")).toThrow(/check constraint/);
    expect(() => db.query("insert into public.fee_schedule(kind,payer,public_label,created_by) values ('custody','holder','Fee','admin')")).toThrow(/check constraint/);
    expect(() => db.query("insert into public.fee_schedule(kind,payer,public_label,created_by) values ('conversion','platform','Fee','admin')")).toThrow(/check constraint/);
    expect(() => db.query("insert into public.fee_schedule(kind,payer,public_label,created_by) values ('conversion','holder','  ','admin')")).toThrow(/check constraint/);
    // The 0071 guard: a devnet project never takes a mainnet row.
    expect(() => db.query("insert into public.fee_schedule(network,kind,payer,public_label,created_by) values ('mainnet','conversion','holder','Fee','admin')"))
      .toThrow(/does not belong to this devnet project/);
  });

  it("publishes only through publish_fee_schedule, never into the past, and retires the previous version with it", () => {
    const first = draft("conversion", { effective_from: "2001-01-01" });
    // A plain update cannot publish, even with every field a published row needs.
    expect(() => db.query(
      "set role service_role; update public.fee_schedule set status = 'published', published_by = 'x', effective_from = now() where id = :'id'",
      { id: first },
    )).toThrow(/publish_fee_schedule/);
    expect(publish(first)).toBe("published");
    // A past date becomes the publication time; who and when are recorded.
    expect(db.query("select (effective_from = published_at)||'|'||published_by||'|'||(effective_from > now() - interval '1 minute') from public.fee_schedule where id = :'id'", { id: first }))
      .toBe("true|super-admin|true");

    const second = draft("conversion", { label: "Conversion v2" });
    const before = revision(second);
    expect(() => publish(second, "2000-01-01 00:00:00+00")).toThrow(/changed or is no longer a draft/);
    expect(() => publish(second, before, "mainnet")).toThrow(/Fee not found/);
    expect(() => publish(first)).toThrow(/changed or is no longer a draft/);
    expect(publish(second, before)).toBe("published");
    expect(status(first)).toBe("retired");
    expect(db.query("select retired_by||'|'||(retired_at is not null) from public.fee_schedule where id = :'id'", { id: first })).toBe("super-admin|true");
    expect(db.query("select count(*) from public.fee_schedule where kind = 'conversion' and status = 'published'")).toBe("1");
    expect(db.query("select indexdef from pg_indexes where indexname = 'fee_schedule_one_published'")).toContain("WHERE (status = 'published'::text)");
    // A kind's first price may be announced for later: its planned date is kept.
    const planned = draft("otc", { effective_from: "2099-01-01" });
    publish(planned);
    expect(db.query("select effective_from::date::text from public.fee_schedule where id = :'id'", { id: planned })).toBe("2099-01-01");
    // A replacement dated in the future would retire the price in force before it applies: refused, nothing changes.
    const later = draft("conversion", { effective_from: "2099-01-01", label: "Conversion v3" });
    expect(() => publish(later)).toThrow(/takes effect when it is published/);
    // The SQLSTATE the route maps to 409 (psql prints it in verbose mode).
    expect(() => db.query(
      "\\set VERBOSITY verbose\nset role service_role; select status from public.publish_fee_schedule(:'id'::uuid, 'devnet', 'super-admin', :'expected'::timestamptz)",
      { id: later, expected: revision(later) },
    )).toThrow(/MF001/);
    expect([status(second), status(later)]).toEqual(["published", "draft"]);
  });

  it("never edits a published price, never changes a retired one, and deletes only drafts", () => {
    const id = draft("tokenization_setup");
    publish(id);
    for (const change of ["fixed_eur = 1", "public_note = 'typo fixed'", "payer = 'buyer'", "effective_from = now() + interval '1 day'", "status = 'draft'"]) {
      expect(() => db.query(`set role service_role; update public.fee_schedule set ${change} where id = :'id'`, { id }), change)
        .toThrow(/cannot be edited/);
    }
    expect(() => db.query("set role service_role; delete from public.fee_schedule where id = :'id'", { id })).toThrow(/Only a draft fee can be deleted/);
    expect(() => db.query("set role service_role; update public.fee_schedule set status = 'retired' where id = :'id'", { id })).toThrow(/records who retired it/);
    db.query("set role service_role; update public.fee_schedule set status = 'retired', retired_by = 'super-admin' where id = :'id'", { id });
    expect(db.query("select status||'|'||(retired_at is not null) from public.fee_schedule where id = :'id'", { id })).toBe("retired|true");
    for (const change of ["status = 'published'", "public_label = 'Revived'", "updated_by = 'someone'"]) {
      expect(() => db.query(`set role service_role; update public.fee_schedule set ${change} where id = :'id'`, { id }), change)
        .toThrow(/retired fee is immutable/);
    }
    expect(() => db.query("set role service_role; delete from public.fee_schedule where id = :'id'", { id })).toThrow(/Only a draft fee can be deleted/);
    const scrap = draft("primary_sale");
    db.query("set role service_role; delete from public.fee_schedule where id = :'id'", { id: scrap });
    expect(db.query("select count(*) from public.fee_schedule where id = :'id'", { id: scrap })).toBe("0");
  });

  it("gives every write a strictly newer revision and keeps the author", () => {
    const id = draft("migration_setup");
    const first = revision(id);
    db.query("set role service_role; update public.fee_schedule set public_label = 'One', created_by = 'spoofed', updated_at = '2000-01-01' where id = :'id'", { id });
    const second = revision(id);
    db.query("set role service_role; update public.fee_schedule set public_label = 'Two' where id = :'id'", { id });
    const third = revision(id);
    const later = (a: string, b: string) => db.query("select :'b'::timestamptz > :'a'::timestamptz", { a, b });
    expect(later(first, second)).toBe("t");
    expect(later(second, third)).toBe("t");
    expect(db.query("select created_by from public.fee_schedule where id = :'id'", { id })).toBe("admin-wallet");
    // A stale compare-and-swap matches nothing.
    expect(db.query("set role service_role; update public.fee_schedule set public_label = 'Stale' where id = :'id' and updated_at = :'rev'::timestamptz returning id", { id, rev: first })).toBe("");
  });

  it("books a charge only against the published, in-effect price of its kind", () => {
    const published = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'published'");
    const unpublished = draft("conversion", { label: "Conversion draft" });
    expect(() => charge(unpublished)).toThrow(/needs the published fee of its kind/);
    expect(() => charge(published, { kind: "otc" })).toThrow(/needs the published fee of its kind/);
    const retired = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'retired' limit 1");
    expect(() => charge(retired)).toThrow(/needs the published fee of its kind/);
    const future = db.query("select id from public.fee_schedule where kind = 'otc' and status = 'published'");
    expect(() => charge(future, { kind: "otc" })).toThrow(/not in effect yet/);
    expect(() => db.query(
      "insert into public.fee_charges(kind,schedule_id,ref_type,ref_id,amount_eur,created_by,status) values ('conversion', :'s'::uuid, 'other', 'X', 1, 'a', 'paid')",
      { s: published },
    )).toThrow(/starts as due/);
    const id = db.query(
      `insert into public.fee_charges(kind,schedule_id,ref_type,ref_id,amount_eur,created_by,invoice_ref,paid_at)
       values ('conversion', :'s'::uuid, 'other', 'PREFILLED', 150, 'admin', 'INV-early', now()) returning id`,
      { s: published },
    );
    expect(db.query("select network||'|'||status||'|'||coalesce(invoice_ref,'-')||'|'||(paid_at is null) from public.fee_charges where id = :'id'", { id }))
      .toBe("devnet|due|-|true");
  });

  it("moves a charge only forward, with its invoice reference and waiver reason", () => {
    const schedule = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'published'");
    const id = charge(schedule);
    const update = (set: string) => db.query(`set role service_role; update public.fee_charges set ${set} where id = :'id'`, { id });
    expect(() => update("status = 'paid'")).toThrow(/illegal fee charge status transition: due -> paid/);
    expect(() => update("status = 'invoiced'")).toThrow(/check constraint/);
    expect(() => update("invoice_ref = 'INV-1'")).toThrow(/set when the charge is invoiced/);
    update("status = 'invoiced', invoice_ref = 'INV-1'");
    expect(chargeField(id, "invoiced_at") !== "").toBe(true);
    expect(() => update("invoice_ref = 'INV-2'")).toThrow(/set when the charge is invoiced/);
    for (const change of ["amount_eur = 1", "base_amount_eur = 1", "quantity = 2", "ref_id = 'OTHER'", "kind = 'otc'", "created_by = 'x'"]) {
      expect(() => update(change), change).toThrow(/immutable/);
    }
    update("status = 'paid', note = 'Paid by bank transfer'");
    expect(chargeField(id, "status") + "|" + (chargeField(id, "paid_at") !== "")).toBe("paid|true");
    expect(() => update("status = 'waived', waived_reason = 'Too late'")).toThrow(/illegal fee charge status transition: paid -> waived/);
    expect(() => db.query("delete from public.fee_charges where id = :'id'", { id })).toThrow(/never deleted/);

    const other = charge(schedule);
    expect(() => db.query("set role service_role; update public.fee_charges set status = 'waived' where id = :'id'", { id: other })).toThrow(/check constraint/);
    db.query("set role service_role; update public.fee_charges set status = 'waived', waived_reason = 'Design partner' where id = :'id'", { id: other });
    expect(chargeField(other, "waived_at") !== "").toBe(true);
    expect(() => db.query("set role service_role; update public.fee_charges set status = 'invoiced', invoice_ref = 'INV-9' where id = :'id'", { id: other }))
      .toThrow(/illegal fee charge status transition: waived -> invoiced/);
    expect(() => db.query("set role service_role; update public.fee_charges set waived_reason = 'Changed story' where id = :'id'", { id: other }))
      .toThrow(/set when the charge is waived/);
  });

  it("allows one open charge per kind and reference; a waived one frees the reference", () => {
    const schedule = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'published'");
    const first = charge(schedule, { ref: "REQ-42" });
    expect(() => charge(schedule, { ref: "REQ-42" })).toThrow(/fee_charges_one_per_ref/);
    db.query("set role service_role; update public.fee_charges set status = 'waived', waived_reason = 'Booked twice' where id = :'id'", { id: first });
    expect(charge(schedule, { ref: "REQ-42" })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("matches the reference type to the kind and the quantity to a per-unit fee", () => {
    const schedule = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'published'");
    const insert = (refType: string, refId: string, quantity = 1) => db.query(
      `insert into public.fee_charges(kind,schedule_id,ref_type,ref_id,quantity,amount_eur,created_by)
       values ('conversion', :'s'::uuid, :'refType', :'refId', :'quantity'::integer, 150, 'admin')`,
      { s: schedule, refType, refId, quantity: String(quantity) },
    );
    expect(() => insert("application", "00000000-0000-4000-8000-000000000001")).toThrow(/check constraint/);
    expect(() => insert("conversion_request", "not-a-uuid")).toThrow(/check constraint/);
    expect(() => insert("other", "REF-Q", 2)).toThrow(/check constraint/);
    expect(() => insert("other", " ")).toThrow(/check constraint/);
    insert("conversion_request", "00000000-0000-4000-8000-0000000000aa");
  });

  it("keeps a charge when its payer's client row is deleted, clearing only the payer", () => {
    const schedule = db.query("select id from public.fee_schedule where kind = 'conversion' and status = 'published'");
    const client = db.query("insert into public.clients(type) values ('investor') returning id");
    const other = db.query("insert into public.clients(type) values ('investor') returning id");
    const id = charge(schedule, { payer: client });
    expect(() => db.query("set role service_role; update public.fee_charges set payer_client_id = :'other'::uuid where id = :'id'", { id, other }))
      .toThrow(/payer is immutable/);
    // A direct update cannot clear it either; only the foreign key's set null (a nested trigger) does.
    expect(() => db.query("set role service_role; update public.fee_charges set payer_client_id = null where id = :'id'", { id }))
      .toThrow(/payer is immutable/);
    db.query("delete from public.clients where id = :'client'", { client });
    expect(db.query("select coalesce(payer_client_id::text, 'none')||'|'||status from public.fee_charges where id = :'id'", { id })).toBe("none|due");
  });

  it("re-applies cleanly and keeps every row", () => {
    const counts = db.query("select (select count(*) from public.fee_schedule)||'|'||(select count(*) from public.fee_charges)");
    db.query(migration);
    expect(db.query("select (select count(*) from public.fee_schedule)||'|'||(select count(*) from public.fee_charges)")).toBe(counts);
    expect(db.query("select count(*) from pg_trigger where tgname in ('fee_schedule_guard','fee_charges_guard','manci_network_guard') and tgrelid in ('public.fee_schedule'::regclass,'public.fee_charges'::regclass)"))
      .toBe("4");
  });
});
