// Migration 0085 (token migrations, V1) on an isolated PostgreSQL with the
// whole migration chain: the ratio and window CHECKs, the campaign and
// deposit lifecycle guards, the units cap under concurrent recording, the
// atomic delivery that never reuses a signature, the refund-once index, the
// write-once final report and burn, and service-role-only access.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (c: string) => c.repeat(32);
let sigN = 0;
/** A distinct, well-formed signature: signatures are unique per network across every test. */
const sig = (_label?: string) => {
  void _label;
  sigN += 1;
  let n = sigN;
  let out = "";
  while (n > 0) { out = BASE58[n % 58] + out; n = Math.floor(n / 58); }
  return out.padStart(88, "2");
};
const LOT = 5000;

let slugN = 0;
/** A draft of the report's worked example (1e9 total, 4e8 excluded, E 12 %, G 1e6 → lot 5,000, cap 120,000). */
function draft(over: Record<string, string> = {}): string {
  slugN += 1;
  const v: Record<string, string> = {
    slug: `'pilot-${slugN}'`,
    company_name: "'Acme d.o.o.'",
    issuer_pda: `'${addr("2")}'`,
    asset_pda: `'${addr("3")}'`,
    share_class_pda: `'${addr("4")}'`,
    new_mint: `'${addr("5")}'`,
    old_mint: `'${addr("6")}'`,
    old_token_program: "'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'",
    old_decimals: "0",
    old_symbol: "'OLD'",
    old_name: "'Old token'",
    old_total_supply: "1000000000",
    excluded_wallets: `array['${addr("7")}']`,
    excluded_wallet_amount: "300000000",
    excluded_manual_amount: "100000000",
    excluded_amount: "400000000",
    supply_read_at: "now()",
    equity_bps: "1200",
    granularity: "1000000",
    lot_base_units: String(LOT),
    units_cap: "120000",
    source: "'founder_transfer'",
    unclaimed_policy: "'return_to_source'",
    deposit_owner: `'${addr("8")}'`,
    deposit_ata: `'${addr(BASE58[slugN % 58])}'`,
    window_opens_at: "now() - interval '1 day'",
    window_closes_at: "now() + interval '74 days'",
    treasury_wallet: `'${addr("9")}'`,
    created_by: `'${addr("a")}'`,
    terms_doc_sha256: `'${"ab".repeat(32)}'`,
    terms_doc_url: "'https://example.com/swap-terms.pdf'",
    ...over,
  };
  const cols = Object.keys(v);
  return `set role service_role; insert into public.token_migrations (${cols.join(",")}) values (${cols.map((c) => v[c]).join(",")}) returning id;`;
}
const create = (over: Record<string, string> = {}) => db.query(draft(over));
const status = (id: string) => db.query(`select status from public.token_migrations where id='${id}'`);
const setStatus = (id: string, to: string) => db.query(`set role service_role; update public.token_migrations set status='${to}' where id='${id}'`);
function deposit(id: string, tx: string, lots: number | null, opts: { reason?: string; holder?: string; amount?: number } = {}) {
  const amount = opts.amount ?? (lots ?? 1) * LOT;
  return JSON.parse(db.query(`set role service_role; select public.record_token_migration_deposit(
    '${id}', '${opts.holder ?? addr("b")}', '${tx}', 123, now(), ${amount}, ${lots ?? "null"},
    ${opts.reason ? `'${opts.reason}'` : "null"}, ${opts.reason ? "'test reason'" : "null"}, 'holder')`)) as {
    created: boolean; id: string; status: string; reason_code: string | null; units_due: string;
  };
}
function deliver(id: string, tx: string, ids: string[]) {
  return JSON.parse(db.query(`set role service_role; select public.record_token_migration_delivery('${id}', '${tx}', array[${ids.map((x) => `'${x}'::uuid`).join(",")}])`)) as {
    created: boolean; count: number;
  };
}
const depositStatus = (id: string) => db.query(`select status||'|'||coalesce(delivery_tx,'')||'|'||coalesce(refund_tx,'') from public.token_migration_deposits where id='${id}'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0085 token migrations on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) { db.close(); throw error; }
  }, 120_000);
  afterAll(() => db.close());

  it("creates drafts on the configured network only, with RLS and no browser-role access", () => {
    const id = create();
    expect(db.query(`select network||'|'||status||'|'||units_cap from public.token_migrations where id='${id}'`)).toBe("devnet|draft|120000");
    expect(() => create({ network: "'mainnet'" })).toThrow(/network/i);
    for (const table of ["token_migrations", "token_migration_deposits"]) {
      expect(db.query(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).toBe("t");
      for (const role of ["anon", "authenticated"]) {
        expect(() => db.query(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
      }
      expect(() => db.query(`set role service_role; delete from public.${table}`)).toThrow(/permission denied/);
    }
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.query(`set role ${role}; select public.record_token_migration_delivery('${id}', '${sig("c")}', array['${id}'::uuid])`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; select public.record_token_migration_deposit('${id}','${addr("b")}','${sig("c")}',1,now(),5000,1,null,null,'holder')`)).toThrow(/permission denied/);
    }
  });

  it("refuses a row that breaks the window, the ratio, the excluded sum or the slug", () => {
    expect(() => create({ window_opens_at: "now()", window_closes_at: "now() + interval '59 days'" })).toThrow(/check constraint/);
    expect(() => create({ window_opens_at: "now()", window_closes_at: "now() + interval '91 days'" })).toThrow(/check constraint/);
    expect(create({ window_opens_at: "now()", window_closes_at: "now() + interval '60 days'" })).toMatch(/^[0-9a-f-]{36}$/);
    expect(create({ window_opens_at: "now()", window_closes_at: "now() + interval '90 days'" })).toMatch(/^[0-9a-f-]{36}$/);
    // N_eff must be floor(S_old / L) and never above N_target (E × G / 10000).
    expect(() => create({ units_cap: "119999" })).toThrow(/check constraint/);
    expect(() => create({ lot_base_units: "4000", units_cap: "150000" })).toThrow(/check constraint/);
    expect(() => create({ excluded_amount: "400000001" })).toThrow(/check constraint/);
    expect(() => create({ granularity: "50000" })).toThrow(/check constraint/);
    expect(() => create({ old_token_program: `'${addr("6")}'` })).toThrow(/check constraint/);
    expect(() => create({ terms_doc_url: "'http://example.com/terms'" })).toThrow(/check constraint/);
    expect(() => create({ slug: "'Bad Slug'" })).toThrow(/check constraint/);
    create({ slug: "'twice'" });
    expect(() => create({ slug: "'twice'" })).toThrow(/duplicate key/);
    expect(() => create({ status: "'open'" })).toThrow(/bare draft/);
  });

  it("moves through its lifecycle, stamps each step and freezes the published terms once open", () => {
    const id = create({ terms_doc_sha256: "null", terms_doc_url: "null" });
    // A draft may change and has no Terms yet; it cannot open without them.
    db.query(`set role service_role; update public.token_migrations set company_name='Acme a.d.' where id='${id}'`);
    expect(() => setStatus(id, "open")).toThrow(/check constraint/);
    db.query(`set role service_role; update public.token_migrations set terms_doc_sha256='${"cd".repeat(32)}', terms_doc_url='https://example.com/t.pdf' where id='${id}'`);
    setStatus(id, "open");
    expect(db.query(`select status||'|'||(opened_at is not null) from public.token_migrations where id='${id}'`)).toBe("open|true");
    for (const change of ["equity_bps=1100, units_cap=110000, lot_base_units=5000", "terms_doc_url='https://example.com/other.pdf'", "treasury_wallet='" + addr("c") + "'", "window_closes_at=window_closes_at + interval '1 day'"]) {
      expect(() => db.query(`set role service_role; update public.token_migrations set ${change} where id='${id}'`), change).toThrow(/frozen|check constraint/);
    }
    expect(() => setStatus(id, "completed")).toThrow(/illegal token migration status transition: open -> completed/);
    expect(() => setStatus(id, "draft")).toThrow(/illegal/);
    setStatus(id, "closed");
    expect(() => setStatus(id, "open")).toThrow(/illegal/);
    expect(db.query(`select (closed_at is not null) from public.token_migrations where id='${id}'`)).toBe("t");
    // A draft can be deleted (it holds no deposit); nothing else can.
    const spare = create();
    db.query(`delete from public.token_migrations where id='${spare}'`);
    expect(() => db.query(`delete from public.token_migrations where id='${id}'`)).toThrow(/Only a draft/);
  });

  it("allows one live campaign per deposit account", () => {
    const ata = `'${addr("Z")}'`;
    const a = create({ deposit_ata: ata });
    const b = create({ deposit_ata: ata });
    setStatus(a, "open");
    expect(() => setStatus(b, "open")).toThrow(/duplicate key/);
    setStatus(a, "cancelled");
    setStatus(b, "open");
    expect(status(b)).toBe("open");
  });

  it("records deposits under the campaign lock: accepted, irregular, over the cap, idempotent", () => {
    const id = create({ units_cap: "120000" });
    expect(() => deposit(id, sig("d"), 1)).toThrow(/MIGRATION_NOT_RECORDING/);
    setStatus(id, "open");
    const txE = sig();
    const first = deposit(id, txE, 2);
    expect(first).toMatchObject({ created: true, status: "accepted", reason_code: null, units_due: "2" });
    expect(deposit(id, txE, 2)).toMatchObject({ created: false, id: first.id, status: "accepted" });
    const late = deposit(id, sig("f"), null, { reason: "outside_window" });
    expect(late).toMatchObject({ created: true, status: "irregular", reason_code: "outside_window", units_due: "0" });
    // 2 accepted so far: 119,998 more fit, the next one does not.
    expect(deposit(id, sig("g"), 119_998)).toMatchObject({ status: "accepted", units_due: "119998" });
    expect(deposit(id, sig("h"), 1)).toMatchObject({ status: "irregular", reason_code: "over_cap", units_due: "0" });
    expect(() => deposit(id, sig("i"), 3, { amount: 3 * LOT + 1 })).toThrow(/INVALID_DEPOSIT_ARGUMENTS/);
    expect(() => deposit("00000000-0000-4000-8000-000000000000", sig("j"), 1)).toThrow(/MIGRATION_NOT_FOUND/);
    // The trigger holds the cap and the lifecycle under a direct write too.
    expect(() => db.query(`set role service_role; insert into public.token_migration_deposits
      (migration_id, holder_wallet, deposit_tx, deposit_slot, block_time, amount_base, units_due, status, recorded_via)
      values ('${id}', '${addr("b")}', '${sig("k")}', 1, now(), ${LOT}, 1, 'accepted', 'holder')`)).toThrow(/units cap/);
    expect(() => db.query(`set role service_role; insert into public.token_migration_deposits
      (migration_id, holder_wallet, deposit_tx, deposit_slot, block_time, amount_base, units_due, status, delivery_tx, recorded_via)
      values ('${id}', '${addr("b")}', '${sig("m")}', 1, now(), ${LOT}, 1, 'delivered', '${sig("n")}', 'holder')`)).toThrow(/accepted or irregular/);
    // Another campaign cannot claim a recorded signature.
    const other = create();
    setStatus(other, "open");
    expect(() => deposit(other, txE, 2)).toThrow(/DEPOSIT_TX_OTHER_MIGRATION/);
  });

  it("serializes concurrent recordings so the cap is never passed", async () => {
    const id = create({ old_total_supply: "1000000000", excluded_wallet_amount: "0", excluded_manual_amount: "999950000", excluded_amount: "999950000", equity_bps: "1", granularity: "100000", lot_base_units: "5000", units_cap: "10" });
    setStatus(id, "open");
    const calls = Array.from({ length: 12 }, (_, i) => db.queryAsync(`set role service_role; select public.record_token_migration_deposit(
      '${id}', '${addr("b")}', '${sig()}', 1, now(), ${LOT}, 1, null, null, 'holder')->>'status'`));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r === "accepted")).toHaveLength(10);
    expect(results.filter((r) => r === "irregular")).toHaveLength(2);
    expect(db.query(`select sum(units_due) from public.token_migration_deposits where migration_id='${id}'`)).toBe("10");
  });

  it("delivers atomically and never reuses a delivery signature", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig("o"), 1);
    const b = deposit(id, sig("p"), 2);
    const c = deposit(id, sig("q"), null, { reason: "memo_mismatch" });
    const txR = sig();
    expect(deliver(id, txR, [a.id])).toEqual({ created: true, count: 1 });
    expect(depositStatus(a.id)).toBe(`delivered|${txR}|`);
    expect(db.query(`select delivered_at is not null from public.token_migration_deposits where id='${a.id}'`)).toBe("t");
    expect(deliver(id, txR, [a.id])).toEqual({ created: false, count: 1 });
    expect(() => deliver(id, txR, [b.id])).toThrow(/DELIVERY_TX_ALREADY_RECORDED/);
    // All or nothing: an irregular deposit in the list leaves the accepted one untouched.
    expect(() => deliver(id, sig("s"), [b.id, c.id])).toThrow(/DELIVERY_DEPOSITS_NOT_ACCEPTED/);
    expect(depositStatus(b.id)).toBe("accepted||");
    const txT = sig();
    expect(() => deliver(id, txT, [b.id, b.id])).toThrow(/INVALID_DELIVERY_ARGUMENTS/);
    expect(deliver(id, txT, [b.id])).toEqual({ created: true, count: 1 });
    // What the chain proved never changes.
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set amount_base=1 where id='${a.id}'`)).toThrow(/never changes/);
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set delivery_tx='${sig("u")}' where id='${a.id}'`)).toThrow(/only with its status/);
    expect(() => db.query(`delete from public.token_migration_deposits where id='${a.id}'`)).toThrow(/never deleted/);
  });

  it("refunds an irregular deposit once; an accepted one only in a cancelled campaign", () => {
    const id = create();
    setStatus(id, "open");
    const ok = deposit(id, sig("v"), 1);
    const bad1 = deposit(id, sig("w"), null, { reason: "not_lot_multiple", amount: 1234 });
    const bad2 = deposit(id, sig("x"), null, { reason: "excluded_wallet" });
    const refund = (depositId: string, tx: string) =>
      db.query(`set role service_role; update public.token_migration_deposits set status='refunded', refund_tx='${tx}' where id='${depositId}'`);
    const txY = sig();
    refund(bad1.id, txY);
    expect(depositStatus(bad1.id)).toBe(`refunded||${txY}`);
    expect(() => refund(bad2.id, txY)).toThrow(/duplicate key/);
    const txZ = sig();
    expect(() => refund(ok.id, txZ)).toThrow(/illegal token migration deposit transition: accepted -> refunded \(campaign open\)/);
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set status='refunded', refund_tx='${sig("2")}', reason_code='over_cap' where id='${bad2.id}'`)).toThrow(/keeps the reason/);
    setStatus(id, "cancelled");
    refund(ok.id, txZ);
    // A cancelled campaign records late deposits as irregular only.
    expect(deposit(id, sig("3"), 1)).toMatchObject({ status: "irregular", reason_code: "not_open" });
  });

  it("is never cancelled once a deposit was delivered", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig("4"), 1);
    deliver(id, sig("5"), [a.id]);
    expect(() => setStatus(id, "cancelled")).toThrow(/delivered deposits cannot be cancelled/);
    setStatus(id, "closed");
    expect(() => setStatus(id, "cancelled")).toThrow(/delivered deposits cannot be cancelled/);
  });

  it("completes only with every deposit settled; the report and the burn are written once", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig("6"), 1);
    const b = deposit(id, sig("7"), null, { reason: "outside_window" });
    // The burn waits for the window to end.
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig("8")}', old_tokens_burned=5000 where id='${id}'`)).toThrow(/closed or completed/);
    setStatus(id, "closed");
    const complete = () => db.query(`set role service_role; update public.token_migrations set status='completed', final_report='{"kind":"x"}', final_report_sha256='${"ef".repeat(32)}' where id='${id}'`);
    expect(complete).toThrow(/delivered or refunded/);
    deliver(id, sig("9"), [a.id]);
    db.query(`set role service_role; update public.token_migration_deposits set status='refunded', refund_tx='${sig("A")}' where id='${b.id}'`);
    // The report comes with the completion, never before it or without it.
    expect(() => db.query(`set role service_role; update public.token_migrations set final_report='{}', final_report_sha256='${"ef".repeat(32)}' where id='${id}'`)).toThrow(/written once/);
    expect(() => setStatus(id, "completed")).toThrow(/check constraint/);
    complete();
    expect(db.query(`select status||'|'||(completed_at is not null)||'|'||final_report_sha256 from public.token_migrations where id='${id}'`)).toBe(`completed|true|${"ef".repeat(32)}`);
    expect(() => db.query(`set role service_role; update public.token_migrations set final_report='{"kind":"y"}' where id='${id}'`)).toThrow(/written once/);
    db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig("B")}', old_tokens_burned=5000 where id='${id}'`);
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig("C")}', old_tokens_burned=5000 where id='${id}'`)).toThrow(/recorded once/);
    // A draft records no burn (and a burn always names its amount).
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig("D")}', old_tokens_burned=1 where id='${create()}'`)).toThrow(/closed or completed/);
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig("D")}' where id='${id}'`)).toThrow(/recorded once|check constraint/);
    // No deposit can be recorded on a completed campaign.
    expect(() => deposit(id, sig("E"), 1)).toThrow(/MIGRATION_NOT_RECORDING/);
  });

  it("cannot be redirected through caller-controlled search_path objects", () => {
    const id = create();
    setStatus(id, "open");
    expect(db.query(`create temp table token_migration_deposits (id uuid); set search_path=pg_temp;
      select public.record_token_migration_deposit('${id}', '${addr("b")}', '${sig("F")}', 1, now(), ${LOT}, 1, null, null, 'holder')->>'status'`)).toBe("accepted");
  });
});
