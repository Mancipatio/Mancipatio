// SERVER-ONLY helpers for the GDPR routes /api/clients/export and
// /api/clients/anonymize. Underscore-prefixed file → never routed.
// (The "no open conversion / delivery request" rule lives in the database:
// anonymize_client() in migration 0065, with a dry-run mode for preflight.)

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import { PRIVATE_BUCKET, clientStoragePrefix } from "./_helpers";

/**
 * PostgREST `or` filter matching a dossier's rows by client_id or by the
 * dossier's wallet. Both values are validated (UUID / base58 from the stored
 * row), so they carry no filter syntax.
 */
export function ownerFilter(clientId: string, wallet: string | null, walletColumn: string): string {
  return wallet
    ? `client_id.eq.${clientId},${walletColumn}.eq.${wallet}`
    : `client_id.eq.${clientId}`;
}

type StorageEntry = { name: string; id: string | null };

/**
 * Every object stored under the dossier's prefix in the private bucket
 * (clients/<id>/<kind>/<file>), including files whose database row was never
 * written. THROWS on a listing error — erasure must not proceed half-blind.
 */
export async function listClientObjects(
  sb: SupabaseClient,
  clientId: string,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (prefix: string, depth: number): Promise<void> => {
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await sb.storage
        .from(PRIVATE_BUCKET)
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
 * Delete `paths` from the private bucket. Returns the paths storage reported
 * as deleted (a path that did not exist is simply not in the list). THROWS
 * when a delete call fails.
 */
export async function removeObjects(
  sb: SupabaseClient,
  paths: readonly string[],
): Promise<Set<string>> {
  const removed = new Set<string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { data, error } = await sb.storage.from(PRIVATE_BUCKET).remove(chunk);
    if (error) throw new SiwsError(500, "Could not delete the stored documents");
    for (const item of (data ?? []) as Array<{ name?: string | null }>) {
      if (typeof item.name === "string") removed.add(item.name);
    }
  }
  return removed;
}
