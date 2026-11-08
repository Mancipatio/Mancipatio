// Field-by-field narrowing of the admin fee routes' signed params (house
// style: no schema library). Throws FeeValidationError with a message safe
// to show; the server maps it to HTTP 400. The database checks of 0089 are
// the backstop for every rule here.

import {
  FEE_KIND_REF_TYPES,
  FEE_REF_TYPES,
  isFeeKind,
  isFeePayer,
  isPerUnitKind,
  type FeeChargeStatus,
  type FeeKind,
  type FeePayer,
  type FeeRefType,
} from "@/lib/fees/schedule";
import { centsToDecimal, eurToCents, quoteFee } from "@/lib/fees/quote";

export class FeeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeValidationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Printable text without control characters (labels, notes, references).
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Fixed parts, minimums and maximums: up to EUR 10,000,000 (a typo guard well inside numeric(12,2)). */
export const MAX_FEE_EUR = 10_000_000;
/** A charge's EUR base (e.g. a conversion value): up to EUR 1,000,000,000 (numeric(14,2)). */
export const MAX_BASE_EUR = 1_000_000_000;
/** Units of a per-unit fee (0089 check). */
export const MAX_QUANTITY = 1_000_000;

function fail(message: string): never {
  throw new FeeValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A EUR amount as the canonical "1234.50" string, within [0, max]. */
export function parseEurAmount(value: unknown, field: string, max: number): string {
  if (typeof value !== "number" && typeof value !== "string") fail(`${field} must be an amount in EUR`);
  let cents: bigint;
  try {
    cents = eurToCents(value);
  } catch {
    fail(`${field} must be an amount in EUR with at most two decimals`);
  }
  if (cents > eurToCents(max)) fail(`${field} must be at most EUR ${max.toLocaleString("en-US")}`);
  return centsToDecimal(cents);
}

function optionalAmount(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parseEurAmount(value, field, MAX_FEE_EUR);
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") fail(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length < min) fail(min === 1 ? `${field} is required` : `${field} needs at least ${min} characters`);
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters`);
  if (CONTROL_RE.test(trimmed)) fail(`${field} contains control characters`);
  return trimmed;
}

/** The compare-and-swap token: the updated_at the editor last read. */
function revision(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || value.length > 64) {
    fail("expected_updated_at must be the revision you last loaded");
  }
  return value;
}

export function parseFeeId(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("id must be a UUID");
  return value.toLowerCase();
}

export type FeeDraftRow = {
  kind: FeeKind;
  payer: FeePayer;
  fixed_eur: string;
  rate_bps: number;
  min_eur: string | null;
  max_eur: string | null;
  collection: "invoice";
  public_label: string;
  public_note: string;
  effective_from: string | null;
};

/** One draft's fields (create or edit). */
export function parseFeeDraft(input: unknown): FeeDraftRow {
  if (!isPlainObject(input)) fail("fee must be an object");
  if (!isFeeKind(input.kind)) fail("Unknown fee kind");
  if (!isFeePayer(input.payer)) fail("Unknown payer");
  if (input.collection !== undefined && input.collection !== "invoice") fail("Fees are collected by invoice");
  const rate = input.rate_bps;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    fail("rate_bps must be an integer between 0 and 10000");
  }
  const fixed = parseEurAmount(input.fixed_eur ?? "0", "fixed_eur", MAX_FEE_EUR);
  const min = optionalAmount(input.min_eur, "min_eur");
  const max = optionalAmount(input.max_eur, "max_eur");
  if (min !== null && max !== null && eurToCents(min) > eurToCents(max)) fail("The minimum must not exceed the maximum");
  let effective: string | null = null;
  if (input.effective_from !== undefined && input.effective_from !== null && input.effective_from !== "") {
    const match = typeof input.effective_from === "string" ? DATE_RE.exec(input.effective_from) : null;
    const at = match ? new Date(`${input.effective_from as string}T00:00:00.000Z`) : null;
    // A real calendar date only (2026-02-30 is refused, not rolled over).
    if (!match || !at || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== input.effective_from) {
      fail("effective_from must be a date (YYYY-MM-DD) or empty");
    }
    effective = at.toISOString();
  }
  const draft: FeeDraftRow = {
    kind: input.kind,
    payer: input.payer,
    fixed_eur: fixed,
    rate_bps: rate,
    min_eur: min,
    max_eur: max,
    collection: "invoice",
    public_label: text(input.public_label, "public_label", 1, 120),
    public_note: text(input.public_note, "public_note", 0, 500),
    effective_from: effective,
  };
  // The quote must be computable (malformed terms fail here, never on a charge).
  try {
    quoteFee(draft, 0);
  } catch (error) {
    fail(error instanceof Error ? error.message : "The fee cannot be priced");
  }
  return draft;
}

/** fees.scheduleSave: { fee, id?, expected_updated_at } — create (id absent, token null) or edit a draft. */
export function parseFeeDraftSave(params: Record<string, unknown>): {
  id: string | null;
  draft: FeeDraftRow;
  expected_updated_at: string | null;
} {
  if (!("expected_updated_at" in params)) fail("expected_updated_at is required (null for a new draft)");
  const draft = parseFeeDraft(params.fee);
  if (params.id === undefined || params.id === null) {
    if (params.expected_updated_at !== null) fail("A new draft has no revision yet (expected_updated_at: null)");
    return { id: null, draft, expected_updated_at: null };
  }
  return { id: parseFeeId(params.id), draft, expected_updated_at: revision(params.expected_updated_at) };
}

/** fees.schedulePublish / scheduleRetire / scheduleDelete: { id, expected_updated_at }. */
export function parseFeeRevision(params: Record<string, unknown>): { id: string; expected_updated_at: string } {
  return { id: parseFeeId(params.id), expected_updated_at: revision(params.expected_updated_at) };
}

export type FeeChargeInput = {
  kind: FeeKind;
  ref_type: FeeRefType;
  ref_id: string;
  base_amount_eur: string;
  quantity: number;
  payer_client_id: string | null;
  issuer_pda: string | null;
  note: string;
};

function refId(refType: FeeRefType, value: unknown): string {
  if (typeof value !== "string") fail("ref_id is required");
  const trimmed = value.trim();
  if (refType === "conversion_request" || refType === "application") {
    if (!UUID_RE.test(trimmed)) fail(`ref_id must be the ${refType === "application" ? "application" : "conversion request"} id (a UUID)`);
    return trimmed.toLowerCase();
  }
  if (refType === "asset") {
    if (!BASE58_RE.test(trimmed)) fail("ref_id must be the asset address");
    return trimmed;
  }
  return text(trimmed, "ref_id", 1, 120);
}

/** fees.chargeCreate. */
export function parseFeeChargeCreate(params: Record<string, unknown>): FeeChargeInput {
  if (!isFeeKind(params.kind)) fail("Unknown fee kind");
  const kind = params.kind;
  const refType = params.ref_type;
  if (typeof refType !== "string" || !(FEE_REF_TYPES as readonly string[]).includes(refType)) fail("Unknown reference type");
  if (!FEE_KIND_REF_TYPES[kind].includes(refType as FeeRefType)) {
    fail(`A ${kind.replace(/_/g, " ")} fee is not billed against a ${refType.replace(/_/g, " ")}`);
  }
  const quantity = params.quantity === undefined ? 1 : params.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    fail(`quantity must be an integer between 1 and ${MAX_QUANTITY.toLocaleString("en-US")}`);
  }
  if (quantity !== 1 && !isPerUnitKind(kind)) fail("Only a per-unit fee takes a quantity");
  let payer: string | null = null;
  if (params.payer_client_id !== undefined && params.payer_client_id !== null && params.payer_client_id !== "") {
    if (refType === "conversion_request") fail("A conversion charge is billed to the requesting holder; no payer is sent");
    if (typeof params.payer_client_id !== "string" || !UUID_RE.test(params.payer_client_id)) fail("payer_client_id must be a client id");
    payer = params.payer_client_id.toLowerCase();
  }
  let issuer: string | null = null;
  if (params.issuer_pda !== undefined && params.issuer_pda !== null && params.issuer_pda !== "") {
    if (typeof params.issuer_pda !== "string" || !BASE58_RE.test(params.issuer_pda.trim())) fail("issuer_pda must be an issuer address");
    issuer = params.issuer_pda.trim();
  }
  return {
    kind,
    ref_type: refType as FeeRefType,
    ref_id: refId(refType as FeeRefType, params.ref_id),
    base_amount_eur: parseEurAmount(params.base_amount_eur ?? "0", "base_amount_eur", MAX_BASE_EUR),
    quantity,
    payer_client_id: payer,
    issuer_pda: issuer,
    note: text(params.note, "note", 0, 1000),
  };
}

export type FeeChargeUpdate =
  | { id: string; expected_updated_at: string; status: "invoiced"; invoice_ref: string }
  | { id: string; expected_updated_at: string; status: "paid" }
  | { id: string; expected_updated_at: string; status: "waived"; waived_reason: string };

/** fees.chargeUpdate: mark invoiced (with the invoice reference), paid, or waived (with a reason). */
export function parseFeeChargeUpdate(params: Record<string, unknown>): FeeChargeUpdate {
  const id = parseFeeId(params.id);
  const expected = revision(params.expected_updated_at);
  const status = params.status as FeeChargeStatus;
  if (status === "invoiced") {
    return { id, expected_updated_at: expected, status, invoice_ref: text(params.invoice_ref, "invoice_ref", 1, 120) };
  }
  if (status === "paid") return { id, expected_updated_at: expected, status };
  if (status === "waived") {
    return { id, expected_updated_at: expected, status, waived_reason: text(params.waived_reason, "waived_reason", 4, 500) };
  }
  fail("status must be invoiced, paid or waived");
}
