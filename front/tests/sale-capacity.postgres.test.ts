// Migration 0066 — EUR raise-cap reservations for on-chain sale approvals.
// Runs on an isolated PostgreSQL with the WHOLE migration chain applied, so
// the 0027 SPV trigger, 0056 raise limits and the launch_applications
// triggers are the real ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations } from "./helpers/migrations";

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
  approval?: string; sale?: string; cliff?: number; vesting?: number;
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
    ${o.expires ?? "'2099-01-01T00:00:00Z'"},'${o.by ?? "admin-wallet"}',${o.cliff ?? 0},${o.vesting ?? 0})`;
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
      applyMigrations(db, { network: "devnet" });
      // Re-runnable: both files apply cleanly a second time. Re-applying 0066
      // restores its own function bodies, so 0073 and 0074 follow again (the
      // order a rollback-and-reapply would take).
      for (const file of ["0066_sale_capacity.sql", "0067_sales_sale_approval.sql", "0073_spv_issuance_jobs.sql", "0074_ledger_contract.sql"])
        sql(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => {
    sql(`truncate public.sale_capacity_reservations, public.fx_rates, public.spv_issuances, public.spvs,
        public.spv_issuance_jobs, public.sale_capacity_holds cascade;
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

  it("books a sale even when the SPV is over its cap in the meantime (0073: server bookings are never refused)", () => {
    const r = reserve({ saleId: 1, maxGross: BigInt(1_000_000) * WHOLE, max: BigInt(1_000_000) * WHOLE });
    json(`select public.consume_sale_reservation('${r.id}','${row(r.id).sale_pda}',${BigInt(1_000_000) * WHOLE})`);
    // Someone recorded a large override this calendar year in the meantime.
    sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at,cap_override) values ('${SPV}',2500000,current_date,true)`);
    const result = json(`select public.book_sale_reservation('${r.id}',${BigInt(1_000_000) * WHOLE})`);
    expect(result).toMatchObject({ status: "booked", over_cap: true });
    expect(result.book_error).toBeUndefined();
    expect(sql("select count(*) from public.spv_issuances")).toBe("2");
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
        max_price_per_unit,raise_type,cliff_months,vesting_months,expires_at,amount_eur,fx_rate,fx_kind,reserved_by)
        select network,kind,share_class_pda,sale_id,approval_pda,sale_pda,issuer_pda,spv_id,subject,application_snapshot,
        application_hash,payment_mint,payment_decimals,max_gross_raise,min_price_per_unit,max_price_per_unit,raise_type,
        cliff_months,vesting_months,expires_at,amount_eur,fx_rate,fx_kind,reserved_by from public.sale_capacity_reservations where id='${again.id}'`),
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

  it("grows (never refuses) a consumption larger than the reservation, flagged as adopted", () => {
    const r = reserve({ saleId: 1, maxGross: BigInt(100) * WHOLE, max: BigInt(100) * WHOLE });
    const grown = json(`select public.consume_sale_reservation('${r.id}','${row(r.id).sale_pda}',${BigInt(150) * WHOLE})`);
    expect(grown).toMatchObject({ status: "consumed", amount_eur: 150, adopted: true, grew: true });
    expect(String(grown.last_error)).toMatch(/larger than its reservation/);
    expect(row(r.id).max_gross_raise).toBe(150_000_000);
    expect(json(`select public.book_sale_reservation('${r.id}',${BigInt(150) * WHOLE})`)).toMatchObject({ status: "booked" });
  });

  it("adopts the chain: other terms, a released reservation that landed, or an approval nobody reserved", () => {
    const adopt = (o: { approval?: string; sale?: string; saleId?: number; gross?: bigint; by?: string; hash?: string }) =>
      json(`select public.adopt_sale_approval('devnet','${SC}',${o.saleId ?? 1},'${o.approval ?? `${"G".repeat(40)}002`}',
        '${o.sale ?? `${"H".repeat(40)}002`}','${ASSET}','${ISSUER}','${SPV}','${EURC}',${o.gross ?? BigInt(100) * WHOLE},1,10,
        'mature',0,0,'2099-01-01T00:00:00Z','${o.hash ?? HASH}','${o.by ?? "admin-wallet"}','test')`);
    // Same terms: nothing to do.
    const r = reserve({ saleId: 1, maxGross: BigInt(100) * WHOLE });
    expect(adopt({ approval: String(row(r.id).approval_pda), sale: String(row(r.id).sale_pda) })).toMatchObject({ action: "none" });
    // Larger on-chain terms: counted at them, flagged.
    const bigger = adopt({ approval: String(row(r.id).approval_pda), sale: String(row(r.id).sale_pda), gross: BigInt(400) * WHOLE, by: "other-admin" });
    expect(bigger).toMatchObject({ action: "adopted_terms", amount_eur: 400, adopted: true, reserved_by: "other-admin" });
    expect(bigger.adopted_from).toMatchObject({ max_gross_raise: String(BigInt(100) * WHOLE) });
    // A released reservation whose approval landed anyway is reactivated.
    const late = reserve({ saleId: 2, maxGross: BigInt(50) * WHOLE });
    sql(`select public.release_sale_reservation('${late.id}','tx_failed',null)`);
    expect(capacity()).toMatchObject({ reserved: 400 });
    expect(adopt({ saleId: 2, approval: String(row(late.id).approval_pda), sale: String(row(late.id).sale_pda), gross: BigInt(50) * WHOLE }))
      .toMatchObject({ id: late.id, action: "reactivated", status: "reserved" });
    expect(capacity()).toMatchObject({ reserved: 450 });
    // An approval nobody reserved gets a row, even past the cap.
    const orphan = adopt({ saleId: 9, approval: b58("P"), sale: b58("Q"), gross: BigInt(3_000_000) * WHOLE, hash: "cd".repeat(32) });
    expect(orphan).toMatchObject({ action: "inserted", adopted: true, over_cap: true, application_id: null, amount_eur: 3000000 });
    expect(capacity()).toMatchObject({ reserved: 3000450 });
  });

  it("one application backs one sale; a startup approval carries the application's schedule", () => {
    const app = (type = "mature", extra = "") =>
      sql(`insert into public.launch_applications(applicant_wallet,raise_type,company_name,one_liner,category,raise_amount,
        equity_offered,status,network${extra ? ",cliff_months,vesting_months" : ""}) values ('wallet-${type}-${Math.random()}',
        '${type}','Acme','One line','equity',1000000,5,'approved','devnet'${extra}) returning id`);
    const mature = app();
    const first = reserve({ saleId: 1, app: mature, maxGross: BigInt(100) * WHOLE });
    expect(() => reserve({ saleId: 2, app: mature, maxGross: BigInt(100) * WHOLE })).toThrow(/APPLICATION_ALREADY_APPROVED/);
    sql(`select public.release_sale_reservation('${first.id}','revoked',null)`);
    expect(reserve({ saleId: 2, app: mature, maxGross: BigInt(100) * WHOLE })).toMatchObject({ existing: false });
    const linked = app();
    sql(`update public.launch_applications set linked_sale_pubkey='${b58("R")}' where id='${linked}'`);
    expect(() => reserve({ saleId: 3, app: linked })).toThrow(/APPLICATION_ALREADY_APPROVED/);
    const startup = app("startup", ",6,24");
    expect(() => reserve({ saleId: 4, app: startup, raiseType: "startup", cliff: 0, vesting: 12 })).toThrow(/SCHEDULE_MISMATCH/);
    expect(() => reserve({ saleId: 4, raiseType: "mature", cliff: 1, vesting: 2 })).toThrow(/INVALID_TERMS/);
    expect(reserve({ saleId: 4, app: startup, raiseType: "startup", cliff: 6, vesting: 24 })).toMatchObject({ existing: false });
  });

  it("an SPV subject must belong to the network", () => {
    sql(`update public.spvs set network='testnet' where id='${SPV}'`);
    expect(() => reserve({ saleId: 1 })).toThrow(/SPV_NOT_FOUND/);
    expect(() => capacity()).toThrow(/SPV_NOT_FOUND/);
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

  it("resolves the SPV by its issuer_pda: one legal entity, one cap", () => {
    sql(`update public.spvs set issuer_pda='${ISSUER}' where id='${SPV}'`);
    expect(sql(`select public.sale_capacity_spv('devnet','${ASSET}','${ISSUER}')`)).toBe(SPV);
    // No separate issuer bucket, and no other SPV, for an issuer with an SPV.
    expect(() => reserve({ spv: null })).toThrow(/SPV_SUBJECT_CONFLICT/);
    expect(() => reserve({ spv: SPV_SMALL })).toThrow(/SPV_SUBJECT_CONFLICT/);
    expect(reserve({ spv: SPV })).toMatchObject({ subject: `spv:${SPV}` });
    // A profile that points at another SPV is refused (strict) or overruled (adoption).
    sql(`insert into public.asset_profiles(asset_pda,network,category,spv_id) values('${ASSET}','devnet','equity','${SPV_SMALL}')`);
    expect(() => sql(`select public.sale_capacity_spv('devnet','${ASSET}','${ISSUER}')`)).toThrow(/SPV_SUBJECT_CONFLICT/);
    expect(sql(`select public.sale_capacity_spv('devnet','${ASSET}','${ISSUER}',false)`)).toBe(SPV);
    // An SPV registered for another issuer cannot be charged for this one.
    sql(`delete from public.asset_profiles; update public.spvs set issuer_pda='${STALE}' where id='${SPV}'`);
    expect(() => reserve({ saleId: 2, spv: SPV })).toThrow(/SPV_SUBJECT_CONFLICT/);
    sql(`insert into public.asset_profiles(asset_pda,network,category,spv_id) values('${ASSET}','devnet','equity','${SPV_SMALL}')`);
    expect(sql(`select public.sale_capacity_spv('devnet','${ASSET}','${ISSUER}')`)).toBe(SPV_SMALL);
    sql(`delete from public.asset_profiles`);
  });

  it("an issuer subject takes its dossier's client_raise_limits override, as 0056 does", () => {
    const wallet = b58("J");
    sql(`insert into public.issuers(pda,network,authority,legal_entity_id,jurisdiction,kyb_status,kyb_doc_hash,layout_version,last_slot)
      values('${ISSUER}','devnet','${wallet}','le',688,1,'h',2,1) on conflict do nothing`);
    expect(capacity(`issuer:${ISSUER}`)).toMatchObject({ cap: 3000000, cap_source: "platform" });
    const client = sql(`insert into public.clients(network,type,wallet) values('devnet','issuer','${wallet}') returning id`);
    sql(`insert into public.client_raise_limits(client_id,annual_raise_cap_eur) values('${client}',1000)`);
    expect(capacity(`issuer:${ISSUER}`)).toMatchObject({ cap: 1000, cap_source: "client" });
    expect(() => reserve({ spv: null, maxGross: BigInt(1_001) * WHOLE })).toThrow(/SALE_CAP_EXCEEDED remaining=1000/);
    expect(reserve({ spv: null, maxGross: BigInt(1_000) * WHOLE })).toMatchObject({ subject: `issuer:${ISSUER}` });
    sql(`delete from public.client_raise_limits; delete from public.clients; delete from public.issuers`);
  });

  it("a manual SPV adjustment counts live reservations, and is neither future-dated nor backdated", () => {
    const record = (amount: number, opts: { issued?: string; override?: boolean; backdate?: boolean } = {}) =>
      json(`select public.record_spv_adjustment('${SPV}',${amount},null,${opts.issued ?? "null"},'correction','A correction note',
        'admin-wallet',${opts.override ?? false},${opts.backdate ?? false})`);
    reserve({ maxGross: BigInt(2_500_000) * WHOLE });
    expect(() => record(500_001)).toThrow(/SALE_CAP_EXCEEDED remaining=500000/);
    expect(record(500_000)).toMatchObject({ amount_eur: 500000, source: "manual", capacity: { remaining: 0 } });
    expect(() => record(1, { issued: "current_date + 1" })).toThrow(/ISSUED_AT_IN_FUTURE/);
    expect(() => record(1, { issued: "current_date - 40" })).toThrow(/ISSUED_AT_BACKDATED/);
    // A super admin's override is recorded on the row (0027 lets it through too).
    expect(record(10, { override: true })).toMatchObject({ cap_override: true });
    expect(record(10, { issued: "current_date - 400", backdate: true, override: true })).toMatchObject({ amount_eur: 10 });
    expect(() => sql(`select public.record_spv_adjustment('30000000-0000-4000-8000-00000000000f',1,null,null,'correction','A correction note','a',false,false)`))
      .toThrow(/SPV_NOT_FOUND/);
  });

  it("floors a treasury mint's declared value at EUR 1 and the share class's latest price", () => {
    const treasury = (units: number, eur: number, spv = SPV) =>
      json(`select public.reserve_treasury_mint_capacity('devnet','${SC}','${ASSET}','${ISSUER}','${spv}',${units},
        ${eur},'Founder allocation','{"v":1}'::jsonb,'${HASH}','admin-wallet')`);
    expect(() => treasury(500, 0.5)).toThrow(/TREASURY_VALUE_BELOW_FLOOR floor=1.00/);
    expect(treasury(500, 1)).toMatchObject({ amount_eur: 1 });
    // Latest approval's minimum price (2 EURC) until a sale is indexed.
    reserve({ saleId: 1, maxGross: BigInt(100) * WHOLE, min: BigInt(2) * WHOLE, max: BigInt(2) * WHOLE });
    expect(() => treasury(500, 999.99)).toThrow(/TREASURY_VALUE_BELOW_FLOOR floor=1000/);
    // The indexed sale's price (0.9 EUR/USDC x 4 USDC) wins over the approval.
    sql(`insert into public.sales(pda,network,share_class_pda,mint,payment_mint,proceeds,authority,sale_id,price_per_unit,total_for_sale,
      layout_version,last_slot) values('${b58("K")}','devnet','${SC}','m','${USDC}','p','a',1,${BigInt(4) * WHOLE},10,2,1)`);
    expect(() => treasury(500, 1799.99)).toThrow(/TREASURY_VALUE_BELOW_FLOOR floor=1800/);
    expect(treasury(500, 1800)).toMatchObject({ amount_eur: 1800, floor_eur: 1800 });
    sql(`delete from public.sales`);
  });

  it("books a treasury mint found after its reservation was released (adopted), each signature once", () => {
    const treasury = () =>
      json(`select public.reserve_treasury_mint_capacity('devnet','${SC}','${ASSET}','${ISSUER}','${SPV}',5,
        100,'Founder allocation','{"v":1}'::jsonb,'${HASH}','admin-wallet')`);
    const a = treasury(), b = treasury();
    sql(`select public.release_sale_reservation('${a.id}','expired','retry-worker')`);
    expect(capacity()).toMatchObject({ reserved: 100 });
    const booked = json(`select public.book_treasury_mint('${a.id}','sig-late',null)`);
    expect(booked).toMatchObject({ status: "booked", adopted: true, mint_signature: "sig-late", booked_amount_eur: 100 });
    expect(booked.adopted_from).toMatchObject({ status: "released", release_reason: "expired" });
    expect(capacity()).toMatchObject({ reserved: 100, issued: 100 });
    expect(() => sql(`select public.book_treasury_mint('${b.id}','sig-late',null)`)).toThrow(/MINT_ALREADY_BOOKED/);
    // 0073: a treasury mint over the cap is booked and flagged, never refused.
    sql(`update public.spvs set annual_cap_eur=150 where id='${SPV}'`);
    const over = json(`select public.book_treasury_mint('${b.id}','sig-b',current_date - 3)`);
    expect(over).toMatchObject({ status: "booked", over_cap: true });
    expect(sql(`select (current_date - booked_issued_at) from public.sale_capacity_reservations where id='${b.id}'`)).toBe("3");
  });

  it("publishes an application's listing from any wallet linked to the applicant's account", () => {
    const [owner, linked, stranger] = [b58("J"), b58("K"), b58("L")];
    const account = sql(`insert into public.account_profiles(network,wallet) values('devnet','${owner}') returning id`);
    sql(`insert into public.account_wallets(network,wallet,account_id) values('devnet','${owner}','${account}'),
      ('devnet','${linked}','${account}') on conflict do nothing`);
    const app = sql(`insert into public.launch_applications(applicant_wallet,raise_type,company_name,one_liner,category,raise_amount,
      equity_offered,status,network) values ('${owner}','mature','Acme','One line','equity',1000,5,'approved','devnet') returning id`);
    const save = (issuer: string, sale: string) =>
      sql(`select public.save_launch_listing('devnet','${sale}','${issuer}',false,'{"application_id":"${app}","is_published":true}')`);
    expect(() => save(stranger, "sale-x")).toThrow(/does not belong/);
    expect(save(linked, "sale-y")).toBe("sale-y");
    expect(sql(`select linked_issuer from public.launch_applications where id='${app}'`)).toBe(linked);
    sql(`delete from public.launch_listings; delete from public.account_wallets; delete from public.account_profiles`);
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
  // ── 0073: the ledger driven by the indexer (Talas 5.1) ────────────────────

  const salesRow = (pda: string, status: number, approval: string | null, slot = 10) =>
    `insert into public.sales(pda,network,share_class_pda,mint,payment_mint,proceeds,authority,sale_id,price_per_unit,
      total_for_sale,layout_version,last_slot,last_signature,status,sale_approval)
     values('${pda}','devnet','${SC}','m','${EURC}','p','a',9,1,10,2,${slot},'${"5".repeat(88)}',${status},${approval ? `'${approval}'` : "null"})
     on conflict (network,pda) do update set status=excluded.status,last_slot=excluded.last_slot,sale_approval=excluded.sale_approval`;
  const jobs = (kind = "sale_close") => sql(`select coalesce(string_agg(ref,',' order by ref),'') from public.spv_issuance_jobs where kind='${kind}'`);
  const consumed = (o: Reserve = {}) => {
    const r = reserve(o);
    json(`select public.consume_sale_reservation('${r.id}','${row(r.id).sale_pda}',${o.maxGross ?? BigInt(1_000) * WHOLE})`);
    return r;
  };

  it("enqueues one sale_close job when the mirror sees an approved sale close (never an open, unapproved or stale one)", () => {
    const [open, noApproval, closing] = [b58("P"), b58("Q"), b58("R")];
    sql(salesRow(open, 0, b58("G")));
    sql(salesRow(noApproval, 1, null));
    sql(salesRow(closing, 0, b58("G")));
    expect(jobs()).toBe("");
    sql(salesRow(closing, 1, b58("G"), 11));
    sql(salesRow(closing, 1, b58("G"), 12));
    expect(jobs()).toBe(closing);
    expect(sql(`select observed_signature from public.spv_issuance_jobs`)).toBe("5".repeat(88));
    // A stale snapshot (older slot than the tombstone) is dropped before the trigger.
    const stale = b58("S");
    sql(salesRow(stale, 0, b58("G"), 5));
    sql(`insert into public.indexer_account_versions(network,pda,slot,table_name,closed) values('devnet','${stale}',50,'sales',false)
      on conflict (network,pda) do update set slot=50`);
    sql(salesRow(stale, 1, b58("G"), 6));
    expect(jobs()).toBe(closing);
    // Backfill: re-applying 0073 enqueues every closed approved sale once.
    sql(`delete from public.spv_issuance_jobs`);
    sql(readFileSync(join(process.cwd(), "supabase/migrations/0073_spv_issuance_jobs.sql"), "utf8"));
    sql(readFileSync(join(process.cwd(), "supabase/migrations/0074_ledger_contract.sql"), "utf8"));
    expect(jobs()).toBe(closing);
    sql(`delete from public.sales; delete from public.indexer_account_versions where pda in ('${open}','${noApproval}','${closing}','${stale}')`);
  });

  it("books at the proven close date (never in the future) and counts issuers by that date", () => {
    const r = consumed({ saleId: 1 });
    const salePda = row(r.id).sale_pda as string;
    sql(`insert into public.spv_issuance_jobs(network,kind,ref,closed_at) values('devnet','sale_close','${salePda}',now() - interval '40 days')`);
    const booked = json(`select public.book_sale_reservation('${r.id}',${BigInt(100) * WHOLE})`);
    expect(booked).toMatchObject({ status: "booked", over_cap: false });
    expect(sql(`select (current_date - booked_issued_at) from public.sale_capacity_reservations where id='${r.id}'`)).toBe("40");
    expect(sql(`select (current_date - issued_at) from public.spv_issuances`)).toBe("40");
    // A close date in the future (clock skew) is clamped to today.
    const future = consumed({ saleId: 2 });
    sql(`insert into public.spv_issuance_jobs(network,kind,ref,closed_at) values('devnet','sale_close','${row(future.id).sale_pda}',now() + interval '3 days')`);
    json(`select public.book_sale_reservation('${future.id}',${BigInt(1) * WHOLE})`);
    expect(sql(`select booked_issued_at = current_date from public.sale_capacity_reservations where id='${future.id}'`)).toBe("t");
    // An issuer subject closed 13 months ago no longer counts.
    const old = consumed({ saleId: 3, spv: null });
    sql(`insert into public.spv_issuance_jobs(network,kind,ref,closed_at) values('devnet','sale_close','${row(old.id).sale_pda}',now() - interval '13 months')`);
    json(`select public.book_sale_reservation('${old.id}',${BigInt(500) * WHOLE})`);
    expect(capacity(`issuer:${ISSUER}`)).toMatchObject({ issued: 0 });
  });

  it("books a server sale over the cap (flagged over_cap), never refuses it", () => {
    const r = consumed({ saleId: 1, spv: SPV_SMALL, maxGross: BigInt(90) * WHOLE, max: BigInt(90) * WHOLE });
    sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at,cap_override) values ('${SPV_SMALL}',50,current_date,true)`);
    const booked = json(`select public.book_sale_reservation('${r.id}',${BigInt(90) * WHOLE})`);
    expect(booked).toMatchObject({ status: "booked", over_cap: true, booked_amount_eur: 90 });
    expect(capacity(`spv:${SPV_SMALL}`)).toMatchObject({ issued: 140 });
  });

  it("links a legacy sale row instead of inserting a second one, and reports a different amount", () => {
    const r = consumed({ saleId: 1 });
    const salePda = row(r.id).sale_pda;
    sql(`insert into public.spv_issuances(spv_id,sale_pubkey,amount_eur,issued_at,source) values ('${SPV}','${salePda}',70,current_date,'sale')`);
    expect(() => sql(`insert into public.spv_issuances(spv_id,sale_pubkey,amount_eur,source) values ('${SPV}','${salePda}',1,'sale')`))
      .toThrow(/spv_issuances_sale_once/);
    const booked = json(`select public.book_sale_reservation('${r.id}',${BigInt(100) * WHOLE})`);
    expect(booked).toMatchObject({ status: "booked", linked_existing: true, linked_amount_eur: 70, amount_mismatch: true, booked_amount_eur: 100 });
    expect(sql("select count(*) from public.spv_issuances")).toBe("1");
    expect(capacity()).toMatchObject({ issued: 70 });
    // The ledger job and the backstop booking the same reservation again: still one row.
    json(`select public.book_sale_reservation('${r.id}',${BigInt(100) * WHOLE})`);
    expect(sql("select count(*) from public.spv_issuances")).toBe("1");
  });

  it("manual adjustments: rolling cap, a reason and a note, never a sale; the trigger checks direct manual inserts too", () => {
    const adjust = (amount: number, asset = "null", reason = "'correction'", note = "'A correction note'") =>
      json(`select public.record_spv_adjustment('${SPV_SMALL}',${amount},${asset},null,${reason},${note},'admin-wallet',false,false)`);
    expect(adjust(60)).toMatchObject({ source: "manual", reason_code: "correction", capacity: { remaining: 40 } });
    expect(() => adjust(41)).toThrow(/SALE_CAP_EXCEEDED remaining=40/);
    expect(() => adjust(1, "null", "'other'")).toThrow(/INVALID_TERMS/);
    expect(() => adjust(1, "null", "'correction'", "'short'")).toThrow(/INVALID_TERMS/);
    const r = reserve({ saleId: 3 });
    expect(() => adjust(1, `'${row(r.id).sale_pda}'`)).toThrow(/REF_IS_SALE/);
    expect(() => sql(`select public.spv_manual_row_checks('devnet','${SPV}',null,'${b58("Z")}',false)`)).toThrow(/SALE_PUBKEY_NOT_ALLOWED/);
    // A direct manual insert still meets the (now rolling) trigger; older than 12 months counts against nothing.
    expect(() => sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at) values ('${SPV_SMALL}',41,current_date)`))
      .toThrow(/SPV annual issuance cap exceeded/);
    sql(`insert into public.spv_issuances(spv_id,amount_eur,issued_at) values ('${SPV_SMALL}',500,current_date - interval '13 months')`);
  });

  it("a hold blocks new reservations and adjustments of its subject, never an adoption", () => {
    sql(`select public.place_capacity_hold('devnet','spv:${SPV}','${b58("H")}','ADOPTION_PENDING','${USDC}')`);
    expect(capacity()).toMatchObject({ holds: 1 });
    expect(() => reserve({ saleId: 4 })).toThrow(/SUBJECT_ON_HOLD/);
    expect(() => json(`select public.record_spv_adjustment('${SPV}',1,null,null,'correction','A correction note','a',false,false)`))
      .toThrow(/SUBJECT_ON_HOLD/);
    expect(json(`select public.record_spv_adjustment('${SPV}',1,null,null,'correction','A correction note','a',true,false)`))
      .toMatchObject({ cap_override: true });
    const adopted = json(`select public.adopt_sale_approval('devnet','${SC}',5,'${b58("J")}','${b58("L")}','${ASSET}','${ISSUER}','${SPV}',
      '${EURC}',${BigInt(10) * WHOLE},1,1,'mature',0,0,now()+interval '1 day','${HASH}','admin','test')`);
    expect(adopted).toMatchObject({ action: "inserted", adopted: true });
    sql(`select public.clear_capacity_hold('devnet','spv:${SPV}','${b58("H")}')`);
    expect(reserve({ saleId: 4 })).toMatchObject({ existing: false });
  });

  it("adopts an unreserved treasury mint at its floor, once per mint key, and never below the floor on re-value", () => {
    const adopt = (key: string, units = 500) => json(`select public.adopt_treasury_mint('devnet','${SC}','${ASSET}','${ISSUER}','${SPV}',${units},
      '${key}','admin-wallet',current_date,'{"v":1}'::jsonb,'${HASH}')`);
    const sig = "4".repeat(88);
    // No price anywhere: the EUR 1 minimum, critical for the caller.
    expect(adopt(sig)).toMatchObject({ action: "adopted", basis: "minimum", amount_eur: 1, over_cap: false });
    expect(adopt(sig)).toMatchObject({ action: "existing" });
    expect(sql(`select count(*) from public.spv_issuances where source='treasury_mint'`)).toBe("1");
    // The newest indexed sale price: 500 units x 4 USDC x 0.9 = 1800.
    sql(`insert into public.sales(pda,network,share_class_pda,mint,payment_mint,proceeds,authority,sale_id,price_per_unit,total_for_sale,
      layout_version,last_slot) values('${b58("K")}','devnet','${SC}','m','${USDC}','p','a',1,${BigInt(4) * WHOLE},10,2,1)`);
    const priced = adopt(`${sig}:3`);
    expect(priced).toMatchObject({ basis: "sale_price", amount_eur: 1800, fx_stale: false });
    expect(capacity()).toMatchObject({ issued: 1801 });
    // Re-value: never below the floor, then above it; the SPV row follows.
    expect(() => sql(`select public.revalue_treasury_mint('${priced.id}',1799,'Appraisal by the auditor','super')`)).toThrow(/TREASURY_VALUE_BELOW_FLOOR/);
    const up = json(`select public.revalue_treasury_mint('${priced.id}',2500,'Appraisal by the auditor','super')`);
    expect(up).toMatchObject({ amount_eur: 2500, previous_amount_eur: 1800 });
    expect(capacity()).toMatchObject({ issued: 2501 });
    // A price whose mint has no rate: FX_RATE_MISSING, nothing counted silently.
    sql(`delete from public.fx_rates where payment_mint='${USDC}'`);
    expect(() => adopt(`${sig}:4`)).toThrow(/FX_RATE_MISSING/);
    sql(`delete from public.sales`);
  });

  it("revalue_capacity_fx raises a value counted at a stale rate once a fresh rate exists, and never lowers one", () => {
    const r = reserve({ saleId: 1, mint: USDC, maxGross: BigInt(1_000) * WHOLE, max: BigInt(1_000) * WHOLE });
    expect(row(r.id).amount_eur).toBe(900);
    expect(() => sql(`select public.revalue_capacity_fx('${r.id}')`)).toThrow(/NO_REVALUE_HOLD/);
    sql(`select public.place_capacity_hold('devnet','spv:${SPV}','${r.id}','FX_REVALUE','${USDC}')`);
    sql(`update public.fx_rates set as_of=now()-interval '8 days' where payment_mint='${USDC}'`);
    expect(() => sql(`select public.revalue_capacity_fx('${r.id}')`)).toThrow(/FX_RATE_STALE/);
    // A fresh LOWER rate never lowers the counted value.
    sql(`update public.fx_rates set as_of=now(), eur_per_token=0.5 where payment_mint='${USDC}'`);
    expect(json(`select public.revalue_capacity_fx('${r.id}')`)).toMatchObject({ revalued: true, amount_eur: 900 });
    expect(capacity()).toMatchObject({ holds: 0 });
    // A higher one raises it.
    sql(`select public.place_capacity_hold('devnet','spv:${SPV}','${r.id}','FX_REVALUE','${USDC}')`);
    sql(`update public.fx_rates set eur_per_token=1.2 where payment_mint='${USDC}'`);
    expect(json(`select public.revalue_capacity_fx('${r.id}')`)).toMatchObject({ amount_eur: 1200 });
  });

  it("0073 refuses to run while two sale rows count one sale (SPV_SALE_DUPLICATES)", () => {
    sql(`drop index public.spv_issuances_sale_once`);
    try {
      sql(`insert into public.spv_issuances(spv_id,sale_pubkey,amount_eur,source,cap_override) values
        ('${SPV}','${b58("D")}',1,'sale',true),('${SPV}','${b58("D")}',1,'sale',true)`);
      expect(() => sql(readFileSync(join(process.cwd(), "supabase/migrations/0073_spv_issuance_jobs.sql"), "utf8")))
        .toThrow(/SPV_SALE_DUPLICATES/);
    } finally {
      sql(`delete from public.spv_issuances where sale_pubkey='${b58("D")}'`);
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0073_spv_issuance_jobs.sql"), "utf8"));
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0074_ledger_contract.sql"), "utf8"));
    }
  });

  it("0074: browser roles cannot read spv_issuances; the ledger tables are service-role only", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["spv_issuances", "spv_issuance_jobs", "sale_capacity_holds"]) {
        expect(() => sql(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
      }
      expect(() => sql(`set role ${role}; select public.revalue_capacity_fx(gen_random_uuid())`)).toThrow(/permission denied/);
    }
    expect(sql("select to_regprocedure('public.record_spv_issuance(uuid,numeric,text,text,date,text,text,boolean,boolean)') is null")).toBe("t");
  });
});
