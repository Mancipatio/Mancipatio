// "Send to wallets": the sanctions-screening evidence of a distribution's
// recipients (devnet rehearsal 2026-10-03, P1: the screen wrote nothing and
// the audit rows named no screening).
//
// Every screen of the recipients (/api/compliance/screen-recipients) is
// recorded by the server: one server-attributed audit_events row (category
// "compliance", ix_name "sanctions_screening", the share class as target)
// with each wallet's result and the list publication used
// (lib/server/screening-evidence.ts). Before anything is signed,
// /api/compliance/distribution-evidence checks that every recipient of the
// run has a clear screening from the last SCREENING_FRESH_MS and records the
// run's evidence ("distribution_screening_evidence"). The panel keeps that
// evidence in the run's journal, refuses to sign for a row whose evidence is
// older than SCREENING_FRESH_MS, and every distribution audit row carries it
// per recipient (lib/distribution-run distributionAuditRow). No migration:
// the records are audit_events rows, which only the server may write in the
// "compliance" category.
//
// Node-safe: tests/distribution-screening.test.ts.

/** How long a clear screening vouches for a recipient. */
export const SCREENING_FRESH_MS = 15 * 60_000;
/** The panel screens again before it plans the transfers when its evidence is older than this. */
export const SCREENING_RECAPTURE_MS = 10 * 60_000;

/** A recipient's screening result: "unscreened" only where the list could not answer and the screen is not enforced (off mainnet). */
export type ScreeningVerdict = "clear" | "hit" | "unscreened";

/** One recipient's screening, as the evidence route vouched for it. */
export type RecipientScreening = {
  /** The screening record (an audit_events id). */
  screening_id: string;
  screened_at: string;
  /** The list publication(s) screened against (listVersionLabel). */
  list_version: string;
  /** Never "hit": the evidence route refuses a run with one. */
  result: "clear" | "unscreened";
  /** The run's evidence record (an audit_events id). */
  evidence_id: string;
};

/** Recipient wallet → its screening. */
export type ScreeningEvidence = Record<string, RecipientScreening>;

/** "ofac-sdn:2026-10-01:ab12cd34ef56", one per list ("+" between), "none" when no list answered. */
export function listVersionLabel(lists: readonly { source: string; published_on: string | null; sha256: string | null }[]): string {
  if (lists.length === 0) return "none";
  return lists.map((l) => `${l.source}:${l.published_on ?? "unknown"}:${l.sha256 ? l.sha256.slice(0, 12) : "unknown"}`).join("+");
}

/** Whether evidence taken at `takenAt` (ms) is due to be taken again before the plan (SCREENING_RECAPTURE_MS). */
export function evidenceDue(takenAt: number, now: number = Date.now()): boolean {
  return now - takenAt > SCREENING_RECAPTURE_MS;
}

/** The wallets of `wallets` whose evidence is missing or older than `maxAgeMs` at `now`. */
export function staleScreenings(
  evidence: ScreeningEvidence | null | undefined,
  wallets: readonly string[],
  now: number = Date.now(),
  maxAgeMs: number = SCREENING_FRESH_MS,
): string[] {
  return wallets.filter((w) => {
    const e = evidence?.[w];
    const at = e ? Date.parse(e.screened_at) : NaN;
    return !e || (e.result !== "clear" && e.result !== "unscreened") || !Number.isFinite(at) || now - at > maxAgeMs;
  });
}

/** The words of a refusal for `stale` rows (nothing is signed for them). */
export function staleScreeningText(stale: number): string {
  return `The sanctions screening of ${stale} ${stale === 1 ? "recipient is" : "recipients are"} older than ${SCREENING_FRESH_MS / 60_000} minutes or missing, so nothing more was signed. Send again: the recipients are screened again and nothing is sent twice.`;
}

const ENTRY_KEYS = ["screening_id", "screened_at", "list_version", "evidence_id"] as const;

/** A stored evidence map (the run journal), malformed entries dropped. */
export function parseScreeningEvidence(raw: unknown): ScreeningEvidence {
  const out: ScreeningEvidence = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [wallet, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    if (!ENTRY_KEYS.every((k) => typeof e[k] === "string") || (e.result !== "clear" && e.result !== "unscreened")) continue;
    out[wallet] = {
      screening_id: e.screening_id as string,
      screened_at: e.screened_at as string,
      list_version: e.list_version as string,
      result: e.result,
      evidence_id: e.evidence_id as string,
    };
  }
  return out;
}

/** The audit form of one recipient's screening (distributionAuditRow), null without one. */
export function screeningAuditEntry(evidence: ScreeningEvidence | null | undefined, wallet: string) {
  const e = evidence?.[wallet];
  return e
    ? { screening_id: e.screening_id, screened_at: e.screened_at, list_version: e.list_version, result: e.result, evidence_id: e.evidence_id }
    : null;
}
