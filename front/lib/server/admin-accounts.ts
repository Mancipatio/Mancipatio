import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Network } from "@/lib/network";
import { ACCOUNT_DIRECTORY_PAGE_SIZE, type AccountDirectory, type AccountDirectoryRow } from "@/lib/admin-accounts";
import { SiwsError } from "@/lib/server/siws";

type Profile = {
  id: string; display_name: string; email: string | null; email_verified_at: string | null;
  google_email: string | null; google_linked_at: string | null; created_at: string;
};
type Member = { account_id: string; wallet: string };
type Dossier = { id: string; account_id: string | null; wallet: string | null; kyc_status: string; kyc_expires_at: string | null };
export type AccountDirectoryOptions = { query: string; page: number; method: string; verification: string; summaryOnly: boolean };

export function accountDirectoryOptions(params: Record<string, unknown>): AccountDirectoryOptions {
  const query = params.query ?? "";
  const page = params.page ?? 1;
  const method = params.method ?? "all";
  const verification = params.verification ?? "all";
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f]/.test(query)) throw new SiwsError(400, "Search must be at most 200 characters.");
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new SiwsError(400, "Invalid page.");
  if (typeof method !== "string" || !["all", "wallet", "google", "email"].includes(method)) throw new SiwsError(400, "Invalid sign-in method.");
  if (typeof verification !== "string" || !["all", "none", "started"].includes(verification)) throw new SiwsError(400, "Invalid verification filter.");
  return { query: query.trim().toLowerCase(), page, method, verification, summaryOnly: params.summary_only === true };
}

// Keyset pages stay below PostgREST's row cap. A failed page fails the whole
// read: a partial directory must never be presented as an exact total.
async function readAll<T>(sb: SupabaseClient, table: string, columns: string, key: string, network: Network, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    let query = sb.from(table).select(columns).eq("network", network).order(key).limit(500).abortSignal(signal);
    if (cursor !== null) query = query.gt(key, cursor);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error("Account directory unavailable");
    rows.push(...data as unknown as T[]);
    if (data.length < 500) return rows;
    const next = (data[data.length - 1] as unknown as Record<string, unknown>)[key];
    if (typeof next !== "string" || next === cursor) throw new Error("Invalid account directory cursor");
    cursor = next;
  }
}

/** Reads only existing accounts; never creates accounts or changes verification. */
export async function readAccountDirectory(sb: SupabaseClient, network: Network, options: AccountDirectoryOptions, signal: AbortSignal): Promise<AccountDirectory> {
  const [profiles, members, dossiers] = await Promise.all([
    readAll<Profile>(sb, "account_profiles", "id,display_name,email,email_verified_at,google_email,google_linked_at,created_at", "id", network, signal),
    readAll<Member>(sb, "account_wallets", "account_id,wallet", "wallet", network, signal),
    readAll<Dossier>(sb, "clients", "id,account_id,wallet,kyc_status,kyc_expires_at", "id", network, signal),
  ]);
  const byId = new Map<string, AccountDirectoryRow>();
  for (const profile of profiles) {
    byId.set(profile.id, {
      id: profile.id, display_name: profile.display_name, email: profile.email,
      google_email: profile.google_email, created_at: profile.created_at, wallets: [], dossiers: [],
      methods: [
        ...(profile.google_linked_at ? ["google" as const] : []),
        ...(profile.email && profile.email_verified_at ? ["email" as const] : []),
      ],
    });
  }
  const ownerByWallet = new Map<string, string>();
  for (const member of members) {
    const account = byId.get(member.account_id);
    if (!account) continue;
    ownerByWallet.set(member.wallet, account.id);
    if (!account.wallets.includes(member.wallet)) account.wallets.push(member.wallet);
    if (!account.methods.includes("wallet")) account.methods.unshift("wallet");
  }
  const now = Date.now();
  for (const dossier of dossiers) {
    // Explicit ownership wins. Only an unassigned legacy dossier may match a
    // linked wallet; never attach another account's dossier through its wallet.
    const accountId = dossier.account_id ?? (dossier.wallet ? ownerByWallet.get(dossier.wallet) : undefined);
    const account = accountId ? byId.get(accountId) : undefined;
    if (!account || account.dossiers.some((row) => row.id === dossier.id)) continue;
    const expired = dossier.kyc_status === "verified" && dossier.kyc_expires_at !== null && Date.parse(dossier.kyc_expires_at) <= now;
    account.dossiers.push({ id: dossier.id, status: expired ? "expired" : dossier.kyc_status });
  }
  const accounts = [...byId.values()];
  const summary = {
    total: accounts.length,
    wallet: accounts.filter((row) => row.methods.includes("wallet")).length,
    google: accounts.filter((row) => row.methods.includes("google")).length,
    email: accounts.filter((row) => row.methods.includes("email")).length,
    without_verification: accounts.filter((row) => row.dossiers.length === 0).length,
  };
  const filtered = accounts.filter((row) => {
    if (options.method !== "all" && !row.methods.some((method) => method === options.method)) return false;
    if (options.verification === "none" && row.dossiers.length !== 0) return false;
    if (options.verification === "started" && row.dossiers.length === 0) return false;
    return !options.query || [row.id, row.display_name, row.email, row.google_email, ...row.wallets]
      .some((value) => value?.toLowerCase().includes(options.query));
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const page = Math.min(options.page, Math.max(1, Math.ceil(filtered.length / ACCOUNT_DIRECTORY_PAGE_SIZE)));
  const offset = (page - 1) * ACCOUNT_DIRECTORY_PAGE_SIZE;
  return { accounts: options.summaryOnly ? [] : filtered.slice(offset, offset + ACCOUNT_DIRECTORY_PAGE_SIZE), summary,
    filtered_total: filtered.length, page, page_size: ACCOUNT_DIRECTORY_PAGE_SIZE, network };
}
