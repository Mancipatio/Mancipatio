// SERVER-ONLY — operational watches of the alarm worker's checks stage:
// the SOL balance of the platform's operational keys (kritičar-13) and the
// Squads v4 multisig that holds the upgrade authority (ops-qa-13).
//
// Both are configured per deployment in the server env (public keys only)
// and report nothing while unset:
//
//   ALARM_BALANCE_WATCH  comma-separated `label:address[:minSol]` (at most
//                        20 entries; label [a-z0-9-]{1,30}; minSol default
//                        0.1). One incident per address, sol-balance:<address>
//                        (high): fail below minSol, pass from 1.25 × minSol,
//                        hold between. A missing account counts as 0 SOL.
//                        Watch every key that must sign in an emergency: the
//                        super admin, every Admin, the BlocklistAuthority,
//                        the KYC authority (it pays KycEntry rent) and the
//                        bufferWriter. One key holding several roles (the
//                        company wallet model) may be listed under each
//                        label: the entries merge into one watch, with every
//                        label and the highest minSol.
//   ALARM_SQUADS_CONFIG  JSON: the role map's `squads` object (multisig,
//                        threshold, timeLock, configAuthority, members with
//                        permissions; vault and vaultIndex are ignored).
//                        squads-config:<multisig> (critical) fails while the
//                        on-chain Multisig differs from it (members and their
//                        permissions, threshold, time lock, config
//                        authority) or cannot be read as a Squads v4
//                        Multisig. squads-proposal:<proposal PDA>: one
//                        incident PER open proposal, Approved or Executing
//                        (it can execute) critical, Draft or Active (not
//                        stale) high, an unreadable Proposal account
//                        critical. So each new proposal pages on its own,
//                        even while another one is open or acknowledged, and
//                        a proposal is seen while it gathers approvals and
//                        waits out the time lock, not only once it executes
//                        (the program-upgrade and treasury instruction
//                        alarms fire on execution). The team's own proposals
//                        page too: that is the point.
//                        Every run reads the newest PROPOSAL_WINDOW
//                        transaction indexes, one PROPOSAL_SWEEP_CHUNK of the
//                        older ones in rotation (a proposal created late for
//                        an old index, or one pushed out of the window by a
//                        flood of new transactions, is read within
//                        ceil(older / chunk) minutes), and every proposal
//                        whose incident is still open, wherever it is.
// A set value that does not parse is an incident of its own (ops-watch-config,
// high), never a silent skip. An incident whose address or multisig is no
// longer configured reports pass, so it clears.
//
// RPC: at most one getMultipleAccounts for the balances, one for the
// multisig and three for proposals (window, sweep chunk, open incidents) per
// run, each bounded by OPS_WATCH_RPC_TIMEOUT_MS on top of the caller's
// signal: a hanging RPC fails the watch quickly and never the other checks.

import "server-only";
import { fetchEncodedAccounts, isAddress, type Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Network } from "@/lib/network";
import { getServerRpc } from "@/lib/server/rpc";
import type { AlertCategory, IncidentState, Severity } from "@/lib/server/system-alerts";
import {
  FINAL_PROPOSAL_STATUSES,
  PERMISSION_NAMES,
  SQUADS_V4_PROGRAM,
  compareMultisig,
  decodeMultisig,
  decodeProposal,
  squadsProposalPda,
  type DecodedMultisig,
} from "@/scripts/chain/lib/squads";

export type WatchReport = {
  check: string; state: IncidentState; severity: Severity; category: AlertCategory; source: string; summary: string;
  evidence?: Record<string, unknown>;
};
export type WatchedAccount = { owner: string; lamports: bigint; data: Uint8Array };
/** Reads accounts (null: does not exist). Injected in tests. */
export type AccountFetcher = (addresses: string[], signal: AbortSignal) => Promise<Map<string, WatchedAccount | null>>;

export const BALANCE_WATCH_MAX = 20;
export const DEFAULT_MIN_SOL = 0.1;
/** The most recent transaction indexes whose proposals are read each run. */
export const PROPOSAL_WINDOW = 100;
/** Older transaction indexes read per run, one chunk per minute in rotation. */
export const PROPOSAL_SWEEP_CHUNK = 100;
/** Open proposals reported individually per run (executable first, then newest). */
export const PROPOSAL_REPORTS_MAX = 20;
/** Each chain read of a watch, on top of the caller's signal. */
export const OPS_WATCH_RPC_TIMEOUT_MS = 5_000;

const serverFetcher: AccountFetcher = async (addresses, signal) => {
  const out = new Map<string, WatchedAccount | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const accounts = await fetchEncodedAccounts(getServerRpc(), chunk.map((a) => a as Address), { commitment: "confirmed", abortSignal: signal });
    accounts.forEach((account, k) => out.set(chunk[k], account.exists
      ? { owner: account.programAddress, lamports: BigInt(account.lamports), data: new Uint8Array(account.data) } : null));
  }
  return out;
};

/** One read bounded by its own timeout; rejects on abort even if the fetcher ignores its signal. */
function boundedFetcher(fetchAccounts: AccountFetcher, timeoutMs: number): AccountFetcher {
  return (addresses, signal) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("Chain read timed out"));
      if (bounded.aborted) return onAbort();
      bounded.addEventListener("abort", onAbort, { once: true });
      fetchAccounts(addresses, bounded).then(resolve, reject).finally(() => bounded.removeEventListener("abort", onAbort));
    });
  };
}

// ── Configuration ────────────────────────────────────────────────────────

export type BalanceWatch = { label: string; address: string; minLamports: bigint };

/**
 * ALARM_BALANCE_WATCH; [] when unset, "invalid" when set but unusable. The
 * same address under several labels (one key, several roles) is one watch:
 * its labels joined with "+", the highest threshold.
 */
export function parseBalanceWatch(value: string | undefined): BalanceWatch[] | "invalid" {
  const raw = value?.trim();
  if (!raw) return [];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length > BALANCE_WATCH_MAX) return "invalid";
  const out: BalanceWatch[] = [];
  for (const item of items) {
    const [label, address, min, extra] = item.split(":").map((s) => s.trim());
    if (extra !== undefined || !/^[a-z0-9-]{1,30}$/.test(label ?? "") || !address || !isAddress(address)) return "invalid";
    const sol = min === undefined || min === "" ? DEFAULT_MIN_SOL : Number(min);
    if (!Number.isFinite(sol) || sol <= 0 || sol > 1_000) return "invalid";
    const minLamports = BigInt(Math.round(sol * 1e9));
    const same = out.find((w) => w.address === address);
    if (same) {
      if (!same.label.split("+").includes(label)) same.label += `+${label}`;
      if (minLamports > same.minLamports) same.minLamports = minLamports;
    } else {
      out.push({ label, address, minLamports });
    }
  }
  return out;
}

export type SquadsWatch = {
  multisig: Address; threshold: number; timeLock: number; configAuthority: Address | null;
  members: { key: Address; permissions: string[] }[];
};

/** ALARM_SQUADS_CONFIG; null when unset, "invalid" when set but unusable. */
export function parseSquadsWatch(value: string | undefined): SquadsWatch | null | "invalid" {
  const raw = value?.trim();
  if (!raw) return null;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "invalid";
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid";
  const { multisig, threshold, timeLock, configAuthority, members } = input;
  const int = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
  if (typeof multisig !== "string" || !isAddress(multisig) || !int(threshold, 65_535) || (threshold as number) < 1
    || !int(timeLock, 0xffffffff) || !(configAuthority === null || (typeof configAuthority === "string" && isAddress(configAuthority)))
    || !Array.isArray(members) || members.length < 1 || members.length > 64) return "invalid";
  const parsed: SquadsWatch["members"] = [];
  for (const m of members as unknown[]) {
    const member = m as { key?: unknown; permissions?: unknown };
    if (!member || typeof member.key !== "string" || !isAddress(member.key) || !Array.isArray(member.permissions)
      || !member.permissions.length || !member.permissions.every((p) => (PERMISSION_NAMES as string[]).includes(p as string))
      || parsed.some((p) => p.key === member.key)) return "invalid";
    parsed.push({ key: member.key, permissions: member.permissions as string[] });
  }
  return { multisig, threshold: threshold as number, timeLock: timeLock as number, configAuthority: configAuthority as Address | null, members: parsed };
}

function configReport(problems: string[]): WatchReport {
  return {
    check: "ops-watch-config", state: problems.length ? "fail" : "pass", severity: "high", category: "worker",
    source: "worker:ops-watch-config",
    summary: problems.length ? `Alarm watch configuration is invalid: ${problems.join(", ")}` : "Alarm watch configuration is valid",
    evidence: { invalid: problems },
  };
}

// ── Checks ───────────────────────────────────────────────────────────────

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4).replace(/\.?0+$/, "");

export function balanceReport(watch: BalanceWatch, lamports: bigint): WatchReport {
  const state: IncidentState = lamports < watch.minLamports ? "fail"
    : lamports * BigInt(4) >= watch.minLamports * BigInt(5) ? "pass" : "hold";
  return {
    check: `sol-balance:${watch.address}`, state, severity: "high", category: "onchain", source: "onchain:low-balance",
    summary: state === "fail"
      ? `Operational key ${watch.label} (${watch.address}) has ${sol(lamports)} SOL, below ${sol(watch.minLamports)} SOL: top it up`
      : `Operational key ${watch.label} (${watch.address}) has ${sol(lamports)} SOL (threshold ${sol(watch.minLamports)} SOL)`,
    evidence: { label: watch.label, address: watch.address, lamports: lamports.toString(), min_lamports: watch.minLamports.toString() },
  };
}

/** index: null for a tracked proposal whose account could not be decoded. */
type OpenProposal = { pda: string; index: bigint | null; status: string; approvals: number; stale: boolean; unreadable: boolean };

const PROPOSAL_CHECK = "squads-proposal";

/** Transaction indexes read this run: the newest window and one older chunk in rotation. */
export function proposalScanIndexes(last: bigint, now: number): { recent: bigint[]; sweep: bigint[] } {
  const window = BigInt(PROPOSAL_WINDOW);
  const first = last >= window ? last - window + BigInt(1) : BigInt(1);
  const recent: bigint[] = [];
  for (let index = first; index <= last; index++) recent.push(index);
  const sweep: bigint[] = [];
  const older = first - BigInt(1);
  if (older >= BigInt(1)) {
    const chunk = BigInt(PROPOSAL_SWEEP_CHUNK);
    const chunks = (older + chunk - BigInt(1)) / chunk;
    const from = (BigInt(Math.floor(now / 60_000)) % chunks) * chunk + BigInt(1);
    const to = from + chunk - BigInt(1) < older ? from + chunk - BigInt(1) : older;
    for (let index = from; index <= to; index++) sweep.push(index);
  }
  return { recent, sweep };
}

/**
 * The Multisig against the expected configuration, and one incident per open
 * proposal. `openKeys`: the open incident keys, so a proposal whose incident
 * is open is read wherever its index is, and passes once it is no longer open.
 */
export async function squadsReports(
  watch: SquadsWatch, fetchAccounts: AccountFetcher, signal: AbortSignal, openKeys: readonly string[] = [], now = Date.now(),
): Promise<WatchReport[]> {
  const base = { category: "onchain" as const };
  const configCheck = `squads-config:${watch.multisig}`;
  const account = (await fetchAccounts([watch.multisig], signal)).get(watch.multisig) ?? null;
  let decoded: DecodedMultisig | null = null;
  const problems: string[] = [];
  if (!account) problems.push("the multisig account does not exist");
  else if (account.owner !== SQUADS_V4_PROGRAM) problems.push(`the multisig is owned by ${account.owner}, not Squads v4`);
  else {
    try {
      decoded = decodeMultisig(account.data);
    } catch {
      problems.push("the multisig account is not a Squads v4 Multisig");
    }
  }
  // compareMultisig reads threshold, timeLock, configAuthority and members only.
  if (decoded) problems.push(...compareMultisig(decoded, { ...watch, vaultIndex: 0, vault: watch.multisig }));
  const reports: WatchReport[] = [{
    ...base, check: configCheck, state: problems.length ? "fail" : "pass", severity: "critical", source: "onchain:squads-config",
    summary: problems.length
      ? `Squads multisig ${watch.multisig} differs from its expected configuration: ${problems.slice(0, 5).join("; ")}`
      : `Squads multisig ${watch.multisig} matches its expected configuration`,
    evidence: { multisig: watch.multisig, problems: problems.slice(0, 20),
      threshold: decoded?.threshold ?? null, time_lock: decoded?.timeLock ?? null, members: decoded?.members.length ?? null },
  }];
  if (!decoded) return reports;
  const multisig = decoded;

  const { recent, sweep } = proposalScanIndexes(multisig.transactionIndex, now);
  const pdaOf = async (indexes: bigint[]) =>
    Promise.all(indexes.map(async (index) => ({ index, pda: await squadsProposalPda(watch.multisig, index) as string })));
  const scanned = [...await pdaOf(recent), ...await pdaOf(sweep)];
  const indexOf = new Map<string, bigint | null>(scanned.map((p) => [p.pda, p.index]));
  // Proposals whose incident is open but whose index is outside this run's reads.
  const tracked = openKeys.filter((k) => k.startsWith(`${PROPOSAL_CHECK}:`)).map((k) => k.slice(PROPOSAL_CHECK.length + 1))
    .filter((pda) => !indexOf.has(pda)).slice(0, 100);
  for (const pda of tracked) indexOf.set(pda, null);
  // Three reads at most (window, sweep chunk, tracked), each under its own timeout.
  const read = new Map<string, WatchedAccount | null>();
  const groups = [scanned.slice(0, recent.length), scanned.slice(recent.length)].map((g) => g.map((p) => p.pda));
  for (const group of [...groups, tracked]) {
    if (!group.length) continue;
    for (const [pda, value] of await fetchAccounts(group, signal)) read.set(pda, value);
  }

  const open: OpenProposal[] = [];
  const closed: string[] = [];
  for (const [pda, expectedIndex] of indexOf) {
    if (!read.has(pda)) continue;
    const proposal = read.get(pda) ?? null;
    // A missing account was never proposed or was closed after it finished; an
    // account the Squads program does not own cannot be one of its proposals.
    if (!proposal || proposal.owner !== SQUADS_V4_PROGRAM) {
      closed.push(pda);
      continue;
    }
    let p;
    try {
      p = decodeProposal(proposal.data);
    } catch {
      open.push({ pda, index: expectedIndex, status: "unreadable", approvals: 0, stale: false, unreadable: true });
      continue;
    }
    if (p.multisig !== watch.multisig) {
      // A proposal of another multisig (only a tracked one can be): no longer watched.
      if (expectedIndex === null) closed.push(pda);
      else open.push({ pda, index: expectedIndex, status: "unreadable", approvals: 0, stale: false, unreadable: true });
      continue;
    }
    if (expectedIndex !== null && p.transactionIndex !== expectedIndex) {
      open.push({ pda, index: expectedIndex, status: "unreadable", approvals: 0, stale: false, unreadable: true });
      continue;
    }
    const stale = p.transactionIndex <= multisig.staleTransactionIndex;
    // A stale Draft or Active proposal can no longer be approved; an Approved one still executes.
    if (FINAL_PROPOSAL_STATUSES.includes(p.status) || (stale && (p.status === "Draft" || p.status === "Active"))) {
      closed.push(pda);
      continue;
    }
    open.push({ pda, index: p.transactionIndex, status: p.status, approvals: p.approved.length, stale, unreadable: false });
  }

  const critical = (p: OpenProposal) => p.unreadable || p.status === "Approved" || p.status === "Executing";
  const rank = (p: OpenProposal) => p.index ?? BigInt(-1);
  open.sort((a, b) => Number(critical(b)) - Number(critical(a)) || (rank(b) > rank(a) ? 1 : rank(b) < rank(a) ? -1 : 0));
  for (const p of open.slice(0, PROPOSAL_REPORTS_MAX)) {
    reports.push({
      ...base, check: `${PROPOSAL_CHECK}:${p.pda}`, state: "fail", severity: critical(p) ? "critical" : "high", source: "onchain:squads-proposal",
      summary: p.unreadable
        ? `Squads multisig ${watch.multisig}: the proposal account ${p.pda} (#${p.index ?? "?"}) could not be read as its Squads v4 Proposal. Check it before anything executes.`
        : `Squads multisig ${watch.multisig}: proposal #${p.index} is ${p.status} (${p.approvals}/${multisig.threshold} approvals${p.stale ? ", stale" : ""}). Check it before it executes.`,
      evidence: { multisig: watch.multisig, proposal: p.pda, index: p.index?.toString() ?? null, status: p.status, approvals: p.approvals,
        threshold: multisig.threshold, stale: p.stale, time_lock: multisig.timeLock, open_proposals: open.length },
    });
  }
  // Only a proposal read this run and no longer open passes (one over the report cap keeps its incident).
  const openKeySet = new Set(openKeys);
  for (const pda of closed) {
    if (!openKeySet.has(`${PROPOSAL_CHECK}:${pda}`)) continue;
    reports.push({ ...base, check: `${PROPOSAL_CHECK}:${pda}`, state: "pass", severity: "high", source: "onchain:squads-proposal",
      summary: `Squads proposal ${pda} is no longer open`, evidence: { multisig: watch.multisig, proposal: pda } });
  }
  return reports;
}

/**
 * The watches' incidents; [] when nothing is configured and nothing is open.
 * Throws when the chain or the incident table cannot be read (the worker
 * counts that as a check that could not run).
 */
export async function opsWatchReports(
  sb: SupabaseClient, network: Network, signal: AbortSignal,
  env: Record<string, string | undefined> = process.env, fetchAccounts: AccountFetcher = serverFetcher,
  options: { rpcTimeoutMs?: number; now?: number } = {},
): Promise<WatchReport[]> {
  const fetchBounded = boundedFetcher(fetchAccounts, options.rpcTimeoutMs ?? OPS_WATCH_RPC_TIMEOUT_MS);
  const balances = parseBalanceWatch(env.ALARM_BALANCE_WATCH);
  const squads = parseSquadsWatch(env.ALARM_SQUADS_CONFIG);
  const invalid = [...(balances === "invalid" ? ["ALARM_BALANCE_WATCH"] : []), ...(squads === "invalid" ? ["ALARM_SQUADS_CONFIG"] : [])];
  const reports: WatchReport[] = [];
  const { data, error } = await sb.from("alarm_incidents").select("check_key").eq("network", network).is("cleared_at", null)
    .not("last_fail_at", "is", null).limit(500).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
  if (error) throw new Error("Incidents unavailable");
  const openKeys = ((data ?? []) as { check_key: string }[]).map((r) => r.check_key);
  if (invalid.length || openKeys.includes("ops-watch-config")) reports.push(configReport(invalid));

  const watched = balances === "invalid" ? [] : balances;
  if (watched.length) {
    const accounts = await fetchBounded(watched.map((w) => w.address), signal);
    for (const w of watched) reports.push(balanceReport(w, accounts.get(w.address)?.lamports ?? BigInt(0)));
  }
  const multisig = squads && squads !== "invalid" ? squads : null;
  if (multisig) reports.push(...await squadsReports(multisig, fetchBounded, signal, openKeys, options.now));

  // Open incidents of addresses or a multisig no longer watched: the condition is gone.
  // An invalid value keeps its incidents (nothing is known about them).
  const reported = new Set(reports.map((r) => r.check));
  for (const key of openKeys) {
    if (reported.has(key)) continue;
    const [kind, subject] = key.split(":");
    if (kind === "sol-balance" && balances !== "invalid" && subject) {
      reports.push({ check: key, state: "pass", severity: "high", category: "onchain", source: "onchain:low-balance",
        summary: `Operational key ${subject} is no longer watched` });
    } else if (kind === "squads-config" && squads !== "invalid" && subject) {
      reports.push({ check: key, state: "pass", severity: "critical", category: "onchain", source: "onchain:squads-config",
        summary: `Squads multisig ${subject} is no longer watched` });
    } else if (kind === PROPOSAL_CHECK && squads === null && subject) {
      // With a multisig configured, squadsReports reads every open proposal incident itself.
      reports.push({ check: key, state: "pass", severity: "high", category: "onchain", source: "onchain:squads-proposal",
        summary: `Squads proposal ${subject} is no longer watched` });
    }
  }
  return reports;
}
