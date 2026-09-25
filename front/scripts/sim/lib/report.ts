/**
 * `SIM_CMD=report` and owner-queue.txt (design-sim §5, §6). Pure functions
 * over the journal and state, plus the file writers:
 *
 * - report.md (docs/mainnet-readiness/sim/report.md): every unexpected HTTP
 *   status/body and transaction error per user and step — the point of the
 *   run is to find site bugs — then the same findings grouped by
 *   (route or instruction, status, message) with a count and 3 example users,
 *   the split expected / unexpected 4xx / 5xx / on-chain / consistency /
 *   unexpected accept, the transfer probes, the largest balance lag and the
 *   donor loan (cohort X), and every user's stage;
 * - summary.json in the run directory (the grouped findings, machine-readable);
 * - owner-queue.txt: what each waiting SIM user expects the owner to do, and
 *   the cohort-X loan and early leavers as information (no task).
 */
import path from "node:path";
import { FINDING_OUTCOMES, type JournalEntry, type Outcome } from "./journal";
import { writePrivateFile } from "./safety";
import type { SimState, UserState } from "./state";

function errorText(e: JournalEntry): string {
  if (e.err) return e.err;
  if (!e.body) return "";
  try {
    const parsed = JSON.parse(e.body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON: a proxy page or a platform error
  }
  return e.body.slice(0, 200);
}

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export type Group = { key: string; where: string; status: string; message: string; outcome: Outcome; count: number; users: string[] };

export function groupFindings(entries: JournalEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const e of entries.filter((x) => FINDING_OUTCOMES.has(x.outcome))) {
    const where = e.route ?? e.ix ?? e.step;
    const status = e.httpStatus !== undefined ? String(e.httpStatus) : e.kind;
    const message = errorText(e).slice(0, 160);
    const key = `${where}|${status}|${message}`;
    const g = groups.get(key) ?? { key, where, status, message, outcome: e.outcome, count: 0, users: [] };
    g.count += 1;
    if (!g.users.includes(e.user) && g.users.length < 3) g.users.push(e.user);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function tally(entries: JournalEntry[]) {
  const t = {
    requests: 0,
    expected: 0,
    unexpected4xx: 0,
    unexpected2xx: 0,
    fivexx: 0,
    network: 0,
    onchain: 0,
    consistency: 0,
    unexpectedAccept: 0,
    tx: 0,
    probes: 0,
    probesPassed: 0,
    probesMismatch: 0,
  };
  for (const e of entries) {
    if (e.kind === "http") t.requests += 1;
    if (e.kind === "tx" && e.outcome === "ok") t.tx += 1;
    if (e.kind === "probe") {
      t.probes += 1;
      if (e.outcome === "ok" || e.outcome === "expected-error") t.probesPassed += 1;
      if (e.outcome === "tx-error") t.probesMismatch += 1;
    }
    if (e.outcome === "unexpected-accept") t.unexpectedAccept += 1;
    if (e.outcome === "ok" || e.outcome === "expected-error") t.expected += 1;
    if (e.outcome === "unexpected-4xx") t.unexpected4xx += 1;
    if (e.outcome === "unexpected-2xx") t.unexpected2xx += 1;
    if (e.outcome === "5xx") t.fivexx += 1;
    if (e.outcome === "network") t.network += 1;
    if (e.outcome === "tx-error") t.onchain += 1;
    if (e.outcome === "consistency") t.consistency += 1;
  }
  return t;
}

/** The largest C1 lag (seconds) after a cohort-X transfer: checks `xfer.<row>.balance` with body "lag Ns". */
export function largestTransferLag(entries: JournalEntry[]): number | null {
  let max: number | null = null;
  for (const e of entries) {
    if (e.kind !== "check" || !/^xfer\.S\d\.balance$/.test(e.step)) continue;
    const lag = /^lag (\d+)s$/.exec(e.body ?? "");
    const seconds = lag ? Number(lag[1]) : e.outcome === "ok" ? 0 : null;
    if (seconds !== null) max = Math.max(max ?? 0, seconds);
  }
  return max;
}

/** The donor loan: outstanding (who holds it), returned, or none taken. */
export function loanLine(state: SimState | null): string {
  const loan = state?.market.loan;
  if (loan) return `outstanding: ${loan.units} class A units of e2e buyer3 lent to pair ${loan.pair} (hub ${loan.hub}) since ${loan.at.slice(0, 19)}Z`;
  const returned = Object.values(state?.users ?? {}).filter((u) => u.data.xferSource === "donor" && u.tx["xfer.r2"]?.status === "landed");
  return returned.length ? `returned (${returned.map((u) => u.plan.label).join(", ")})` : "none taken";
}

export function userStage(u: UserState): string {
  if (u.terminal) return u.terminal;
  return u.awaitingOwner ? `awaiting_owner (${u.stage})` : u.stage;
}

export function renderReport(state: SimState | null, entries: JournalEntry[], now = new Date()): string {
  const t = tally(entries);
  const lag = largestTransferLag(entries);
  const findings = entries.filter((e) => FINDING_OUTCOMES.has(e.outcome));
  const lines: string[] = [
    `# Manci devnet simulator — run ${state?.runId ?? "?"}`,
    "",
    `Generated ${now.toISOString()} from ${entries.length} journal lines (${t.requests} HTTP requests, ${t.tx} landed transactions).`,
    "",
    "## Summary",
    "",
    "| class | count |",
    "|---|---|",
    `| as expected (2xx and expected errors) | ${t.expected} |`,
    `| unexpected 4xx | ${t.unexpected4xx} |`,
    `| unexpected 2xx (a bad request was accepted) | ${t.unexpected2xx} |`,
    `| 5xx | ${t.fivexx} |`,
    `| no response (network, timeout) | ${t.network} |`,
    `| on-chain / builder errors | ${t.onchain} |`,
    `| consistency / lag | ${t.consistency} |`,
    `| unexpected accept (a rule the chain should enforce accepted the transfer; never sent) | ${t.unexpectedAccept} |`,
    `| transfer probes: as expected / mismatch / unexpected accept (simulated only) | ${t.probesPassed} / ${t.probesMismatch} / ${t.unexpectedAccept} |`,
    `| largest balance lag after a transfer (C1) | ${lag === null ? "-" : `${lag} s`} |`,
    `| donor loan (cohort X) | ${cell(loanLine(state))} |`,
    "",
    findings.length === 0 ? "**No unexpected results.**" : `**${findings.length} unexpected results** — each is listed below.`,
    "",
    "## Every unexpected result, per user and step",
    "",
  ];
  if (findings.length) {
    lines.push("| time (UTC) | user | cohort | wave | step | route / instruction | status | expected | outcome | detail |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const e of findings) {
      lines.push(
        `| ${e.ts.slice(0, 19)} | ${e.user} | ${e.cohort} | ${e.wave ?? "-"} | ${cell(e.step)} | ${cell(e.route ?? e.ix ?? "")} | ${e.httpStatus ?? "-"} | ${cell(e.expected ?? "")} | ${e.outcome} | ${cell(errorText(e).slice(0, 300))}${e.txSig ? ` (tx ${e.txSig.slice(0, 16)}…)` : ""}${e.logMessages?.length ? ` logs: ${cell(e.logMessages.slice(-3).join(" / "))}` : ""} |`,
      );
    }
  } else {
    lines.push("_none_");
  }
  lines.push("", "## Grouped by route or instruction, status and message", "");
  const groups = groupFindings(entries);
  if (groups.length) {
    lines.push("| route / instruction | status | outcome | message | count | example users |", "|---|---|---|---|---|---|");
    for (const g of groups) lines.push(`| ${cell(g.where)} | ${g.status} | ${g.outcome} | ${cell(g.message)} | ${g.count} | ${g.users.join(", ")} |`);
  } else {
    lines.push("_none_");
  }
  lines.push("", "## Users", "");
  const users = Object.values(state?.users ?? {}).sort((a, b) => a.plan.n - b.plan.n);
  if (users.length) {
    lines.push("| user | cohort | variant | wave | review | stage | reason / owner task |", "|---|---|---|---|---|---|---|");
    for (const u of users) {
      lines.push(`| ${u.plan.label} | ${u.plan.cohort} | ${u.plan.variant} | ${u.plan.wave === 0 ? "pilot" : u.plan.wave} | ${u.plan.review} | ${userStage(u)} | ${cell(u.reason ?? u.ownerTask ?? "")} |`);
    }
  } else {
    lines.push("_no users started_");
  }
  lines.push("");
  return lines.join("\n");
}

export function writeReport(simRoot: string, runDir: string, state: SimState | null, entries: JournalEntry[]): { reportPath: string; findings: number } {
  const reportPath = path.join(simRoot, "report.md");
  writePrivateFile(reportPath, renderReport(state, entries));
  writePrivateFile(
    path.join(runDir, "summary.json"),
    `${JSON.stringify({ runId: state?.runId, generatedUtc: new Date().toISOString(), tally: tally(entries), groups: groupFindings(entries) }, null, 2)}\n`,
  );
  return { reportPath, findings: entries.filter((e) => FINDING_OUTCOMES.has(e.outcome)).length };
}

/** owner-queue.txt: one line per waiting user, market tasks first. */
export function renderOwnerQueue(state: SimState, extra: string[] = []): string {
  const waiting = Object.values(state.users)
    .filter((u) => !u.terminal && (u.awaitingOwner || u.ownerTask))
    .sort((a, b) => a.plan.n - b.plan.n);
  const edge = Object.values(state.users)
    .filter((u) => u.plan.cohort === "E" && u.data.clientId)
    .sort((a, b) => a.plan.n - b.plan.n);
  const xfer = Object.values(state.users)
    .filter((u) => u.plan.cohort === "X")
    .sort((a, b) => a.plan.n - b.plan.n);
  const transfers = xfer.length || state.market.loan
    ? [
        "## Transfers (cohort X): information, no action",
        `- donor loan: ${loanLine(state)}`,
        ...xfer.filter((u) => u.terminal && u.terminal !== "done").map((u) => `- ${u.plan.label} [X/${u.plan.variant}] ended ${u.terminal}: ${u.reason ?? ""}`),
        "",
      ]
    : [];
  const lines = [
    `# Manci simulator run ${state.runId} — what the owner is asked to do (${new Date().toISOString()})`,
    "# The simulator never approves anything itself; it polls every 2 min and continues each user.",
    "",
    "## Before and during the run",
    "- /admin/limits: the e2e payment mint 6bJVc… needs an eur_peg FX row (else FX_RATE_MISSING).",
    "- Maintenance off; the Helius devnet webhook active.",
    ...(state.market.termsOk ? [] : ["- Publish a verified whitepaper for the e2e asset (MANCI-E2E-42eac4): /api/launchpad/terms answers 409 until then and every buyer waits."]),
    ...(state.market.fxKind && state.market.fxKind !== "eur_peg" && state.market.fxKind !== "rate"
      ? [`- FX row for the e2e payment mint: ${state.market.fxKind} — add an eur_peg row on /admin/limits before the buys.`]
      : []),
    ...extra.map((x) => `- ${x}`),
    "",
    `## Waiting users (${waiting.length})`,
    ...waiting.map((u) => `${u.plan.label} [${u.plan.cohort}/${u.plan.variant}, ${u.plan.wave === 0 ? "pilot" : `wave ${u.plan.wave}`}, review=${u.plan.review}] wallet ${u.wallet}: ${u.ownerTask ?? u.stage}`),
    "",
    "## Edge-cohort dossiers (opened only to test bad uploads): leave them untouched",
    ...edge.map((u) => `${u.plan.label} client ${u.data.clientId} wallet ${u.wallet}`),
    "",
    ...transfers,
  ];
  return lines.join("\n");
}
