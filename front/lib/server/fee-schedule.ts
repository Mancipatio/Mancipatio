// SERVER-ONLY — the fee schedule and charges of migration 0089 (the model is
// lib/fees/schedule.ts, the price lib/fees/quote.ts).
//
// Every read and write is scoped to this deployment's network and goes
// through the service role; the browser roles have no grant on either table.
// The public side reads ONLY the published projection (PUBLIC_FEE_COLUMNS:
// no ids, no admin wallets, never a draft). Admin writes compare the row's
// updated_at (compare-and-swap, as lib/server/assistant-knowledge.ts), and
// the database guards of 0089 refuse whatever a route might get wrong:
// publishing outside publish_fee_schedule, editing a published price,
// charging an unpublished one, changing a charge's amount.
//
// Errors are SiwsError with a status: 400 bad input, 404 unknown reference,
// 409 a conflict the admin resolves by reloading, 503 the database is
// unavailable or 0089 is not applied. Database text is never echoed.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { SiwsError } from "@/lib/server/siws-error";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { centsToDecimal, formatEurCents, quoteFee, type FeeQuote } from "@/lib/fees/quote";
import {
  FEE_KIND_LABEL,
  PUBLIC_FEE_COLUMNS,
  SUGGESTED_FEE_DRAFTS,
  orderPublicFees,
  parsePublicFee,
  type FeeChargeRow,
  type FeeKind,
  type FeeScheduleRow,
  type PublicFee,
} from "@/lib/fees/schedule";
import {
  FeeValidationError,
  parseFeeChargeCreate,
  parseFeeChargeUpdate,
  parseFeeDraft,
  parseFeeDraftSave,
  parseFeeRevision,
  type FeeChargeUpdate,
} from "@/lib/fees/validate";

const SCHEDULE = "fee_schedule";
const CHARGES = "fee_charges";
const SCHEDULE_COLUMNS =
  `id,network,status,${PUBLIC_FEE_COLUMNS},published_at,published_by,retired_at,retired_by,created_by,updated_by,created_at,updated_at`;
const CHARGE_COLUMNS =
  "id,network,kind,schedule_id,payer_client_id,issuer_pda,ref_type,ref_id,base_amount_eur,quantity,amount_eur," +
  "status,invoice_ref,waived_reason,note,created_by,updated_by,invoiced_at,paid_at,waived_at,created_at,updated_at";
const TIMEOUT_MS = 5_000;
const SCHEDULE_LIST_LIMIT = 500;
const CHARGE_LIST_LIMIT = 500;
const MISSING_TABLE: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);
const MISSING_FUNCTION: ReadonlySet<string> = new Set(["PGRST202", "42883"]);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type DbError = { code?: string; message?: string } | null;

function unavailable(): never {
  throw new SiwsError(503, "The fee schedule is unavailable. Please try again shortly.");
}

function notInstalled(): never {
  throw new SiwsError(503, "The fee schedule is not installed on this database yet (migration 0089).");
}

/** A failed query: never echo the database's text, it can carry row data. */
function failed(where: string, error: DbError): never {
  if (MISSING_TABLE.has(error?.code ?? "")) notInstalled();
  console.error(`[fee-schedule] ${where} failed:`, error?.code ?? "unknown");
  unavailable();
}

function parse<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof FeeValidationError) throw new SiwsError(400, error.message);
    throw error;
  }
}

/** Runs one admin operation with a request budget; transport failures become 503. */
async function withDatabase<T>(run: (sb: SupabaseClient, network: Network, signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    return await run(getSupabaseAdmin(signal), detectNetwork(), signal);
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    console.error("[fee-schedule] request failed:", error instanceof Error ? error.name : "unknown");
    return unavailable();
  }
}

const amount = (value: unknown): number => Number(value);
const nullableAmount = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function scheduleRow(value: unknown): FeeScheduleRow {
  const row = value as FeeScheduleRow;
  return {
    ...row,
    fixed_eur: amount(row.fixed_eur),
    min_eur: nullableAmount(row.min_eur),
    max_eur: nullableAmount(row.max_eur),
  };
}

function chargeRow(value: unknown): FeeChargeRow {
  const row = value as FeeChargeRow;
  return {
    ...row,
    base_amount_eur: amount(row.base_amount_eur),
    amount_eur: amount(row.amount_eur),
    quantity: Number(row.quantity),
  };
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * The published fees of this deployment, in display order, one per kind.
 * An empty list is a real answer: nothing is published, or 0089 is not
 * applied yet (nothing can be published without its table). Every other
 * failure THROWS SiwsError(503), so /pricing says the schedule could not be
 * loaded instead of claiming there are no fees.
 */
export async function loadPublishedFees(): Promise<PublicFee[]> {
  let result: { data: unknown; error: DbError };
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    result = await getSupabaseAdmin(signal).from(SCHEDULE).select(PUBLIC_FEE_COLUMNS)
      .eq("network", detectNetwork()).eq("status", "published")
      .abortSignal(signal);
  } catch {
    return unavailable();
  }
  if (result.error) {
    if (MISSING_TABLE.has(result.error.code ?? "")) return [];
    console.error("[fee-schedule] published read failed:", result.error.code ?? "unknown");
    return unavailable();
  }
  if (!Array.isArray(result.data)) return unavailable();
  const fees = result.data.map(parsePublicFee);
  // A published row the projection cannot read is a fault, not a missing price.
  if (fees.some((fee) => fee === null)) {
    console.error("[fee-schedule] a published row failed the public projection");
    return unavailable();
  }
  return orderPublicFees(fees as PublicFee[]);
}

// ── Admin: schedule ─────────────────────────────────────────────────────────

/** Every schedule row (drafts, published, retired) and the latest charges of this network. */
export async function listFeeAdmin(): Promise<{ schedule: FeeScheduleRow[]; charges: FeeChargeRow[] }> {
  return withDatabase(async (sb, network, signal) => {
    const [schedule, charges] = await Promise.all([
      sb.from(SCHEDULE).select(SCHEDULE_COLUMNS).eq("network", network)
        .order("created_at", { ascending: false }).limit(SCHEDULE_LIST_LIMIT).abortSignal(signal),
      sb.from(CHARGES).select(CHARGE_COLUMNS).eq("network", network)
        .order("created_at", { ascending: false }).limit(CHARGE_LIST_LIMIT).abortSignal(signal),
    ]);
    if (schedule.error) failed("schedule list", schedule.error);
    if (charges.error) failed("charge list", charges.error);
    return {
      schedule: (schedule.data ?? []).map(scheduleRow),
      charges: (charges.data ?? []).map(chargeRow),
    };
  });
}

/** Create a draft (id absent, expected_updated_at null) or edit one (its last revision). */
export async function saveFeeDraft(params: Record<string, unknown>, wallet: string): Promise<FeeScheduleRow> {
  const { id, draft, expected_updated_at } = parse(() => parseFeeDraftSave(params));
  return withDatabase(async (sb, network, signal) => {
    const operation = id === null
      ? sb.from(SCHEDULE).insert({ ...draft, network, status: "draft", created_by: wallet, updated_by: wallet })
      : sb.from(SCHEDULE).update({ ...draft, updated_by: wallet })
        .eq("network", network).eq("id", id).eq("status", "draft").eq("updated_at", expected_updated_at);
    const { data, error } = await operation.select(SCHEDULE_COLUMNS).abortSignal(signal).maybeSingle();
    if (error?.code === "23514") throw new SiwsError(409, "Only a draft can be edited. Reload the fee schedule.");
    if (error) failed("draft save", error);
    if (!data) throw new SiwsError(409, "This fee changed, was published or was deleted. Reload it before saving.");
    return scheduleRow(data);
  });
}

/**
 * Publish a draft. publish_fee_schedule retires the price in force for the
 * same kind in the same transaction, and refuses (409) a future-dated draft
 * that would replace it. `replaced` is that row as read just before
 * (informational: the audit row and the admin's confirmation; publishing is
 * the Super Admin's alone, so no other publication races it in practice).
 */
export async function publishFee(
  params: Record<string, unknown>,
  wallet: string,
): Promise<{ published: FeeScheduleRow; replaced: FeeScheduleRow | null }> {
  const { id, expected_updated_at } = parse(() => parseFeeRevision(params));
  return withDatabase(async (sb, network, signal) => {
    const before = await sb.from(SCHEDULE).select(SCHEDULE_COLUMNS)
      .eq("network", network).eq("status", "published").abortSignal(signal);
    if (before.error) failed("published read", before.error);
    const { data, error } = await sb.rpc("publish_fee_schedule", {
      p_id: id,
      p_network: network,
      p_actor: wallet,
      p_expected_updated_at: expected_updated_at,
    }).abortSignal(signal);
    if (error) {
      if (error.code === "P0002") throw new SiwsError(404, "Fee not found");
      // A future-dated draft would retire the price in force before it applies.
      if (error.code === "MF001") {
        throw new SiwsError(
          409,
          "A replacement price takes effect when it is published. Publish it on its effective date, or clear the planned date to replace the current price now.",
        );
      }
      if (error.code === "P0001" || error.code === "23505" || error.code === "23514") {
        throw new SiwsError(409, "This fee changed or is no longer a draft. Reload it before publishing.");
      }
      if (MISSING_FUNCTION.has(error.code ?? "")) notInstalled();
      failed("publish", error);
    }
    const row = (Array.isArray(data) ? data[0] : data) as unknown;
    if (!row || typeof row !== "object") return unavailable();
    const published = scheduleRow(row);
    const previous = (before.data ?? []).map(scheduleRow)
      .find((fee) => fee.kind === published.kind && fee.id !== published.id) ?? null;
    return { published, replaced: previous };
  });
}

/** Retire the published price (the kind then has none in force until another is published). */
export async function retireFee(params: Record<string, unknown>, wallet: string): Promise<FeeScheduleRow> {
  const { id, expected_updated_at } = parse(() => parseFeeRevision(params));
  return withDatabase(async (sb, network, signal) => {
    const { data, error } = await sb.from(SCHEDULE)
      .update({ status: "retired", retired_by: wallet, updated_by: wallet })
      .eq("network", network).eq("id", id).eq("status", "published").eq("updated_at", expected_updated_at)
      .select(SCHEDULE_COLUMNS).abortSignal(signal).maybeSingle();
    if (error?.code === "23514") throw new SiwsError(409, "Only a published fee can be retired. Reload the fee schedule.");
    if (error) failed("retire", error);
    if (!data) throw new SiwsError(409, "This fee changed or is not published. Reload it before retiring.");
    return scheduleRow(data);
  });
}

/** Delete an unchanged draft. Published and retired rows are history and stay. */
export async function deleteFeeDraft(params: Record<string, unknown>): Promise<{ id: string; kind: FeeKind }> {
  const { id, expected_updated_at } = parse(() => parseFeeRevision(params));
  return withDatabase(async (sb, network, signal) => {
    const { data, error } = await sb.from(SCHEDULE).delete()
      .eq("network", network).eq("id", id).eq("status", "draft").eq("updated_at", expected_updated_at)
      .select("id,kind").abortSignal(signal).maybeSingle();
    if (error?.code === "23514") throw new SiwsError(409, "Only a draft can be deleted. Retire a published fee instead.");
    if (error) failed("draft delete", error);
    if (!data) throw new SiwsError(409, "Only an unchanged draft can be deleted. Reload it first.");
    return data as { id: string; kind: FeeKind };
  });
}

/**
 * The owner's suggested prices (SUGGESTED_FEE_DRAFTS) as DRAFTS, for the
 * kinds that have no draft and no published price yet: loading them twice,
 * or after a price was published, never duplicates or replaces anything.
 * Nothing is published.
 */
export async function createSuggestedDrafts(
  wallet: string,
): Promise<{ created: FeeScheduleRow[]; skipped: FeeKind[] }> {
  return withDatabase(async (sb, network, signal) => {
    const existing = await sb.from(SCHEDULE).select("kind")
      .eq("network", network).in("status", ["draft", "published"]).abortSignal(signal);
    if (existing.error) failed("schedule read", existing.error);
    const taken = new Set((existing.data ?? []).map((row) => (row as { kind: FeeKind }).kind));
    const skipped = SUGGESTED_FEE_DRAFTS.filter((fee) => taken.has(fee.kind)).map((fee) => fee.kind);
    const rows = SUGGESTED_FEE_DRAFTS.filter((fee) => !taken.has(fee.kind))
      .map((fee) => ({ ...parseFeeDraft(fee), network, status: "draft", created_by: wallet, updated_by: wallet }));
    if (rows.length === 0) return { created: [], skipped };
    const { data, error } = await sb.from(SCHEDULE).insert(rows).select(SCHEDULE_COLUMNS).abortSignal(signal);
    if (error) failed("suggested drafts", error);
    return { created: (data ?? []).map(scheduleRow), skipped };
  });
}

// ── Admin: charges ──────────────────────────────────────────────────────────

/**
 * Book a charge: priced now, by quoteFee, from the PUBLISHED price of its
 * kind (refused when there is none or it is not in effect yet), for a
 * reference that exists on this network. A conversion charge is billed to
 * the requesting holder's client (never a payer the admin names); an
 * application charge takes the application's linked issuer when none is
 * given. The database refuses a second open charge for the same kind and
 * reference (409), and any price that is not the published one.
 */
export async function createFeeCharge(
  params: Record<string, unknown>,
  wallet: string,
): Promise<{ charge: FeeChargeRow; quote: FeeQuote; schedule: FeeScheduleRow }> {
  const input = parse(() => parseFeeChargeCreate(params));
  return withDatabase(async (sb, network, signal) => {
    const priced = await sb.from(SCHEDULE).select(SCHEDULE_COLUMNS)
      .eq("network", network).eq("kind", input.kind).eq("status", "published")
      .abortSignal(signal).maybeSingle();
    if (priced.error) failed("published read", priced.error);
    if (!priced.data) {
      throw new SiwsError(409, `No ${FEE_KIND_LABEL[input.kind]} fee is published. Publish one before charging it.`);
    }
    const schedule = scheduleRow(priced.data);
    if (schedule.effective_from === null || Date.parse(schedule.effective_from) > Date.now()) {
      throw new SiwsError(409, `The published ${FEE_KIND_LABEL[input.kind]} fee is not in effect yet.`);
    }

    let payer = input.payer_client_id;
    let issuer = input.issuer_pda;
    if (input.ref_type === "conversion_request") {
      const request = await sb.from("conversion_requests").select("id,client_id,status")
        .eq("network", network).eq("id", input.ref_id).abortSignal(signal).maybeSingle();
      if (request.error) failed("conversion request read", request.error);
      if (!request.data) throw new SiwsError(404, "Conversion request not found");
      const row = request.data as { client_id: string | null; status: string };
      if (row.status === "cancelled" || row.status === "returned") {
        throw new SiwsError(409, `This conversion request did not go ahead (${row.status}); there is nothing to charge.`);
      }
      payer = row.client_id ?? null;
    } else if (input.ref_type === "application") {
      const application = await sb.from("launch_applications").select("id,status,linked_issuer")
        .eq("network", network).eq("id", input.ref_id).abortSignal(signal).maybeSingle();
      if (application.error) failed("application read", application.error);
      if (!application.data) throw new SiwsError(404, "Application not found");
      const row = application.data as { status: string; linked_issuer: string | null };
      if (row.status === "rejected") throw new SiwsError(409, "This application was rejected; there is nothing to charge.");
      if (issuer === null && typeof row.linked_issuer === "string" && BASE58_RE.test(row.linked_issuer)) issuer = row.linked_issuer;
    }
    if (payer !== null && input.ref_type !== "conversion_request") {
      const client = await sb.from("clients").select("id")
        .eq("network", network).eq("id", payer).abortSignal(signal).maybeSingle();
      if (client.error) failed("client read", client.error);
      if (!client.data) throw new SiwsError(400, "Unknown client");
    }

    let quote: FeeQuote;
    try {
      quote = quoteFee(schedule, input.base_amount_eur, input.quantity);
    } catch (error) {
      throw new SiwsError(400, error instanceof Error ? error.message : "The fee cannot be priced");
    }

    const { data, error } = await sb.from(CHARGES).insert({
      network,
      kind: input.kind,
      schedule_id: schedule.id,
      payer_client_id: payer,
      issuer_pda: issuer,
      ref_type: input.ref_type,
      ref_id: input.ref_id,
      base_amount_eur: input.base_amount_eur,
      quantity: input.quantity,
      amount_eur: centsToDecimal(quote.cents),
      status: "due",
      note: input.note,
      created_by: wallet,
      updated_by: wallet,
    }).select(CHARGE_COLUMNS).abortSignal(signal).maybeSingle();
    if (error?.code === "23505") {
      throw new SiwsError(409, "This reference already has an open charge of this kind. Waive it before charging again.");
    }
    if (error?.code === "23514") {
      throw new SiwsError(409, "The published fee changed while the charge was being created. Reload and try again.");
    }
    if (error?.code === "23503") throw new SiwsError(400, "Unknown client");
    if (error) failed("charge insert", error);
    if (!data) return unavailable();
    return { charge: chargeRow(data), quote, schedule };
  });
}

/** The statuses a charge may be in for each move (the database guard is the backstop). */
const MOVES_FROM: Record<FeeChargeUpdate["status"], readonly string[]> = {
  invoiced: ["due"],
  paid: ["invoiced"],
  waived: ["due", "invoiced"],
};

/** Mark a charge invoiced (with the invoice reference), paid, or waived (with a reason). */
export async function updateFeeCharge(
  params: Record<string, unknown>,
  wallet: string,
): Promise<{ charge: FeeChargeRow; update: FeeChargeUpdate }> {
  const update = parse(() => parseFeeChargeUpdate(params));
  return withDatabase(async (sb, network, signal) => {
    const patch: Record<string, unknown> = { status: update.status, updated_by: wallet };
    if (update.status === "invoiced") patch.invoice_ref = update.invoice_ref;
    if (update.status === "waived") patch.waived_reason = update.waived_reason;
    const { data, error } = await sb.from(CHARGES).update(patch)
      .eq("network", network).eq("id", update.id).in("status", [...MOVES_FROM[update.status]])
      .eq("updated_at", update.expected_updated_at)
      .select(CHARGE_COLUMNS).abortSignal(signal).maybeSingle();
    if (error?.code === "23514") throw new SiwsError(409, "This charge cannot move to that status. Reload it.");
    if (error) failed("charge update", error);
    if (!data) throw new SiwsError(409, "This charge changed since you loaded it, or cannot move to that status. Reload it.");
    return { charge: chargeRow(data), update };
  });
}

/** "EUR 150 (minimum)" — how a quote reads in an audit reason. */
export function quoteSummary(quote: FeeQuote): string {
  return `${formatEurCents(quote.cents)}${quote.basis === "formula" ? "" : ` (${quote.basis})`}`;
}

export type FeeAuditEvent =
  | "fee_schedule_save"
  | "fee_schedule_publish"
  | "fee_schedule_retire"
  | "fee_schedule_delete"
  | "fee_schedule_defaults"
  | "fee_charge_create"
  | "fee_charge_update";

/**
 * The server audit row of a fee write that succeeded (category "platform",
 * attributed to the verified signer). Best effort AFTER the write, as the
 * other admin configuration writes (admin-config/fx-rates,
 * spvs/record-issuance): the row is already written, so a failed audit
 * insert is logged, never answered as a failed write that would invite a
 * second submit.
 */
export async function auditFeeWrite(input: {
  event: FeeAuditEvent;
  wallet: string;
  via: "signature" | "session" | undefined;
  reason: string;
  target: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await writeServerAudit(getSupabaseAdmin(), {
      ix_name: input.event,
      category: "platform",
      actor_wallet: input.wallet,
      actor_source: actorSourceOf(input.via),
      reason: input.reason.slice(0, 1000),
      target_label: input.target,
      metadata: { network: detectNetwork(), ...input.metadata },
    });
  } catch {
    console.error(`[fee-schedule] audit row not written (${input.event})`);
  }
}
