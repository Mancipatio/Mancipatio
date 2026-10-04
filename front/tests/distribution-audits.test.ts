// The retry worker's audit stage (lib/server/distribution-audits): a pending
// share_class_distribution row the sender's browser never confirmed (tab
// closed, RPC 429) gets its final row from the server once the chain has
// FINALIZED the transaction: "success", or "failed" with the transaction
// error; never "expired" (no lastValidBlockHeight is stored with the row),
// so a transaction the chain does not know stays pending and ages out after
// 7 days. Idempotent (one server row per transaction, its id derived from
// the signature, ON CONFLICT DO NOTHING), bounded per run, newest first.
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));

import {
  CANDIDATES_PER_LIMIT,
  DISTRIBUTION_AUDIT_IX,
  RECONCILE_MAX_AGE_MS,
  RECONCILE_MIN_AGE_MS,
  finalAuditStatus,
  reconcileDistributionAudits,
  reconciledAuditId,
} from "@/lib/server/distribution-audits";
import { distributionAuditRow } from "@/lib/distribution-run";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const MIN = 60_000;
/** A base58 address (32 bytes), distinct per n: synthetic, nobody's wallet. */
const ADDR = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
/** A valid base58 signature (64 bytes), distinct per n. */
const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const SENDER = ADDR(1);
const HOLDER = ADDR(2);
const MINT = ADDR(3);
const SC = ADDR(4);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Status = { slot: bigint; err: unknown; confirmationStatus: string | null } | null;

function chain(statuses: Record<string, Status> = {}) {
  const calls: string[][] = [];
  const configs: unknown[] = [];
  let fail: Error | null = null;
  const rpc = {
    getSignatureStatuses: vi.fn((signatures: readonly string[], config: unknown) => {
      calls.push([...signatures]);
      configs.push(config);
      return {
        send: async () => {
          if (fail) throw fail;
          return { context: { slot: BigInt(1) }, value: signatures.map((s) => statuses[s] ?? null) };
        },
      };
    }),
  };
  return { rpc, calls, configs, statuses, failWith: (e: Error) => void (fail = e) };
}

/**
 * memorySupabase plus what this stage relies on from PostgREST: INSERT … ON
 * CONFLICT (id) DO NOTHING for an upsert that asks for it (the conflict is
 * checked when the statement runs, like the database does), and the upserts
 * and orderings recorded (the helper itself applies no order).
 */
function database() {
  const db = memorySupabase();
  db.defaults.audit_events = () => ({ created_at: new Date().toISOString() });
  const upserts: { rows: Row[]; options: unknown }[] = [];
  const orders: [string, unknown][] = [];
  const client = {
    ...db.client,
    from: (table: string) => {
      const b = db.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
      const upsert = b.upsert;
      const order = b.order;
      b.order = (column: unknown, options?: unknown) => (orders.push([String(column), options]), order(column, options));
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
  return { db, client, upserts, orders };
}

let store: ReturnType<typeof database>;
const audit = () => store.db.rows("audit_events");
const finals = () => audit().filter((r) => r.status !== "pending");

/** A pending row as the browser writes it (via /api/audit: network and the server stamps). */
function pending(signature: string, minutesAgo: number, over: Partial<Row> = {}): Row {
  const row = {
    id: `pending-${audit().length + 1}`,
    network: "mainnet",
    created_at: at(minutesAgo * MIN),
    ...distributionAuditRow({
      actor: SENDER,
      reason: "First distribution",
      scPda: SC,
      runId: "run-1",
      mint: MINT,
      signature,
      status: "pending",
      rows: [{ wallet: HOLDER, amount: BigInt(500) }],
    }),
    ...over,
  } as Row;
  row.metadata = { ...(row.metadata as Row), server_received_at: at(minutesAgo * MIN), actor_verified: false, actor_source: "client-unsigned" };
  audit().push(row);
  return row;
}

const finalized = (slot = 400_000_000, err: unknown = null): Status => ({ slot: BigInt(slot), err, confirmationStatus: "finalized" });

async function run(rpc: ReturnType<typeof chain>["rpc"], limit = 10, deadline = Date.now() + 5_000, signal?: AbortSignal) {
  return reconcileDistributionAudits(limit, deadline, signal, { sb: store.client as never, rpc: rpc as never, now: () => NOW });
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

describe("reconcileDistributionAudits", () => {
  it("appends the final row of a pending transaction the chain finalized (the rehearsal's stuck rows)", async () => {
    const row = pending(SIG(1), 30);
    const { rpc, calls, configs } = chain({ [SIG(1)]: finalized(401_234_567) });
    expect(await run(rpc)).toEqual({ complete: 1, pending: 0, invalid: 0 });
    expect(calls).toEqual([[SIG(1)]]);
    expect(configs[0]).toEqual({ searchTransactionHistory: true });
    // The pending row is never changed (append-only); the final row is appended next to it.
    expect(audit().find((r) => r.id === row.id)?.status).toBe("pending");
    const [final] = finals();
    expect(final).toMatchObject({
      id: reconciledAuditId("mainnet", SIG(1)),
      network: "mainnet",
      ix_name: DISTRIBUTION_AUDIT_IX,
      category: "share-class",
      actor_wallet: SENDER,
      target_label: SC,
      tx_signature: SIG(1),
      reason: "First distribution",
      status: "success",
    });
    expect(final.metadata).toMatchObject({
      run_id: "run-1",
      mint: MINT,
      recipients: [{ to: HOLDER, amount: "500", screening: null }],
      total: "500",
      reconciled_by_server: true,
      reconciled_by: "retry-worker",
      reconciled_from: row.id,
      pending_created_at: row.created_at,
      slot: "401234567",
      confirmation_status: "finalized",
      // The claim stays what it was: an unsigned pending row is not verified by the server's row.
      actor_verified: false,
      actor_source: "client-unsigned",
    });
    expect(final.metadata).not.toHaveProperty("tx_error");
    expect((final.metadata as Row).server_received_at).not.toBe((row.metadata as Row).server_received_at);
  });

  it("marks a transaction that landed with an error failed, with the error (bigints as strings)", async () => {
    pending(SIG(2), 10);
    const err = { InstructionError: [1, { Custom: BigInt(6128) }] };
    const { rpc } = chain({ [SIG(2)]: finalized(5, err) });
    expect(await run(rpc)).toEqual({ complete: 1, pending: 0, invalid: 0 });
    expect(finals()[0]).toMatchObject({ status: "failed", tx_signature: SIG(2) });
    expect((finals()[0].metadata as Row).tx_error).toEqual({ InstructionError: [1, { Custom: "6128" }] });
  });

  it("leaves pending what is not final yet, and what the chain does not know (never 'expired')", async () => {
    pending(SIG(3), 10);
    pending(SIG(4), 10);
    pending(SIG(5), 10);
    const { rpc, calls } = chain({
      [SIG(3)]: { slot: BigInt(9), err: null, confirmationStatus: "confirmed" },
      [SIG(4)]: { slot: BigInt(9), err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" },
      // SIG(5): not found.
    });
    expect(await run(rpc)).toEqual({ complete: 0, pending: 3, invalid: 0 });
    expect(calls[0].sort()).toEqual([SIG(3), SIG(4), SIG(5)].sort());
    expect(finals()).toEqual([]);
    expect(audit().every((r) => r.status === "pending")).toBe(true);
  });

  it("looks only at rows between 5 minutes and 7 days old (younger: the browser's; older: aged out, no alarm)", async () => {
    pending(SIG(6), RECONCILE_MIN_AGE_MS / MIN - 1); // still the browser's
    pending(SIG(7), RECONCILE_MAX_AGE_MS / MIN + 1); // aged out
    pending(SIG(8), RECONCILE_MIN_AGE_MS / MIN); // the boundary is in
    const { rpc, calls } = chain({ [SIG(6)]: finalized(), [SIG(7)]: finalized(), [SIG(8)]: finalized() });
    expect(await run(rpc)).toEqual({ complete: 1, pending: 0, invalid: 0 });
    expect(calls).toEqual([[SIG(8)]]);
    expect(finals().map((r) => r.tx_signature)).toEqual([SIG(8)]);
  });

  it("skips a transaction that already has its final row (the browser's, a resume's or its own), and other networks and instructions", async () => {
    pending(SIG(9), 20);
    audit().push({ ...pending(SIG(9), 19), id: "browser-final", status: "success" });
    pending(SIG(10), 20);
    audit().push({ ...pending(SIG(10), 19), id: "resume-final", status: "failed" });
    pending(SIG(11), 20, { network: "devnet" });
    pending(SIG(12), 20, { ix_name: "mint_to_treasury" });
    const { rpc, calls } = chain({ [SIG(9)]: finalized(), [SIG(10)]: finalized(), [SIG(11)]: finalized(), [SIG(12)]: finalized() });
    expect(await run(rpc)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(calls).toEqual([]); // nothing left to ask the chain
    expect(store.upserts).toEqual([]);
  });

  it("is idempotent: a second run finds the final row and asks nothing", async () => {
    pending(SIG(13), 30);
    const first = chain({ [SIG(13)]: finalized() });
    await run(first.rpc);
    const second = chain({ [SIG(13)]: finalized() });
    expect(await run(second.rpc)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(second.calls).toEqual([]);
    expect(finals()).toHaveLength(1);
  });

  it("two runs that race write one row: the id comes from the signature and the write is ON CONFLICT DO NOTHING", async () => {
    pending(SIG(14), 30);
    const a = chain({ [SIG(14)]: finalized() });
    const b = chain({ [SIG(14)]: finalized() });
    await Promise.all([run(a.rpc), run(b.rpc)]);
    // Both saw the row pending and both wrote it…
    expect(store.upserts).toHaveLength(2);
    for (const u of store.upserts) expect(u.options).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(store.upserts[0].rows[0].id).toBe(store.upserts[1].rows[0].id);
    // …and the table holds one final row.
    expect(finals()).toHaveLength(1);
    expect(finals()[0].id).toBe(reconciledAuditId("mainnet", SIG(14)));
  });

  it("one final row for duplicate pending rows of one transaction", async () => {
    const older = pending(SIG(15), 40);
    const newer = pending(SIG(15), 39);
    const { rpc, calls } = chain({ [SIG(15)]: finalized() });
    expect(await run(rpc)).toEqual({ complete: 1, pending: 0, invalid: 0 });
    expect(calls).toEqual([[SIG(15)]]);
    expect(finals()).toHaveLength(1);
    expect([older.id, newer.id]).toContain((finals()[0].metadata as Row).reconciled_from);
  });

  it("reads the pending rows newest first (rows that never settle hold back only older ones)", async () => {
    pending(SIG(20), 10);
    await run(chain().rpc);
    expect(store.orders).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("is bounded per run: limit × 10 signatures in one status call", async () => {
    for (let i = 0; i < 15; i++) pending(SIG(100 + i), 10 + i);
    const statuses: Record<string, Status> = {};
    for (let i = 0; i < 15; i++) statuses[SIG(100 + i)] = finalized();
    const { rpc, calls } = chain(statuses);
    expect(await run(rpc, 1)).toEqual({ complete: CANDIDATES_PER_LIMIT, pending: 0, invalid: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(CANDIDATES_PER_LIMIT);
    // The next run takes the rest.
    const next = chain(statuses);
    expect(await run(next.rpc, 1)).toEqual({ complete: 5, pending: 0, invalid: 0 });
    expect(finals()).toHaveLength(15);
    await expect(run(next.rpc, 21)).rejects.toThrow(/between 1 and 20/);
    await expect(run(next.rpc, 0)).rejects.toThrow(/between 1 and 20/);
  });

  it("settles more rows than one page (the full rows are read 50 ids at a time)", async () => {
    const statuses: Record<string, Status> = {};
    for (let i = 0; i < 60; i++) {
      pending(SIG(150 + i), 10 + i);
      statuses[SIG(150 + i)] = finalized(1_000 + i);
    }
    const { rpc, calls } = chain(statuses);
    expect(await run(rpc, 20)).toEqual({ complete: 60, pending: 0, invalid: 0 });
    expect(calls).toHaveLength(1);
    expect(new Set(finals().map((r) => r.tx_signature)).size).toBe(60);
  });

  it("counts a row without a usable signature as invalid and never sends it to the chain", async () => {
    pending("not-a-signature", 10);
    pending(SIG(16), 10, { tx_signature: null });
    pending(SIG(17), 10);
    const { rpc, calls } = chain({ [SIG(17)]: finalized() });
    expect(await run(rpc)).toEqual({ complete: 1, pending: 0, invalid: 2 });
    expect(calls).toEqual([[SIG(17)]]);
  });

  it("writes nothing when the chain or the database cannot answer (the stage fails; the rows wait)", async () => {
    pending(SIG(18), 10);
    const down = chain({ [SIG(18)]: finalized() });
    down.failWith(new Error("HTTP error (429): Too Many Requests"));
    await expect(run(down.rpc)).rejects.toThrow(/429/);
    expect(finals()).toEqual([]);

    store.db.failReads.add("audit_events");
    await expect(run(chain().rpc)).rejects.toThrow(/unavailable/);
    store.db.failReads.clear();

    store.db.failWrites.add("audit_events");
    await expect(run(chain({ [SIG(18)]: finalized() }).rpc)).rejects.toThrow(/not written/);
    store.db.failWrites.clear();
    expect(finals()).toEqual([]);
  });

  it("does nothing past its deadline or after an abort", async () => {
    pending(SIG(19), 10);
    const { rpc, calls } = chain({ [SIG(19)]: finalized() });
    expect(await run(rpc, 10, Date.now() - 1)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(await run(rpc, 10, Date.now() + 5_000, AbortSignal.abort())).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(calls).toEqual([]);
    expect(finals()).toEqual([]);
  });

  it("asks nothing of the chain when there is nothing to settle", async () => {
    const { rpc, calls } = chain();
    expect(await run(rpc)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(calls).toEqual([]);
  });
});
