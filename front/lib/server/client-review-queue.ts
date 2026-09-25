// SERVER-ONLY — which client dossiers wait for a reviewer
// (lib/admin-badge-rules.ts clientReviewReasons). One reader for the two
// places that show the number: the /admin/clients menu badge
// (lib/server/admin-badges.ts) and the "Needs review" tab of the client
// directory (POST /api/clients/admin-list), so the tab always reproduces the
// badge.
//
// Candidates are bounded reads (the dossiers that are `pending`, the ones
// with a document `submitted` and, for admins, the ones with KYB `pending`),
// scoped to this network through `clients` and without erased dossiers.
// Their requirement and /verify-details statuses are then read by id and the
// pure rule decides. Ids and statuses never leave the server through the
// badge; admin-list attaches only the reason keys to rows it already returns.
// kyc_requirements and client_verification_details have no network column:
// they are scoped through their clients row.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Network } from "@/lib/network";
import { clientReviewReasons, type ClientReviewReason } from "@/lib/admin-badge-rules";
import type { AdminOrKycRole } from "@/lib/server/kyc-provider-gate";

/** PostgREST caps an un-ranged select at 1000 rows without an error. */
export const REVIEW_ID_CAP = 1000;
/** Ids per `.in()` read: 150 uuids keep the request URL well under 8 KB. */
const ID_CHUNK = 150;
/** At most this many chunk reads in flight at once. */
const CHUNK_CONCURRENCY = 4;

export type ClientReviewQueue = {
  /** Client id → why it waits (only dossiers that do). */
  reasons: Map<string, ClientReviewReason[]>;
  /** A candidate read hit REVIEW_ID_CAP: the real queue is at least this big. */
  capped: boolean;
  /** Newest document / details change among the counted dossiers (ISO), or null. */
  latest: string | null;
};

type DbError = { message: string; code?: string };
type Rows<T> = PromiseLike<{ data: T[] | null; error: DbError | null }>;

class QueueReadError extends Error {
  readonly code: string | undefined;
  constructor(table: string, error: DbError) {
    super(`${table}: ${error.message}`);
    this.code = error.code;
  }
}

async function rows<T>(table: string, query: Rows<T>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new QueueReadError(table, error);
  return data ?? [];
}

function chunks<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, items.length) }, worker));
  return out;
}

type ClientStatusRow = { id: string; kyc_status: string };

/**
 * clients rows of this network that are not erased, narrowed to one KYC
 * status or to a set of ids. A database without migration 0065 has no
 * `anonymized_at` column: then nothing was ever erased and the filter is
 * dropped (the admin-detail route reads the column the same way).
 */
async function scopedClients(
  sb: SupabaseClient,
  network: Network,
  narrow: { kycStatus: string } | { ids: string[] },
  signal: AbortSignal | undefined,
): Promise<ClientStatusRow[]> {
  const read = (withErasure: boolean) => {
    let query = sb.from("clients").select("id,kyc_status").eq("network", network);
    if (withErasure) query = query.is("anonymized_at", null);
    query = "ids" in narrow ? query.in("id", narrow.ids) : query.eq("kyc_status", narrow.kycStatus).limit(REVIEW_ID_CAP);
    return signal ? query.abortSignal(signal) : query;
  };
  const first = await read(true);
  if (first.error?.message?.includes("anonymized_at")) {
    return rows<ClientStatusRow>("clients", read(false));
  }
  if (first.error) throw new QueueReadError("clients", first.error);
  return (first.data ?? []) as ClientStatusRow[];
}

type RequirementRow = { client_id: string; status: string; updated_at: string | null };
type DetailsRow = { client_id: string; kind: string; status: string; updated_at: string | null };

function later(a: string | null, b: string | null | undefined): string | null {
  if (!b || !Number.isFinite(Date.parse(b))) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * The dossiers of `network` that wait for a reviewer. `role` narrows it to
 * what the gate's role decides: the KYB reason (and its candidate read) is
 * admin-only. THROWS on a database error; callers isolate it.
 */
export async function readClientReviewQueue(
  sb: SupabaseClient,
  network: Network,
  role: AdminOrKycRole,
  signal?: AbortSignal,
): Promise<ClientReviewQueue> {
  const includeKyb = role === "admin";
  const bounded = <Q extends { abortSignal(s: AbortSignal): Q }>(query: Q): Q =>
    signal ? query.abortSignal(signal) : query;

  const [pending, submitted, kyb] = await Promise.all([
    scopedClients(sb, network, { kycStatus: "pending" }, signal),
    rows<{ client_id: string }>("kyc_requirements", bounded(
      sb.from("kyc_requirements").select("client_id").eq("status", "submitted").limit(REVIEW_ID_CAP),
    )),
    includeKyb
      ? rows<{ client_id: string }>("client_verification_details", bounded(
        sb.from("client_verification_details").select("client_id").eq("kind", "kyb").eq("status", "pending").limit(REVIEW_ID_CAP),
      ))
      : Promise.resolve([] as { client_id: string }[]),
  ]);
  const capped = [pending, submitted, kyb].some((list) => list.length >= REVIEW_ID_CAP);

  // Scope the unscoped candidates (no network column) through clients.
  const status = new Map(pending.map((r) => [r.id, r.kyc_status]));
  const unscoped = [...new Set([...submitted, ...kyb].map((r) => r.client_id))].filter((id) => !status.has(id));
  for (const list of await mapLimited(chunks(unscoped), (ids) => scopedClients(sb, network, { ids }, signal))) {
    for (const r of list) status.set(r.id, r.kyc_status);
  }

  const ids = [...status.keys()];
  const [requirements, details] = await Promise.all([
    mapLimited(chunks(ids), (chunk) => rows<RequirementRow>("kyc_requirements", bounded(
      sb.from("kyc_requirements").select("client_id,status,updated_at").in("client_id", chunk),
    ))),
    mapLimited(chunks(ids), (chunk) => rows<DetailsRow>("client_verification_details", bounded(
      sb.from("client_verification_details").select("client_id,kind,status,updated_at").in("client_id", chunk),
    ))),
  ]);
  const reqsBy = new Map<string, RequirementRow[]>();
  for (const r of requirements.flat()) reqsBy.set(r.client_id, [...(reqsBy.get(r.client_id) ?? []), r]);
  const detailsBy = new Map<string, DetailsRow[]>();
  for (const d of details.flat()) detailsBy.set(d.client_id, [...(detailsBy.get(d.client_id) ?? []), d]);

  const reasons = new Map<string, ClientReviewReason[]>();
  let latest: string | null = null;
  for (const [id, kycStatus] of status) {
    const reqs = reqsBy.get(id) ?? [];
    const own = detailsBy.get(id) ?? [];
    const why = clientReviewReasons({ kyc_status: kycStatus, requirements: reqs, details: own }, { includeKyb });
    if (why.length === 0) continue;
    reasons.set(id, why);
    for (const r of reqs) if (r.status === "submitted" || r.status === "approved") latest = later(latest, r.updated_at);
    for (const d of own) latest = later(latest, d.updated_at);
  }
  return { reasons, capped, latest };
}
