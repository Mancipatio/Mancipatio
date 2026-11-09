// SERVER-ONLY — reads and writes of admin_wallet_labels (0092) and the
// linked-account lookup for /admin/admins. Pure over a Supabase client, so
// the routes stay thin and the tests drive it with a fake.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WALLET_LABELS_READ_MAX,
  isWalletAddress,
  normalizeWalletLabel,
  type WalletAccount,
  type WalletLabel,
  type WalletLabels,
} from "@/lib/admin-wallet-labels";
import { SiwsError } from "@/lib/server/siws";

/** 0092 is not applied: Postgres "undefined_table", or PostgREST's "table not found" (as in fee-schedule.ts). */
const MISSING_TABLE: ReadonlySet<string> = new Set(["42P01", "PGRST205"]);

export const LABELS_NOT_SET_UP = "Wallet names are not set up on this network yet (database migration 0092).";

/** `params.wallets`: 1-200 distinct base58 addresses. */
export function walletsParam(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new SiwsError(400, "wallets must be a non-empty list");
  if (value.length > WALLET_LABELS_READ_MAX) throw new SiwsError(400, `At most ${WALLET_LABELS_READ_MAX} wallets per read`);
  if (!value.every(isWalletAddress)) throw new SiwsError(400, "Every wallet must be a base58 address");
  return [...new Set(value)];
}

/** `params.wallet` and `params.label` of a write ("" removes the name). */
export function labelWriteParams(params: Record<string, unknown>): { wallet: string; label: string } {
  if (!isWalletAddress(params.wallet)) throw new SiwsError(400, "wallet must be a base58 address");
  if (typeof params.label !== "string") throw new SiwsError(400, "label must be a string");
  try {
    return { wallet: params.wallet, label: normalizeWalletLabel(params.label) };
  } catch (err) {
    throw new SiwsError(400, err instanceof Error ? err.message : "Invalid name");
  }
}

export async function readWalletLabelRows(
  sb: SupabaseClient,
  network: string,
  wallets: readonly string[],
): Promise<WalletLabels> {
  const labels: Record<string, WalletLabel> = {};
  const accounts: Record<string, WalletAccount> = {};
  let available = true;

  const named = await sb
    .from("admin_wallet_labels")
    .select("wallet,label,set_by,updated_at")
    .eq("network", network)
    .in("wallet", wallets);
  if (named.error) {
    if (!MISSING_TABLE.has(named.error.code ?? "")) throw new SiwsError(503, "Wallet names are temporarily unavailable");
    available = false;
  } else {
    for (const row of (named.data ?? []) as Array<{ wallet: string; label: string; set_by: string; updated_at: string }>) {
      labels[row.wallet] = { label: row.label, setBy: row.set_by, updatedAt: row.updated_at };
    }
  }

  const members = await sb.from("account_wallets").select("wallet,account_id").eq("network", network).in("wallet", wallets);
  if (members.error) throw new SiwsError(503, "Linked accounts are temporarily unavailable");
  const byAccount = new Map<string, string[]>();
  for (const row of (members.data ?? []) as Array<{ wallet: string; account_id: string }>) {
    byAccount.set(row.account_id, [...(byAccount.get(row.account_id) ?? []), row.wallet]);
  }
  if (byAccount.size > 0) {
    const profiles = await sb
      .from("account_profiles")
      .select("id,display_name,email")
      .eq("network", network)
      .in("id", [...byAccount.keys()]);
    if (profiles.error) throw new SiwsError(503, "Linked accounts are temporarily unavailable");
    for (const p of (profiles.data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>) {
      for (const wallet of byAccount.get(p.id) ?? []) {
        accounts[wallet] = { displayName: (p.display_name ?? "").trim(), email: p.email ?? null };
      }
    }
  }
  return { available, labels, accounts };
}

/** Upserts the name of `wallet`, or deletes it for "". Returns the stored name, or null. */
export async function writeWalletLabelRow(
  sb: SupabaseClient,
  network: string,
  wallet: string,
  label: string,
  setBy: string,
): Promise<string | null> {
  const result = label === ""
    ? await sb.from("admin_wallet_labels").delete().eq("network", network).eq("wallet", wallet)
    : await sb
        .from("admin_wallet_labels")
        .upsert({ network, wallet, label, set_by: setBy }, { onConflict: "network,wallet" });
  if (result.error) {
    if (MISSING_TABLE.has(result.error.code ?? "")) throw new SiwsError(503, LABELS_NOT_SET_UP);
    throw new SiwsError(503, "The name could not be saved — try again");
  }
  return label === "" ? null : label;
}
