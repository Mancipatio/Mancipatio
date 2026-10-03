// SERVER-ONLY — the durable record of a distribution's recipient screening
// (devnet rehearsal 2026-10-03, P1; the design is in lib/distribution-
// screening.ts).
//
// No migration: both records are server-attributed audit_events rows
// (writeServerAudit: actor verified, network stamped) in the "compliance"
// category, which the unsigned /api/audit refuses, so neither can be forged
// from the browser. They are durable (no retention job deletes audit_events)
// and queryable per wallet, network and list version:
//
//   select created_at, actor_wallet, target_label as share_class,
//          metadata->>'list_version' as list_version,
//          metadata->'results'->>'<wallet>' as result
//     from audit_events
//    where category = 'compliance' and ix_name = 'sanctions_screening'
//      and network = '<network>' and metadata->'results' ? '<wallet>'
//    order by created_at desc;
//
//  1. sanctions_screening (recordRecipientScreening, POST /api/compliance/
//     screen-recipients): one row per screen — every wallet's result
//     (clear / hit / unscreened), the list publication(s) used (source,
//     publish date, SHA-256 of the file), the providers that could not
//     answer (off mainnet only: mainnet refuses with 503 instead) and the run
//     the screen was for. A failed write refuses the screen (503): nothing is
//     sent on a screen that left no record.
//  2. distribution_screening_evidence (requireRunEvidence, POST
//     /api/compliance/distribution-evidence): before the sender signs, every
//     recipient of the declared run must have a screening of this share class
//     on this network from the last SCREENING_FRESH_MS whose LATEST result is
//     clear ("unscreened" passes only where the screen is not enforced);
//     otherwise 409 and nothing is recorded. The row lists each recipient's
//     screening id, time, list version and result; its id is the evidence id
//     every distribution audit row cites.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork } from "@/lib/network";
import {
  SCREENING_FRESH_MS,
  listVersionLabel,
  type RecipientScreening,
  type ScreeningVerdict,
} from "@/lib/distribution-screening";
import { writeServerAudit, type AuditActorSource } from "@/lib/server/audit";
import { screenAndRaise, screeningFailsClosed } from "@/lib/server/sanctions";
import { SiwsError } from "@/lib/server/siws-error";

export const SCREENING_IX = "sanctions_screening";
export const EVIDENCE_IX = "distribution_screening_evidence";
/** The screening records read back for one check (a share class's last SCREENING_FRESH_MS). */
const MAX_SCREENING_ROWS = 500;

export type Actor = { wallet: string; source: AuditActorSource };

export type ScreeningRecord = {
  id: string;
  screened_at: string;
  list_version: string;
  results: Record<string, ScreeningVerdict>;
};

/**
 * Screens the recipients (lib/server/sanctions screenAndRaise: a hit raises
 * its compliance alert; mainnet refuses with 503 while a list cannot answer)
 * and records the result. THROWS SiwsError(503) when the record cannot be
 * written.
 */
export async function recordRecipientScreening(
  sb: SupabaseClient,
  input: { actor: Actor; shareClass: string; runId: string | null; wallets: readonly string[]; route: string },
): Promise<{ blocked: string[]; record: ScreeningRecord }> {
  const { blocked, result } = await screenAndRaise(sb, {
    route: input.route,
    wallets: input.wallets.map((wallet) => ({ wallet, role: "counterparty" as const })),
  });
  const unscreened = result.unavailable.length > 0;
  const results: Record<string, ScreeningVerdict> = {};
  for (const wallet of input.wallets) results[wallet] = blocked.has(wallet) ? "hit" : unscreened ? "unscreened" : "clear";
  const counts = { clear: 0, hit: 0, unscreened: 0 };
  for (const verdict of Object.values(results)) counts[verdict]++;
  const screenedAt = new Date().toISOString();
  const listVersion = listVersionLabel(result.lists);
  const n = input.wallets.length;
  const id = await writeServerAudit(sb, {
    ix_name: SCREENING_IX,
    category: "compliance",
    actor_wallet: input.actor.wallet,
    actor_source: input.actor.source,
    reason: `Sanctions screening of ${n} distribution ${n === 1 ? "recipient" : "recipients"}`,
    target_label: input.shareClass,
    metadata: {
      route: input.route,
      share_class: input.shareClass,
      run_id: input.runId,
      screened_at: screenedAt,
      list_version: listVersion,
      lists: result.lists,
      results,
      counts,
      unavailable: result.unavailable,
      enforced: screeningFailsClosed(),
    },
  });
  return { blocked: input.wallets.filter((w) => blocked.has(w)), record: { id, screened_at: screenedAt, list_version: listVersion, results } };
}

export type LatestScreening = { screening_id: string; screened_at: string; list_version: string; result: ScreeningVerdict };

/**
 * Each wallet's LATEST screening of `shareClass` on this network within
 * `maxAgeMs` of `now` (a wallet screened clear and then hit is a hit).
 * THROWS SiwsError(503) when the records cannot be read.
 */
export async function latestScreenings(
  sb: SupabaseClient,
  input: { shareClass: string; wallets: readonly string[]; now?: number; maxAgeMs?: number },
): Promise<Map<string, LatestScreening>> {
  const now = input.now ?? Date.now();
  const since = now - (input.maxAgeMs ?? SCREENING_FRESH_MS);
  const { data, error } = await sb
    .from("audit_events")
    .select("id, created_at, metadata")
    .eq("network", detectNetwork())
    .eq("category", "compliance")
    .eq("ix_name", SCREENING_IX)
    .eq("target_label", input.shareClass)
    .gte("created_at", new Date(since).toISOString())
    .order("created_at", { ascending: false })
    .limit(MAX_SCREENING_ROWS);
  if (error || !Array.isArray(data)) throw new SiwsError(503, "Screening records unavailable — nothing was recorded; try again");
  const rows = (data as { id: unknown; created_at: unknown; metadata: unknown }[])
    .filter((r) => typeof r.id === "string" && typeof r.created_at === "string" && Date.parse(r.created_at) >= since && Date.parse(r.created_at) <= now + 60_000)
    .sort((a, b) => Date.parse(b.created_at as string) - Date.parse(a.created_at as string));
  const out = new Map<string, LatestScreening>();
  const wanted = new Set(input.wallets);
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as { results?: unknown; list_version?: unknown };
    const results = meta.results && typeof meta.results === "object" ? (meta.results as Record<string, unknown>) : {};
    for (const [wallet, verdict] of Object.entries(results)) {
      if (!wanted.has(wallet) || out.has(wallet)) continue;
      if (verdict !== "clear" && verdict !== "hit" && verdict !== "unscreened") continue;
      out.set(wallet, {
        screening_id: row.id as string,
        screened_at: row.created_at as string,
        list_version: typeof meta.list_version === "string" ? meta.list_version : "unknown",
        result: verdict,
      });
    }
  }
  return out;
}

/** Whether a screening result lets a recipient be paid now. */
export function acceptedVerdict(verdict: ScreeningVerdict): boolean {
  return verdict === "clear" || (verdict === "unscreened" && !screeningFailsClosed());
}

export const NO_FRESH_SCREENING = (missing: number, total: number) =>
  `${missing} of the ${total} ${total === 1 ? "recipient has" : "recipients have"} no clear sanctions screening from the last ${SCREENING_FRESH_MS / 60_000} minutes, so nothing may be sent to ${missing === 1 ? "it" : "them"}. Send again: the recipients are screened again first.`;

/**
 * The run's evidence: refuses (409) unless every wallet's latest screening
 * of this share class is fresh and clear, then records which screening
 * vouches for each recipient and returns it. THROWS SiwsError(503) when the
 * records cannot be read or the evidence cannot be written.
 */
export async function requireRunEvidence(
  sb: SupabaseClient,
  input: { actor: Actor; shareClass: string; runId: string; wallets: readonly string[]; now?: number },
): Promise<{ evidence_id: string; checked_at: string; recipients: Record<string, RecipientScreening> }> {
  const now = input.now ?? Date.now();
  const latest = await latestScreenings(sb, { shareClass: input.shareClass, wallets: input.wallets, now });
  const refused = input.wallets.filter((w) => {
    const s = latest.get(w);
    return !s || !acceptedVerdict(s.result);
  });
  if (refused.length > 0) throw new SiwsError(409, NO_FRESH_SCREENING(refused.length, input.wallets.length));
  const checkedAt = new Date(now).toISOString();
  const recipients = input.wallets.map((wallet) => {
    const s = latest.get(wallet)!;
    return { wallet, screening_id: s.screening_id, screened_at: s.screened_at, list_version: s.list_version, result: s.result };
  });
  const n = input.wallets.length;
  const evidenceId = await writeServerAudit(sb, {
    ix_name: EVIDENCE_IX,
    category: "compliance",
    actor_wallet: input.actor.wallet,
    actor_source: input.actor.source,
    reason: `Screening evidence of distribution run ${input.runId.slice(0, 8)}: ${n} ${n === 1 ? "recipient" : "recipients"}`,
    target_label: input.shareClass,
    metadata: {
      run_id: input.runId,
      share_class: input.shareClass,
      checked_at: checkedAt,
      max_age_ms: SCREENING_FRESH_MS,
      enforced: screeningFailsClosed(),
      recipients,
    },
  });
  const out: Record<string, RecipientScreening> = {};
  for (const r of recipients) {
    out[r.wallet] = {
      screening_id: r.screening_id,
      screened_at: r.screened_at,
      list_version: r.list_version,
      result: r.result as RecipientScreening["result"],
      evidence_id: evidenceId,
    };
  }
  return { evidence_id: evidenceId, checked_at: checkedAt, recipients: out };
}
