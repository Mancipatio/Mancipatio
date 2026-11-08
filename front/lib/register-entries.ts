// Register entries (migration 0086): the admin's record of the registry
// decision behind converted units. Manual parameter narrowing shared by the
// admin form (app/admin/cap-table) and the signed routes
// (/api/cap-table/register-create, /register-void), which re-check
// everything on the server: the share class on chain, a linked conversion
// request, the holder's dossier. Pure and node-safe: tests/cap-table.test.ts.

import { normalizeBps } from "@/lib/cap-table";

export class RegisterEntryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisterEntryInputError";
  }
}

export type RegisterEntryInput = {
  share_class_pda: string;
  /** Integer units as decimal text. */
  units: string;
  /** Basis points as normalized decimal text ("250", "12.34"). */
  percent_bps: string;
  registry: string;
  decision_ref: string;
  /** YYYY-MM-DD. */
  decision_date: string;
  /** Lower-case hex. */
  decision_doc_sha256: string;
  conversion_request_id: string | null;
  realize_tx: string | null;
  holder_client_id: string | null;
  note: string;
};

export const DEFAULT_REGISTRY = "APR";
export const U64_MAX = BigInt("18446744073709551615");

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS_RE = /^[1-9]\d{0,19}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function text(params: Record<string, unknown>, key: string, max: number, opts: { required: boolean; fallback?: string }): string {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required && opts.fallback === undefined) throw new RegisterEntryInputError(`${key} is required`);
    return opts.fallback ?? "";
  }
  if (typeof raw !== "string") throw new RegisterEntryInputError(`${key} must be text`);
  const value = raw.trim();
  if (opts.required && value.length === 0) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new RegisterEntryInputError(`${key} is required`);
  }
  if (value.length > max) throw new RegisterEntryInputError(`${key} must be at most ${max} characters`);
  return value;
}

function optional(params: Record<string, unknown>, key: string, re: RegExp, message: string): string | null {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !re.test(raw.trim())) throw new RegisterEntryInputError(message);
  return raw.trim();
}

/** "YYYY-MM-DD" of `date` in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A calendar date from 2000-01-01 to tomorrow (UTC; the registry's date is
 * local, and the database allows the same day of slack).
 */
export function validDecisionDate(value: string, today: Date = new Date()): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  const tomorrow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  return value >= "2000-01-01" && value <= isoDate(tomorrow);
}

/** Narrow a register-create request. Throws RegisterEntryInputError with the field's problem. */
export function parseRegisterEntryInput(params: Record<string, unknown>, today: Date = new Date()): RegisterEntryInput {
  const sharePda = params.share_class_pda;
  if (typeof sharePda !== "string" || !ADDRESS_RE.test(sharePda)) {
    throw new RegisterEntryInputError("share_class_pda is not a valid address");
  }
  const units = params.units;
  if (typeof units !== "string" || !UNITS_RE.test(units) || BigInt(units) > U64_MAX) {
    throw new RegisterEntryInputError("units must be a whole number of units above zero");
  }
  const bps = typeof params.percent_bps === "string" ? normalizeBps(params.percent_bps) : null;
  if (bps === null) {
    throw new RegisterEntryInputError("percent_bps must be basis points above 0 and at most 10,000, with up to four decimals");
  }
  const registry = text(params, "registry", 80, { required: true, fallback: DEFAULT_REGISTRY });
  const decisionRef = text(params, "decision_ref", 120, { required: true });
  if (CONTROL_RE.test(registry) || CONTROL_RE.test(decisionRef)) {
    throw new RegisterEntryInputError("registry and decision_ref must be single lines of text");
  }
  const date = params.decision_date;
  if (typeof date !== "string" || !validDecisionDate(date, today)) {
    throw new RegisterEntryInputError("decision_date must be a date (YYYY-MM-DD) from 2000 to today");
  }
  const sha = typeof params.decision_doc_sha256 === "string" ? params.decision_doc_sha256.trim().toLowerCase() : "";
  if (!SHA256_RE.test(sha) || /^0+$/.test(sha)) {
    throw new RegisterEntryInputError("decision_doc_sha256 must be the SHA-256 of the decision document (64 hex characters)");
  }
  const note = text(params, "note", 2000, { required: false });
  if (NOTE_CONTROL_RE.test(note)) throw new RegisterEntryInputError("note contains control characters");
  return {
    share_class_pda: sharePda,
    units,
    percent_bps: bps,
    registry,
    decision_ref: decisionRef,
    decision_date: date,
    decision_doc_sha256: sha,
    conversion_request_id: optional(params, "conversion_request_id", UUID_RE, "conversion_request_id is not a valid id")?.toLowerCase() ?? null,
    realize_tx: optional(params, "realize_tx", SIGNATURE_RE, "realize_tx is not a valid transaction signature"),
    holder_client_id: optional(params, "holder_client_id", UUID_RE, "holder_client_id is not a valid id")?.toLowerCase() ?? null,
    note,
  };
}

export type RegisterVoidInput = { id: string; reason: string };

/** Narrow a register-void request: the entry id and a reason (1–500 characters). */
export function parseRegisterVoidInput(params: Record<string, unknown>): RegisterVoidInput {
  const id = params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new RegisterEntryInputError("id is not a valid register entry id");
  const reason = text(params, "reason", 500, { required: true });
  if (CONTROL_RE.test(reason)) throw new RegisterEntryInputError("reason must be a single line of text");
  return { id: id.toLowerCase(), reason };
}
