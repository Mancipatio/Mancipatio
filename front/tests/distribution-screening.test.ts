// "Send to wallets": the recipients' sanctions-screening evidence on the
// client side (devnet rehearsal 2026-10-03, P1): what makes a row signable,
// what the run journal keeps, what every distribution audit row carries, and
// that the panel signs nothing for a row without fresh evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCREENING_FRESH_MS,
  SCREENING_RECAPTURE_MS,
  evidenceDue,
  listVersionLabel,
  parseScreeningEvidence,
  screeningAuditEntry,
  staleScreenings,
  staleScreeningText,
  type ScreeningEvidence,
} from "@/lib/distribution-screening";
import { distributionAuditRow } from "@/lib/distribution-run";
import { newJournal, parseJournal } from "@/lib/distribution-journal";

const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const B = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku";
const C = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const NOW = Date.parse("2026-10-03T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const entry = (msAgo: number, result: "clear" | "unscreened" = "clear") => ({
  screening_id: "11111111-1111-4111-8111-111111111111",
  screened_at: at(msAgo),
  list_version: "ofac-sdn:2026-10-01:c0ffeec0ffee",
  result,
  evidence_id: "22222222-2222-4222-8222-222222222222",
});
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("screening evidence (lib/distribution-screening)", () => {
  it("a row is signable only with evidence from the last 15 minutes", () => {
    expect(SCREENING_FRESH_MS).toBe(15 * 60_000);
    expect(SCREENING_RECAPTURE_MS).toBeLessThan(SCREENING_FRESH_MS);
    const evidence: ScreeningEvidence = { [A]: entry(60_000), [B]: entry(SCREENING_FRESH_MS + 1), [C]: entry(0, "unscreened") };
    expect(staleScreenings(evidence, [A, B, C], NOW)).toEqual([B]);
    // No evidence at all, or for another wallet, is stale.
    expect(staleScreenings(evidence, ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"], NOW)).toHaveLength(1);
    expect(staleScreenings(null, [A], NOW)).toEqual([A]);
    // A malformed time or result never passes.
    expect(staleScreenings({ [A]: { ...entry(0), screened_at: "never" } }, [A], NOW)).toEqual([A]);
    expect(staleScreenings({ [A]: { ...entry(0), result: "hit" as never } }, [A], NOW)).toEqual([A]);
    // Taken again before the plan once older than SCREENING_RECAPTURE_MS.
    expect(evidenceDue(NOW - SCREENING_RECAPTURE_MS, NOW)).toBe(false);
    expect(evidenceDue(NOW - SCREENING_RECAPTURE_MS - 1, NOW)).toBe(true);
    expect(staleScreeningText(1)).toMatch(/^The sanctions screening of 1 recipient is older than 15 minutes or missing, so nothing more was signed/);
    expect(staleScreeningText(3)).toMatch(/of 3 recipients are older/);
  });

  it("names the list publication a screen used", () => {
    expect(listVersionLabel([])).toBe("none");
    expect(listVersionLabel([{ source: "ofac-sdn", published_on: "2026-10-01", sha256: "c0ffee".repeat(10) + "abcd" }])).toBe("ofac-sdn:2026-10-01:c0ffeec0ffee");
    expect(listVersionLabel([
      { source: "ofac-sdn", published_on: null, sha256: null },
      { source: "paid", published_on: "2026-10-02", sha256: "ab".repeat(32) },
    ])).toBe("ofac-sdn:unknown:unknown+paid:2026-10-02:abababababab");
  });

  it("parses stored evidence, dropping what it cannot vouch for", () => {
    expect(parseScreeningEvidence(null)).toEqual({});
    expect(parseScreeningEvidence([entry(0)])).toEqual({});
    expect(parseScreeningEvidence({ [A]: entry(0), [B]: { ...entry(0), result: "hit" }, [C]: { ...entry(0), evidence_id: 1 }, x: "junk" })).toEqual({ [A]: entry(0) });
    expect(screeningAuditEntry({ [A]: entry(0) }, A)).toEqual(entry(0));
    expect(screeningAuditEntry({ [A]: entry(0) }, B)).toBeNull();
  });
});

describe("the run journal and the audit rows carry it", () => {
  it("every distribution audit row names each recipient's screening (and says when one is missing)", () => {
    const row = distributionAuditRow({
      actor: A, reason: "Distribution run abcd1234: 2 wallets", scPda: "SC", runId: "r", mint: C,
      signature: "1".repeat(88), status: "success", rows: [{ wallet: A, amount: BigInt(5) }, { wallet: B, amount: BigInt(7) }],
      screening: { [A]: entry(0), [B]: entry(1_000) },
    });
    expect(row.metadata.recipients).toEqual([
      { to: A, amount: "5", screening: entry(0) },
      { to: B, amount: "7", screening: entry(1_000) },
    ]);
    expect(row.metadata.screening_complete).toBe(true);
    const partial = distributionAuditRow({
      actor: A, reason: "r", scPda: "SC", runId: "r", mint: C, signature: "2".repeat(88), status: "pending",
      rows: [{ wallet: A, amount: BigInt(5) }, { wallet: B, amount: BigInt(7) }], screening: { [A]: entry(0) },
    });
    expect(partial.metadata.recipients[1].screening).toBeNull();
    expect(partial.metadata.screening_complete).toBe(false);
    // An old journal without evidence: every recipient null, never an error.
    expect(distributionAuditRow({ actor: A, reason: "r", scPda: "SC", runId: "r", mint: C, signature: "3".repeat(88), status: "success", rows: [{ wallet: A, amount: BigInt(1) }] }).metadata.screening_complete).toBe(false);
  });

  it("the journal keeps the evidence (sanitized) so a resume's audit rows cite it; older journals still parse", () => {
    const j = { ...newJournal({ runId: "r", network: "devnet", mint: C, sender: A, rows: [{ wallet: B, amount: BigInt(1) }] }), screening: { [B]: entry(0) } };
    expect(parseJournal(JSON.stringify(j))?.screening).toEqual({ [B]: entry(0) });
    expect(parseJournal(JSON.stringify({ ...j, screening: { [B]: { ...entry(0), result: "hit" } } }))?.screening).toEqual({});
    const { screening: _drop, ...old } = j;
    void _drop;
    expect(parseJournal(JSON.stringify(old))).not.toBeNull();
    expect(parseJournal(JSON.stringify(old))).not.toHaveProperty("screening");
  });
});

describe("the panel signs nothing for a row without fresh evidence", () => {
  const panel = src("components/send-to-wallets-panel.tsx");

  it("screens with the run, takes the server's evidence, then plans", () => {
    const screen = panel.indexOf("const hits = await screenRecipients(session, { shareClass: scPda, wallets, runId });");
    const take = panel.indexOf("await distributionEvidence(session, { shareClass: scPda, runId, wallets })");
    expect(screen).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(screen);
    // A hit stops before the evidence is asked for.
    expect(panel.slice(screen, take)).toContain("return false;");
    expect(panel).toContain("if (!(await screenAndRecord(toSend))) return;");
    // Re-taken at plan time when older than SCREENING_RECAPTURE_MS, before the test run.
    const recapture = panel.indexOf("if (evidenceDue(evidenceAt)) {");
    expect(recapture).toBeGreaterThan(take);
    expect(panel.indexOf("await planWithSimulation(rows")).toBeGreaterThan(recapture);
  });

  it("checks every group's rows right before the wallet prompt and cites the evidence in every audit row", () => {
    const check = panel.indexOf("const stale = staleScreenings(evidence, group.flatMap((t) => t.index.map((e) => e.row)));");
    const prompt = panel.indexOf("await sender.prepareAndSendAll(requests");
    expect(check).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(check);
    expect(panel.slice(check, prompt)).toContain("setProblem(staleScreeningText(stale.length));");
    // Pending and final rows of the session, and the rows a resume writes.
    expect(panel.match(/screening: evidence,?\s/g)?.length).toBeGreaterThanOrEqual(2);
    expect(panel).toContain("screening: evaluated.screening ?? null,");
    // The journal keeps it from the start of the run.
    expect(panel).toContain("j = { ...j, reason, dismissedAt: null, screening: { ...(j.screening ?? {}), ...evidence } };");
  });
});
