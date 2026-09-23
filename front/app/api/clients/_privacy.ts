// SERVER-ONLY helpers for the GDPR routes /api/clients/export and
// /api/clients/anonymize. Underscore-prefixed file → never routed.
// (The "no open conversion / delivery request" rule lives in the database:
// anonymize_client() in migration 0065, with a dry-run mode for preflight.)

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import { PUBLIC_BUCKET } from "../storage/_lib";
import { PRIVATE_BUCKET, clientStoragePrefix } from "./_helpers";

/**
 * The old public bucket that pre-P1 KYC uploads went to, at the same
 * storage_path their client_documents row still carries. A public bucket
 * serves /storage/v1/object/public/... without consulting RLS, so an object
 * left there stays readable by anyone holding its URL (0031 ops note).
 */
export const LEGACY_KYC_BUCKET = PUBLIC_BUCKET;

/**
 * Top-level folders of the global document repository in the public bucket
 * (app/api/storage/upload ADMIN_PREFIXES + whitepapers). Erasure never deletes
 * a public-bucket object under one of these: such a file belongs to the
 * repository, not to one dossier, even when a stray document row points at it.
 */
const REPOSITORY_PREFIXES: ReadonlySet<string> = new Set([
  "whitepapers",
  "legal",
  "kyb-template",
  "issuer-agreement",
  "compliance",
  "marketing",
  "other",
]);

/** True when `path` sits in a folder of the global document repository. */
export function isRepositoryPath(path: string): boolean {
  return REPOSITORY_PREFIXES.has(path.split("/")[0] ?? "");
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The distinct, well-formed wallets among `values` (safe inside a filter string). */
export function walletSet(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) if (typeof v === "string" && BASE58_RE.test(v)) out.add(v);
  return [...out];
}

/**
 * PostgREST `or` filter matching a dossier's rows by client_id or by any of
 * the person's wallets. The client id is a validated UUID and every wallet
 * passed walletSet (base58 only), so neither carries filter syntax.
 */
export function ownerFilter(clientId: string, wallets: readonly string[], walletColumn: string): string {
  const safe = walletSet(wallets);
  return safe.length > 0
    ? `client_id.eq.${clientId},${walletColumn}.in.(${safe.join(",")})`
    : `client_id.eq.${clientId}`;
}

/**
 * Columns that name the operator who did something to the record (admin
 * wallets). The export shows them as "operator" unless the value is one of
 * the data subject's own wallets: staff identities are other people's data
 * (GDPR art. 15(4)) and stay in the audit log. Free text (note bodies, the
 * admin_note a holder already sees on their request) is not rewritten.
 */
const OPERATOR_COLUMNS: ReadonlySet<string> = new Set([
  "author",
  "uploaded_by",
  "requested_by",
  "handled_by",
  "decided_by",
  "granted_by",
  "reviewed_by",
  "updated_by",
  "created_by",
  "recorded_by",
  "resolved_by",
  "moderated_by",
  "pending_email_requested_by",
]);

/** Placeholder the export uses for an operator's wallet. */
export const OPERATOR_PLACEHOLDER = "operator";

/**
 * Copy of `value` (a row, a list of rows, or null) with every operator column
 * that holds a wallet other than the subject's own replaced by "operator".
 */
export function redactOperators<T>(value: T, ownWallets: ReadonlySet<string>): T {
  if (Array.isArray(value)) return value.map((v) => redactOperators(v, ownWallets)) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (OPERATOR_COLUMNS.has(key) && typeof v === "string" && BASE58_RE.test(v) && !ownWallets.has(v)) {
      out[key] = OPERATOR_PLACEHOLDER;
    }
  }
  return out as T;
}

type StorageEntry = { name: string; id: string | null };

/**
 * Every object stored under the dossier's prefix (clients/<id>/<kind>/<file>)
 * in `bucket` — the private bucket by default — including files whose
 * database row was never written. THROWS on a listing error: erasure must not
 * proceed half-blind.
 */
export async function listClientObjects(
  sb: SupabaseClient,
  clientId: string,
  bucket: string = PRIVATE_BUCKET,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (prefix: string, depth: number): Promise<void> => {
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await sb.storage
        .from(bucket)
        .list(prefix, { limit: pageSize, offset });
      if (error) throw new SiwsError(500, "Could not list the stored documents");
      const entries = (data ?? []) as StorageEntry[];
      for (const entry of entries) {
        const path = `${prefix}/${entry.name}`;
        // Folders come back without an id.
        if (entry.id === null) {
          if (depth < 3) await walk(path, depth + 1);
        } else {
          found.push(path);
        }
      }
      if (entries.length < pageSize) break;
    }
  };
  await walk(clientStoragePrefix(clientId), 0);
  return found;
}

/**
 * Delete `paths` from `bucket` (the private bucket by default). Returns the
 * paths storage reported as deleted (a path that did not exist is simply not
 * in the list). THROWS when a delete call fails.
 */
export async function removeObjects(
  sb: SupabaseClient,
  paths: readonly string[],
  bucket: string = PRIVATE_BUCKET,
): Promise<Set<string>> {
  const removed = new Set<string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { data, error } = await sb.storage.from(bucket).remove(chunk);
    if (error) throw new SiwsError(500, "Could not delete the stored documents");
    for (const item of (data ?? []) as Array<{ name?: string | null }>) {
      if (typeof item.name === "string") removed.add(item.name);
    }
  }
  return removed;
}

/**
 * Of `paths`, those a document row of ANOTHER dossier also points at. Erasing
 * one dossier must never delete a file another dossier still relies on.
 * THROWS (500) when the lookup fails.
 */
export async function pathsSharedWithOtherDossiers(
  sb: SupabaseClient,
  clientId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const shared = new Set<string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { data, error } = await sb
      .from("client_documents")
      .select("client_id, storage_path")
      .in("storage_path", chunk)
      .neq("client_id", clientId);
    if (error) throw new SiwsError(500, "Could not check the stored documents");
    for (const row of (data ?? []) as Array<{ storage_path?: unknown }>) {
      if (typeof row.storage_path === "string") shared.add(row.storage_path);
    }
  }
  return shared;
}
