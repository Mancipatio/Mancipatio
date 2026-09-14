import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { canonicalPayoutSnapshot, verifyOriginalSnapshotProof } from "@/lib/payout-snapshots";
const db = new LocalPostgres();
const A = "11111111111111111111111111111111";
const B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
let canonical: Awaited<ReturnType<typeof canonicalPayoutSnapshot>>;
const q = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
function prepare(network = "devnet", extra = {}, entries = canonical.entries) {
  return `select public.prepare_payout_snapshot(${q({ network, kind: "vault_vote", target_pda: A, round: "1", root_hex: canonical.root_hex, rows_hash: canonical.rows_hash, total_weight: canonical.total_weight, entry_count: canonical.count, created_by: A, ...extra })},${q(entries)});`;
}
const bind = (id: string, root = canonical.root_hex, network = "devnet") => `select public.bind_payout_snapshot('${id}','${network}','${root}',${canonical.total_weight},123);`;
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0050 immutable original entitlements on isolated PostgreSQL", () => {
  beforeAll(async () => {
    try {
      db.initialize(); db.query("create role anon; create role authenticated; create role service_role bypassrls;");
      db.query(readFileSync(join(process.cwd(), "supabase/migrations/0050_payout_snapshots.sql"), "utf8"));
      canonical = await canonicalPayoutSnapshot([{ wallet: A, weight: "10" }, { wallet: B, weight: "9007199254740993" }]);
    } catch (err) { db.close(); throw err; }
  }, 30_000);
  afterAll(() => db.close()); beforeEach(() => db.query("truncate public.payout_snapshot_entries,public.payout_snapshots;"));
  it("atomically stores original rows/proofs and preserves exact u64 JSON strings", async () => {
    const row = JSON.parse(db.query(`set role service_role; ${prepare()}`));
    expect(row).toMatchObject({ status: "prepared", total_weight: "9007199254741003", round: "1", bound_slot: null });
    expect(db.query("set role service_role; select weight from public.payout_snapshot_proofs order by wallet desc limit 1;")).toBe("9007199254740993");
    const entry = JSON.parse(db.query(`select json_build_object('weight',weight::text,'proof',proof) from public.payout_snapshot_entries where wallet='${A}';`));
    expect(await verifyOriginalSnapshotProof(A, entry.weight, entry.proof, canonical.root_hex)).toBe(true);
    db.stop(); db.start(); expect(db.query("select count(*) from public.payout_snapshot_entries;")).toBe("2");
  });
  it("deduplicates concurrent preparation without overwriting original content", async () => {
    const result = await Promise.all(Array.from({ length: 4 }, () => db.queryAsync(prepare())));
    expect(new Set(result.map((r) => JSON.parse(r).id)).size).toBe(1);
    expect(db.query("select count(*) from public.payout_snapshot_entries;")).toBe("2");
    expect(() => db.query(prepare("devnet", { rows_hash: "0".repeat(64) }))).toThrow(/content conflict/);
  });
  it("separates prepared from bound, validates context and makes repeat binding idempotent", () => {
    const row = JSON.parse(db.query(prepare()));
    expect(() => db.query(bind(row.id, "0".repeat(64)))).toThrow(/mismatch/);
    expect(() => db.query(bind(row.id, canonical.root_hex, "mainnet"))).toThrow(/mismatch/);
    const first = JSON.parse(db.query(bind(row.id))); const repeat = JSON.parse(db.query(bind(row.id)));
    expect(first).toMatchObject({ status: "bound", bound_slot: "123" }); expect(repeat.bound_at).toBe(first.bound_at);
  });
  it("allows separate network/round identities but only one bound root for each", () => {
    const one = JSON.parse(db.query(prepare())); db.query(bind(one.id));
    const two = JSON.parse(db.query(prepare("devnet", { root_hex: "1".repeat(64) })));
    expect(() => db.query(bind(two.id, "1".repeat(64)))).toThrow(/unique/);
    db.query(prepare("mainnet")); db.query(prepare("devnet", { round: "2" }));
    expect(db.query("select count(*) from public.payout_snapshots;")).toBe("4");
  });
  it("rolls back invalid counts/totals/duplicate entries", () => {
    expect(() => db.query(prepare("devnet", { total_weight: "1" }))).toThrow();
    expect(() => db.query(prepare("devnet", { entry_count: 3 }))).toThrow();
    expect(() => db.query(prepare("devnet", {}, [canonical.entries[0], canonical.entries[0]]))).toThrow();
    expect(db.query("select count(*) from public.payout_snapshots;")).toBe("0");
  });
  it.each(["anon", "authenticated"])("denies investor enumeration and mutation to %s", (role) => {
    expect(() => db.query(`set role ${role}; select * from public.payout_snapshot_metadata;`)).toThrow();
    expect(() => db.query(`set role ${role}; select * from public.payout_snapshot_proofs;`)).toThrow();
    expect(() => db.query(`set role ${role}; ${prepare()}`)).toThrow();
  });
  it("makes snapshot rows immutable even to direct service-role table writes", () => {
    db.query(prepare());
    expect(() => db.query("set role service_role; update public.payout_snapshots set total_weight=1;")).toThrow();
    expect(() => db.query("set role service_role; delete from public.payout_snapshot_entries;")).toThrow();
  });
});
