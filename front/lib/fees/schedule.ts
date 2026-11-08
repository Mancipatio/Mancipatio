// The fee model of migration 0089, shared by the server routes, the admin
// console, the public /pricing page and the quote surfaces
// (components/fee-quote.tsx). Importable everywhere: no "use client", no
// "server-only", no I/O.
//
//   fee_schedule — the price list. One PUBLISHED row per kind and network is
//                  the price in force; drafts are private; retired rows are
//                  history. Nothing is charged until an admin publishes.
//   fee_charges  — what is billed: priced from the published row when the
//                  charge is created, collected by invoice (off-chain), due ->
//                  invoiced -> paid, or waived with a reason.
//
// 0004's fee_config / fee_waivers (lib/fees.ts) are a different thing: the
// internal register of per-engagement terms and per-client waivers. Neither
// is public, and neither prices a charge.

import { scopeEnabled, type ScopeName } from "@/lib/features";
import { detectNetwork, type Network } from "@/lib/network";

/** Display order everywhere (admin, /pricing). */
export const FEE_KINDS = [
  "tokenization_setup",
  "primary_sale",
  "conversion",
  "otc",
  "migration_setup",
  "migration_per_holder",
] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

export const FEE_PAYERS = ["issuer", "holder", "buyer", "seller"] as const;
export type FeePayer = (typeof FEE_PAYERS)[number];

export const FEE_SCHEDULE_STATUSES = ["draft", "published", "retired"] as const;
export type FeeScheduleStatus = (typeof FEE_SCHEDULE_STATUSES)[number];

export const FEE_CHARGE_STATUSES = ["due", "invoiced", "paid", "waived"] as const;
export type FeeChargeStatus = (typeof FEE_CHARGE_STATUSES)[number];

export const FEE_REF_TYPES = ["conversion_request", "application", "asset", "migration", "other"] as const;
export type FeeRefType = (typeof FEE_REF_TYPES)[number];

/** Collection method. Only invoicing exists in this version (0089 check). */
export type FeeCollection = "invoice";

export function isFeeKind(value: unknown): value is FeeKind {
  return typeof value === "string" && (FEE_KINDS as readonly string[]).includes(value);
}
export function isFeePayer(value: unknown): value is FeePayer {
  return typeof value === "string" && (FEE_PAYERS as readonly string[]).includes(value);
}

/** Admin-facing names of the kinds. */
export const FEE_KIND_LABEL: Record<FeeKind, string> = {
  tokenization_setup: "Tokenization setup",
  primary_sale: "Primary sale",
  conversion: "Conversion",
  otc: "OTC trade",
  migration_setup: "Migration setup",
  migration_per_holder: "Migration per holder",
};

export const FEE_PAYER_LABEL: Record<FeePayer, string> = {
  issuer: "Issuer",
  holder: "Holder",
  buyer: "Buyer",
  seller: "Seller",
};

/** The payer a new draft starts with (the admin may change it). */
export const FEE_KIND_DEFAULT_PAYER: Record<FeeKind, FeePayer> = {
  tokenization_setup: "issuer",
  primary_sale: "issuer",
  conversion: "holder",
  otc: "seller",
  migration_setup: "issuer",
  migration_per_holder: "issuer",
};

/**
 * When Manci issues the invoice, per kind: the "When it is invoiced" column
 * of /pricing and the quote surfaces. A statement about process, so it is
 * fixed copy (reviewed with the rest of the public text), not admin input;
 * the row's public_note carries anything specific to one price.
 */
export const FEE_KIND_INVOICED_WHEN: Record<FeeKind, string> = {
  tokenization_setup: "When the application is approved",
  primary_sale: "When the sale closes",
  conversion: "When the conversion request is approved",
  otc: "When the trade settles",
  migration_setup: "When the migration campaign is agreed",
  migration_per_holder: "After delivery, for each holder wallet that received units",
};

/** What the rate is a percentage of (lib/fees/quote.ts describeFee). */
export const FEE_KIND_BASE: Record<FeeKind, string> = {
  tokenization_setup: "the issuance value",
  primary_sale: "the amount raised",
  conversion: "the conversion value",
  otc: "the trade value",
  migration_setup: "the migrated value",
  migration_per_holder: "the delivered value",
};

/**
 * The unit a per-unit fee counts. Only such a fee multiplies its fixed part
 * by a quantity (0089: quantity = 1 unless the kind is per unit).
 */
export const FEE_KIND_UNIT: Record<FeeKind, string | null> = {
  tokenization_setup: null,
  primary_sale: null,
  conversion: null,
  otc: null,
  migration_setup: null,
  migration_per_holder: "delivered holder wallet",
};

export function isPerUnitKind(kind: FeeKind): boolean {
  return FEE_KIND_UNIT[kind] !== null;
}

/**
 * The service each fee belongs to (lib/features.ts scopeEnabled). A fee whose
 * service is not offered on this build is still listed on /pricing, labelled
 * "where offered", so a published price never reads as a service the Terms
 * or the switches do not offer. Token migration has no module yet: until it
 * has one, its fees always read "where offered".
 */
export const FEE_KIND_SCOPE: Record<FeeKind, ScopeName | null> = {
  tokenization_setup: "issuance",
  primary_sale: "primarySales",
  conversion: "custodyConversion",
  otc: "secondaryTrading",
  migration_setup: null,
  migration_per_holder: null,
};

export function feeServiceOffered(kind: FeeKind, network: Network = detectNetwork()): boolean {
  const scope = FEE_KIND_SCOPE[kind];
  return scope !== null && scopeEnabled(scope, network);
}

/** Which references a charge of each kind is billed against (0089 check). */
export const FEE_KIND_REF_TYPES: Record<FeeKind, readonly FeeRefType[]> = {
  tokenization_setup: ["application", "asset", "other"],
  primary_sale: ["application", "asset", "other"],
  conversion: ["conversion_request", "other"],
  otc: ["asset", "other"],
  migration_setup: ["migration", "other"],
  migration_per_holder: ["migration", "other"],
};

export const FEE_REF_TYPE_LABEL: Record<FeeRefType, string> = {
  conversion_request: "Conversion request",
  application: "Application",
  asset: "Asset",
  migration: "Migration",
  other: "Other reference",
};

export const FEE_CHARGE_STATUS_LABEL: Record<FeeChargeStatus, string> = {
  due: "Due",
  invoiced: "Invoiced",
  paid: "Paid",
  waived: "Waived",
};

/** The priced fields of a fee (what lib/fees/quote.ts needs). */
export type FeeTerms = {
  kind: FeeKind;
  /** numeric(12,2); PostgREST answers a number, a string is accepted too. */
  fixed_eur: number | string;
  rate_bps: number;
  min_eur: number | string | null;
  max_eur: number | string | null;
};

/** The public projection of a published row (GET /api/fees/public, /pricing). */
export type PublicFee = FeeTerms & {
  payer: FeePayer;
  collection: FeeCollection;
  public_label: string;
  public_note: string;
  /** ISO timestamp; may be in the future (an announced price). */
  effective_from: string;
};

/** Columns of the public projection: no ids, no admin wallets, no drafts. */
export const PUBLIC_FEE_COLUMNS =
  "kind,payer,fixed_eur,rate_bps,min_eur,max_eur,collection,public_label,public_note,effective_from";

/** A fee_schedule row as the admin console sees it. */
export type FeeScheduleRow = Omit<PublicFee, "effective_from"> & {
  id: string;
  network: string;
  status: FeeScheduleStatus;
  /** Null on a draft without a planned date. */
  effective_from: string | null;
  published_at: string | null;
  published_by: string | null;
  retired_at: string | null;
  retired_by: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FeeChargeRow = {
  id: string;
  network: string;
  kind: FeeKind;
  schedule_id: string;
  payer_client_id: string | null;
  issuer_pda: string | null;
  ref_type: FeeRefType;
  ref_id: string;
  base_amount_eur: number;
  quantity: number;
  amount_eur: number;
  status: FeeChargeStatus;
  invoice_ref: string | null;
  waived_reason: string | null;
  note: string;
  created_by: string;
  updated_by: string | null;
  invoiced_at: string | null;
  paid_at: string | null;
  waived_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A draft as the editor sends it (lib/fees/validate.ts narrows it). */
export type FeeDraftInput = {
  kind: FeeKind;
  payer: FeePayer;
  fixed_eur: string;
  rate_bps: number;
  min_eur: string | null;
  max_eur: string | null;
  public_label: string;
  public_note: string;
  /** YYYY-MM-DD (UTC) or null: publication then sets it to the moment it is published. */
  effective_from: string | null;
};

/**
 * The owner's suggested prices (2026-11-08). "Load suggested defaults" on
 * /admin/fees creates them as DRAFTS for the kinds that have no draft or
 * published row yet; nothing here is ever published or charged on its own.
 * Primary sale and OTC have no suggestion. The holder's token swap in a
 * migration is free, so it has no row at all.
 */
export const SUGGESTED_FEE_DRAFTS: readonly FeeDraftInput[] = [
  {
    kind: "tokenization_setup",
    payer: "issuer",
    fixed_eur: "2500.00",
    rate_bps: 0,
    min_eur: null,
    max_eur: null,
    public_label: "Tokenization setup",
    public_note:
      "One-off, per issuance. Legal drafting, SPV incorporation, notary and business-register costs are passed through at cost.",
    effective_from: null,
  },
  {
    kind: "conversion",
    payer: "holder",
    fixed_eur: "0.00",
    rate_bps: 100,
    min_eur: "150.00",
    max_eur: null,
    public_label: "Conversion into registered ownership",
    public_note: "Notary and business-register costs are passed through at cost.",
    effective_from: null,
  },
  {
    kind: "migration_setup",
    payer: "issuer",
    fixed_eur: "5000.00",
    rate_bps: 0,
    min_eur: null,
    max_eur: null,
    public_label: "Token migration setup",
    public_note: "Per migration campaign.",
    effective_from: null,
  },
  {
    kind: "migration_per_holder",
    payer: "issuer",
    fixed_eur: "2.00",
    rate_bps: 0,
    min_eur: null,
    max_eur: null,
    public_label: "Token migration delivery",
    public_note: "Holders swap their tokens free of charge.",
    effective_from: null,
  },
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
function isAmount(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" && /^\d{1,12}(\.\d{1,2})?$/.test(value));
}

/**
 * Narrows one row of the public answer. Null for anything malformed, so a
 * quote surface shows no price rather than a wrong one.
 */
export function parsePublicFee(value: unknown): PublicFee | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isFeeKind(row.kind) || !isFeePayer(row.payer) || row.collection !== "invoice") return null;
  if (!isAmount(row.fixed_eur) || !Number.isInteger(row.rate_bps) || (row.rate_bps as number) < 0 || (row.rate_bps as number) > 10_000) return null;
  if (row.min_eur !== null && !isAmount(row.min_eur)) return null;
  if (row.max_eur !== null && !isAmount(row.max_eur)) return null;
  if (typeof row.public_label !== "string" || !row.public_label.trim()) return null;
  if (typeof row.public_note !== "string") return null;
  if (typeof row.effective_from !== "string" || !ISO_RE.test(row.effective_from) || Number.isNaN(Date.parse(row.effective_from))) return null;
  return {
    kind: row.kind,
    payer: row.payer,
    fixed_eur: row.fixed_eur,
    rate_bps: row.rate_bps as number,
    min_eur: row.min_eur as number | string | null,
    max_eur: row.max_eur as number | string | null,
    collection: "invoice",
    public_label: row.public_label,
    public_note: row.public_note,
    effective_from: row.effective_from,
  };
}

/** The published fees in display order, one per kind (the first wins). */
export function orderPublicFees(fees: readonly PublicFee[]): PublicFee[] {
  const byKind = new Map<FeeKind, PublicFee>();
  for (const fee of fees) if (!byKind.has(fee.kind)) byKind.set(fee.kind, fee);
  return FEE_KINDS.flatMap((kind) => (byKind.has(kind) ? [byKind.get(kind)!] : []));
}
