// Migration 0073 (Talas 5.1) BEFORE its contract step 0074: the expand window
// in which the previous front is still live. It reads spv_issuances with the
// anon key and books manual rows through record_spv_issuance with the old
// argument list; 0073's v2 of that function must already refuse what the new
// ledger refuses (a sale named by a manual row, a held subject, the rolling
// cap). Then 0074 closes both.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { SUPABASE_PLATFORM_SQL, applyMigrations, migrationFiles, migrationNumber } from "./helpers/migrations";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = new LocalPostgres();
const sql = (q: string) => db.query(q);
const json = (q: string) => JSON.parse(sql(q)) as Record<string, unknown>;
const SPV = "30000000-0000-4000-8000-000000000009";
const SALE = "H".repeat(43);
const ASSET = "C".repeat(43);
/** The old front's call (0066's argument list), as it runs during the expand window. */
const oldFront = (amount: number, asset: string | null = null, salePubkey: string | null = null, override = false) =>
  json(`select public.record_spv_issuance('${SPV}',${amount},${asset ? `'${asset}'` : "null"},${salePubkey ? `'${salePubkey}'` : "null"},
    current_date,'Old front manual row','admin-wallet',${override},false)`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0073 expand window (before 0074)", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet", files: migrationFiles().filter((f) => migrationNumber(f) <= 73) });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => {
    sql(`truncate public.spv_issuances, public.sale_capacity_holds, public.spvs cascade;
      insert into public.spvs(id,network,name,annual_cap_eur) values ('${SPV}','devnet','SPV expand',1000);`);
  });

  it("record_spv_issuance v2 (old arguments) books a manual row and refuses a sale, a held subject and the rolling cap", () => {
    expect(oldFront(100)).toMatchObject({ source: "manual", amount_eur: 100, sale_pubkey: null });
    expect(() => oldFront(1, null, SALE)).toThrow(/SALE_PUBKEY_NOT_ALLOWED/);
    sql(`insert into public.spv_issuances(spv_id,sale_pubkey,amount_eur,issued_at,source) values ('${SPV}','${SALE}',10,current_date,'sale')`);
    expect(() => oldFront(1, SALE)).toThrow(/REF_IS_SALE/);
    expect(oldFront(1, ASSET)).toMatchObject({ asset_pda: ASSET });
    // Rolling 12 months: 111 already issued (100 + 10 + 1).
    expect(() => oldFront(890)).toThrow(/SALE_CAP_EXCEEDED remaining=889/);
    sql(`insert into public.sale_capacity_holds(network,subject,ref,code) values ('devnet','spv:${SPV}','r-1','FX_REVALUE')`);
    expect(() => oldFront(1)).toThrow(/SUBJECT_ON_HOLD/);
    // The super admin's override still records (and is not blocked by the hold).
    expect(oldFront(1, null, null, true)).toMatchObject({ source: "manual", cap_override: true });
  });

  it("the ledger preflight (section 4) lists a server booking still to come next to a manual row that may duplicate it", () => {
    const r = json(`select public.reserve_treasury_mint_capacity('devnet','${"A".repeat(43)}','${ASSET}','${"B".repeat(43)}','${SPV}',5,
      100,'Founder allocation','{"v":1}'::jsonb,'${"ab".repeat(32)}','admin-wallet')`);
    sql(`update public.sale_capacity_reservations set last_error = 'Booking refused: SPV annual issuance cap exceeded: 900 already issued in 2026' where id = '${r.id}'`);
    oldFront(100, ASSET);
    const out = db.psql(["-f", join(process.cwd(), "scripts/ops/ledger-preflight.sql")]);
    expect(out.status).toBe(0);
    const section4 = out.stdout.slice(out.stdout.indexOf("4. Server bookings"));
    expect(section4).toContain(String(r.id));
    expect(section4).toMatch(new RegExp(`${r.id}\\|treasury_mint\\|reserved\\|${SPV}\\|${ASSET}\\|\\|100(\\.00)?\\|[^|]*\\|t\\|`));
    expect(section4).toContain("Old front manual row");
  });

  it("the old front still reads spv_issuances with the anon key; 0074 then drops that read and record_spv_issuance", () => {
    oldFront(5);
    expect(sql(`set role anon; select count(*) from public.spv_issuances; reset role;`)).toBe("1");
    sql(readFileSync(join(process.cwd(), "supabase/migrations/0074_ledger_contract.sql"), "utf8"));
    expect(() => sql(`set role anon; select count(*) from public.spv_issuances;`)).toThrow(/permission denied/);
    expect(sql(`select count(*) from pg_proc where proname = 'record_spv_issuance'`)).toBe("0");
    expect(sql(`select count(*) from pg_proc where proname = 'record_spv_adjustment'`)).toBe("1");
  });
});
