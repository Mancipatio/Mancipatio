// lib/distribution-audit-writer: a "Send to wallets" transaction's pending
// audit row is written as soon as the transaction is journalled, before it is
// broadcast — one write after another, started once per signature (once
// more only when the first did not get its row), the broadcast held back a
// few seconds at most and never past what the blockhash can spare, no write
// holding up the next for long — so a tab closed in the middle of a group
// does not leave a landed transaction without the row the retry worker
// settles from the chain (except a row whose request had not left yet: see
// the module header). The panel's onSigned hook is journalThenPendingAudits
// (tested here, and in tests/verified-batch-send through a real one-by-one
// run interrupted after its first transaction).
import fs from "node:fs";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  createPendingAuditWriter,
  journalThenPendingAudits,
  PENDING_AUDIT_ATTEMPT_TIMEOUT_MS,
  PENDING_AUDIT_WAIT_MS,
  PENDING_AUDIT_WRITE_LIMIT_MS,
  type DistributionAuditRow,
} from "@/lib/distribution-audit-writer";
import { distributionAuditRow } from "@/lib/distribution-run";

const ADDR = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const SIG = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
const SENDER = ADDR(1);
const SC = ADDR(4);
const MINT = ADDR(3);
const base = () => ({ actor: SENDER, reason: "Distribution run abcd1234: 3 wallets", scPda: SC, runId: "run-1", mint: MINT, screening: null });
const entry = (n: number) => ({ signature: SIG(n), rows: [{ wallet: ADDR(10 + n), amount: BigInt(100 * n) }] });

/** An audit endpoint that stores what it is given; `answer` decides each write (an id, or null for a failed write). */
function endpoint(answer: (row: DistributionAuditRow, call: number) => Promise<string | null> | string | null = (_, call) => `row-${call}`) {
  const rows: DistributionAuditRow[] = [];
  let calls = 0;
  const record = vi.fn(async (row: DistributionAuditRow) => {
    const call = ++calls;
    const id = await answer(row, call);
    if (id !== null) rows.push(row);
    return id;
  });
  return { rows, record };
}

describe("createPendingAuditWriter", () => {
  it("writes the session's own pending row (distributionAuditRow, status pending) for each journalled transaction", async () => {
    const audit = endpoint();
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1), entry(2)]);
    expect(audit.rows).toEqual([
      distributionAuditRow({ ...base(), signature: SIG(1), status: "pending", rows: entry(1).rows }),
      distributionAuditRow({ ...base(), signature: SIG(2), status: "pending", rows: entry(2).rows }),
    ]);
    expect(audit.rows.every((r) => r.status === "pending" && r.ix_name === "share_class_distribution")).toBe(true);
    expect(writer.has(SIG(1)) && writer.has(SIG(2))).toBe(true);
  });

  it("never writes a signature twice, however often it is journalled or settled", async () => {
    const audit = endpoint();
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1)]);
    await writer.writeSigned([entry(1), entry(2)]);
    expect(await writer.settle([SIG(1), SIG(2)])).toEqual(new Set([SIG(1), SIG(2)]));
    await writer.settle([SIG(1)]);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.rows.map((r) => r.tx_signature)).toEqual([SIG(1), SIG(2)]);
  });

  it("writes one row at a time, in the order they were journalled (the audit route's burst limit)", async () => {
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const audit = endpoint(async (row) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      order.push(row.tx_signature);
      inFlight--;
      return "id";
    });
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1), entry(2), entry(3)]);
    expect(most).toBe(1);
    expect(order).toEqual([SIG(1), SIG(2), SIG(3)]);
  });

  it("holds the broadcast back at most `waitMs`; a slow row is finished meanwhile and settle() waits for it", async () => {
    let release: (id: string) => void = () => {};
    const audit = endpoint(() => new Promise<string>((resolve) => (release = resolve)));
    const writer = createPendingAuditWriter({ record: audit.record, base });
    const started = Date.now();
    await writer.writeSigned([entry(1)], 20);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(writer.has(SIG(1))).toBe(false);
    const settled = writer.settle([SIG(1)]);
    release("late-id");
    expect(await settled).toEqual(new Set([SIG(1)]));
    expect(audit.record).toHaveBeenCalledOnce();
    expect(PENDING_AUDIT_WAIT_MS).toBe(5_000);
  });

  it("settle() writes once more each row that failed (and a write that threw), and reports only the rows written", async () => {
    const audit = endpoint((row, call) => {
      if (call === 1) return null; // SIG(1): the first write failed (recordAudit gave up)
      if (call === 2) throw new Error("network"); // SIG(2): a write that threw
      if (row.tx_signature === SIG(3)) return null; // SIG(3): fails every time
      return `id-${call}`;
    });
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1), entry(2), entry(3)]);
    expect(await writer.settle([SIG(1), SIG(2), SIG(3), SIG(9)])).toEqual(new Set([SIG(1), SIG(2)]));
    // SIG(9) was never journalled here: nothing to write for it.
    expect(audit.record.mock.calls.map(([row]) => row.tx_signature)).toEqual([SIG(1), SIG(2), SIG(3), SIG(1), SIG(2), SIG(3)]);
  });

  it("reads the base when each row is written (the run's screening evidence can be taken again)", async () => {
    const audit = endpoint();
    let screening: Record<string, unknown> | null = null;
    const writer = createPendingAuditWriter({ record: audit.record, base: () => ({ ...base(), screening: screening as never }) });
    await writer.writeSigned([entry(1)]);
    screening = { [ADDR(12)]: { screening_id: "s-2", screened_at: "2026-10-05T10:00:00.000Z", list_version: "v1", result: "clear", evidence_id: "e-2" } };
    await writer.writeSigned([entry(2)]);
    expect((audit.rows[0].metadata.recipients[0] as { screening: unknown }).screening).toBeNull();
    expect((audit.rows[1].metadata.recipients[0] as { screening: unknown }).screening).not.toBeNull();
  });

  it("drain() waits for every write started", async () => {
    let release: (id: string) => void = () => {};
    const audit = endpoint(() => new Promise<string>((resolve) => (release = resolve)));
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1)], 1);
    let drained = false;
    const done = writer.drain().then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(drained).toBe(false);
    release("id");
    await done;
    expect(writer.has(SIG(1))).toBe(true);
  });

  it("a run that stops mid-group (prepareAndSendAll threw after sends): drain() finishes what was started and writes nothing again", async () => {
    const audit = endpoint((_, call) => (call === 1 ? null : `id-${call}`));
    const writer = createPendingAuditWriter({ record: audit.record, base });
    await writer.writeSigned([entry(1), entry(2)]);
    await writer.drain();
    // SIG(1) failed and is not retried by drain (only settle() retries); the resume's evaluation decides.
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(writer.has(SIG(1))).toBe(false);
    expect(writer.has(SIG(2))).toBe(true);
  });

  it("settle() covers every journalled signature, also one whose broadcast failed (it may still land)", async () => {
    const audit = endpoint();
    const writer = createPendingAuditWriter({ record: audit.record, base });
    // Both journalled (their rows written before the broadcast); SIG(2)'s broadcast then failed.
    await writer.writeSigned([entry(1), entry(2)]);
    expect(await writer.settle([SIG(1), SIG(2)])).toEqual(new Set([SIG(1), SIG(2)]));
    expect(audit.rows.map((r) => r.tx_signature)).toEqual([SIG(1), SIG(2)]);
  });

  it("a write whose answer was lost (the row inserted) counts as failed: settle() leaves a second pending row for it (no idempotency key)", async () => {
    // The first POST inserts the row but its answer never arrives (recordAudit returns null).
    const inserted: string[] = [];
    const record = vi.fn(async (row: DistributionAuditRow) => {
      inserted.push(row.tx_signature);
      return record.mock.calls.length === 1 ? null : "id";
    });
    const writer = createPendingAuditWriter({ record, base });
    await writer.writeSigned([entry(1)]);
    expect(await writer.settle([SIG(1)])).toEqual(new Set([SIG(1)]));
    // At most one more: the retry worker groups pending rows by signature (one server row, the oldest's claims).
    expect(inserted).toEqual([SIG(1), SIG(1)]);
    await writer.settle([SIG(1)]);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("a record that never answers holds up the rows after it only writeLimitMs (PENDING_AUDIT_WRITE_LIMIT_MS by default)", async () => {
    expect(PENDING_AUDIT_WRITE_LIMIT_MS).toBe(60_000);
    expect(PENDING_AUDIT_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    const audit = endpoint((row) => (row.tx_signature === SIG(1) ? new Promise<string>(() => {}) : "id"));
    const writer = createPendingAuditWriter({ record: audit.record, base, writeLimitMs: 20 });
    await writer.writeSigned([entry(1), entry(2)], 1_000);
    // SIG(1) never answered; SIG(2) was still written, after it.
    expect(writer.has(SIG(2))).toBe(true);
    expect(writer.has(SIG(1))).toBe(false);
    await writer.drain();
  });
});

describe("journalThenPendingAudits (the panel's onSigned hook)", () => {
  const signed = (n: number, index: number) => ({ index, signature: SIG(n), lastValidBlockHeight: BigInt(1_000) });

  it("the journal first, then onSending, then each transaction's pending row (its rows by index), awaited before it returns", async () => {
    const order: string[] = [];
    const audit = endpoint((row) => {
      order.push(`audit:${row.tx_signature === SIG(1) ? 1 : 2}`);
      return "id";
    });
    const writer = createPendingAuditWriter({ record: audit.record, base });
    const hook = journalThenPendingAudits({
      journal: (list) => order.push(`journal:${list.map((s) => s.index).join(",")}`),
      audits: writer,
      rowsOf: (index) => entry(index + 1).rows,
      onSending: (count) => order.push(`sending:${count}`),
    });
    await hook([signed(1, 0), signed(2, 1)], { waitMs: 10_000 });
    expect(order).toEqual(["journal:0,1", "sending:2", "audit:1", "audit:2"]);
    expect(audit.rows.map((r) => r.metadata.recipients)).toEqual([
      distributionAuditRow({ ...base(), signature: SIG(1), status: "pending", rows: entry(1).rows }).metadata.recipients,
      distributionAuditRow({ ...base(), signature: SIG(2), status: "pending", rows: entry(2).rows }).metadata.recipients,
    ]);
  });

  it("waits at most PENDING_AUDIT_WAIT_MS, and never longer than the blockhash can spare (info.waitMs; 0 and junk: no wait)", async () => {
    const audit = endpoint(() => new Promise<string>(() => {}));
    for (const [waitMs, most] of [
      [40, 2_000],
      [0, 1_000],
      [-5, 1_000],
      [Number.NaN, 1_000],
    ] as const) {
      const writer = createPendingAuditWriter({ record: audit.record, base, writeLimitMs: 10 });
      const hook = journalThenPendingAudits({ journal: () => {}, audits: writer, rowsOf: () => [] });
      const started = Date.now();
      await hook([signed(1, 0)], { waitMs });
      expect(Date.now() - started).toBeLessThan(most);
    }
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const writer = createPendingAuditWriter({ record: async () => "id", base });
      await journalThenPendingAudits({ journal: () => {}, audits: writer, rowsOf: () => [] })([signed(1, 0)], { waitMs: 45_000 });
      // The broadcast's wait (writeSigned's timer) is PENDING_AUDIT_WAIT_MS, not the 45 s the blockhash could spare.
      expect(spy.mock.calls.map(([, ms]) => ms)).toContain(PENDING_AUDIT_WAIT_MS);
      expect(spy.mock.calls.map(([, ms]) => ms)).not.toContain(45_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("a journal that throws stops it before any row is written (prepareAndSendAll then sends nothing)", async () => {
    const audit = endpoint();
    const writer = createPendingAuditWriter({ record: audit.record, base });
    const hook = journalThenPendingAudits({
      journal: () => {
        throw new Error("storage full");
      },
      audits: writer,
      rowsOf: () => [],
    });
    await expect(hook([signed(1, 0)], { waitMs: 1_000 })).rejects.toThrow("storage full");
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("the panel writes each pending row when the transaction is journalled, before it is broadcast", () => {
  const panel = fs.readFileSync(path.join(__dirname, "..", "components/send-to-wallets-panel.tsx"), "utf8");

  it("onSigned is journalThenPendingAudits (tested above): the journal, the text, the group's rows, the writer", () => {
    const hook = panel.slice(panel.indexOf("onSigned: journalThenPendingAudits({"));
    expect(hook.length).toBeLessThan(panel.length);
    const journal = hook.indexOf("writeJournal(store, j);");
    expect(journal).toBeGreaterThan(-1);
    expect(hook.indexOf("audits,")).toBeGreaterThan(journal);
    expect(hook).toContain("rowsOf: (index) => rowsOf(group[index]),");
    expect(panel).toContain("base: () => ({ actor, reason, scPda, runId, mint: sc.mint, screening: evidence }),");
    // keepalive and a cut-off per attempt (lib/supabase recordAudit options).
    expect(panel).toContain("record: (row) => recordAudit(row, AUDIT_RETRY_DELAYS_MS, { keepalive: true, timeoutMs: PENDING_AUDIT_ATTEMPT_TIMEOUT_MS }),");
  });

  it("after the group: no second pending write, only settle() (a failed one retried once) and the journal mark", () => {
    expect(panel).toContain("const signedHere = result.outcomes.flatMap((o) => (o.signature ? [o.signature] : []));");
    expect(panel).toContain("const pendingAudited = await audits.settle(signedHere);");
    expect(panel).toContain('j = withAudited(j, pendingAudited, "pending");');
    expect(panel).not.toMatch(/status: "pending", rows: s\.rows/);
    // The final rows once the network decided are unchanged.
    expect(panel).toContain('status: outcomes[i] === "confirmed" ? "success" : "failed",');
    // A run that stops early still finishes the rows being written.
    expect(panel).toContain("if (pendingAudits) await pendingAudits.drain().catch(() => undefined);");
  });

  it("the previous group unconfirmed (EarlierTransactionUnconfirmedError, position null): the groups already sent still go through step 8", () => {
    const loop = panel.slice(panel.indexOf("result = await sender.prepareAndSendAll(requests, {"), panel.indexOf("// 8. Wait for the network"));
    expect(loop).toContain("if (!(err instanceof EarlierTransactionUnconfirmedError) || err.position !== null) throw err;");
    // `break` (to step 8), not a throw past it.
    expect(loop.slice(loop.indexOf("err.position !== null) throw err;"))).toMatch(/setProblem\([\s\S]*?\);\s*break;/);
    // Step 8: one status read for all of them per poll, refused reads retried.
    expect(panel).toMatch(/await waitForSignatures\(\s*rpc,\s*sent\.map\(\(s\) => s\.signature\),\s*\{ timeoutMs: 60_000, retryReads: true \},?\s*\)/);
    expect(panel).not.toContain("waitForSignature(rpc, s.signature");
  });
});
