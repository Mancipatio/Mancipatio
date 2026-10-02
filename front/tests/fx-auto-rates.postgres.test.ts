// Migration 0080 — the automatic EUR rate. Runs on an isolated PostgreSQL
// with the WHOLE migration chain applied: the writers and their rate limit,
// fx_effective_rate (the same rule as lib/fx-effective.ts, tests/fx-auto.test.ts)
// and the 0066/0073 ledger functions that now read it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const json = (query: string) => JSON.parse(sql(query)) as Record<string, unknown>;

const SPV = "30000000-0000-4000-8000-000000000001";
const b58 = (c: string) => c.repeat(43);
const SC = b58("A"), ISSUER = b58("B"), ASSET = b58("C"), EURC = b58("D"), USDC = b58("E");
const HASH = "ab".repeat(32);
const WHOLE = BigInt(1_000_000);
const QUOTES = `'{"v":1,"sources":{"kraken":{"rate":"0.88895"}}}'::jsonb`;

const recordRate = (rate = "0.88895", mint = USDC, network = "devnet", maxAge = 900) =>
  json(`select public.record_fx_auto_rate('${network}','${mint}',${rate},6,'auto: median of kraken, coinbase (ECB 2026-10-02: 1.1225 USD/EUR)',${QUOTES},${maxAge})`);
const recordRefusal = (code: string, mint = USDC) =>
  json(`select public.record_fx_auto_refusal('devnet','${mint}','${code}','{"v":1}'::jsonb)`);
/** Moves every observation back, so the 20-second rate limit lets the next run record. */
const age = (interval = "1 minute") => sql(`update public.fx_rate_observations set observed_at = observed_at - interval '${interval}'`);
const claim = (mint = USDC, network = "devnet") => json(`select public.claim_fx_auto_run('${network}','${mint}')`);
const effective = (mint = USDC) => {
  const out = sql(`select to_jsonb(e) from public.fx_effective_rate('devnet','${mint}') e`);
  return out ? (JSON.parse(out) as Record<string, unknown>) : null;
};
function reserve(saleId: number, mint = USDC) {
  const approval = `${"G".repeat(40)}${String(saleId).padStart(3, "2")}`;
  const sale = `${"H".repeat(40)}${String(saleId).padStart(3, "2")}`;
  return json(`select public.reserve_sale_capacity('devnet','${SC}',${saleId},'${approval}','${sale}','${ASSET}',
    '${ISSUER}','${SPV}',null,'{"v":1}'::jsonb,'${HASH}','${mint}',6,${BigInt(1_000) * WHOLE},1,10,'mature',
    '2099-01-01T00:00:00Z','admin-wallet',0,0)`);
}
const reservation = (id: unknown) => json(`select to_jsonb(r) from public.sale_capacity_reservations r where id='${id}'`);
const manual = (rate: string, over = "") =>
  sql(`insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source,as_of${over ? "," + over.split("=")[0] : ""})
    values ('devnet','${USDC}','rate',${rate},6,'ECB',now()${over ? "," + over.split("=")[1] : ""})`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0080 automatic EUR rate", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => {
    sql(`truncate public.sale_capacity_reservations, public.fx_rates, public.fx_auto_rates, public.fx_rate_observations,
        public.fx_auto_runs, public.spv_issuances, public.spvs, public.spv_issuance_jobs, public.sale_capacity_holds cascade;
      insert into public.spvs(id,network,name,annual_cap_eur) values ('${SPV}','devnet','SPV one',3000000);
      insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source,as_of) values
        ('devnet','${EURC}','eur_peg',1,6,'EURC peg',now());`);
  });

  it("records an accepted rate (15 minutes valid) and the observation behind it", () => {
    expect(recordRate()).toMatchObject({ written: true, throttled: false });
    expect(json(`select to_jsonb(a) - 'as_of' - 'updated_at' from public.fx_auto_rates a`)).toEqual({
      network: "devnet", payment_mint: USDC, eur_per_token: 0.88895, decimals: 6, max_age: "00:15:00",
      source: "auto: median of kraken, coinbase (ECB 2026-10-02: 1.1225 USD/EUR)", quotes: { v: 1, sources: { kraken: { rate: "0.88895" } } },
    });
    expect(sql(`select status||'|'||coalesce(code,'-')||'|'||eur_per_token from public.fx_rate_observations`)).toBe("accepted|-|0.8889500000");
    // A newer accepted rate replaces it; the observations keep both.
    age();
    recordRate("0.8891");
    expect(sql(`select eur_per_token from public.fx_auto_rates`)).toBe("0.8891000000");
    expect(sql(`select count(*) from public.fx_rate_observations`)).toBe("2");
  });

  it("records a refusal code without touching the rate", () => {
    recordRate();
    age();
    expect(recordRefusal("ECB_DEVIATION")).toMatchObject({ written: true });
    expect(sql(`select eur_per_token from public.fx_auto_rates`)).toBe("0.8889500000");
    expect(sql(`select string_agg(status||':'||coalesce(code,'-'),',' order by observed_at) from public.fx_rate_observations`))
      .toBe("accepted:-,refused:ECB_DEVIATION");
  });

  it("rate limit: a second observation within 20 seconds is not recorded, accepted or refused", () => {
    recordRate();
    expect(recordRate("0.8899")).toEqual({ written: false, throttled: true });
    expect(recordRefusal("TOO_FEW_SOURCES")).toEqual({ written: false, throttled: true });
    expect(sql(`select count(*) from public.fx_rate_observations`)).toBe("1");
    expect(sql(`select eur_per_token from public.fx_auto_rates`)).toBe("0.8889500000");
    // Another mint has its own window.
    expect(recordRate("0.9", b58("F"))).toMatchObject({ written: true });
  });

  it("claim_fx_auto_run: one claim per 20 seconds per mint, before any source is asked; an observation closes the window too", () => {
    expect(claim()).toEqual({ claimed: true });
    // A concurrent call (or a leaked secret hammering the route) gets no slot, even though nothing was recorded.
    expect(claim()).toEqual({ claimed: false });
    expect(sql(`select count(*) from public.fx_rate_observations`)).toBe("0");
    // The run that claimed records normally: its own claim does not throttle its write.
    expect(recordRate()).toMatchObject({ written: true });
    // Another mint has its own slot.
    expect(claim(b58("F"))).toEqual({ claimed: true });
    // 20 seconds later (claim and observation aged): claimed again.
    sql(`update public.fx_auto_runs set claimed_at = claimed_at - interval '21 seconds'`);
    expect(claim()).toEqual({ claimed: false });
    age("21 seconds");
    expect(claim()).toEqual({ claimed: true });
    // A run whose recording failed still held its slot: the window is the claim's.
    sql(`truncate public.fx_rate_observations; update public.fx_auto_runs set claimed_at = now() - interval '10 seconds'`);
    expect(claim()).toEqual({ claimed: false });
    expect(() => claim("0x12")).toThrow(/INVALID_PAYMENT_MINT/);
    expect(() => claim(USDC, "prod")).toThrow(/INVALID_NETWORK/);
    // The 0071 guard: a devnet project never takes a mainnet claim.
    expect(() => claim(USDC, "mainnet")).toThrow(/mainnet/);
  });

  it("refuses malformed input and keeps 30 days of observations", () => {
    for (const bad of [
      `select public.record_fx_auto_rate('devnet','${USDC}',0,6,'auto',${QUOTES},900)`,
      `select public.record_fx_auto_rate('devnet','${USDC}',0.9,19,'auto',${QUOTES},900)`,
      `select public.record_fx_auto_rate('devnet','${USDC}',0.9,6,'',${QUOTES},900)`,
      `select public.record_fx_auto_rate('devnet','${USDC}',0.9,6,'auto','[]'::jsonb,900)`,
      `select public.record_fx_auto_rate('devnet','${USDC}',0.9,6,'auto',${QUOTES},30)`,
      `select public.record_fx_auto_refusal('devnet','${USDC}','not a code','{}'::jsonb)`,
    ]) expect(() => sql(bad), bad).toThrow(/INVALID_FX_RATE|INVALID_FX_REFUSAL/);
    expect(() => sql(`select public.record_fx_auto_rate('prod','${USDC}',0.9,6,'auto',${QUOTES},900)`)).toThrow(/INVALID_NETWORK/);
    expect(() => sql(`select public.record_fx_auto_rate('devnet','0x12',0.9,6,'auto',${QUOTES},900)`)).toThrow(/INVALID_PAYMENT_MINT/);
    sql(`insert into public.fx_rate_observations(network,payment_mint,observed_at,status,code) values
      ('devnet','${USDC}',now()-interval '31 days','refused','TOO_FEW_SOURCES'),
      ('devnet','${USDC}',now()-interval '29 days','refused','TOO_FEW_SOURCES')`);
    recordRate();
    expect(sql(`select count(*) from public.fx_rate_observations where observed_at < now() - interval '30 days'`)).toBe("0");
    expect(sql(`select count(*) from public.fx_rate_observations`)).toBe("2");
    // An accepted observation always carries its rate, a refusal its code.
    expect(() => sql(`insert into public.fx_rate_observations(network,payment_mint,status) values ('devnet','${USDC}','accepted')`))
      .toThrow(/fx_rate_observations_outcome/);
  });

  it("the 0071 guard: a devnet project never takes a mainnet automatic rate", () => {
    expect(() => recordRate("0.889", USDC, "mainnet")).toThrow(/mainnet/);
    expect(sql(`select count(*) from public.fx_auto_rates`)).toBe("0");
  });

  it("fx_effective_rate: auto while fresh, then the manual fallback, an override or a peg always, else the newest", () => {
    expect(effective()).toBeNull();
    manual("0.9");
    expect(effective()).toMatchObject({ eur_per_token: 0.9, updated_by: null, source: "ECB" });
    recordRate();
    expect(effective()).toMatchObject({ kind: "rate", eur_per_token: 0.88895, updated_by: "fx-auto", max_age: "00:15:00", override_auto: false,
      source: expect.stringMatching(/^auto: median of/) });
    // The automatic rate goes stale: the fresh manual row counts.
    sql(`update public.fx_auto_rates set as_of = now() - interval '16 minutes'`);
    expect(effective()).toMatchObject({ eur_per_token: 0.9, source: "ECB" });
    // Both stale: the most recently observed one.
    sql(`update public.fx_rates set as_of = now() - interval '8 days' where payment_mint='${USDC}'`);
    expect(effective()).toMatchObject({ updated_by: "fx-auto" });
    // An override counts over a fresh automatic rate.
    sql(`update public.fx_auto_rates set as_of = now()`);
    sql(`update public.fx_rates set override_auto = true, as_of = now() where payment_mint='${USDC}'`);
    expect(effective()).toMatchObject({ eur_per_token: 0.9, override_auto: true });
    // A peg never needs a rate.
    sql(`insert into public.fx_auto_rates(network,payment_mint,eur_per_token,decimals,source,quotes,as_of) values
      ('devnet','${EURC}',0.95,6,'auto','{}'::jsonb,now())`);
    expect(effective(EURC)).toMatchObject({ kind: "eur_peg", eur_per_token: 1 });
  });

  it("a reservation locks the automatic rate, with its source, while it is fresh", () => {
    manual("0.9");
    recordRate();
    const r = reserve(1);
    expect(r.amount_eur).toBe(888.95);
    expect(reservation(r.id)).toMatchObject({ fx_rate: 0.88895, fx_kind: "rate", fx_source: expect.stringMatching(/^auto: median of kraken/) });
    // Booking keeps the locked rate whatever the automatic rate does next.
    json(`select public.consume_sale_reservation('${r.id}','${reservation(r.id).sale_pda}',${BigInt(1_000) * WHOLE})`);
    age();
    recordRate("0.95");
    expect(json(`select public.book_sale_reservation('${r.id}',${BigInt(100) * WHOLE})`)).toMatchObject({ booked_amount_eur: 88.9 });
  });

  it("a stale automatic rate: the manual fallback when fresh, FX_RATE_STALE when nothing fresh is left; nothing: FX_RATE_MISSING", () => {
    expect(() => reserve(1)).toThrow(/FX_RATE_MISSING/);
    recordRate();
    sql(`update public.fx_auto_rates set as_of = now() - interval '16 minutes'`);
    expect(() => reserve(1)).toThrow(/FX_RATE_STALE/);
    manual("0.9");
    const r = reserve(2);
    expect(reservation(r.id)).toMatchObject({ fx_rate: 0.9, fx_source: "ECB" });
  });

  it("the treasury floor and the revaluation read the effective rate too", () => {
    const defs = ["reserve_sale_capacity", "adopt_sale_approval", "reserve_treasury_mint_capacity", "treasury_mint_floor", "revalue_capacity_fx"]
      .map((name) => sql(`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='${name}'`));
    for (const def of defs) {
      expect(def).toContain("public.fx_effective_rate(");
      expect(def).not.toMatch(/from public\.fx_rates where/);
    }
    // treasury_mint_floor with an approval priced in USDC: the stale flag follows the automatic rate.
    const r = (() => { manual("0.9"); recordRate(); return reserve(1); })();
    expect(r.id).toBeTruthy();
    const floor = () => json(`select public.treasury_mint_floor('devnet','${SC}',1000000)`);
    expect(floor()).toMatchObject({ basis: "approval_price", fx_missing: false, fx_stale: false, floor_eur: 1 });
    sql(`update public.fx_auto_rates set as_of = now() - interval '16 minutes';
      update public.fx_rates set as_of = now() - interval '8 days' where payment_mint='${USDC}'`);
    expect(floor()).toMatchObject({ fx_stale: true });
  });

  it("is invisible to browser roles; the service role runs the writers and the resolver, never the internal helper", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["fx_auto_rates", "fx_rate_observations", "fx_auto_runs"]) {
        expect(() => sql(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
      }
      expect(() => sql(`set role ${role}; select * from public.fx_effective_rate('devnet','${USDC}')`)).toThrow(/permission denied/);
      expect(() => sql(`set role ${role}; select public.record_fx_auto_refusal('devnet','${USDC}','TOO_FEW_SOURCES','{}'::jsonb)`))
        .toThrow(/permission denied/);
      expect(() => sql(`set role ${role}; select public.claim_fx_auto_run('devnet','${USDC}')`)).toThrow(/permission denied/);
    }
    expect(sql(`set role service_role; select (public.record_fx_auto_refusal('devnet','${USDC}','TOO_FEW_SOURCES','{}'::jsonb))->>'written'`))
      .toBe("true");
    expect(sql(`set role service_role; select count(*) from public.fx_effective_rate('devnet','${EURC}')`)).toBe("1");
    expect(() => sql(`set role service_role; select public.fx_auto_may_record('devnet','${USDC}')`)).toThrow(/permission denied/);
    expect(() => sql(`set role service_role; select public.fx_auto_lock('devnet','${USDC}')`)).toThrow(/permission denied/);
    expect(sql(`set role service_role; select (public.claim_fx_auto_run('devnet','${b58("F")}'))->>'claimed'`)).toBe("true");
    expect(sql(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where t.tgname='manci_network_guard' and c.relname in ('fx_auto_rates','fx_rate_observations','fx_auto_runs')`)).toBe("3");
  });

  it("re-applies cleanly, also after a 0066/0073 rollback re-run", () => {
    const file = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    sql(file("0080_fx_auto_rates.sql"));
    sql(file("0066_sale_capacity.sql"));
    sql(file("0067_sales_sale_approval.sql"));
    sql(file("0073_spv_issuance_jobs.sql"));
    sql(file("0074_ledger_contract.sql"));
    // The rollback restored the direct reads; 0080 again brings the effective rate back.
    manual("0.9");
    recordRate();
    expect(reservation(reserve(1).id)).toMatchObject({ fx_source: "ECB" });
    sql(file("0080_fx_auto_rates.sql"));
    expect(reservation(reserve(2).id)).toMatchObject({ fx_source: expect.stringMatching(/^auto:/) });
  });
});
