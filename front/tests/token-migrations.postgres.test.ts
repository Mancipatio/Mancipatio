// Migration 0085 (token migrations, V1) on an isolated PostgreSQL with the
// whole migration chain: the ratio and window CHECKs, the campaign and
// deposit lifecycle guards, the opening slot and one-campaign-per-deposit-
// account rules, the units cap under concurrent recording, the atomic
// delivery and refund functions that never reuse a signature, the
// write-once final report and burn (only once everything is settled), and
// service-role-only access.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (c: string) => c.repeat(32);
function base58Of(n: number, width: number, pad: string): string {
  let out = "";
  while (n > 0) { out = BASE58[n % 58] + out; n = Math.floor(n / 58); }
  return out.padStart(width, pad);
}
let sigN = 0;
/** A distinct, well-formed signature: signatures are unique per network across every test. */
const sig = (_label?: string) => {
  void _label;
  return base58Of(++sigN, 88, "2");
};
let ataN = 0;
/** A distinct deposit account: one campaign per deposit account, for good. */
const freshAta = () => base58Of(++ataN, 44, "3");
const LOT = 5000;
const OPENED_SLOT = 100;
const SLOT = 123;

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
    deposit_ata: `'${freshAta()}'`,
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
/** Moves the campaign; opening also sets its opening slot, as the route does. */
const setStatus = (id: string, to: string) =>
  db.query(`set role service_role; update public.token_migrations set status='${to}'${to === "open" ? `, opened_slot=${OPENED_SLOT}` : ""} where id='${id}'`);
function deposit(id: string, tx: string, lots: number | null, opts: { reason?: string; holder?: string; amount?: number; slot?: number } = {}) {
  const amount = opts.amount ?? (lots ?? 1) * LOT;
  return JSON.parse(db.query(`set role service_role; select public.record_token_migration_deposit(
    '${id}', '${opts.holder ?? addr("b")}', '${tx}', ${opts.slot ?? SLOT}, now(), ${amount}, ${lots ?? "null"},
    ${opts.reason ? `'${opts.reason}'` : "null"}, ${opts.reason ? "'test reason'" : "null"}, 'holder')`)) as {
    created: boolean; id: string; status: string; reason_code: string | null; units_due: string;
  };
}
const ids = (list: string[]) => `array[${list.map((x) => `'${x}'::uuid`).join(",")}]`;
function deliver(id: string, tx: string, list: string[]) {
  return JSON.parse(db.query(`set role service_role; select public.record_token_migration_delivery('${id}', '${tx}', ${ids(list)})`)) as {
    created: boolean; count: number;
  };
}
function refund(id: string, tx: string, list: string[]) {
  return JSON.parse(db.query(`set role service_role; select public.record_token_migration_refund('${id}', '${tx}', ${ids(list)})`)) as {
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
      expect(() => db.query(`set role ${role}; select public.record_token_migration_delivery('${id}', '${sig()}', array['${id}'::uuid])`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; select public.record_token_migration_refund('${id}', '${sig()}', array['${id}'::uuid])`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role}; select public.record_token_migration_deposit('${id}','${addr("b")}','${sig()}',${SLOT},now(),5000,1,null,null,'holder')`)).toThrow(/permission denied/);
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
    // A smaller G with the same lot and cap would let N_eff pass N_target.
    expect(() => create({ granularity: "50000" })).toThrow(/check constraint/);
    expect(() => create({ old_token_program: `'${addr("6")}'` })).toThrow(/check constraint/);
    expect(() => create({ terms_doc_url: "'http://example.com/terms'" })).toThrow(/check constraint/);
    expect(() => create({ slug: "'Bad Slug'" })).toThrow(/check constraint/);
    create({ slug: "'twice'" });
    expect(() => create({ slug: "'twice'" })).toThrow(/duplicate key/);
    expect(() => create({ status: "'open'" })).toThrow(/bare draft/);
    expect(() => create({ opened_slot: "5" })).toThrow(/bare draft/);
  });

  it("takes any whole G from 100 to 10^12 (a joint-stock company's number of shares) and refuses one outside", () => {
    // Rows that keep every ratio CHECK (E 100 %, S_old = lot × G, cap = G), so only the G check can refuse one.
    const atG = (g: string, lot: string) =>
      create({
        old_total_supply: (BigInt(g) * BigInt(lot)).toString(), excluded_wallet_amount: "0", excluded_manual_amount: "0", excluded_amount: "0",
        equity_bps: "10000", granularity: g, lot_base_units: lot, units_cap: g,
      });
    for (const [g, lot] of [["100", "10"], ["37000", "1000"], ["50000", "20"], ["1000000000000", "1"]]) {
      expect(atG(g, lot), g).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(() => atG("99", "10")).toThrow(/token_migrations_granularity_check/);
    expect(() => atG("1000000000001", "1")).toThrow(/token_migrations_granularity_check/);
    // The worked example on 37,000 shares (E 12 %): N_target 4,440, lot 200,000, cap 3,000.
    const id = create({ granularity: "37000", lot_base_units: "200000", units_cap: "3000" });
    expect(db.query(`select granularity||'|'||lot_base_units||'|'||units_cap from public.token_migrations where id='${id}'`)).toBe("37000|200000|3000");
    // G is still bound to the ratio: 37,000 with the 1,000,000-unit lot and cap breaks N_eff ≤ N_target.
    expect(() => create({ granularity: "37000" })).toThrow(/check constraint/);
  });

  it("moves through its lifecycle, stamps each step and freezes the published terms and the opening slot", () => {
    const id = create({ terms_doc_sha256: "null", terms_doc_url: "null" });
    // A draft may change and has no Terms yet; it cannot open without them, nor without its opening slot.
    db.query(`set role service_role; update public.token_migrations set company_name='Acme a.d.' where id='${id}'`);
    expect(() => setStatus(id, "open")).toThrow(/check constraint/);
    db.query(`set role service_role; update public.token_migrations set terms_doc_sha256='${"cd".repeat(32)}', terms_doc_url='https://example.com/t.pdf' where id='${id}'`);
    expect(() => db.query(`set role service_role; update public.token_migrations set status='open' where id='${id}'`)).toThrow(/check constraint/);
    expect(() => db.query(`set role service_role; update public.token_migrations set opened_slot=7 where id='${id}'`)).toThrow(/set when the token migration opens/);
    setStatus(id, "open");
    expect(db.query(`select status||'|'||(opened_at is not null)||'|'||opened_slot from public.token_migrations where id='${id}'`)).toBe(`open|true|${OPENED_SLOT}`);
    for (const change of ["equity_bps=1100, units_cap=110000, lot_base_units=5000", "terms_doc_url='https://example.com/other.pdf'", "treasury_wallet='" + addr("c") + "'", "window_closes_at=window_closes_at + interval '1 day'"]) {
      expect(() => db.query(`set role service_role; update public.token_migrations set ${change} where id='${id}'`), change).toThrow(/frozen|check constraint/);
    }
    expect(() => db.query(`set role service_role; update public.token_migrations set opened_slot=1 where id='${id}'`)).toThrow(/never changes/);
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

  it("gives a deposit account to one campaign for good", () => {
    const ata = `'${freshAta()}'`;
    const a = create({ deposit_ata: ata });
    const b = create({ deposit_ata: ata });
    setStatus(a, "open");
    expect(() => setStatus(b, "open")).toThrow(/duplicate key/);
    // Cancelled, the first campaign keeps the account: a re-run needs a fresh deposit owner.
    setStatus(a, "cancelled");
    expect(() => setStatus(b, "open")).toThrow(/duplicate key/);
    // A draft that never opened can still be cancelled.
    setStatus(b, "cancelled");
    expect(status(b)).toBe("cancelled");
  });

  it("records deposits under the campaign lock: accepted, irregular, over the cap, idempotent, never before the opening", () => {
    const id = create({ units_cap: "120000" });
    expect(() => deposit(id, sig(), 1)).toThrow(/MIGRATION_NOT_RECORDING/);
    setStatus(id, "open");
    expect(() => deposit(id, sig(), 1, { slot: OPENED_SLOT - 1 })).toThrow(/DEPOSIT_BEFORE_OPENING/);
    expect(deposit(id, sig(), 1, { slot: OPENED_SLOT })).toMatchObject({ created: true, status: "accepted" });
    const txE = sig();
    const first = deposit(id, txE, 2);
    expect(first).toMatchObject({ created: true, status: "accepted", reason_code: null, units_due: "2" });
    expect(deposit(id, txE, 2)).toMatchObject({ created: false, id: first.id, status: "accepted" });
    const late = deposit(id, sig(), null, { reason: "outside_window" });
    expect(late).toMatchObject({ created: true, status: "irregular", reason_code: "outside_window", units_due: "0" });
    // 3 accepted so far: 119,997 more fit, the next one does not.
    expect(deposit(id, sig(), 119_997)).toMatchObject({ status: "accepted", units_due: "119997" });
    expect(deposit(id, sig(), 1)).toMatchObject({ status: "irregular", reason_code: "over_cap", units_due: "0" });
    expect(() => deposit(id, sig(), 3, { amount: 3 * LOT + 1 })).toThrow(/INVALID_DEPOSIT_ARGUMENTS/);
    expect(() => deposit("00000000-0000-4000-8000-000000000000", sig(), 1)).toThrow(/MIGRATION_NOT_FOUND/);
    // The trigger holds the cap, the opening slot and the lifecycle under a direct write too.
    const insert = (columns: string, values: string) => db.query(`set role service_role; insert into public.token_migration_deposits
      (migration_id, holder_wallet, deposit_tx, deposit_slot, block_time, amount_base, units_due, status, recorded_via${columns})
      values ('${id}', '${addr("b")}', '${sig()}', ${values})`);
    expect(() => insert("", `${SLOT}, now(), ${LOT}, 1, 'accepted', 'holder'`)).toThrow(/units cap/);
    expect(() => insert(", reason_code", `${OPENED_SLOT - 1}, now(), ${LOT}, 0, 'irregular', 'holder', 'memo_mismatch'`)).toThrow(/before the token migration opened/);
    expect(() => insert(", delivery_tx", `${SLOT}, now(), ${LOT}, 1, 'delivered', 'holder', '${sig()}'`)).toThrow(/accepted or irregular/);
    // Another campaign cannot claim a recorded signature.
    const other = create();
    setStatus(other, "open");
    expect(() => deposit(other, txE, 2)).toThrow(/DEPOSIT_TX_OTHER_MIGRATION/);
  });

  it("serializes concurrent recordings so the cap is never passed", async () => {
    const id = create({ old_total_supply: "1000000000", excluded_wallet_amount: "0", excluded_manual_amount: "999950000", excluded_amount: "999950000", equity_bps: "1", granularity: "100000", lot_base_units: "5000", units_cap: "10" });
    setStatus(id, "open");
    const calls = Array.from({ length: 12 }, () => db.queryAsync(`set role service_role; select public.record_token_migration_deposit(
      '${id}', '${addr("b")}', '${sig()}', ${SLOT}, now(), ${LOT}, 1, null, null, 'holder')->>'status'`));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r === "accepted")).toHaveLength(10);
    expect(results.filter((r) => r === "irregular")).toHaveLength(2);
    expect(db.query(`select sum(units_due) from public.token_migration_deposits where migration_id='${id}'`)).toBe("10");
  });

  it("delivers atomically and never reuses a delivery signature", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig(), 1);
    const b = deposit(id, sig(), 2);
    const c = deposit(id, sig(), null, { reason: "memo_mismatch" });
    const txR = sig();
    expect(deliver(id, txR, [a.id])).toEqual({ created: true, count: 1 });
    expect(depositStatus(a.id)).toBe(`delivered|${txR}|`);
    expect(db.query(`select delivered_at is not null from public.token_migration_deposits where id='${a.id}'`)).toBe("t");
    expect(deliver(id, txR, [a.id])).toEqual({ created: false, count: 1 });
    expect(() => deliver(id, txR, [b.id])).toThrow(/DELIVERY_TX_ALREADY_RECORDED/);
    // All or nothing: an irregular deposit in the list leaves the accepted one untouched.
    expect(() => deliver(id, sig(), [b.id, c.id])).toThrow(/DELIVERY_DEPOSITS_NOT_ACCEPTED/);
    expect(depositStatus(b.id)).toBe("accepted||");
    const txT = sig();
    expect(() => deliver(id, txT, [b.id, b.id])).toThrow(/INVALID_DELIVERY_ARGUMENTS/);
    expect(deliver(id, txT, [b.id])).toEqual({ created: true, count: 1 });
    // What the chain proved never changes.
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set amount_base=1 where id='${a.id}'`)).toThrow(/never changes/);
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set delivery_tx='${sig()}' where id='${a.id}'`)).toThrow(/only with its status/);
    expect(() => db.query(`delete from public.token_migration_deposits where id='${a.id}'`)).toThrow(/never deleted/);
  });

  it("refunds one holder's irregular deposits in one transaction, never another holder's, and an accepted one only in a cancelled campaign", () => {
    const id = create();
    setStatus(id, "open");
    const ok = deposit(id, sig(), 1);
    const dust1 = deposit(id, sig(), null, { reason: "not_lot_multiple", amount: 1 });
    const dust2 = deposit(id, sig(), null, { reason: "not_lot_multiple", amount: 2 });
    const someoneElse = deposit(id, sig(), null, { reason: "excluded_wallet", holder: addr("c") });
    const txY = sig();
    expect(() => refund(id, txY, [dust1.id, someoneElse.id])).toThrow(/REFUND_DEPOSITS_NOT_REFUNDABLE/);
    expect(refund(id, txY, [dust1.id, dust2.id])).toEqual({ created: true, count: 2 });
    expect(depositStatus(dust2.id)).toBe(`refunded||${txY}`);
    expect(refund(id, txY, [dust1.id, dust2.id])).toEqual({ created: false, count: 2 });
    expect(() => refund(id, txY, [someoneElse.id])).toThrow(/REFUND_TX_ALREADY_RECORDED/);
    // A direct write cannot stretch a refund transaction over another holder either.
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set status='refunded', refund_tx='${txY}' where id='${someoneElse.id}'`)).toThrow(/one holder of one campaign/);
    expect(() => refund(id, sig(), [ok.id])).toThrow(/REFUND_DEPOSITS_NOT_REFUNDABLE/);
    expect(() => db.query(`set role service_role; update public.token_migration_deposits set status='refunded', refund_tx='${sig()}', reason_code='over_cap' where id='${someoneElse.id}'`)).toThrow(/keeps the reason/);
    setStatus(id, "cancelled");
    expect(refund(id, sig(), [ok.id])).toEqual({ created: true, count: 1 });
    // A cancelled campaign records late deposits as irregular only.
    expect(deposit(id, sig(), 1)).toMatchObject({ status: "irregular", reason_code: "not_open" });
  });

  it("is never cancelled once a deposit was delivered", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig(), 1);
    deliver(id, sig(), [a.id]);
    expect(() => setStatus(id, "cancelled")).toThrow(/delivered deposits cannot be cancelled/);
    setStatus(id, "closed");
    expect(() => setStatus(id, "cancelled")).toThrow(/delivered deposits cannot be cancelled/);
  });

  it("burns only a settled campaign after the window, and a burned campaign is never cancelled", () => {
    const id = create();
    setStatus(id, "open");
    const late = deposit(id, sig(), null, { reason: "outside_window" });
    const burn = (tx: string) => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${tx}', old_tokens_burned=5000 where id='${id}'`);
    expect(() => burn(sig())).toThrow(/closed or completed/);
    setStatus(id, "closed");
    expect(() => burn(sig())).toThrow(/every deposit is delivered or refunded/);
    refund(id, sig(), [late.id]);
    const txB = sig();
    burn(txB);
    expect(() => setStatus(id, "cancelled")).toThrow(/burned cannot be cancelled/);
    // A burn proves one campaign's burn.
    const other = create();
    setStatus(other, "open");
    setStatus(other, "closed");
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${txB}', old_tokens_burned=5000 where id='${other}'`)).toThrow(/duplicate key/);
  });

  it("completes only with every deposit settled; the report keeps the route's time; the report and the burn are written once", () => {
    const id = create();
    setStatus(id, "open");
    const a = deposit(id, sig(), 1);
    const b = deposit(id, sig(), null, { reason: "outside_window" });
    setStatus(id, "closed");
    const at = "2026-11-08T12:00:00.123Z";
    const complete = (completedAt = "now()") => db.query(`set role service_role; update public.token_migrations set status='completed', completed_at=${completedAt}, final_report='{"kind":"x"}', final_report_sha256='${"ef".repeat(32)}' where id='${id}'`);
    expect(() => complete()).toThrow(/delivered or refunded/);
    deliver(id, sig(), [a.id]);
    refund(id, sig(), [b.id]);
    // The report comes with the completion, never before it or without it.
    expect(() => db.query(`set role service_role; update public.token_migrations set final_report='{}', final_report_sha256='${"ef".repeat(32)}' where id='${id}'`)).toThrow(/written once/);
    expect(() => setStatus(id, "completed")).toThrow(/check constraint/);
    // An implausible completion time is replaced by the database clock; a current one is kept.
    complete(`'${at}'`);
    expect(db.query(`select status||'|'||(completed_at > now() - interval '1 minute')||'|'||final_report_sha256 from public.token_migrations where id='${id}'`)).toBe(`completed|true|${"ef".repeat(32)}`);
    const kept = create();
    setStatus(kept, "open");
    setStatus(kept, "closed");
    const now = db.query("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')");
    db.query(`set role service_role; update public.token_migrations set status='completed', completed_at='${now}', final_report='{}', final_report_sha256='${"ef".repeat(32)}' where id='${kept}'`);
    expect(db.query(`select to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from public.token_migrations where id='${kept}'`)).toBe(now);
    expect(() => db.query(`set role service_role; update public.token_migrations set final_report='{"kind":"y"}' where id='${id}'`)).toThrow(/written once/);
    db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig()}', old_tokens_burned=5000 where id='${id}'`);
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig()}', old_tokens_burned=5000 where id='${id}'`)).toThrow(/recorded once/);
    // A draft records no burn, and the reconcile cursor does not move on a completed campaign.
    expect(() => db.query(`set role service_role; update public.token_migrations set old_tokens_burn_tx='${sig()}', old_tokens_burned=1 where id='${create()}'`)).toThrow(/closed or completed/);
    expect(() => db.query(`set role service_role; update public.token_migrations set reconcile_cursor='${sig()}' where id='${id}'`)).toThrow(/reconcile cursor/);
    // No deposit can be recorded on a completed campaign.
    expect(() => deposit(id, sig(), 1)).toThrow(/MIGRATION_NOT_RECORDING/);
  });

  it("cannot be redirected through caller-controlled search_path objects", () => {
    const id = create();
    setStatus(id, "open");
    expect(db.query(`create temp table token_migration_deposits (id uuid); set search_path=pg_temp;
      select public.record_token_migration_deposit('${id}', '${addr("b")}', '${sig()}', ${SLOT}, now(), ${LOT}, 1, null, null, 'holder')->>'status'`)).toBe("accepted");
  });
});
