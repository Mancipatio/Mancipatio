// `SIM_CMD=report`, owner-queue.txt, `SIM_CMD=plan` and the site preflight
// (scripts/sim/lib/report.ts, plan.ts, runner.ts). Offline: a temp git repo,
// stub fetches, synthetic journal lines.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRoster } from "@/scripts/sim/lib/identity";
import type { JournalEntry } from "@/scripts/sim/lib/journal";
import { planSummary, renderPlan } from "@/scripts/sim/lib/plan";
import { renderOwnerQueue, renderReport, groupFindings } from "@/scripts/sim/lib/report";
import { assertDevnetSite, runSim } from "@/scripts/sim/lib/runner";
import { newState, newUserState, saveState } from "@/scripts/sim/lib/state";

const entry = (over: Partial<JournalEntry>): JournalEntry => ({ ts: "2026-09-25T10:00:00.000Z", wave: 0, user: "u001", cohort: "K", step: "x", kind: "http", outcome: "ok", ...over });

const journal: JournalEntry[] = [
  entry({ step: "account.me", route: "POST /api/account/me", httpStatus: 200, expected: "2xx" }),
  entry({ step: "edge.stale-ts", route: "POST /api/clients/me", httpStatus: 401, expected: "401", outcome: "expected-error" }),
  entry({ user: "u002", step: "upload.passport", route: "POST /api/clients/upload", httpStatus: 500, expected: "2xx", outcome: "5xx", body: '{"ok":false,"error":"Storage upload failed: timeout"}' }),
  entry({ user: "u003", step: "upload.passport", route: "POST /api/clients/upload", httpStatus: 500, expected: "2xx", outcome: "5xx", body: '{"ok":false,"error":"Storage upload failed: timeout"}' }),
  entry({ user: "u005", step: "edge.tos-wrong-version", route: "POST /api/tos/accept", httpStatus: 200, expected: "400", outcome: "unexpected-2xx", body: '{"ok":true}' }),
  entry({ user: "u002", step: "buy", kind: "tx", ix: "buy", outcome: "tx-error", err: "signed simulation failed: asset_registry: SaleNotActive (6012)", logMessages: ["Program log: AnchorError"] }),
  entry({ user: "u002", step: "launchpad.recordPurchase.lag", kind: "check", outcome: "consistency", err: "purchase still pending after 6 polls (> 3 min)" }),
];

describe("report", () => {
  it("lists every unexpected result per user and step, groups them and tallies the classes", () => {
    const state = newState("r3p0rt", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const plans = buildRoster();
    state.users.u001 = { ...newUserState(plans[0], "W1"), terminal: "done", stage: "done" };
    state.users.u002 = { ...newUserState(plans[1], "W2"), stage: "await.passport", awaitingOwner: true, ownerTask: "issue the passport" };
    const md = renderReport(state, journal, new Date("2026-09-25T12:00:00Z"));
    expect(md).toContain("# Manci devnet simulator — run r3p0rt");
    expect(md).toContain("**5 unexpected results**");
    expect(md).toContain("| u002 | K | 0 | upload.passport | POST /api/clients/upload | 500 | 2xx | 5xx | Storage upload failed: timeout |");
    expect(md).toContain("unexpected-2xx");
    expect(md).toContain("SaleNotActive (6012)");
    expect(md).toContain("logs: Program log: AnchorError");
    expect(md).toContain("purchase still pending");
    expect(md).not.toContain("edge.stale-ts |"); // expected errors are not findings
    expect(md).toContain("| u002 | I | buyer-kyc | pilot | approve | awaiting_owner (await.passport) | issue the passport |");
    const groups = groupFindings(journal);
    expect(groups[0]).toMatchObject({ where: "POST /api/clients/upload", status: "500", count: 2, users: ["u002", "u003"] });
  });

  it("writes report.md into the sim directory with SIM_CMD=report", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sim-report-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".gitignore"), "/docs/\n");
    const simRoot = path.join(repo, "docs", "mainnet-readiness", "sim");
    const runDir = path.join(simRoot, "abc123");
    saveState(runDir, newState("abc123", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"));
    fs.writeFileSync(path.join(runDir, "journal.ndjson"), journal.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const lines: string[] = [];
    const result = await runSim({ SIM_CMD: "report", SIM_RUN_ID: "abc123" }, { root: repo, log: (l) => lines.push(l) });
    expect(result).toEqual({ status: "reported", detail: "5" });
    expect(fs.readFileSync(path.join(simRoot, "report.md"), "utf8")).toContain("**5 unexpected results**");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")).tally.fivexx).toBe(2);
    expect(fs.statSync(path.join(simRoot, "report.md")).mode & 0o777).toBe(0o600);
    expect(lines[0]).toMatch(/report\.md \(5 unexpected results\)/);
  });

  it("refuses a report outside a git-ignored directory", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sim-report-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    await expect(runSim({ SIM_CMD: "report", SIM_RUN_ID: "abc123" }, { root: repo, log: () => {} })).rejects.toThrow(/not git-ignored/);
  });
});

describe("owner queue", () => {
  it("lists the market tasks, every waiting user and the edge dossiers", () => {
    const state = newState("q00000", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    state.market.termsOk = false;
    state.market.fxKind = "missing";
    const plans = buildRoster();
    state.users.u001 = { ...newUserState(plans[0], "WALLET1"), awaitingOwner: true, ownerTask: "KYC SIM-001: /admin/clients/x → approve" };
    state.users.u005 = { ...newUserState(plans[4], "WALLET5"), terminal: "done", data: { clientId: "c-5" } };
    const text = renderOwnerQueue(state);
    expect(text).toContain("never approves anything itself");
    expect(text).toContain("Publish a verified whitepaper");
    expect(text).toContain("FX row for the e2e payment mint: missing");
    expect(text).toContain("u001 [K/kyc, pilot, review=approve] wallet WALLET1: KYC SIM-001");
    expect(text).toContain("u005 client c-5 wallet WALLET5");
  });
});

describe("plan", () => {
  it("prints counts, the review split, the request budget and the pilot command", () => {
    const text = renderPlan(planSummary("preview"));
    expect(text).toContain("users 100: K 30 · I 35 (20 KYC + 15 no-KYC) · T 12 (6 pairs) · B 15 (10 KYB + 5 founders) · E 8");
    expect(text).toMatch(/waves: pilot 5 · w1 \d+ · w2 \d+ · w3 \d+ · w4 \d+ · w5 \d+/);
    expect(text).toMatch(/owner reviews 65 dossiers: approve \d+ · reject \d+ · more_info \d+ · leave \d+/);
    expect(text).toMatch(/budget \(estimate incl\. owner-wait polls\): signed writes \d+ · reads \d+ · uploads \d+ \([\d.]+ MB\)/);
    expect(text).toContain("SIM_CMD=pilot SIM_SEND=1 CHAIN_NETWORK=devnet");
  });

  it("runs offline through runSim", async () => {
    const lines: string[] = [];
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sim-plan-"));
    expect(await runSim({ SIM_CMD: "plan" }, { root: repo, log: (l) => lines.push(l) })).toEqual({ status: "planned" });
    expect(lines.join("\n")).toContain("plan sends nothing");
  });
});

describe("site preflight", () => {
  const DEVNET = JSON.stringify({ ok: true, network: "devnet" });
  const health = (body: string, { status = 200, date = new Date().toUTCString(), urls = [] as string[] } = {}) =>
    (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(body, { status, headers: { date, "content-type": "application/json" } });
    }) as unknown as typeof fetch;

  it("accepts a healthy devnet site, read from /api/health", async () => {
    const urls: string[] = [];
    await expect(assertDevnetSite(health(DEVNET, { urls }))).resolves.toBeUndefined();
    expect(urls).toEqual(["https://www.manci.io/api/health"]);
  });

  it("refuses a site that does not report devnet", async () => {
    await expect(assertDevnetSite(health(JSON.stringify({ ok: true, network: "mainnet" })))).rejects.toThrow(/does not report a healthy Solana Devnet/);
  });

  it("refuses an unhealthy devnet site", async () => {
    await expect(assertDevnetSite(health(JSON.stringify({ ok: false, network: "devnet" })))).rejects.toThrow(/does not report a healthy Solana Devnet/);
    await expect(assertDevnetSite(health(DEVNET, { status: 503 }))).rejects.toThrow(/answered 503/);
  });

  it("refuses an answer that is not JSON", async () => {
    await expect(assertDevnetSite(health('<span title="Connected to Solana Devnet">'))).rejects.toThrow(/did not answer JSON/);
  });

  it("refuses a skewed local clock", async () => {
    await expect(assertDevnetSite(health(DEVNET, { date: new Date(Date.now() - 600_000).toUTCString() }))).rejects.toThrow(/clock/);
  });

  it("refuses an unreachable site without leaking details", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED 1.2.3.4");
    }) as unknown as typeof fetch;
    await expect(assertDevnetSite(down)).rejects.toThrow(/^https:\/\/www\.manci\.io is unreachable$/);
  });
});
