import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { findDistributionPda } from "@/lib/generated/asset_registry";
import { canonicalDistributionPlan } from "@/lib/distribution-plans";
import { LocalPostgres } from "./helpers/local-postgres";
const db = new LocalPostgres();
const A = address("11111111111111111111111111111111");
const B = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
let plan: Awaited<ReturnType<typeof canonicalDistributionPlan>>;
const q = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const prepare = (extra = {}, batches = plan.batches) => `select public.prepare_distribution_plan(${q({ ...plan, batches: undefined, network: "devnet", created_by: A, ...extra })},${q(batches)});`;
const bind = (id: string, extra: { network?: string; root?: string; hash?: string; slot?: number } = {}) => `select public.bind_distribution_plan('${id}','${extra.network ?? "devnet"}','${extra.root ?? plan.root_hex}','${extra.hash ?? plan.plan_hash}',${extra.slot ?? 123});`;
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0051 immutable distribution plans on isolated PostgreSQL", () => {
  beforeAll(async () => {
    try {
      db.initialize(); db.query("create role anon; create role authenticated; create role service_role bypassrls;");
      db.query(readFileSync(join(process.cwd(), "supabase/migrations/0051_distribution_plans.sql"), "utf8"));
      const entries = await Promise.all([A, B].map(async (wallet) => ({ token_owner: wallet, token_account: (await findAssociatedTokenPda({ owner: wallet, mint: A, tokenProgram: B }))[0], amount: wallet === A ? "10" : "9007199254740993" })));
      plan = await canonicalDistributionPlan({ distribution_pda: (await findDistributionPda({ shareClass: A, distributionId: BigInt(7) }))[0], distribution_id: "7", share_class: A, payment_mint: A, payment_token_program: B, funder: A, total_amount: "9007199254741003", snapshot_supply: "9007199254741003" }, entries);
    } catch (err) { db.close(); throw err; }
  }, 30_000);
  afterAll(() => db.close()); beforeEach(() => db.query("truncate public.distribution_plan_batches,public.distribution_plans;"));
  it("persists the original ordered batches before funding and survives restart with exact u64 strings", () => {
    const id = db.query(`set role service_role; ${prepare()}`);
    const row = JSON.parse(db.query(`set role service_role; select row_to_json(p) from public.distribution_plan_metadata p where id='${id}';`));
    expect(row).toMatchObject({ status: "prepared", total_amount: "9007199254741003", snapshot_supply: "9007199254741003", bound_slot: null });
    expect(JSON.parse(db.query(`set role service_role; select entries from public.distribution_plan_batches where plan_id='${id}';`))).toEqual(plan.batches[0].entries);
    db.stop(); db.start(); expect(db.query("select count(*) from public.distribution_plan_batches;")).toBe("1");
  });
  it("deduplicates concurrent preparation of the same id and never replaces a funded intent", async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => db.queryAsync(prepare()))); expect(new Set(ids).size).toBe(1);
    db.query(bind(ids[0]));
    for (const change of [{ plan_hash: "1".repeat(64) }, { root_hex: "1".repeat(64) }, { snapshot_supply: "9007199254741005" }]) expect(() => db.query(prepare(change))).toThrow(/Immutable distribution/);
    expect(db.query("select count(*) from public.distribution_plans;")).toBe("1");
  });
  it("binds only matching context and keeps first finalized evidence on repeated verification", () => {
    const id = db.query(prepare());
    for (const change of [{ network: "mainnet" }, { root: "0".repeat(64) }, { hash: "0".repeat(64) }, { slot: -1 }]) expect(() => db.query(bind(id, change))).toThrow(/mismatch/);
    db.query(bind(id)); const time = db.query("select bound_at from public.distribution_plans;"); db.query(bind(id, { slot: 999 }));
    expect(db.query("select status||':'||bound_slot::text from public.distribution_plans;")).toBe("bound:123"); expect(db.query("select bound_at from public.distribution_plans;")).toBe(time);
  });
  it("isolates identical distribution PDAs by network", () => {
    expect(db.query(prepare())).not.toBe(db.query(prepare({ network: "mainnet" })));
    expect(db.query("select count(*) from public.distribution_plans;")).toBe("2");
  });
  it("atomically rejects invalid batch order, recipient duplication and allocation mismatch", () => {
    expect(() => db.query(prepare({}, [{ ...plan.batches[0], batch_id: 1 }]))).toThrow();
    expect(() => db.query(prepare({}, [{ ...plan.batches[0], entries: [plan.batches[0].entries[0], plan.batches[0].entries[0]] }]))).toThrow();
    expect(() => db.query(prepare({ allocated_amount: "1" }))).toThrow();
    expect(() => db.query(prepare({ entry_count: 3 }))).toThrow();
    expect(() => db.query(prepare({ total_amount: "1" }))).toThrow();
    expect(() => db.query(prepare({ total_amount: "9007199254741005" }))).toThrow();
    expect(() => db.query(prepare({ created_by: B }))).toThrow();
    expect(db.query("select count(*) from public.distribution_plans;")).toBe("0");
  });
  it.each(["anon", "authenticated"])("denies wallet enumeration and plan mutation to %s", (role) => {
    expect(() => db.query(`set role ${role}; select * from public.distribution_plan_metadata;`)).toThrow();
    expect(() => db.query(`set role ${role}; select * from public.distribution_plan_batches;`)).toThrow();
    expect(() => db.query(`set role ${role}; ${prepare()}`)).toThrow();
  });
  it("denies direct service writes to immutable plan and recipient tables", () => {
    db.query(prepare());
    expect(() => db.query("set role service_role; update public.distribution_plans set total_amount=1;")).toThrow();
    expect(() => db.query("set role service_role; delete from public.distribution_plan_batches;")).toThrow();
  });
});
