// SERVER-ONLY — operational watches of the alarm worker's checks stage:
// the SOL balance of the platform's operational keys (kritičar-13) and the
// Squads v4 multisig that holds the upgrade authority (ops-qa-13).
//
// Both are configured per deployment in the server env (public keys only)
// and report nothing while unset:
//
//   ALARM_BALANCE_WATCH  comma-separated `label:address[:minSol]` (at most
//                        20; label [a-z0-9-]{1,30}; minSol default 0.1).
//                        One incident per address, sol-balance:<address>
//                        (high): fail below minSol, pass from 1.25 × minSol,
//                        hold between. A missing account counts as 0 SOL.
//                        Watch every key that must sign in an emergency: the
//                        super admin, every Admin, the BlocklistAuthority,
//                        the KYC authority (it pays KycEntry rent) and the
//                        bufferWriter.
//   ALARM_SQUADS_CONFIG  JSON: the role map's `squads` object (multisig,
//                        threshold, timeLock, configAuthority, members with
//                        permissions; vault and vaultIndex are ignored).
//                        squads-config:<multisig> (critical) fails while the
//                        on-chain Multisig differs from it (members and their
//                        permissions, threshold, time lock, config
//                        authority) or cannot be read as a Squads v4
//                        Multisig. squads-proposals:<multisig> fails while a
//                        proposal among the last PROPOSAL_WINDOW transaction
//                        indexes is open: Approved or Executing (it can
//                        execute) critical, Draft or Active (not stale) high.
//                        So a proposal is seen while it gathers approvals and
//                        waits out the time lock, not only once it executes
//                        (the program-upgrade and treasury instruction
//                        alarms fire on execution). The team's own proposals
//                        page too: that is the point.
// A set value that does not parse is an incident of its own (ops-watch-config,
// high), never a silent skip. An incident whose address or multisig is no
// longer configured reports pass, so it clears.
//
// RPC: one getMultipleAccounts for the balances, one for the multisig and one
// for its proposal window, per run.

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
export const PROPOSAL_WINDOW = 50;

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

// ── Configuration ────────────────────────────────────────────────────────

export type BalanceWatch = { label: string; address: string; minLamports: bigint };

/** ALARM_BALANCE_WATCH; [] when unset, "invalid" when set but unusable. */
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
    if (out.some((w) => w.address === address)) return "invalid";
    out.push({ label, address, minLamports: BigInt(Math.round(sol * 1e9)) });
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

type Proposal = { index: string; status: string; approvals: number; stale: boolean };

/** The Multisig against the expected configuration, and its open proposals. */
export async function squadsReports(
  watch: SquadsWatch, fetchAccounts: AccountFetcher, signal: AbortSignal,
): Promise<WatchReport[]> {
  const base = { category: "onchain" as const };
  const configCheck = `squads-config:${watch.multisig}`;
  const proposalsCheck = `squads-proposals:${watch.multisig}`;
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

  const last = decoded.transactionIndex;
  const window = BigInt(PROPOSAL_WINDOW);
  const first = last >= window ? last - window + BigInt(1) : BigInt(1);
  const pdas: { index: bigint; pda: string }[] = [];
  for (let index = first; index <= last; index++) pdas.push({ index, pda: await squadsProposalPda(watch.multisig, index) });
  const accounts = pdas.length ? await fetchAccounts(pdas.map((p) => p.pda), signal) : new Map<string, WatchedAccount | null>();
  const open: Proposal[] = [];
  const unreadable: string[] = [];
  for (const { index, pda } of pdas) {
    const proposal = accounts.get(pda);
    if (!proposal) continue;
    try {
      if (proposal.owner !== SQUADS_V4_PROGRAM) throw new Error("owner");
      const p = decodeProposal(proposal.data);
      if (p.multisig !== watch.multisig || p.transactionIndex !== index) throw new Error("mismatch");
      if (FINAL_PROPOSAL_STATUSES.includes(p.status)) continue;
      const stale = index <= decoded.staleTransactionIndex;
      // A stale Draft or Active proposal can no longer be approved; an Approved one still executes.
      if (stale && (p.status === "Draft" || p.status === "Active")) continue;
      open.push({ index: index.toString(), status: p.status, approvals: p.approved.length, stale });
    } catch {
      unreadable.push(index.toString());
    }
  }
  const executable = open.some((p) => p.status === "Approved" || p.status === "Executing");
  const list = open.slice(0, 5).map((p) => `#${p.index} ${p.status} (${p.approvals}/${decoded!.threshold})`).join(", ");
  reports.push({
    ...base, check: proposalsCheck, state: open.length || unreadable.length ? "fail" : "pass",
    severity: executable || unreadable.length ? "critical" : "high", source: "onchain:squads-proposal",
    summary: open.length || unreadable.length
      ? `Squads multisig ${watch.multisig}: ${open.length} open proposal(s)${list ? `: ${list}` : ""}`
        + `${unreadable.length ? `; ${unreadable.length} proposal account(s) could not be read` : ""}. Check each one before it executes.`
      : `Squads multisig ${watch.multisig} has no open proposal`,
    evidence: { multisig: watch.multisig, open: open.slice(0, 20), unreadable: unreadable.slice(0, 20),
      scanned: [first.toString(), last.toString()], time_lock: decoded.timeLock },
  });
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
): Promise<WatchReport[]> {
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
    const accounts = await fetchAccounts(watched.map((w) => w.address), signal);
    for (const w of watched) reports.push(balanceReport(w, accounts.get(w.address)?.lamports ?? BigInt(0)));
  }
  const multisig = squads && squads !== "invalid" ? squads : null;
  if (multisig) reports.push(...await squadsReports(multisig, fetchAccounts, signal));

  // Open incidents of addresses or a multisig no longer watched: the condition is gone.
  // An invalid value keeps its incidents (nothing is known about them).
  const reported = new Set(reports.map((r) => r.check));
  for (const key of openKeys) {
    if (reported.has(key)) continue;
    const [kind, subject] = key.split(":");
    if (kind === "sol-balance" && balances !== "invalid" && subject) {
      reports.push({ check: key, state: "pass", severity: "high", category: "onchain", source: "onchain:low-balance",
        summary: `Operational key ${subject} is no longer watched` });
    } else if ((kind === "squads-config" || kind === "squads-proposals") && squads !== "invalid" && subject) {
      reports.push({ check: key, state: "pass", severity: kind === "squads-config" ? "critical" : "high", category: "onchain",
        source: kind === "squads-config" ? "onchain:squads-config" : "onchain:squads-proposal",
        summary: `Squads multisig ${subject} is no longer watched` });
    }
  }
  return reports;
}
