// Migration 0075 (indexer freshness heartbeat) on the whole migration chain:
// the plan, every proof condition of confirm_indexer_quiet and its reason
// code, the watermarks and cursors, probes, the account sample, the expiry,
// validation (every NULL fails closed), the network rules, privileges and the
// sync-row lock. The worker side (RPC evidence) is indexer-heartbeat.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { INDEXER_ENTITIES, type DecodedIndexerAccount } from "@/lib/server/indexer-accounts";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, MIGRATIONS_DIR, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const json = (query: string) => JSON.parse(sql(query));
const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const texts = (list: string[]) => `array[${list.map((s) => `'${s}'`).join(",")}]::text[]`;
const AR = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const TH = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy";
const FLOOR = 1_000;
/** A distinct base58 64-byte signature per n. */
function sig(n: number) {
  const bytes = new Uint8Array(64).fill(7);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  bytes[4] = 9;
  return getBase58Decoder().decode(bytes);
}
type R = { signature: string; slot: number; ok: boolean };
const r = (n: number, slot: number, ok = true): R => ({ signature: sig(n), slot, ok });
/** The oldest row of a quiet listing: at the floor. */
const floorRow = (n: number, slot = FLOOR) => r(n, slot);
const indexed = (n: number, slot: number | null, decoded = true, network = "devnet", age = "0 seconds") => sql(
  `insert into public.indexer_events(network, signature, slot, program, decoded, created_at)
   values ('${network}', '${sig(n)}', ${slot ?? "null"}, '${AR}', ${decoded}, now() - interval '${age}')`);
const MIRROR = ["platforms", "issuers", "assets", "share_classes", "sales", "custody_vaults", "offers", "proposals",
  "vote_records", "rights_issuances", "milestones", "milestone_claims", "kyc_registries", "kyc_entries"];

let tip = 0;
type Rows = R[] | ((tip: number) => R[]);
type Evidence = {
  ar?: Rows; th?: Rows; arBefore?: string | null; thBefore?: string | null; tipDelta?: number;
  finalized?: number; accounts?: unknown[]; exempt?: string[];
};
const rows = (value: Rows | undefined, fallback: R[]) => (typeof value === "function" ? value(tip) : value ?? fallback);
function plan(network = "devnet") {
  return json(`select public.indexer_heartbeat_plan('${network}')`);
}
function confirmWith(planId: string, e: Evidence = {}) {
  tip += e.tipDelta ?? 300;
  const listings = [
    { program: AR, before: e.arBefore ?? null, rows: rows(e.ar, [floorRow(9_001)]) },
    { program: TH, before: e.thBefore ?? null, rows: rows(e.th, [floorRow(9_002)]) },
  ];
  const sample = { context_slot: e.finalized ?? tip - 32, accounts: e.accounts ?? [] };
  return json(`select public.confirm_indexer_quiet('devnet', '${planId}', null, ${tip}, ${q(listings)}, ${q(sample)}, ${texts(e.exempt ?? [])})`);
}
/** One heartbeat run: a due plan, then its evidence. */
function run(e: Evidence = {}) {
  const p = plan();
  expect(p.due, "plan due").toBe(true);
  return confirmWith(p.plan_id, e);
}
/** The time between two runs: the stamps the next run judges by move back. */
function tick(seconds = 120) {
  sql(`update public.indexer_heartbeat_state set
    planned_at = planned_at - make_interval(secs => ${seconds}), tip_seen_at = tip_seen_at - make_interval(secs => ${seconds})`);
}
/** The first run stores the tip (TIP_BASELINE); the next one can prove. */
function warm() {
  expect(run()).toMatchObject({ outcome: "declined", reason: "TIP_BASELINE" });
  tick();
}
const state = () => json(`select to_jsonb(s) from public.indexer_heartbeat_state s where network = 'devnet'`);
const syncRow = () => json(`select to_jsonb(s) from public.indexer_sync_state s where network = 'devnet'`);
function watermark(program = AR) {
  const out = sql(`select to_jsonb(w) from public.indexer_heartbeat_watermarks w where network = 'devnet' and program = '${program}'`);
  return out ? JSON.parse(out) as { slot: number | null; resume_signature: string | null; resume_slot: number | null } : null;
}
const checkedIsPlanned = () => sql(`select s.checked_at = h.planned_at from public.indexer_sync_state s
  join public.indexer_heartbeat_state h using (network) where network = 'devnet'`);

function reset(mode = "on") {
  sql(`truncate ${[...MIRROR, "indexer_account_versions", "indexer_closed_rows", "indexer_jobs", "indexer_events", "onchain_event_jobs",
    "indexer_sync_state", "indexer_heartbeat_state", "indexer_heartbeat_watermarks", "alarm_incidents", "compliance_alerts",
    "spv_issuance_jobs"].map((t) => `public.${t}`).join(", ")} cascade`);
  sql(`insert into public.indexer_heartbeat_state(network, mode) values ('devnet', '${mode}')`);
  sql(`insert into public.indexer_sync_state(network, status, last_slot, completed_at, checked_at)
    values ('devnet', 'ready', ${FLOOR}, now() - interval '1 hour', now() - interval '10 minutes')`);
  tip = 100_000;
}

let seeded: Record<string, unknown> = {};
const fixtures: DecodedIndexerAccount[] = [];

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0075 indexer freshness heartbeat", () => {
  beforeAll(async () => {
    try {
      db.initialize();
      sql(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
      seeded = json(`select to_jsonb(s) from public.indexer_heartbeat_state s where network = 'devnet'`);
      for (const f of indexerFixtures()) {
        const decoded = await INDEXER_ENTITIES.find((e) => e.table === f.table)!.decode(f.bytes, f.address);
        fixtures.push({ table: f.table, row: { ...decoded, raw: { base64: Buffer.from(f.bytes).toString("base64") } } });
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => reset());

  it("seeds one observe row for the deployment network; the programs are the 0047 / webhook literals", () => {
    expect(seeded).toMatchObject({ network: "devnet", mode: "observe", interval_seconds: 120, sample_size: 100,
      reconcile_max_age_hours: 168, plan_id: null, tip_slot: null, last_outcome: null });
    expect(sql("select public.indexer_heartbeat_programs()")).toBe(`{${AR},${TH}}`);
  });

  describe("plan", () => {
    it("is due once per interval, stamps the plan, and returns floors, cursors, the sample and the probes", () => {
      const p = plan();
      expect(p).toMatchObject({ mode: "on", due: true, floors: { [AR]: FLOOR, [TH]: FLOOR }, resume: { [AR]: null, [TH]: null },
        sample: [], probe: [] });
      expect(p.plan_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(state()).toMatchObject({ plan_id: p.plan_id, planned_at: expect.any(String) });
      expect(plan()).toEqual({ mode: "on", due: false });
      sql("update public.indexer_heartbeat_state set interval_seconds = 60");
      tick(50);
      expect(plan().due).toBe(false);
      tick(6);
      expect(plan().due).toBe(true);
    });

    it("off: not due and nothing stamped", () => {
      sql("update public.indexer_heartbeat_state set mode = 'off'");
      expect(plan()).toEqual({ mode: "off", due: false });
      expect(state()).toMatchObject({ plan_id: null, planned_at: null });
    });

    it("floors = greatest(watermark, last_slot), nulls skipped; a cursor only above its floor", () => {
      sql(`insert into public.indexer_heartbeat_watermarks(network, program, slot, resume_signature, resume_slot)
        values ('devnet', '${AR}', 1500, '${sig(1)}', 2000), ('devnet', '${TH}', 800, '${sig(2)}', 900)`);
      expect(plan()).toMatchObject({ floors: { [AR]: 1500, [TH]: FLOOR },
        resume: { [AR]: { signature: sig(1), slot: 2000 }, [TH]: null } });
      sql("update public.indexer_sync_state set last_slot = null");
      tick();
      expect(plan()).toMatchObject({ floors: { [AR]: 1500, [TH]: 800 } });
      sql("delete from public.indexer_heartbeat_watermarks");
      tick();
      expect(plan()).toMatchObject({ floors: { [AR]: null, [TH]: null } });
    });
  });

  describe("proof conditions", () => {
    it("a quiet network: the first run stores the tip, the next proves and stamps checked_at with the plan's time", () => {
      const before = syncRow();
      expect(run()).toEqual({ outcome: "declined", reason: "TIP_BASELINE", expired: false, checked_at: null });
      expect(state()).toMatchObject({ tip_slot: tip, last_outcome: "declined", last_reason: "TIP_BASELINE", plan_id: null });
      expect(syncRow().checked_at).toBe(before.checked_at);
      tick();
      const out = run();
      expect(out).toMatchObject({ outcome: "bumped", reason: null, expired: false });
      expect(checkedIsPlanned()).toBe("t");
      expect(syncRow()).toMatchObject({ status: "ready", last_slot: FLOOR, completed_at: before.completed_at });
      expect(state()).toMatchObject({ last_outcome: "bumped", last_reason: null, declined_since: null });
      expect(sql("select last_proven_at = planned_at from public.indexer_heartbeat_state")).toBe("t");
    });

    it("P1: never revives a missing, warming, degraded or unreconciled mirror, nor one reconciled too long ago", () => {
      warm();
      for (const [setup, reason] of [
        ["delete from public.indexer_sync_state", "NOT_INITIALIZED"],
        ["update public.indexer_sync_state set status = 'warming'", "NOT_READY"],
        ["update public.indexer_sync_state set status = 'degraded'", "NOT_READY"],
        ["update public.indexer_sync_state set completed_at = null", "NOT_RECONCILED"],
        ["update public.indexer_sync_state set last_slot = null", "NOT_RECONCILED"],
        ["update public.indexer_sync_state set completed_at = now() - interval '169 hours'", "RECONCILE_TOO_OLD"],
      ] as const) {
        reset();
        warm();
        sql(setup);
        const before = sql("select coalesce(status || ':' || checked_at, 'none') from public.indexer_sync_state");
        expect(run(), setup).toMatchObject({ outcome: "declined", reason });
        expect(sql("select coalesce(status || ':' || checked_at, 'none') from public.indexer_sync_state"), setup).toBe(before);
      }
    });

    it("P2: a pending, a retrying and a leased job all decline; once the job completes the proof lands", () => {
      warm();
      const event = [{ signature: sig(500), slot: 1_200, block_time: null, ix_name: "TEST", wallets: [AR], payload: {} }];
      sql(`select public.enqueue_indexer_events('devnet', ${q(event)})`);
      const listing = { ar: [r(500, 1_200), floorRow(9_001)] };
      expect(run(listing)).toMatchObject({ reason: "PENDING_JOBS" });
      // Retrying: attempts, last_error and a backoff (the failure also marks degraded; undo that to isolate P2).
      const owner = "10000000-0000-4000-8000-000000000001";
      let job = sql(`select id from public.claim_indexer_jobs('devnet', '${owner}', 1, 90)`);
      sql(`select public.finish_indexer_job('${job}', '${owner}', false, 'RPC unavailable')`);
      sql("update public.indexer_sync_state set status = 'ready'");
      expect(sql("select attempts || ':' || (next_attempt_at > now()) from public.indexer_jobs")).toBe("1:true");
      tick();
      expect(run(listing)).toMatchObject({ reason: "PENDING_JOBS" });
      // Leased.
      sql("update public.indexer_jobs set next_attempt_at = now()");
      job = sql(`select id from public.claim_indexer_jobs('devnet', '${owner}', 1, 90)`);
      tick();
      expect(run(listing)).toMatchObject({ reason: "PENDING_JOBS" });
      expect(watermark()).toBeNull();
      sql(`select public.finish_indexer_job('${job}', '${owner}', true, null)`);
      tick();
      expect(run(listing)).toMatchObject({ outcome: "bumped", reason: null });
      expect(watermark()?.slot).toBe(1_200);
    });

    it("P3: an open indexer-gap or indexer-degraded incident declines until it clears", () => {
      warm();
      for (const check of ["indexer-gap", "indexer-degraded"]) {
        sql(`select public.report_incident('devnet', '${check}', 'fail', 'indexer', 'indexer:gap', 'high', 'x', '{}'::jsonb, false)`);
        expect(run()).toMatchObject({ reason: "OPEN_INCIDENT" });
        sql(`update public.alarm_incidents set cleared_at = now() where check_key = '${check}'`);
        tick();
        expect(run()).toMatchObject({ outcome: "bumped" });
        tick();
      }
    });

    it("P4: the tip must move 1..4 slots per second since an observation 20 s..5 min old", () => {
      expect(run()).toMatchObject({ reason: "TIP_BASELINE" });
      const baseline = tip;
      tick();
      expect(run({ tipDelta: -5 })).toMatchObject({ reason: "RPC_BEHIND" });
      expect(state().tip_slot).toBe(baseline);                                 // kept: expires with the observation
      tick();
      tip = baseline;
      expect(run({ tipDelta: 10 })).toMatchObject({ reason: "RPC_TIP_STALLED" }); // 10 slots in 240 s
      expect(state().tip_slot).toBe(baseline + 10);                            // stored: a stuck node keeps failing
      tick();
      expect(run({ tipDelta: 100_000 })).toMatchObject({ reason: "RPC_TIP_IMPLAUSIBLE" });
      expect(state().tip_slot).toBe(baseline + 10);                            // never stored
      tick();
      tip = baseline + 10;
      expect(run({ tipDelta: 600 })).toMatchObject({ outcome: "bumped" });     // 600 slots in 240 s
      tick();
      sql("update public.indexer_heartbeat_state set tip_seen_at = now() - interval '10 seconds'");
      expect(run()).toMatchObject({ reason: "TIP_TOO_SOON" });
      tick(400);
      expect(run()).toMatchObject({ reason: "TIP_BASELINE" });                 // too old to judge
      tick();
      expect(run()).toMatchObject({ outcome: "bumped" });
    });

    it("P5 (M1): a short or empty listing whose oldest row is above the floor is incomplete; so is any listing without a floor", () => {
      warm();
      expect(run({ ar: [] })).toMatchObject({ reason: "LISTING_INCOMPLETE" });
      tick();
      indexed(1, 1_500);
      expect(run({ ar: [r(1, 1_500)] })).toMatchObject({ reason: "LISTING_INCOMPLETE" });
      expect(watermark()?.slot ?? null).toBeNull();
      tick();
      // Failed rows count for continuity too: the oldest row, whatever its status.
      expect(run({ ar: [r(1, 1_500), r(2, 900, false)] })).toMatchObject({ outcome: "bumped" });
      reset();
      warm();
      sql("update public.indexer_sync_state set last_slot = null, completed_at = null");
      indexed(3, 1_500);
      expect(run({ ar: [r(3, 1_500), r(4, 10)], th: [r(5, 10)] })).toMatchObject({ reason: "NOT_RECONCILED" });
      expect(sql("select count(*) from public.indexer_heartbeat_watermarks")).toBe("0");
    });

    it("P6: unindexed, undecoded, null event slot (M3) and slot mismatch decline; rows at or below the floor are exempt", () => {
      warm();
      const cases: [() => void, string][] = [
        [() => {}, "UNINDEXED_SIGNATURE"],
        [() => indexed(10, 1_100, false), "UNDECODED_SIGNATURE"],
        [() => indexed(10, null, true), "UNPROVEN_EVENT_SLOT"],
        [() => indexed(10, 1_101, true), "SLOT_MISMATCH"],
        [() => indexed(10, 1_100, true, "testnet"), "UNINDEXED_SIGNATURE"],
      ];
      for (const [setup, reason] of cases) {
        sql("delete from public.indexer_events");
        setup();
        expect(run({ ar: [r(10, 1_100), floorRow(9_001)] }), reason).toMatchObject({ reason });
        tick();
      }
      // At the floor, below it, or at/below a watermark: not required.
      sql("delete from public.indexer_events");
      expect(run({ ar: [r(11, FLOOR), r(12, 900)] })).toMatchObject({ outcome: "bumped" });
      tick();
      sql(`insert into public.indexer_heartbeat_watermarks(network, program, slot) values ('devnet', '${AR}', 1200)`);
      expect(run({ ar: [r(13, 1_150), floorRow(9_001)] })).toMatchObject({ outcome: "bumped" });
    });

    it("S4: an event delivered 1-10 minutes ago above every listed row means the RPC index is behind", () => {
      warm();
      indexed(20, 50_000, true, "devnet", "2 minutes");
      indexed(21, 1_300, true);
      expect(run({ ar: [r(21, 1_300), floorRow(9_001)] })).toMatchObject({ reason: "RPC_INDEX_BEHIND" });
      expect(watermark()).toBeNull();                                          // no advance on a stale index
      sql("update public.indexer_events set created_at = now() - interval '11 minutes' where slot = 50000");
      tick();
      expect(run({ ar: [r(21, 1_300), floorRow(9_001)] })).toMatchObject({ outcome: "bumped" });
      sql("update public.indexer_events set created_at = now() - interval '30 seconds' where slot = 50000");
      tick();
      expect(run()).toMatchObject({ outcome: "bumped" });                      // still being delivered: not judged
    });

    it("S1: a sampled mirrored account that differs from the finalized chain declines, and the same batch is checked again", () => {
      warm();
      sql(`select public.apply_indexer_snapshot('devnet', 900, ${q(fixtures)}, '{}'::text[], null, 2)`);
      const raw = new Map(fixtures.map((f) => [String(f.row.pda), (f.row.raw as { base64: string }).base64]));
      const all = sql("select pda from public.indexer_account_versions where network = 'devnet' order by pda").split("\n");
      expect(all).toHaveLength(14);
      const accounts = (pdas: string[], change: (pda: string) => object = () => ({})) =>
        pdas.map((pda) => ({ pda, owner: AR, data: raw.get(pda), ...change(pda) }));
      let p = plan();
      expect(p.sample).toEqual(all);
      expect(confirmWith(p.plan_id, { accounts: accounts(all) })).toMatchObject({ outcome: "bumped" });
      expect(state().sample_cursor).toBe(all[13]);
      for (const change of [
        (pda: string) => (pda === all[3] ? { data: "AAAA" } : {}),
        (pda: string) => (pda === all[5] ? { owner: TH } : {}),
        (pda: string) => (pda === all[7] ? { owner: null, data: null } : {}),     // closed on chain, still mirrored
      ]) {
        tick();
        p = plan();
        expect(confirmWith(p.plan_id, { accounts: accounts(p.sample, change) })).toMatchObject({ reason: "SAMPLE_MISMATCH" });
        expect(state().sample_cursor).toBe(all[13]);
      }
      // A mirror row newer than the snapshot is not compared.
      tick();
      p = plan();
      expect(confirmWith(p.plan_id, { finalized: 899, accounts: accounts(p.sample, () => ({ data: "AAAA" })) })).toMatchObject({ outcome: "bumped" });
      // The evidence must be the planned sample, exactly.
      tick();
      p = plan();
      expect(() => confirmWith(p.plan_id, { accounts: accounts(all.slice(1)) })).toThrow(/Invalid heartbeat evidence/);
    });

    it("S1: the sample rotates through the mirror in sample_size batches and wraps", () => {
      warm();
      sql(`select public.apply_indexer_snapshot('devnet', 900, ${q(fixtures)}, '{}'::text[], null, 2)`);
      const raw = new Map(fixtures.map((f) => [String(f.row.pda), (f.row.raw as { base64: string }).base64]));
      const all = sql("select pda from public.indexer_account_versions where network = 'devnet' order by pda").split("\n");
      sql("update public.indexer_heartbeat_state set sample_size = 5");
      const batches: string[][] = [];
      for (let i = 0; i < 4; i++) {
        const p = plan();
        batches.push(p.sample);
        confirmWith(p.plan_id, { accounts: p.sample.map((pda: string) => ({ pda, owner: AR, data: raw.get(pda) })) });
        tick();
      }
      expect(batches[0]).toEqual(all.slice(0, 5));
      expect(batches[1]).toEqual(all.slice(5, 10));
      expect(batches[2]).toEqual([...all.slice(10, 14), all[0]]);
      expect(batches[3]).toEqual(all.slice(1, 6));
    });

    it("P7: observe records would_bump without touching checked_at; off at confirm time declines; declined_since spans a streak", () => {
      sql("update public.indexer_heartbeat_state set mode = 'observe'");
      warm();
      const before = syncRow().checked_at;
      expect(run()).toMatchObject({ outcome: "would_bump", reason: null });
      expect(syncRow().checked_at).toBe(before);
      expect(sql("select last_proven_at = planned_at from public.indexer_heartbeat_state")).toBe("t");
      tick();
      const p = plan();
      sql("update public.indexer_heartbeat_state set mode = 'off'");
      expect(confirmWith(p.plan_id)).toMatchObject({ outcome: "declined", reason: "OFF" });
      sql("update public.indexer_heartbeat_state set mode = 'on'");
      tick();
      run({ ar: [] });
      const since = state().declined_since;
      expect(since).toEqual(expect.any(String));
      tick();
      expect(run({ ar: [] })).toMatchObject({ reason: "LISTING_INCOMPLETE" });
      expect(state().declined_since).toBe(since);
      tick();
      expect(run()).toMatchObject({ outcome: "bumped" });
      expect(state().declined_since).toBeNull();
    });

    it("a bump never moves checked_at back (a job that finished after the plan keeps its newer stamp)", () => {
      warm();
      const p = plan();
      sql("update public.indexer_sync_state set checked_at = now() + interval '1 second'");
      const newer = syncRow().checked_at;
      expect(confirmWith(p.plan_id)).toMatchObject({ outcome: "bumped" });
      expect(syncRow().checked_at).toBe(newer);
    });
  });

  describe("watermarks (M2) and cursors (S2)", () => {
    it("advance to the highest listed slot below the first unproven row, capped at tip - 150 and at the finalized slot, never back", () => {
      warm();
      for (const [n, slot] of [[30, 1_200], [31, 1_300], [33, 1_450]] as const) indexed(n, slot);
      // 1400 is missing: the prefix stops below it. Failed rows are proven by definition.
      const listing = [r(33, 1_450), r(32, 1_400), r(34, 1_350, false), r(31, 1_300), r(30, 1_200), floorRow(9_001)];
      expect(run({ ar: listing })).toMatchObject({ reason: "UNINDEXED_SIGNATURE" });
      expect(watermark()).toMatchObject({ slot: 1_350, resume_signature: null });
      tick();
      // The finalized cap.
      indexed(32, 1_400);
      expect(run({ ar: [r(33, 1_450), r(32, 1_400), floorRow(9_001, 1_350)], finalized: 1_420 })).toMatchObject({ outcome: "bumped" });
      expect(watermark()?.slot).toBe(1_420);
      tick();
      // The tip - 150 cap, and never back.
      indexed(35, tip + 300 - 100);
      expect(run({ ar: (t) => [r(35, t - 100), floorRow(9_001, 1_420)] })).toMatchObject({ outcome: "bumped" });
      expect(watermark()?.slot).toBe(tip - 150);
      const high = tip - 150;
      tick();
      expect(run({ ar: [floorRow(9_001, high)] })).toMatchObject({ outcome: "bumped" });
      expect(watermark()?.slot).toBe(high);
    });

    it("advance while P1-P3 decline, but never on a failing tip or an incomplete listing", () => {
      warm();
      indexed(40, 1_300);
      sql("update public.indexer_sync_state set status = 'degraded'");
      expect(run({ ar: [r(40, 1_300), floorRow(9_001)] })).toMatchObject({ reason: "NOT_READY" });
      expect(watermark()?.slot).toBe(1_300);
      sql("update public.indexer_sync_state set status = 'ready'");
      indexed(41, 1_400);
      tick();
      expect(run({ ar: [r(41, 1_400), r(40, 1_300)], tipDelta: -5 })).toMatchObject({ reason: "RPC_BEHIND" });
      expect(watermark()?.slot).toBe(1_300);
      tick();
      expect(run({ ar: [r(41, 1_400), r(40, 1_300)], tipDelta: 5 })).toMatchObject({ reason: "RPC_TIP_STALLED" });
      expect(watermark()?.slot).toBe(1_300);
    });

    it("a listing that does not reach the floor leaves a cursor; the next run continues below it (CATCHING_UP), then proves from the tip", () => {
      warm();
      for (const [n, slot] of [[50, 2_200], [51, 2_100], [52, 2_000], [53, 1_500]] as const) indexed(n, slot);
      expect(run({ ar: [r(50, 2_200), r(51, 2_100), r(52, 2_000)] })).toMatchObject({ reason: "LISTING_INCOMPLETE" });
      expect(watermark()).toMatchObject({ slot: null, resume_signature: sig(52), resume_slot: 2_000 });
      tick();
      const p = plan();
      expect(p.resume[AR]).toEqual({ signature: sig(52), slot: 2_000 });
      expect(confirmWith(p.plan_id, { arBefore: sig(52), ar: [r(53, 1_500), floorRow(9_001)] })).toMatchObject({ reason: "CATCHING_UP" });
      expect(watermark()).toMatchObject({ slot: 1_500, resume_signature: null, resume_slot: null });
      tick();
      expect(plan().floors[AR]).toBe(1_500);
      tick();
      expect(run({ ar: [r(50, 2_200), r(51, 2_100), r(52, 2_000), r(53, 1_500)] })).toMatchObject({ outcome: "bumped" });
      expect(watermark()?.slot).toBe(2_200);
    });

    it("a cursor below its own slot: the cursor's slot is excluded; an empty page from the cursor resets it; a moved cursor is refused", () => {
      warm();
      sql(`insert into public.indexer_heartbeat_watermarks(network, program, resume_signature, resume_slot)
        values ('devnet', '${AR}', '${sig(60)}', 2000)`);
      indexed(61, 2_000);
      indexed(62, 1_900);
      let p = plan();
      expect(confirmWith(p.plan_id, { arBefore: sig(60), ar: [r(61, 2_000), r(62, 1_900), floorRow(9_001)] }))
        .toMatchObject({ reason: "CATCHING_UP" });
      expect(watermark()).toMatchObject({ slot: 1_999, resume_signature: null });
      // A continuing cursor moves down; an empty page clears it; a different `before` changes nothing.
      sql(`update public.indexer_heartbeat_watermarks set resume_signature = '${sig(63)}', resume_slot = 5000`);
      tick();
      p = plan();
      confirmWith(p.plan_id, { arBefore: sig(63), ar: [r(64, 4_000), r(65, 3_000)] });
      expect(watermark()).toMatchObject({ slot: 1_999, resume_signature: sig(65), resume_slot: 3_000 });
      tick();
      p = plan();
      expect(confirmWith(p.plan_id, { arBefore: sig(99), ar: [] })).toMatchObject({ reason: "CURSOR_MOVED" });
      expect(watermark()).toMatchObject({ resume_signature: sig(65) });
      tick();
      p = plan();
      confirmWith(p.plan_id, { arBefore: sig(65), ar: [] });
      expect(watermark()).toMatchObject({ slot: 1_999, resume_signature: null, resume_slot: null });
    });
  });

  describe("probes (S3) and expiry (S5)", () => {
    it("names old missing signatures as probe candidates; an exemption is accepted only for a candidate", () => {
      warm();
      // Old enough (tip - 150): a candidate. Too young: not yet.
      const listing = (t: number) => [r(70, t - 10), r(71, t - 400), floorRow(9_001)];
      expect(run({ ar: listing })).toMatchObject({ reason: "UNINDEXED_SIGNATURE" });
      expect(state().probe_signatures).toEqual([sig(71)]);
      tick();
      const p = plan();
      expect(p.probe).toEqual([sig(71)]);
      indexed(70, tip + 300 - 10);
      expect(confirmWith(p.plan_id, { ar: listing, exempt: [sig(70), sig(71)] })).toMatchObject({ outcome: "bumped" });
      const w = tip - 150;
      expect(watermark()?.slot).toBe(w);
      tick();
      // Not a candidate of the previous run: ignored.
      expect(run({ ar: (t) => [r(72, t - 100), floorRow(9_001, w)], exempt: [sig(72)] })).toMatchObject({ reason: "UNINDEXED_SIGNATURE" });
    });

    it("mode on: a signature missing for more than ~60 s expires freshness (status untouched); observe and young misses do not", () => {
      warm();
      sql("update public.indexer_sync_state set checked_at = now()");
      expect(run({ ar: (t) => [r(80, t - 10), floorRow(9_001)] })).toMatchObject({ reason: "UNINDEXED_SIGNATURE", expired: false });
      tick();
      const out = run({ ar: (t) => [r(80, t - 400), floorRow(9_001)] });
      expect(out).toMatchObject({ outcome: "declined", reason: "UNINDEXED_SIGNATURE", expired: true });
      expect(sql("select status || ':' || (checked_at < now() - interval '5 minutes') from public.indexer_sync_state")).toBe("ready:true");
      expect(state().last_expired_at).toEqual(expect.any(String));
      // Undecoded (delivered, job pending) never expires.
      sql("update public.indexer_sync_state set checked_at = now()");
      indexed(81, tip + 300 - 400, false);
      tick();
      expect(run({ ar: (t) => [r(81, t - 400), floorRow(9_001)] })).toMatchObject({ reason: "UNDECODED_SIGNATURE", expired: false });
      sql("update public.indexer_heartbeat_state set mode = 'observe'");
      tick();
      expect(run({ ar: (t) => [r(82, t - 400), floorRow(9_001)] })).toMatchObject({ reason: "UNINDEXED_SIGNATURE", expired: false });
      expect(sql("select checked_at > now() - interval '5 minutes' from public.indexer_sync_state")).toBe("t");
    });
  });

  describe("plans, client reasons and validation (M4)", () => {
    it("one confirm per plan; a superseded or late plan changes nothing it should not", () => {
      warm();
      const p = plan();
      expect(confirmWith(p.plan_id)).toMatchObject({ outcome: "bumped" });
      const after = state();
      expect(confirmWith(p.plan_id)).toEqual({ outcome: "declined", reason: "PLAN_SUPERSEDED", expired: false });
      expect(state()).toEqual(after);
      tick();
      const first = plan();
      tick();
      const second = plan();
      expect(confirmWith(first.plan_id)).toMatchObject({ reason: "PLAN_SUPERSEDED" });
      sql("update public.indexer_heartbeat_state set planned_at = now() - interval '40 seconds'");
      const tipBefore = state().tip_slot;
      expect(confirmWith(second.plan_id)).toMatchObject({ outcome: "declined", reason: "PLAN_EXPIRED" });
      expect(state()).toMatchObject({ plan_id: null, tip_slot: tipBefore });
    });

    it("a client reason is recorded under its plan and never bumps", () => {
      warm();
      sql(`update public.indexer_heartbeat_state set probe_signatures = ${texts([sig(1)])}`);
      for (const reason of ["RPC_ERROR", "RPC_TIMEOUT", "NO_BUDGET"]) {
        const p = plan();
        expect(json(`select public.confirm_indexer_quiet('devnet', '${p.plan_id}', '${reason}', null, null, null, null)`))
          .toMatchObject({ outcome: "declined", reason });
        expect(state()).toMatchObject({ plan_id: null, last_reason: reason, probe_signatures: [sig(1)] });
        tick();
      }
    });

    it("rejects malformed evidence with 22023, before any write; every NULL fails closed", () => {
      warm();
      const p = plan();
      const good = {
        tip: String(tip + 300),
        listings: [{ program: AR, before: null, rows: [floorRow(1)] }, { program: TH, before: null, rows: [floorRow(2)] }] as unknown[],
        sample: { context_slot: 199_000, accounts: [] } as unknown,
        exempt: "'{}'::text[]", reason: "null", plan: `'${p.plan_id}'`,
      };
      const call = (o: Partial<typeof good>) => {
        const v = { ...good, ...o };
        return sql(`select public.confirm_indexer_quiet('devnet', ${v.plan}, ${v.reason}, ${v.tip}, ${
          v.listings === null ? "null" : q(v.listings)}, ${v.sample === null ? "null" : q(v.sample)}, ${v.exempt})`);
      };
      const withRow = (row: unknown) => [{ program: AR, before: null, rows: [row] }, good.listings[1]];
      const withAccount = (account: unknown) => ({ context_slot: 1, accounts: [account] });
      const bad: Partial<typeof good>[] = [
        { plan: "null" },
        { reason: "'SOMETHING_ELSE'" },
        { tip: "null" }, { tip: "-1" },
        { listings: null as unknown as unknown[] }, { listings: {} as unknown as unknown[] },
        { listings: [good.listings[0]] },                                                       // missing program
        { listings: [good.listings[0], good.listings[0]] },                                     // duplicate program
        { listings: [good.listings[0], { program: "11111111111111111111111111111111", before: null, rows: [] }] },
        { listings: [{ program: AR, before: null }, good.listings[1]] },                          // no rows
        { listings: [{ program: AR, before: 5, rows: [] }, good.listings[1]] },
        { listings: [{ program: AR, before: "nope", rows: [] }, good.listings[1]] },
        { listings: withRow({ signature: sig(1), slot: 5 }) },                                  // missing ok (M4)
        { listings: withRow({ signature: sig(1), slot: 5, ok: null }) },
        { listings: withRow({ signature: sig(1), slot: null, ok: true }) },                     // null slot (M4)
        { listings: withRow({ signature: sig(1), ok: true }) },
        { listings: withRow({ signature: sig(1), slot: 1.5, ok: true }) },
        { listings: withRow({ signature: sig(1), slot: -1, ok: true }) },
        { listings: withRow({ signature: sig(1), slot: "5", ok: true }) },
        { listings: withRow({ signature: "short", slot: 5, ok: true }) },
        { listings: withRow(null) },
        { listings: [{ program: AR, before: null, rows: [r(1, 5), r(2, 6)] }, good.listings[1]] },          // slots go up
        { listings: [{ program: AR, before: null, rows: [r(1, 6), r(1, 5)] }, good.listings[1]] },          // duplicate row
        { listings: [{ program: AR, before: null, rows: Array.from({ length: 301 }, (_, i) => r(i, 5_000 - i)) }, good.listings[1]] },
        { sample: null }, { sample: { accounts: [] } }, { sample: { context_slot: null, accounts: [] } },
        { sample: { context_slot: 1 } },
        { sample: withAccount({ pda: AR, owner: AR }) },                                        // missing data key
        { sample: withAccount({ pda: AR, owner: AR, data: null }) },
        { sample: withAccount({ pda: AR, owner: null, data: "AA==" }) },
        { sample: withAccount({ pda: AR, owner: AR, data: "not base64!" }) },
        { sample: withAccount({ pda: "x", owner: null, data: null }) },
        { sample: { context_slot: 1, accounts: [{ pda: AR, owner: null, data: null }, { pda: AR, owner: null, data: null }] } },
        { exempt: texts([sig(1), sig(2), sig(3)]) }, { exempt: texts(["bad"]) }, { exempt: "array[null]::text[]" },
      ];
      const before = state();
      for (const o of bad) expect(() => call(o), JSON.stringify(o)).toThrow(/Invalid heartbeat evidence/);
      expect(state()).toEqual(before);
      expect(JSON.parse(call({}))).toMatchObject({ outcome: "bumped" });
    });
  });

  describe("networks, privileges and locking", () => {
    it("refuses mainnet on a devnet project; testnet keeps its own rows", () => {
      expect(() => plan("mainnet")).toThrow(/DEPLOYMENT_NETWORK_MISMATCH/);
      expect(() => sql(`select public.confirm_indexer_quiet('mainnet', gen_random_uuid(), 'RPC_ERROR', null, null, null, null)`))
        .toThrow(/DEPLOYMENT_NETWORK_MISMATCH/);
      const t = plan("testnet");
      expect(t).toMatchObject({ mode: "observe", due: true, floors: { [AR]: null, [TH]: null } });
      json(`select public.confirm_indexer_quiet('testnet', '${t.plan_id}', 'RPC_ERROR', null, null, null, null)`);
      expect(sql("select network || ':' || coalesce(last_reason, '-') from public.indexer_heartbeat_state order by network"))
        .toBe("devnet:-\ntestnet:RPC_ERROR");
    });

    it("is service_role only", () => {
      for (const role of ["anon", "authenticated"]) {
        for (const statement of [
          "select public.indexer_heartbeat_plan('devnet')",
          "select public.confirm_indexer_quiet('devnet', gen_random_uuid(), 'RPC_ERROR', null, null, null, null)",
          "select public.indexer_heartbeat_programs()",
          "select * from public.indexer_heartbeat_state",
          "select * from public.indexer_heartbeat_watermarks",
        ]) expect(() => sql(`set role ${role}; ${statement}`), `${role}: ${statement}`).toThrow(/permission denied/);
      }
      expect(sql("set role service_role; select public.indexer_heartbeat_plan('devnet')->>'mode'")).toBe("on");
      expect(sql("set role service_role; select count(*) from public.indexer_heartbeat_state")).toBe("1");
    });

    it("waits at most 2 s for the sync-row lock that finish_indexer_job and the reconcile take", async () => {
      expect(sql(`select array_to_string(proconfig, ',') from pg_proc where proname = 'confirm_indexer_quiet'`)).toContain("lock_timeout=2s");
      warm();
      const p = plan();
      const holder = db.queryAsync("begin; select 1 from public.indexer_sync_state where network = 'devnet' for update; select pg_sleep(4); commit;");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = Date.now();
      expect(() => confirmWith(p.plan_id)).toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(3_900);
      await holder;
      expect(state()).toMatchObject({ plan_id: p.plan_id });                     // nothing written
    }, 15_000);

    it("the status script is read-only and runs", () => {
      warm();
      const out = sql(readFileSync(join(process.cwd(), "scripts/ops/indexer-heartbeat-status.sql"), "utf8"));
      expect(out).toContain("TIP_BASELINE");
      expect(out).toContain("devnet|ready|1000");
    });

    it("re-applying 0075 keeps the configuration", () => {
      sql("update public.indexer_heartbeat_state set mode = 'on', interval_seconds = 60");
      sql(readFileSync(join(MIGRATIONS_DIR, "0075_indexer_heartbeat.sql"), "utf8"));
      expect(state()).toMatchObject({ mode: "on", interval_seconds: 60 });
      warm();
      expect(run()).toMatchObject({ outcome: "bumped" });
    });
  });
});
