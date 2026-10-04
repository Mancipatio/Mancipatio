// lib/distribution-audit-writer: a "Send to wallets" transaction's pending
// audit row is written as soon as the transaction is journalled, before it is
// broadcast — one write after another, never twice for a signature, the
// broadcast held back a few seconds at most — so a tab closed in the middle
// of a group never leaves a landed transaction without the row the retry
// worker settles from the chain. The panel wires it into prepareAndSendAll's
// onSigned hook (and tests/verified-batch-send runs it through a real
// one-by-one run interrupted after its first transaction).
import fs from "node:fs";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createPendingAuditWriter, PENDING_AUDIT_WAIT_MS, type DistributionAuditRow } from "@/lib/distribution-audit-writer";
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
});

describe("the panel writes each pending row when the transaction is journalled, before it is broadcast", () => {
  const panel = fs.readFileSync(path.join(__dirname, "..", "components/send-to-wallets-panel.tsx"), "utf8");

  it("onSigned: the journal, then the pending rows (awaited, bounded), in both the batch and the one-by-one path", () => {
    const hook = panel.slice(panel.indexOf("onSigned: async (signed) => {"));
    expect(hook.length).toBeLessThan(panel.length);
    const journal = hook.indexOf("writeJournal(store, j);");
    const rows = hook.indexOf("await audits.writeSigned(signed.map((s) => ({ signature: s.signature, rows: rowsOf(group[s.index]) })));");
    expect(journal).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(journal);
    // Before the hook returns (prepareAndSendAll broadcasts only after it).
    expect(hook.slice(rows).indexOf("},")).toBeLessThan(hook.slice(rows).indexOf("});"));
    expect(panel).toContain("base: () => ({ actor, reason, scPda, runId, mint: sc.mint, screening: evidence }),");
  });

  it("after the group: no second pending write, only settle() (a failed one retried once) and the journal mark", () => {
    expect(panel).toContain("const pendingAudited = await audits.settle(result.outcomes.flatMap((o) => (o.signature ? [o.signature] : [])));");
    expect(panel).toContain('j = withAudited(j, pendingAudited, "pending");');
    expect(panel).not.toMatch(/status: "pending", rows: s\.rows/);
    // The final rows once the network decided are unchanged.
    expect(panel).toContain('status: outcomes[i] === "confirmed" ? "success" : "failed",');
    // A run that stops early still finishes the rows being written.
    expect(panel).toContain("if (pendingAudits) await pendingAudits.drain().catch(() => undefined);");
  });
});
