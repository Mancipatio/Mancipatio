// SERVER-ONLY — the cap table behind /api/cap-table/*: the chain side
// (lib/server/cap-table-chain.ts) next to the platform's rows of this
// network (conversion_requests, 0034; register_entries, 0086), reconciled by
// lib/cap-table.ts, plus the register writes and the CSV export.
//
// Each audience gets only its own columns, chosen in the SELECT itself and
// again when the rows are mapped (a column that is not read cannot leak):
//   admin   everything, including the dossier link of entries and requests,
//           staff notes and void reasons
//   issuer  wallets, units and decision references: no dossier link, staff
//           note, void reason, staff wallet or voided entry
//   public  aggregates, the non-personal columns of recorded entries and the
//           status, vault, units and realize signature of conversion
//           requests: no case number, request id, wallet or person
// The share of the company one unit is comes from the asset profile's
// tokenize figures (readUnitShareFigures): a draft's for the admin and the
// issuer, a published profile's only for the public; only the derived share
// of one unit leaves the server, never `fields`. Every row read is scoped to
// detectNetwork(). Every read fails closed (503).

import "server-only";

import { address } from "@solana/kit";
import { detectNetwork } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { readArchivedIssuers } from "@/lib/server/archive";
import { readAssetChain, readEntryShareClass } from "@/lib/server/cap-table-chain";
import { companyFiguresFrom } from "@/lib/distribution-rows";
import { isPublishedProfileRow, PUBLIC_TOKENIZE_SELECT } from "@/lib/profile-public";
import { CLASS_INDEX } from "@/lib/tokenize-shares";
import {
  capTableCsv,
  capTableCsvFilename,
  issuerReconciliation,
  publicSupplyClass,
  reconcileAsset,
  registerEntryView,
  type AssetIdentity,
  type AssetReconciliation,
  type ConversionFacts,
  type ConversionStatusRead,
  type PublicSupply,
  type RegisterEntryFacts,
  type RegisterEntryView,
  type UnitShareFigures,
} from "@/lib/cap-table";
import {
  parseRegisterEntryInput,
  parseRegisterVoidInput,
  RegisterEntryInputError,
  U64_MAX,
} from "@/lib/register-entries";

export type CapTableAudience = "admin" | "issuer";
type Row = Record<string, unknown>;

const PAGE = 1000;
const OPEN_STATUSES: ConversionStatusRead[] = ["vault_opened", "deposited"];
const READ_STATUSES: ConversionStatusRead[] = [...OPEN_STATUSES, "converted"];

/** PostgREST casts (`::text`) keep numeric columns exact past 2^53. */
const CONVERSION_COLUMNS: Record<CapTableAudience, string> = {
  admin: "id,status,share_class_pda,holder_wallet,client_id,amount::text,vault_pda,outcome_tx,outcome_evidence,decided_at",
  issuer: "id,status,share_class_pda,holder_wallet,amount::text,vault_pda,outcome_tx,outcome_evidence,decided_at",
};
/** Units and the realize signature are public on chain; no id, wallet, dossier or contact. */
const PUBLIC_CONVERSION_COLUMNS = "status,share_class_pda,vault_pda,amount::text,outcome_tx";
/** What the share of one unit is derived from: the tokenize object only, never the rest of `fields`. */
const PROFILE_FIGURES_COLUMNS = `is_published,status,${PUBLIC_TOKENIZE_SELECT}`;
const ENTRY_COLUMNS: Record<CapTableAudience | "public", string> = {
  admin: "id,share_class_pda,units::text,percent_bps::text,registry,decision_ref,decision_date,decision_doc_sha256," +
    "conversion_request_id,realize_tx,holder_client_id,note,status,void_reason,voided_by,voided_at,created_by,created_at",
  issuer: "id,share_class_pda,units::text,percent_bps::text,registry,decision_ref,decision_date,decision_doc_sha256," +
    "conversion_request_id,realize_tx,status,created_at",
  public: "share_class_pda,units::text,percent_bps::text,registry,decision_date,decision_doc_sha256,realize_tx,status",
};

function recordsUnavailable(): never {
  throw new SiwsError(503, "Cap table records unavailable — try again");
}

/** The asset address of a request (400 unless it is a valid address). */
export function assetPdaParam(value: unknown, name = "asset_pda"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) throw new SiwsError(400, `${name} is required`);
  try {
    return address(value).toString();
  } catch {
    throw new SiwsError(400, `${name} is not a valid address`);
  }
}

// ── Row mapping (fails closed on anything unexpected) ─────────────────────

function units(value: unknown): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,20}$/.test(text) || BigInt(text) > U64_MAX) recordsUnavailable();
  return BigInt(text);
}
const str = (value: unknown): string => (typeof value === "string" ? value : recordsUnavailable());
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : str(value));

/** The proven burn of a converted request (lib/server/custody-evidence.ts stores amountAtomic). */
function provenBurn(evidence: unknown): bigint | null {
  const amount = evidence && typeof evidence === "object" ? (evidence as { amountAtomic?: unknown }).amountAtomic : undefined;
  return typeof amount === "string" && /^\d{1,20}$/.test(amount) ? BigInt(amount) : null;
}

function conversionFacts(row: Row, audience: CapTableAudience): ConversionFacts {
  const status = str(row.status) as ConversionStatusRead;
  if (!READ_STATUSES.includes(status)) recordsUnavailable();
  return {
    id: str(row.id),
    shareClassPda: str(row.share_class_pda),
    status,
    units: units(row.amount),
    burned: status === "converted" ? provenBurn(row.outcome_evidence) : null,
    realizeTx: status === "converted" ? strOrNull(row.outcome_tx) : null,
    vaultPda: strOrNull(row.vault_pda),
    holderWallet: str(row.holder_wallet),
    decidedAt: strOrNull(row.decided_at),
    ...(audience === "admin" ? { clientId: strOrNull(row.client_id) } : {}),
  };
}

function entryFacts(row: Row, audience: CapTableAudience): RegisterEntryFacts {
  const status = str(row.status);
  if (status !== "recorded" && status !== "voided") recordsUnavailable();
  const facts: RegisterEntryFacts = {
    id: str(row.id),
    shareClassPda: str(row.share_class_pda),
    units: units(row.units),
    percentBps: typeof row.percent_bps === "number" ? String(row.percent_bps) : str(row.percent_bps),
    registry: str(row.registry),
    decisionRef: str(row.decision_ref),
    decisionDate: str(row.decision_date),
    decisionDocSha256: str(row.decision_doc_sha256),
    conversionRequestId: strOrNull(row.conversion_request_id),
    realizeTx: strOrNull(row.realize_tx),
    status,
    createdAt: strOrNull(row.created_at) ?? undefined,
  };
  if (audience === "admin") {
    facts.holderClientId = strOrNull(row.holder_client_id);
    facts.note = typeof row.note === "string" ? row.note : "";
    facts.voidReason = strOrNull(row.void_reason);
    facts.voidedBy = strOrNull(row.voided_by);
    facts.voidedAt = strOrNull(row.voided_at);
    facts.createdBy = strOrNull(row.created_by) ?? "";
  }
  return facts;
}

type Paged = { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }> };

/** Every page of a network-scoped read (PostgREST caps one answer at 1000 rows). */
async function allRows(build: () => Paged): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let result;
    try {
      result = await build().range(offset, offset + PAGE - 1);
    } catch {
      return recordsUnavailable();
    }
    if (result.error || !Array.isArray(result.data)) {
      console.error("[cap-table] records read failed:", (result.error as { code?: string } | null)?.code ?? "unexpected answer");
      return recordsUnavailable();
    }
    out.push(...(result.data as Row[]));
    if (result.data.length < PAGE) return out;
  }
}

async function readConversions(network: string, classPdas: string[], audience: CapTableAudience): Promise<ConversionFacts[]> {
  const sb = getSupabaseAdmin();
  const rows = await allRows(() => sb.from("conversion_requests").select(CONVERSION_COLUMNS[audience])
    .eq("network", network).in("share_class_pda", classPdas).in("status", READ_STATUSES)
    .order("created_at", { ascending: true }).order("id", { ascending: true }) as unknown as Paged);
  return rows.map((row) => conversionFacts(row, audience));
}

async function readEntries(network: string, classPdas: string[], audience: CapTableAudience): Promise<RegisterEntryFacts[]> {
  const sb = getSupabaseAdmin();
  const rows = await allRows(() => {
    let query = sb.from("register_entries").select(ENTRY_COLUMNS[audience])
      .eq("network", network).in("share_class_pda", classPdas);
    // The issuer never sees a voided entry (its void reason is staff text).
    if (audience === "issuer") query = query.eq("status", "recorded");
    return query.order("created_at", { ascending: true }).order("id", { ascending: true }) as unknown as Paged;
  });
  return rows.map((row) => entryFacts(row, audience));
}

/**
 * The asset's tokenize figures (asset_profiles.fields->tokenize, through
 * lib/distribution-rows companyFiguresFrom: consistent with each other, or
 * none), for the class the tokenize flow creates (lib/tokenize-shares
 * CLASS_INDEX). Read only to derive the share of the company one unit is;
 * nothing else of the profile leaves this function. The public read takes
 * them only the way the public profile reader does (/api/profiles/public): a
 * published profile, re-checked after the SELECT (isPublishedProfileRow), of
 * an issuer that is not archived. The admin and issuer reads (signed) take a
 * draft profile's figures too. Either way lib/cap-table.ts unitShareOf
 * applies them only to a class they match. A failed read is a 503.
 */
async function readUnitShareFigures(
  network: string,
  identity: AssetIdentity,
  audience: CapTableAudience | "public",
): Promise<UnitShareFigures | null> {
  const sb = getSupabaseAdmin();
  let query = sb.from("asset_profiles").select(PROFILE_FIGURES_COLUMNS)
    .eq("network", network).eq("asset_pda", identity.asset_pda);
  if (audience === "public") query = query.eq("is_published", true).eq("status", "published");
  let result;
  try {
    result = await query.maybeSingle();
  } catch {
    return recordsUnavailable();
  }
  if (result.error) {
    console.error("[cap-table] profile read failed:", (result.error as { code?: string }).code ?? "unexpected answer");
    return recordsUnavailable();
  }
  const row = result.data as Row | null;
  if (!row || (audience === "public" && !isPublishedProfileRow(row))) return null;
  const figures = companyFiguresFrom(row.tokenize);
  if (!figures) return null;
  // An archived issuer's assets leave the public lists (lib/archive.ts), and their figures with them.
  if (audience === "public" && (await readArchivedIssuers(sb)).has(identity.issuer_pda)) return null;
  return { classIndex: CLASS_INDEX, tokens: figures.tokens, tokenE4: figures.tokenE4 };
}

/** The reconciliation of one asset, for the admin or (stripped) for its issuer. */
export async function readAssetReconciliation(assetPda: string, audience: CapTableAudience): Promise<AssetReconciliation> {
  const network = detectNetwork();
  const chain = await readAssetChain(assetPda, { holders: true });
  const classPdas = chain.classes.map((c) => c.shareClassPda);
  const [conversions, entries, figures] = classPdas.length
    ? await Promise.all([
        readConversions(network, classPdas, audience),
        readEntries(network, classPdas, audience),
        readUnitShareFigures(network, chain.identity, audience),
      ])
    : [[], [], null];
  const table = reconcileAsset(chain.identity, network, chain.classes, conversions, entries, figures);
  return audience === "issuer" ? issuerReconciliation(table) : table;
}

/**
 * The public "Supply and conversions" figures of one asset: chain supply,
 * the units in open conversion escrows (their vaults only), the conversions
 * realized on chain (units and realize signature only), the non-personal
 * columns of recorded register entries, and the share of one unit from a
 * published profile's tokenize figures (else units only).
 */
export async function readPublicSupply(assetPda: string): Promise<PublicSupply> {
  const network = detectNetwork();
  const chain = await readAssetChain(assetPda, { holders: false });
  const classPdas = chain.classes.map((c) => c.shareClassPda);
  const sb = getSupabaseAdmin();
  const [conversions, recorded, figures] = classPdas.length
    ? await Promise.all([
        allRows(() => sb.from("conversion_requests").select(PUBLIC_CONVERSION_COLUMNS)
          .eq("network", network).in("share_class_pda", classPdas).in("status", READ_STATUSES)
          .order("created_at", { ascending: true }).order("id", { ascending: true }) as unknown as Paged),
        allRows(() => sb.from("register_entries").select(ENTRY_COLUMNS.public)
          .eq("network", network).in("share_class_pda", classPdas).eq("status", "recorded")
          .order("decision_date", { ascending: true }).order("id", { ascending: true }) as unknown as Paged),
        readUnitShareFigures(network, chain.identity, "public"),
      ])
    : [[], [], null];
  return {
    network,
    asset_pda: chain.identity.asset_pda,
    generated_at: new Date().toISOString(),
    classes: chain.classes.map((c) => publicSupplyClass(
      c,
      conversions.filter((r) => r.share_class_pda === c.shareClassPda).map((r) => {
        const status = str(r.status) as ConversionStatusRead;
        if (!READ_STATUSES.includes(status)) recordsUnavailable();
        return {
          status,
          vaultPda: strOrNull(r.vault_pda),
          units: units(r.amount),
          realizeTx: status === "converted" ? strOrNull(r.outcome_tx) : null,
        };
      }),
      recorded.filter((r) => r.share_class_pda === c.shareClassPda && r.status === "recorded").map((r) => ({
        units: units(r.units),
        percentBps: typeof r.percent_bps === "number" ? String(r.percent_bps) : str(r.percent_bps),
        registry: str(r.registry),
        decisionDate: str(r.decision_date),
        decisionDocSha256: str(r.decision_doc_sha256),
        realizeTx: strOrNull(r.realize_tx),
        status: "recorded" as const,
      })),
      figures,
    )),
  };
}

// ── Register writes ────────────────────────────────────────────────────────

function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof RegisterEntryInputError) throw new SiwsError(400, err.message);
    throw err;
  }
}

/** A database refusal of a register write: the guard's or a constraint's (23514) is a 409. */
function writeRefused(error: { code?: string; message?: string }, conflict: string): never {
  if (error.code === "23505") throw new SiwsError(409, conflict);
  if (error.code === "23514") throw new SiwsError(409, `The register refused this change: ${error.message ?? "check failed"}`);
  console.error("[cap-table] register write failed:", error.code ?? "unknown");
  throw new SiwsError(503, "The register is unavailable — try again");
}

/** A best-effort audit row: the entry itself carries who recorded or voided it and when. */
async function auditRegister(input: Parameters<typeof writeServerAudit>[1]): Promise<void> {
  try {
    await writeServerAudit(getSupabaseAdmin(), input);
  } catch (err) {
    console.warn("[cap-table] register audit row not written:", err instanceof Error ? err.message : String(err));
  }
}

function adminEntryView(row: Row): RegisterEntryView {
  return registerEntryView(entryFacts(row, "admin"));
}

/**
 * Record a register entry (admin). The asset comes from the chain; a linked
 * conversion request must be this network's, of the same class and
 * converted, and gives the realize signature and the holder's dossier when
 * the admin leaves them out. The database guard re-checks the link.
 */
export async function recordRegisterEntry(
  params: Record<string, unknown>,
  wallet: string,
  via: "signature" | "session" | undefined,
): Promise<RegisterEntryView> {
  const input = parsed(() => parseRegisterEntryInput(params));
  const network = detectNetwork();
  const shareClass = await readEntryShareClass(input.share_class_pda);
  if (shareClass.maxSupply !== null && BigInt(input.units) > shareClass.maxSupply) {
    throw new SiwsError(400, "units exceed the class's max supply (the class cap in units)");
  }
  const sb = getSupabaseAdmin();
  let realizeTx = input.realize_tx;
  let holder = input.holder_client_id;
  if (input.conversion_request_id) {
    const { data: request, error } = await sb.from("conversion_requests")
      .select("id,status,share_class_pda,outcome_tx,client_id")
      .eq("id", input.conversion_request_id).eq("network", network).maybeSingle();
    if (error) recordsUnavailable();
    if (!request) throw new SiwsError(404, "Conversion request not found");
    if (request.share_class_pda !== input.share_class_pda) {
      throw new SiwsError(409, "The conversion request belongs to another share class");
    }
    if (request.status !== "converted") {
      throw new SiwsError(409, "Only a converted request can be registered: confirm the conversion (the realize) first");
    }
    const outcome = typeof request.outcome_tx === "string" ? request.outcome_tx : null;
    if (realizeTx && outcome && realizeTx !== outcome) {
      throw new SiwsError(409, "realize_tx differs from the conversion's realize transaction");
    }
    realizeTx = outcome ?? realizeTx;
    holder = holder ?? (typeof request.client_id === "string" ? request.client_id : null);
  }
  if (holder) {
    const { data: client, error } = await sb.from("clients").select("id").eq("id", holder).eq("network", network).maybeSingle();
    if (error) recordsUnavailable();
    if (!client) throw new SiwsError(400, "holder_client_id is not a client on this network");
  }
  const { data, error } = await sb.from("register_entries").insert({
    network,
    share_class_pda: input.share_class_pda,
    asset_pda: shareClass.assetPda,
    units: input.units,
    percent_bps: input.percent_bps,
    registry: input.registry,
    decision_ref: input.decision_ref,
    decision_date: input.decision_date,
    decision_doc_sha256: input.decision_doc_sha256,
    conversion_request_id: input.conversion_request_id,
    realize_tx: realizeTx,
    holder_client_id: holder,
    note: input.note,
    status: "recorded",
    created_by: wallet,
  }).select(ENTRY_COLUMNS.admin).maybeSingle();
  if (error) writeRefused(error, "This conversion already has a recorded register entry; void it before recording a corrected one");
  if (!data) recordsUnavailable();
  const entry = adminEntryView(data as unknown as Row);
  await auditRegister({
    ix_name: "register_entry_record",
    category: "custody",
    actor_wallet: wallet,
    actor_source: actorSourceOf(via),
    reason: `Recorded a register entry: ${input.units} units (${entry.percent} %), ${input.registry} ${input.decision_ref}`,
    target_label: input.share_class_pda,
    tx_signature: realizeTx,
    metadata: {
      register_entry_id: entry.id,
      asset_pda: shareClass.assetPda,
      units: input.units,
      percent_bps: input.percent_bps,
      decision_date: input.decision_date,
      decision_doc_sha256: input.decision_doc_sha256,
      conversion_request_id: input.conversion_request_id,
    },
  });
  return entry;
}

/** Void a recorded entry (admin): terminal, with a reason; a correction is a new entry. */
export async function voidRegisterEntry(
  params: Record<string, unknown>,
  wallet: string,
  via: "signature" | "session" | undefined,
): Promise<RegisterEntryView> {
  const { id, reason } = parsed(() => parseRegisterVoidInput(params));
  const network = detectNetwork();
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("register_entries")
    .update({ status: "voided", void_reason: reason, voided_by: wallet, voided_at: new Date().toISOString() })
    .eq("id", id).eq("network", network).eq("status", "recorded")
    .select(ENTRY_COLUMNS.admin).maybeSingle();
  if (error) writeRefused(error, "The entry changed meanwhile; reload it");
  if (!data) {
    const { data: existing, error: readError } = await sb.from("register_entries").select("id,status")
      .eq("id", id).eq("network", network).maybeSingle();
    if (readError) recordsUnavailable();
    if (!existing) throw new SiwsError(404, "Register entry not found");
    throw new SiwsError(409, "The register entry is already voided");
  }
  const row = data as unknown as Row;
  const entry = adminEntryView(row);
  await auditRegister({
    ix_name: "register_entry_void",
    category: "custody",
    actor_wallet: wallet,
    actor_source: actorSourceOf(via),
    reason: `Voided a register entry: ${reason}`,
    target_label: typeof row.share_class_pda === "string" ? row.share_class_pda : null,
    metadata: { register_entry_id: entry.id, units: entry.units, decision_date: entry.decision_date },
  });
  return entry;
}

// ── CSV export ─────────────────────────────────────────────────────────────

export type CapTableExport = { filename: string; csv: string; personal_data: boolean };

/** Holder names by client id (company name, else display name), this network only. */
async function holderNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await allRows(() => getSupabaseAdmin().from("clients").select("id,display_name,company_name")
    .eq("network", detectNetwork()).in("id", ids).order("id", { ascending: true }) as unknown as Paged);
  for (const row of rows) {
    const company = typeof row.company_name === "string" ? row.company_name.trim() : "";
    const display = typeof row.display_name === "string" ? row.display_name.trim() : "";
    if (typeof row.id === "string") names.set(row.id, company || display);
  }
  return names;
}

/**
 * The reconciliation as CSV (admin). Without `personal_data: true` it holds
 * no personal data. Like /api/clients/export, the access is logged BEFORE
 * anything is returned and a failed log write returns nothing (503): the
 * personal-data variant writes one "kyc" row per dossier it names (each
 * dossier's own access log, read by the GDPR export), the plain variant one
 * "share-class" row.
 */
export async function exportCapTable(
  params: Record<string, unknown>,
  wallet: string,
  via: "signature" | "session" | undefined,
): Promise<CapTableExport> {
  const assetPda = assetPdaParam(params.asset_pda);
  if (params.personal_data !== undefined && typeof params.personal_data !== "boolean") {
    throw new SiwsError(400, "personal_data must be true or false");
  }
  const personal = params.personal_data === true;
  const table = await readAssetReconciliation(assetPda, "admin");
  const clientIds = personal
    ? [...new Set(table.classes.flatMap((c) => [
        ...c.entries.map((e) => e.holder_client_id),
        ...c.conversions.map((v) => v.client_id),
      ]).filter((id): id is string => typeof id === "string"))].sort()
    : [];
  const names = personal ? await holderNames(clientIds) : null;
  const csv = capTableCsv(table, names ? { names } : null);
  const filename = capTableCsvFilename(table, personal);
  const sb = getSupabaseAdmin();
  const metadata = {
    asset_pda: assetPda,
    classes: table.classes.length,
    entries: table.classes.reduce((n, c) => n + c.entries.length, 0),
    personal_data: personal,
    actor_wallet: wallet,
  };
  if (personal) {
    // Logged before anything leaves the server; a failed write throws 503.
    for (const target of clientIds.length ? clientIds : [assetPda]) {
      await writeServerAudit(sb, {
        ix_name: "cap_table_export_personal_data",
        category: "kyc",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: "Exported the cap table of an asset with holder names",
        target_label: target,
        metadata: { ...metadata, clients: clientIds.length },
      });
    }
  } else {
    await writeServerAudit(sb, {
      ix_name: "cap_table_export",
      category: "share-class",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: "Exported the cap table of an asset (no personal data)",
      target_label: assetPda,
      metadata,
    });
  }
  return { filename, csv, personal_data: personal };
}
