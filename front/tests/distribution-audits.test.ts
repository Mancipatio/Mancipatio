// The retry worker's audit stage (lib/server/distribution-audits): a pending
// share_class_distribution row the sender's browser never confirmed (tab
// closed, RPC 429) gets its final row from the server once the chain has
// FINALIZED the transaction ("success", or "failed" with the transaction
// error), or "failed", not found (expired), when the cluster does not know
// it 2 hours after its pending row. The server row asserts only the chain
// status; what the pending row reported is carried as unverified
// client_claims. Idempotent (one server row per transaction, its id derived
// from the signature, ON CONFLICT DO NOTHING), bounded per run, oldest first
// with a keyset cursor, the fresh band before the backlog band.
//
// The in-memory database applies order(), limit() and range() here
// (`ordered`), so an ordering or paging bug changes which rows a run takes.
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));

import {
  CANDIDATES_PER_LIMIT,
  DISTRIBUTION_AUDIT_IX,
  DistributionAuditError,
  EXPIRY_HORIZON_MS,
  FRESH_BAND_MS,
  RECONCILE_MAX_AGE_MS,
  RECONCILE_MIN_AGE_MS,
  SCAN_PAGE,
  SCAN_PAGES,
  finalAuditStatus,
  reconcileDistributionAudits,
  reconciledAuditId,
} from "@/lib/server/distribution-audits";
import { distributionAuditRow } from "@/lib/distribution-run";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const MIN = 60_000;
/** A base58 address (32 bytes), distinct per n: synthetic, nobody's wallet. */
const ADDR = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
/** A valid base58 signature (64 bytes), distinct per n (n < 256). */
const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
/** A valid base58 signature for larger n (two bytes of n, the rest fixed). */
const BIGSIG = (n: number) => {
  const bytes = new Uint8Array(64).fill(7);
  bytes[0] = 1 + (n >> 8);
  bytes[1] = n & 0xff;
  return getBase58Decoder().decode(bytes);
};
const SENDER = ADDR(1);
const HOLDER = ADDR(2);
const MINT = ADDR(3);
const SC = ADDR(4);
const at = (msAgo: number, now = NOW) => new Date(now - msAgo).toISOString();
const ZERO = { complete: 0, pending: 0, invalid: 0, expired: 0, deferred: 0 };

type Status = { slot: bigint; err: unknown; confirmationStatus: string | null } | null;

function chain(statuses: Record<string, Status> = {}) {
  const calls: string[][] = [];
  const configs: unknown[] = [];
  let fail: Error | null = null;
  let onSend: (() => void) | null = null;
  const rpc = {
    getSignatureStatuses: vi.fn((signatures: readonly string[], config: unknown) => {
      calls.push([...signatures]);
      configs.push(config);
      return {
        send: async () => {
          onSend?.();
          if (fail) throw fail;
          return { context: { slot: BigInt(1) }, value: signatures.map((s) => statuses[s] ?? null) };
        },
      };
    }),
  };
  return { rpc, calls, configs, statuses, failWith: (e: Error) => void (fail = e), onSend: (f: () => void) => void (onSend = f) };
}

type Query = { table: string; calls: [string, unknown[]][] };

/**
 * memorySupabase (ordered) plus what this stage relies on from PostgREST:
 * INSERT … ON CONFLICT (id) DO NOTHING for an upsert that asks for it (the
 * conflict is checked when the statement runs, like the database does), and
 * every query's builder calls recorded.
 */
function database() {
  const db = memorySupabase();
  db.ordered = true;
  db.defaults.audit_events = () => ({ created_at: new Date().toISOString() });
  const upserts: { rows: Row[]; options: unknown }[] = [];
  const queries: Query[] = [];
  const client = {
    ...db.client,
    from: (table: string) => {
      const b = db.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
      const query: Query = { table, calls: [] };
      queries.push(query);
      for (const method of ["select", "eq", "in", "gte", "lte", "lt", "order", "limit", "range"]) {
        const original = b[method];
        b[method] = (...args: unknown[]) => (query.calls.push([method, args]), original(...args));
      }
      const upsert = b.upsert;
      b.upsert = (rows: unknown, options?: unknown) => {
        const list = (Array.isArray(rows) ? rows : [rows]) as Row[];
        upserts.push({ rows: list, options });
        const ignore = (options as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates;
        const statement = {
          abortSignal: () => statement,
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
            const fresh = ignore ? list.filter((r) => !db.rows(table).some((x) => x.id === r.id)) : list;
            return (upsert(fresh, options) as PromiseLike<unknown>).then(resolve, reject);
          },
        };
        return statement;
      };
      return b;
    },
  };
  /** The pending-row scans, in order (the reads that select id,created_at,tx_signature). */
  const scans = () => queries.filter((q) => q.calls.some(([m, a]) => m === "select" && a[0] === "id,created_at,tx_signature"));
  return { db, client, upserts, queries, scans };
}

let store: ReturnType<typeof database>;
const audit = () => store.db.rows("audit_events");
const finals = () => audit().filter((r) => r.status !== "pending");
const finalOf = (signature: string) => finals().find((r) => r.tx_signature === signature);
const call = (q: Query, method: string) => q.calls.filter(([m]) => m === method).map(([, a]) => a);

/** A pending row as the browser writes it (via /api/audit: network and the server stamps). */
function pending(signature: string | null, minutesAgo: number, over: Partial<Row> = {}): Row {
  const row = {
    id: `pending-${String(audit().length + 1).padStart(5, "0")}`,
    network: "mainnet",
    created_at: at(minutesAgo * MIN),
    ...distributionAuditRow({
      actor: SENDER,
      reason: "First distribution",
      scPda: SC,
      runId: "run-1",
      mint: MINT,
      signature: signature as string,
      status: "pending",
      rows: [{ wallet: HOLDER, amount: BigInt(500) }],
    }),
    ...over,
  } as Row;
  row.metadata = { ...(row.metadata as Row), server_received_at: row.created_at, actor_verified: false, actor_source: "client-unsigned" };
  audit().push(row);
  return row;
}

/** The browser's own final row for a signature (what the stage must skip). */
function browserFinal(signature: string, minutesAgo: number, status: "success" | "failed" = "success"): Row {
  const row: Row = { ...pending(signature, minutesAgo), status };
  audit().pop();
  row.id = `final-${String(audit().length + 1).padStart(5, "0")}`;
  audit().push(row);
  return row;
}

const finalized = (slot = 400_000_000, err: unknown = null): Status => ({ slot: BigInt(slot), err, confirmationStatus: "finalized" });

async function run(
  rpc: ReturnType<typeof chain>["rpc"],
  limit = 10,
  options: { deadline?: number; signal?: AbortSignal; now?: number } = {},
) {
  return reconcileDistributionAudits(limit, options.deadline ?? Date.now() + 5_000, options.signal, {
    sb: store.client as never,
    rpc: rpc as never,
    now: () => options.now ?? NOW,
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  store = database();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("finalAuditStatus", () => {
  it("settles only a FINALIZED status: no error → success, an error → failed", () => {
    expect(finalAuditStatus(finalized())).toBe("success");
    expect(finalAuditStatus(finalized(1, { InstructionError: [0, { Custom: 6001 }] }))).toBe("failed");
    expect(finalAuditStatus({ slot: BigInt(1), err: null, confirmationStatus: "confirmed" })).toBeNull();
    expect(finalAuditStatus({ slot: BigInt(1), err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" })).toBeNull();
    expect(finalAuditStatus({ slot: BigInt(1), err: null, confirmationStatus: null })).toBeNull();
    expect(finalAuditStatus(null)).toBeNull();
  });
});

describe("reconciledAuditId", () => {
  it("is a UUID derived from the network and the signature", () => {
    const id = reconciledAuditId("mainnet", SIG(1));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(reconciledAuditId("mainnet", SIG(1))).toBe(id);
    expect(reconciledAuditId("devnet", SIG(1))).not.toBe(id);
    expect(reconciledAuditId("mainnet", SIG(2))).not.toBe(id);
  });
});

describe("the server's final row: chain facts only", () => {
  it("settles a pending transaction the chain finalized (the rehearsal's stuck rows); the claims stay unverified", async () => {
    const row = pending(SIG(1), 30);
    const { rpc, calls, configs } = chain({ [SIG(1)]: finalized(401_234_567) });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 1 });
    expect(calls).toEqual([[SIG(1)]]);
    expect(configs[0]).toEqual({ searchTransactionHistory: true });
    // The pending row is never changed (append-only); the final row is appended next to it.
    expect(audit().find((r) => r.id === row.id)?.status).toBe("pending");
    const final = finalOf(SIG(1))!;
    // The server's row: its own actor, no share class, its own reason — nothing taken from the pending row.
    expect(final).toMatchObject({
      id: reconciledAuditId("mainnet", SIG(1)),
      network: "mainnet",
      ix_name: DISTRIBUTION_AUDIT_IX,
      category: "share-class",
      actor_wallet: "server",
      target_label: null,
      tx_signature: SIG(1),
      reason: "Finalized on chain (checked by the server)",
      status: "success",
    });
    const metadata = final.metadata as Row;
    expect(metadata).toMatchObject({
      chain_outcome: "finalized",
      slot: "401234567",
      confirmation_status: "finalized",
      reconciled_by_server: true,
      reconciled_by: "retry-worker",
      pending_row_ids: [row.id],
      pending_rows: 1,
      pending_created_at: row.created_at,
      actor_verified: false,
      actor_source: "retry-worker",
    });
    expect(metadata).not.toHaveProperty("tx_error");
    // No claim at the top level, where a reader would take it for checked…
    for (const key of ["recipients", "total", "run_id", "mint", "screening_complete", "reconciled_from"]) expect(metadata).not.toHaveProperty(key);
    // …only under client_claims, marked unverified.
    expect(metadata.client_claims).toEqual({
      verified: false,
      row_id: row.id,
      created_at: row.created_at,
      actor_wallet: SENDER,
      actor_source: "client-unsigned",
      reason: "First distribution",
      target_label: SC,
      run_id: "run-1",
      mint: MINT,
      decimals: 0,
      recipients: [{ to: HOLDER, amount: "500", screening: null }],
      total: "500",
      screening_complete: false,
    });
  });

  it("marks a transaction that landed with an error failed, with the error (bigints as strings)", async () => {
    pending(SIG(2), 10);
    const err = { InstructionError: [1, { Custom: BigInt(6128) }] };
    const { rpc } = chain({ [SIG(2)]: finalized(5, err) });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 1 });
    expect(finalOf(SIG(2))).toMatchObject({ status: "failed", reason: "Finalized on chain with an error (checked by the server)" });
    expect(finalOf(SIG(2))!.metadata).toMatchObject({ chain_outcome: "finalized_with_error", tx_error: { InstructionError: [1, { Custom: "6128" }] } });
  });

  it("a later pending row naming the same (real) signature cannot replace the sender's claims: the oldest row's are carried, the other is only referenced", async () => {
    const honest = pending(SIG(30), 40);
    const forged = pending(SIG(30), 20, {
      actor_wallet: ADDR(9),
      reason: "forged",
      metadata: { run_id: "x", mint: MINT, recipients: [{ to: ADDR(9), amount: "999999", screening: null }], total: "999999" },
    });
    const { rpc } = chain({ [SIG(30)]: finalized() });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 1 });
    const final = finalOf(SIG(30))!;
    expect(final).toMatchObject({ actor_wallet: "server", status: "success" });
    const metadata = final.metadata as Row;
    expect(metadata).toMatchObject({ pending_row_ids: [honest.id, forged.id], pending_rows: 2, pending_created_at: honest.created_at });
    expect(metadata.client_claims).toMatchObject({ verified: false, row_id: honest.id, actor_wallet: SENDER, total: "500" });
    expect(JSON.stringify(final)).not.toContain("999999");
  });
});

describe("what the chain decides", () => {
  it("leaves pending what is not final yet, and what the chain does not know yet (younger than 2 hours)", async () => {
    pending(SIG(3), 10);
    pending(SIG(4), 10);
    pending(SIG(5), 119);
    const { rpc, calls } = chain({
      [SIG(3)]: { slot: BigInt(9), err: null, confirmationStatus: "confirmed" },
      [SIG(4)]: { slot: BigInt(9), err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" },
      // SIG(5): not found, 1 h 59 min after its pending row.
    });
    expect(await run(rpc)).toEqual({ ...ZERO, pending: 3 });
    expect(calls[0].sort()).toEqual([SIG(3), SIG(4), SIG(5)].sort());
    expect(finals()).toEqual([]);
  });

  it("settles a transaction the cluster does not know 2 hours after its oldest pending row: failed, not found (expired)", async () => {
    pending(SIG(40), EXPIRY_HORIZON_MS / MIN); // exactly 2 h: the blockhash (~60-90 s) is long gone
    pending(SIG(41), 125);
    pending(SIG(42), 130); // the oldest pending row of SIG(42) counts…
    pending(SIG(42), 30); // …not the newest
    pending(SIG(43), 150); // found, but not finalized: never called expired
    const { rpc } = chain({ [SIG(43)]: { slot: BigInt(9), err: null, confirmationStatus: "confirmed" } });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 3, expired: 3, pending: 1 });
    for (const signature of [SIG(40), SIG(41), SIG(42)]) {
      const final = finalOf(signature)!;
      expect(final).toMatchObject({ status: "failed", reason: "Not found on chain (expired)", actor_wallet: "server" });
      expect(final.metadata).toMatchObject({ chain_outcome: "not_found_expired", expiry_horizon_ms: EXPIRY_HORIZON_MS });
      expect(final.metadata).not.toHaveProperty("slot");
      expect(final.metadata).not.toHaveProperty("confirmation_status");
    }
    expect(finalOf(SIG(43))).toBeUndefined();
  });

  it("rows that never settle hold the candidate slots for at most 2 hours, oldest first", async () => {
    // limit 1 → 10 candidates per run: ten dropped transactions (never found) and one finalized, newer.
    for (let i = 0; i < 10; i++) pending(SIG(60 + i), 100 + i);
    pending(SIG(70), 10);
    const statuses = { [SIG(70)]: finalized() };
    const first = chain(statuses);
    expect(await run(first.rpc, 1)).toEqual({ ...ZERO, pending: 10 });
    expect(first.calls[0]).not.toContain(SIG(70));
    // Twenty minutes later the ten are 2 h old: expired, settled; SIG(70) is next.
    const later = NOW + 20 * MIN;
    expect(await run(chain(statuses).rpc, 1, { now: later })).toEqual({ ...ZERO, complete: 10, expired: 10 });
    expect(await run(chain(statuses).rpc, 1, { now: later + MIN })).toEqual({ ...ZERO, complete: 1 });
    expect(finalOf(SIG(70))).toMatchObject({ status: "success" });
  });
});

describe("which rows a run takes", () => {
  it("looks only at rows between 5 minutes and 7 days old (younger: the browser's; older: aged out, no alarm)", async () => {
    pending(SIG(6), RECONCILE_MIN_AGE_MS / MIN - 1); // still the browser's
    pending(SIG(7), RECONCILE_MAX_AGE_MS / MIN + 1); // aged out
    pending(SIG(8), RECONCILE_MIN_AGE_MS / MIN); // the boundary is in
    pending(SIG(9), FRESH_BAND_MS / MIN + 120); // the backlog band (an outage), 5 h old
    const { rpc, calls } = chain({ [SIG(6)]: finalized(), [SIG(7)]: finalized(), [SIG(8)]: finalized(), [SIG(9)]: finalized() });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 2 });
    expect(calls).toEqual([[SIG(8), SIG(9)]]);
    expect(finals().map((r) => r.tx_signature).sort()).toEqual([SIG(8), SIG(9)].sort());
  });

  it("skips a transaction that already has its final row (the browser's, a resume's or its own), and other networks and instructions", async () => {
    pending(SIG(10), 20);
    browserFinal(SIG(10), 19);
    pending(SIG(11), 20);
    browserFinal(SIG(11), 19, "failed");
    pending(SIG(12), 20, { network: "devnet" });
    pending(SIG(13), 20, { ix_name: "mint_to_treasury" });
    const { rpc, calls } = chain({ [SIG(10)]: finalized(), [SIG(11)]: finalized(), [SIG(12)]: finalized(), [SIG(13)]: finalized() });
    expect(await run(rpc)).toEqual(ZERO);
    expect(calls).toEqual([]); // nothing left to ask the chain
    expect(store.upserts).toEqual([]);
  });

  it("reads oldest first with a keyset cursor: the fresh band (5 min to 3 h), then the backlog band (3 h to 7 days)", async () => {
    pending(SIG(20), 10);
    await run(chain().rpc);
    const [fresh, backlog] = store.scans();
    expect(store.scans()).toHaveLength(2);
    for (const q of [fresh, backlog]) {
      expect(call(q, "eq")).toEqual([["network", "mainnet"], ["ix_name", DISTRIBUTION_AUDIT_IX], ["status", "pending"]]);
      expect(call(q, "order")).toEqual([["created_at", { ascending: true }], ["id", { ascending: true }]]);
      expect(call(q, "limit")).toEqual([[SCAN_PAGE]]);
      expect(call(q, "range")).toEqual([]); // no offsets
    }
    expect(call(fresh, "gte")).toEqual([["created_at", at(FRESH_BAND_MS)]]);
    expect(call(fresh, "lte")).toEqual([["created_at", at(RECONCILE_MIN_AGE_MS)]]);
    expect(call(backlog, "gte")).toEqual([["created_at", at(RECONCILE_MAX_AGE_MS)]]);
    expect(call(backlog, "lt")).toEqual([["created_at", at(FRESH_BAND_MS)]]);
  });

  it("takes the oldest candidates first when there are more than one run takes", async () => {
    for (let i = 0; i < 15; i++) pending(SIG(100 + i), 10 + i); // SIG(114) is the oldest
    const statuses: Record<string, Status> = {};
    for (let i = 0; i < 15; i++) statuses[SIG(100 + i)] = finalized();
    const first = chain(statuses);
    expect(await run(first.rpc, 1)).toEqual({ ...ZERO, complete: CANDIDATES_PER_LIMIT });
    // Oldest first: the ten oldest (SIG(105)…SIG(114)), in that order.
    expect(first.calls).toEqual([Array.from({ length: 10 }, (_, i) => SIG(114 - i))]);
    // The next run takes the rest.
    const next = chain(statuses);
    expect(await run(next.rpc, 1)).toEqual({ ...ZERO, complete: 5 });
    expect(next.calls).toEqual([[SIG(104), SIG(103), SIG(102), SIG(101), SIG(100)]]);
    expect(finals()).toHaveLength(15);
    await expect(run(next.rpc, 21)).rejects.toThrow(/between 1 and 20/);
    await expect(run(next.rpc, 0)).rejects.toThrow(/between 1 and 20/);
  });

  it("pages past settled rows with the cursor, rows of one instant across a page boundary included, reading each row once", async () => {
    // 120 pending rows in the fresh band, oldest first; the three around the first page boundary share one instant.
    const rows: Row[] = [];
    for (let i = 0; i < 120; i++) {
      // Row i is (175 - i) min 30 s old; rows 48-50 share one instant between rows 47 and 51.
      const created = i >= 48 && i <= 50 ? at(126 * MIN) : at((175 - i) * MIN + 30_000);
      rows.push(pending(BIGSIG(i), 0, { created_at: created }));
    }
    // All of them settled by the browser except five: two of the shared instant (49, the first page's last row,
    // which the second page reads again, and 50, past the boundary) and the three newest.
    const open = new Set([BIGSIG(49), BIGSIG(50), BIGSIG(117), BIGSIG(118), BIGSIG(119)]);
    for (let i = 0; i < 120; i++) if (!open.has(BIGSIG(i))) browserFinal(BIGSIG(i), 0);
    const statuses: Record<string, Status> = {};
    for (const s of open) statuses[s] = finalized();
    const { rpc, calls } = chain(statuses);
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 5 });
    expect(calls).toEqual([[BIGSIG(49), BIGSIG(50), BIGSIG(117), BIGSIG(118), BIGSIG(119)]]);
    // Row 49, read again at the top of the second page, still counts once.
    for (const s of open) expect(finalOf(s)!.metadata).toMatchObject({ pending_rows: 1, pending_row_ids: [expect.any(String)] });
    // Three pages of the fresh band (the second starts AT the first page's last instant), then the backlog band.
    const scans = store.scans();
    expect(scans).toHaveLength(4);
    expect(call(scans[1], "gte")).toEqual([["created_at", rows[SCAN_PAGE - 1].created_at]]);
    expect(rows[SCAN_PAGE - 1].created_at).toBe(rows[48].created_at);
    // The second page started two rows back (48 and 49 again, skipped): it ended at row 97.
    expect(call(scans[2], "gte")).toEqual([["created_at", rows[97].created_at]]);
    // Each new signature was looked up once (no row read twice as new).
    const looked = store.queries
      .filter((q) => call(q, "in").some(([c]) => c === "tx_signature"))
      .flatMap((q) => call(q, "in").filter(([c]) => c === "tx_signature").flatMap(([, v]) => v as string[]));
    expect(looked).toHaveLength(120);
    expect(new Set(looked).size).toBe(120);
  });

  it("a week of settled history never hides a new row: the fresh band is read first", async () => {
    // More settled history in the backlog band than one run's pages (SCAN_PAGES × SCAN_PAGE)…
    const history = SCAN_PAGES * SCAN_PAGE + 100;
    for (let i = 0; i < history; i++) {
      pending(BIGSIG(i), FRESH_BAND_MS / MIN + 1 + i);
      browserFinal(BIGSIG(i), FRESH_BAND_MS / MIN + i);
    }
    // …an unsettled row from an outage, older than all of it, and a new one.
    pending(SIG(201), FRESH_BAND_MS / MIN + history + 10);
    pending(SIG(200), 10);
    const { rpc, calls } = chain({ [SIG(200)]: finalized(), [SIG(201)]: finalized() });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 2 });
    expect(calls).toEqual([[SIG(200), SIG(201)]]);
    expect(store.scans().length).toBeLessThanOrEqual(SCAN_PAGES);
  });

  it("is idempotent: a second run finds the final row and asks nothing", async () => {
    pending(SIG(14), 30);
    const first = chain({ [SIG(14)]: finalized() });
    await run(first.rpc);
    const second = chain({ [SIG(14)]: finalized() });
    expect(await run(second.rpc)).toEqual(ZERO);
    expect(second.calls).toEqual([]);
    expect(finals()).toHaveLength(1);
  });

  it("two runs that race write one row: the id comes from the signature and the write is ON CONFLICT DO NOTHING", async () => {
    pending(SIG(15), 30);
    const a = chain({ [SIG(15)]: finalized() });
    const b = chain({ [SIG(15)]: finalized() });
    await Promise.all([run(a.rpc), run(b.rpc)]);
    // Both saw the row pending and both wrote it…
    expect(store.upserts).toHaveLength(2);
    for (const u of store.upserts) expect(u.options).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(store.upserts[0].rows[0].id).toBe(store.upserts[1].rows[0].id);
    // …and the table holds one final row.
    expect(finals()).toHaveLength(1);
    expect(finals()[0].id).toBe(reconciledAuditId("mainnet", SIG(15)));
  });

  it("one final row for duplicate pending rows of one transaction, listing them oldest first", async () => {
    const older = pending(SIG(16), 40);
    const newer = pending(SIG(16), 39);
    const { rpc, calls } = chain({ [SIG(16)]: finalized() });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 1 });
    expect(calls).toEqual([[SIG(16)]]);
    expect(finals()).toHaveLength(1);
    expect(finals()[0].metadata).toMatchObject({ pending_row_ids: [older.id, newer.id], pending_rows: 2 });
  });

  it("settles more rows than one page (the full rows are read 50 ids at a time)", async () => {
    const statuses: Record<string, Status> = {};
    for (let i = 0; i < 60; i++) {
      pending(SIG(150 + i), 10 + i);
      statuses[SIG(150 + i)] = finalized(1_000 + i);
    }
    const { rpc, calls } = chain(statuses);
    expect(await run(rpc, 20)).toEqual({ ...ZERO, complete: 60 });
    expect(calls).toHaveLength(1);
    expect(new Set(finals().map((r) => r.tx_signature)).size).toBe(60);
    const byId = store.queries.filter((q) => call(q, "in").some(([c]) => c === "id"));
    expect(byId.map((q) => (call(q, "in")[0][1] as string[]).length)).toEqual([50, 10]);
  });

  it("counts a row without a usable signature as invalid and never sends it to the chain", async () => {
    pending("not-a-signature", 10);
    pending(null, 10, { tx_signature: null });
    pending(SIG(17), 10);
    const { rpc, calls } = chain({ [SIG(17)]: finalized() });
    expect(await run(rpc)).toEqual({ ...ZERO, complete: 1, invalid: 2 });
    expect(calls).toEqual([[SIG(17)]]);
  });

  it("asks nothing of the chain when there is nothing to settle", async () => {
    const { rpc, calls } = chain();
    expect(await run(rpc)).toEqual(ZERO);
    expect(calls).toEqual([]);
  });
});

describe("failures and deadlines", () => {
  it("writes nothing when the chain or the database cannot answer; the error says which, with the rows left (no RPC message)", async () => {
    pending(SIG(18), 10);
    const down = chain({ [SIG(18)]: finalized() });
    down.failWith(new Error("HTTP error (429): Too Many Requests https://rpc.invalid/?api-key=secret"));
    const chainError = await run(down.rpc).catch((e: unknown) => e);
    expect(chainError).toBeInstanceOf(DistributionAuditError);
    expect(chainError).toMatchObject({ stageCode: "chain", counts: { ...ZERO, deferred: 1 } });
    expect((chainError as Error).message).not.toContain("api-key");
    expect(finals()).toEqual([]);

    store.db.failReads.add("audit_events");
    await expect(run(chain().rpc)).rejects.toMatchObject({ stageCode: "database", counts: ZERO });
    store.db.failReads.clear();

    store.db.failWrites.add("audit_events");
    await expect(run(chain({ [SIG(18)]: finalized() }).rpc)).rejects.toMatchObject({ stageCode: "database", counts: { ...ZERO, deferred: 1 } });
    store.db.failWrites.clear();
    expect(finals()).toEqual([]);
  });

  it("does nothing past its deadline or after an abort", async () => {
    pending(SIG(19), 10);
    const { rpc, calls } = chain({ [SIG(19)]: finalized() });
    expect(await run(rpc, 10, { deadline: Date.now() - 1 })).toEqual(ZERO);
    expect(await run(rpc, 10, { signal: AbortSignal.abort() })).toEqual(ZERO);
    expect(calls).toEqual([]);
    expect(finals()).toEqual([]);
  });

  it("an abort after the chain answered leaves the decided rows for the next run (deferred), unwritten", async () => {
    pending(SIG(21), 10);
    pending(SIG(22), 10);
    const controller = new AbortController();
    const c = chain({ [SIG(21)]: finalized(), [SIG(22)]: finalized() });
    c.onSend(() => controller.abort());
    expect(await run(c.rpc, 10, { signal: controller.signal })).toEqual({ ...ZERO, deferred: 2 });
    expect(finals()).toEqual([]);
  });
});
