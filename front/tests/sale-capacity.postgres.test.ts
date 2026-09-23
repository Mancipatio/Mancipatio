// Migration 0066 — EUR raise-cap reservations for on-chain sale approvals.
// Runs on an isolated PostgreSQL with the WHOLE migration chain applied, so
// the 0027 SPV trigger, 0056 raise limits and the launch_applications
// triggers are the real ones.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const json = (query: string) => JSON.parse(sql(query)) as Record<string, unknown>;

const SPV = "30000000-0000-4000-8000-000000000001";
const SPV_SMALL = "30000000-0000-4000-8000-000000000002";
const b58 = (c: string) => c.repeat(43);
const SC = b58("A"), ISSUER = b58("B"), ASSET = b58("C"), EURC = b58("D"), USDC = b58("E"), STALE = b58("F");
const HASH = "ab".repeat(32);
const WHOLE = BigInt(1_000_000); // 6-decimal payment mints

type Reserve = {
  saleId?: number; spv?: string | null; issuer?: string; app?: string | null; mint?: string; decimals?: number;
  maxGross?: bigint; min?: bigint; max?: bigint; raiseType?: string; expires?: string; by?: string; hash?: string;
  approval?: string; sale?: string;
};
function reserveSql(o: Reserve = {}) {
  const id = o.saleId ?? 1;
  const lit = (v: string | null | undefined) => (v ? `'${v}'` : "null");
  const approval = o.approval ?? `${"G".repeat(40)}${String(id).padStart(3, "2")}`;
  const sale = o.sale ?? `${"H".repeat(40)}${String(id).padStart(3, "2")}`;
  return `select public.reserve_sale_capacity('devnet','${SC}',${id},'${approval}','${sale}','${ASSET}',
    '${o.issuer ?? ISSUER}',${lit(o.spv === undefined ? SPV : o.spv)},${lit(o.app ?? null)},'{"v":1}'::jsonb,
    '${o.hash ?? HASH}','${o.mint ?? EURC}',${o.decimals ?? 6},${o.maxGross ?? BigInt(1_000) * WHOLE},
    ${o.min ?? BigInt(1)},${o.max ?? BigInt(10)},'${o.raiseType ?? "mature"}',
    ${o.expires ?? "'2099-01-01T00:00:00Z'"},'${o.by ?? "admin-wallet"}')`;
}
const reserve = (o: Reserve = {}) => json(reserveSql(o));
const capacity = (subject = `spv:${SPV}`) => json(`select public.sale_capacity('devnet','${subject}')`);
const row = (id: unknown) =>
  json(`select to_jsonb(r) from public.sale_capacity_reservations r where id='${id}'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0066 sale capacity reservations", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(`create role anon;create role authenticated;create role service_role bypassrls;
        create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
        alter table storage.objects enable row level security;
        grant usage on schema public,storage to anon,authenticated,service_role;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
        grant all on storage.objects,storage.buckets to service_role;
        grant all on storage.objects to anon,authenticated;`);
      const dir = join(process.cwd(), "supabase/migrations");
      for (const file of readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) {
        sql(readFileSync(join(dir, file), "utf8"));
      }
      // Re-runnable: both files apply cleanly a second time.
      sql(readFileSync(join(dir, "0066_sale_capacity.sql"), "utf8"));
      sql(readFileSync(join(dir, "0067_sales_sale_approval.sql"), "utf8"));
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => {
    sql(`truncate public.sale_capacity_reservations, public.fx_rates, public.spv_issuances, public.spvs cascade;
      delete from public.launch_applications;
      insert into public.spvs(id,network,name,annual_cap_eur) values
        ('${SPV}','devnet','SPV one',3000000), ('${SPV_SMALL}','devnet','SPV small',100);
      insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source,as_of) values
        ('devnet','${EURC}','eur_peg',1,6,'EURC peg',now()),
        ('devnet','${USDC}','rate',0.9,6,'ECB',now()),
        ('devnet','${STALE}','rate',0.9,6,'ECB',now()-interval '8 days');`);
  });

  it("reserves under the cap and refuses over it, with the remaining capacity in the message", () => {
    const first = reserve({ saleId: 1, maxGross: BigInt(2_500_000) * WHOLE });
    expect(first).toMatchObject({ amount_eur: 2500000, subject: `spv:${SPV}`, existing: false });
    expect(capacity()).toMatchObject({ cap: 3000000, used: 2500000, remaining: 500000, cap_source: "spv" });
    expect(() => reserve({ saleId: 2, maxGross: BigInt(500_001) * WHOLE })).toThrow(
      /SALE_CAP_EXCEEDED remaining=500000(\.00)? cap=3000000(\.00)? window_start=/,
    );
    expect(reserve({ saleId: 2, maxGross: BigInt(500_000) * WHOLE })).toMatchObject({ amount_eur: 500000 });
    expect(capacity()).toMatchObject({ remaining: 0 });
  });

  it("counts a rolling 12-month window: 13 months ago no, 11 months ago yes", () => {
    sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at,cap_override) values
      ('${SPV}',2000000,current_date - interval '13 months',true),
      ('${SPV}',400000,current_date - interval '11 months',true)`);
    expect(capacity()).toMatchObject({ issued: 400000, used: 400000, remaining: 2600000 });
    expect(() => reserve({ maxGross: BigInt(2_600_001) * WHOLE })).toThrow(/SALE_CAP_EXCEEDED/);
    expect(reserve({ maxGross: BigInt(2_600_000) * WHOLE })).toMatchObject({ amount_eur: 2600000 });
  });

  it("counts reserved and consumed, not released, and booked once (through spv_issuances)", () => {
    const a = reserve({ saleId: 1, maxGross: BigInt(100) * WHOLE, max: BigInt(100) * WHOLE });
    const b = reserve({ saleId: 2, maxGross: BigInt(200) * WHOLE, max: BigInt(200) * WHOLE });
    const c = reserve({ saleId: 3, maxGross: BigInt(300) * WHOLE, max: BigInt(300) * WHOLE });
    expect(capacity()).toMatchObject({ reserved: 600, used: 600 });
    sql(`select public.release_sale_reservation('${c.id}','revoked','admin-wallet')`);
    expect(capacity()).toMatchObject({ reserved: 300 });
    // Consumption shrinks a (100 → 50: price 5 x 10 units).
    const consumed = json(`select public.consume_sale_reservation('${a.id}','${row(a.id).sale_pda}',${BigInt(50) * WHOLE})`);
    expect(consumed).toMatchObject({ status: "consumed", amount_eur: 50 });
    expect(capacity()).toMatchObject({ reserved: 250, issued: 0 });
    // Booking 40 moves it from the reservation into spv_issuances.
    const booked = json(`select public.book_sale_reservation('${a.id}',${BigInt(40) * WHOLE})`);
    expect(booked).toMatchObject({ status: "booked", booked_amount_eur: 40 });
    expect(capacity()).toMatchObject({ reserved: 200, issued: 40, used: 240 });
    expect(sql(`select source||'|'||amount_eur||'|'||sale_pubkey||'|'||recorded_by from public.spv_issuances`)).toBe(
      `sale|40.00|${row(a.id).sale_pda}|server`,
    );
    expect(row(a.id).booked_issuance_id).not.toBeNull();
    // Idempotent: a second book does not insert a second issuance.
    json(`select public.book_sale_reservation('${a.id}',${BigInt(40) * WHOLE})`);
    expect(sql("select count(*) from public.spv_issuances")).toBe("1");
    void b;
  });

  it("an issuer subject uses the platform cap and counts booked_amount_eur", () => {
    const subject = `issuer:${ISSUER}`;
    const r = reserve({ spv: null, maxGross: BigInt(1_000) * WHOLE, max: BigInt(1_000) * WHOLE });
    expect(r.subject).toBe(subject);
    expect(capacity(subject)).toMatchObject({ cap: 3000000, cap_source: "platform", reserved: 1000 });
    json(`select public.consume_sale_reservation('${r.id}','${row(r.id).sale_pda}',${BigInt(1_000) * WHOLE})`);
    json(`select public.book_sale_reservation('${r.id}',${BigInt(700) * WHOLE})`);
    expect(capacity(subject)).toMatchObject({ issued: 700, reserved: 0, used: 700 });
    expect(sql("select count(*) from public.spv_issuances")).toBe("0");
    sql("update public.platform_raise_limits set annual_raise_cap_eur=1000 where network='devnet'");
    expect(() => reserve({ saleId: 9, spv: null, maxGross: BigInt(301) * WHOLE })).toThrow(/SALE_CAP_EXCEEDED remaining=300/);
    sql("update public.platform_raise_limits set annual_raise_cap_eur=3000000 where network='devnet'");
  });

  it("serializes concurrent reservations of one subject", async () => {
    const slow = (saleId: number) =>
      db.queryAsync(`begin; ${reserveSql({ saleId, maxGross: BigInt(2_000_000) * WHOLE })}; select pg_sleep(0.4); commit;`);
    const results = await Promise.allSettled([slow(1), slow(2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/SALE_CAP_EXCEEDED/);
    expect(capacity()).toMatchObject({ reserved: 2000000 });
  });

  it("refuses a missing, stale or mis-scaled FX rate; a peg is 1:1 and amounts round up", () => {
    expect(() => reserve({ mint: b58("J") })).toThrow(/FX_RATE_MISSING/);
    expect(() => reserve({ mint: STALE })).toThrow(/FX_RATE_STALE/);
    expect(() => reserve({ mint: USDC, decimals: 9 })).toThrow(/FX_DECIMALS_MISMATCH/);
    expect(reserve({ saleId: 1, maxGross: BigInt(123_456_789) })).toMatchObject({ amount_eur: 123.46 });
    // 1 base unit at 0.9 EUR/token = 0.0000009 EUR -> one cent.
    const r = reserve({ saleId: 2, mint: USDC, maxGross: BigInt(1), max: BigInt(1) });
    expect(r.amount_eur).toBe(0.01);
    expect(row(r.id)).toMatchObject({ fx_rate: 0.9, fx_kind: "rate", fx_source: "ECB" });
    // The peg check constraint.
    expect(() => sql(`insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source) values ('devnet','${b58("K")}','eur_peg',1.01,6,'x')`)).toThrow(/fx_rates_peg_is_one/);
  });

  it("books at the locked rate, and a closed-unsold sale releases as closed_unsold", () => {
    const r = reserve({ saleId: 1, mint: USDC, maxGross: BigInt(1_000) * WHOLE, max: BigInt(1_000) * WHOLE });
    expect(r.amount_eur).toBe(900);
    const salePda = row(r.id).sale_pda;
    json(`select public.consume_sale_reservation('${r.id}','${salePda}',${BigInt(1_000) * WHOLE})`);
    // A newer rate does not change the booking.
    sql(`update public.fx_rates set eur_per_token=2 where payment_mint='${USDC}'`);
    expect(json(`select public.book_sale_reservation('${r.id}',${BigInt(100) * WHOLE})`)).toMatchObject({ booked_amount_eur: 90 });
    const unsold = reserve({ saleId: 2, maxGross: BigInt(10) * WHOLE, max: BigInt(10) * WHOLE });
    json(`select public.consume_sale_reservation('${unsold.id}','${row(unsold.id).sale_pda}',${BigInt(10) * WHOLE})`);
    expect(json(`select public.book_sale_reservation('${unsold.id}',0)`)).toMatchObject({
      status: "released", release_reason: "closed_unsold", booked_amount_eur: 0,
    });
    expect(() => sql(`select public.consume_sale_reservation('${r.id}','${b58("M")}',1)`)).toThrow(/SALE_MISMATCH/);
  });

  it("keeps a sale consumed with last_error when the 0027 calendar-year trigger refuses the booking", () => {
    const r = reserve({ saleId: 1, maxGross: BigInt(1_000_000) * WHOLE, max: BigInt(1_000_000) * WHOLE });
    json(`select public.consume_sale_reservation('${r.id}','${row(r.id).sale_pda}',${BigInt(1_000_000) * WHOLE})`);
    // Someone recorded a large override this calendar year in the meantime.
    sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at,cap_override) values ('${SPV}',2500000,current_date,true)`);
    const result = json(`select public.book_sale_reservation('${r.id}',${BigInt(1_000_000) * WHOLE})`);
    expect(result).toMatchObject({ status: "consumed" });
    expect(String(result.book_error)).toMatch(/annual issuance cap exceeded/);
    expect(String(row(r.id).last_error)).toMatch(/annual issuance cap exceeded/);
    expect(sql("select count(*) from public.spv_issuances")).toBe("1");
  });

  it("keeps one live reservation per sale id: same terms are idempotent, other terms refuse, a release frees it", () => {
    const first = reserve({ saleId: 7 });
    expect(reserve({ saleId: 7 })).toMatchObject({ id: first.id, existing: true });
    expect(() => reserve({ saleId: 7, max: BigInt(11) })).toThrow(/RESERVATION_EXISTS/);
    sql(`update public.sale_capacity_reservations set chain_confirmed_at=now() where id='${first.id}'`);
    expect(() => reserve({ saleId: 7 })).toThrow(/RESERVATION_EXISTS/);
    sql(`select public.release_sale_reservation('${first.id}','revoked','admin-wallet')`);
    const again = reserve({ saleId: 7, max: BigInt(11) });
    expect(again.id).not.toBe(first.id);
    // Bypassing the function still hits the partial unique index.
    expect(() =>
      sql(`insert into public.sale_capacity_reservations(network,kind,share_class_pda,sale_id,approval_pda,sale_pda,issuer_pda,
        spv_id,subject,application_snapshot,application_hash,payment_mint,payment_decimals,max_gross_raise,min_price_per_unit,
        max_price_per_unit,raise_type,expires_at,amount_eur,fx_rate,fx_kind,reserved_by)
        select network,kind,share_class_pda,sale_id,approval_pda,sale_pda,issuer_pda,spv_id,subject,application_snapshot,
        application_hash,payment_mint,payment_decimals,max_gross_raise,min_price_per_unit,max_price_per_unit,raise_type,
        expires_at,amount_eur,fx_rate,fx_kind,reserved_by from public.sale_capacity_reservations where id='${again.id}'`),
    ).toThrow(/duplicate key/);
  });

  it("releases only reserved rows, and repeated transitions are safe", () => {
    const r = reserve({ saleId: 1 });
    expect(json(`select public.release_sale_reservation('${r.id}','tx_failed',null)`)).toMatchObject({ status: "released", release_reason: "tx_failed" });
    expect(json(`select public.release_sale_reservation('${r.id}','revoked',null)`)).toMatchObject({ release_reason: "tx_failed" });
    const c = reserve({ saleId: 2 });
    json(`select public.confirm_sale_reservation('${c.id}','sig-1')`);
    expect(json(`select public.confirm_sale_reservation('${c.id}','sig-2')`)).toMatchObject({ approve_signature: "sig-1" });
    json(`select public.consume_sale_reservation('${c.id}','${row(c.id).sale_pda}',10)`);
    expect(json(`select public.consume_sale_reservation('${c.id}','${row(c.id).sale_pda}',10)`)).toMatchObject({ status: "consumed" });
    expect(() => sql(`select public.release_sale_reservation('${c.id}','revoked',null)`)).toThrow(/RESERVATION_NOT_RELEASABLE/);
    expect(() => sql(`select public.book_sale_reservation('${r.id}',1)`)).toThrow(/RESERVATION_NOT_CONSUMED/);
    expect(() => sql(`select public.release_sale_reservation('${c.id}','closed_unsold',null)`)).toThrow(/INVALID_RELEASE_REASON/);
  });

  it("checks the linked application: approved, same network and raise type, amount within the raise", () => {
    const app = (status: string, raise: number, wallet: string, type = "mature") =>
      sql(`insert into public.launch_applications(applicant_wallet,raise_type,company_name,one_liner,category,raise_amount,
        equity_offered,status,network) values ('${wallet}','${type}','Acme','One line','equity',${raise},5,'${status}','devnet')
        returning id`);
    const pending = app("pending", 1000, "wallet-1");
    const approved = app("approved", 1000, "wallet-2");
    const startup = app("approved", 1000, "wallet-3", "startup");
    expect(() => reserve({ app: pending })).toThrow(/APPLICATION_NOT_APPROVED/);
    expect(() => reserve({ app: startup })).toThrow(/RAISE_TYPE_MISMATCH/);
    expect(() => reserve({ app: approved, maxGross: BigInt(1_001) * WHOLE })).toThrow(/APPLICATION_AMOUNT_EXCEEDED/);
    expect(reserve({ app: approved, maxGross: BigInt(1_000) * WHOLE })).toMatchObject({ amount_eur: 1000 });
  });

  it("reserves and books an admin-issuer treasury mint", () => {
    const r = json(`select public.reserve_treasury_mint_capacity('devnet','${SC}','${ASSET}','${ISSUER}','${SPV}',500,
      1234.561,'Founder allocation','{"v":1}'::jsonb,'${HASH}','admin-wallet')`);
    expect(r).toMatchObject({ amount_eur: 1234.57, subject: `spv:${SPV}` });
    expect(capacity()).toMatchObject({ reserved: 1234.57 });
    const booked = json(`select public.book_treasury_mint('${r.id}','tx-sig',null)`);
    expect(booked).toMatchObject({ status: "booked", mint_signature: "tx-sig", booked_amount_eur: 1234.57 });
    expect(capacity()).toMatchObject({ reserved: 0, issued: 1234.57 });
    expect(sql("select source from public.spv_issuances")).toBe("treasury_mint");
    expect(json(`select public.book_treasury_mint('${r.id}','tx-sig',null)`)).toMatchObject({ status: "booked" });
    expect(() => sql(`select public.book_treasury_mint('${r.id}','other-sig',null)`)).toThrow(/RESERVATION_ALREADY_BOOKED/);
    expect(() =>
      sql(`select public.reserve_treasury_mint_capacity('devnet','${SC}','${ASSET}','${ISSUER}','${SPV_SMALL}',1,101,'x','{}'::jsonb,'${HASH}','a')`),
    ).toThrow(/SALE_CAP_EXCEEDED/);
  });

  it("is invisible to browser roles and executable only by the service role", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["sale_capacity_reservations", "fx_rates"]) {
        expect(() => sql(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
      }
      expect(() => sql(`set role ${role}; select public.sale_capacity('devnet','spv:${SPV}')`)).toThrow(/permission denied/);
      expect(() => sql(`set role ${role}; ${reserveSql()}`)).toThrow(/permission denied/);
    }
    expect(JSON.parse(sql(`set role service_role; select public.sale_capacity('devnet','spv:${SPV}')`))).toMatchObject({ cap: 3000000 });
    expect(sql(`set role service_role; select count(*) from public.fx_rates`)).toBe("3");
  });
});
