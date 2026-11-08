"use client";

// Token migration (V1): the browser's calls to app/api/token-migrations.
//   public reads   GET /public (campaigns, one campaign's proof table) and
//                  the final report: no wallet, no signature
//   holder         tokenMigration.precheck (a session read: one sign-in,
//                  then no prompt) before the wallet signs the deposit, and
//                  tokenMigration.recordDeposit (a fresh signature) once the
//                  deposit finalized
//   admin          tokenMigration.adminInspect / adminList (session reads),
//                  adminSave / adminTransition / adminReconcile / adminRecord
//                  (fresh signatures; the on-chain admin gate on the server)
// Every write THROWS with the server's words (a 409 "awaiting finalization"
// keeps its code, lib/chain-record-recovery isAwaitingFinalizationError), so
// a page says what happened instead of a generic failure.

import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import type { DepositRow, MigrationProgress, MigrationRow, PublicDeposit, PublicMigration } from "@/lib/token-migration/rows";

export type PublicMigrationSummary = Omit<PublicMigration, "deposits">;

async function publicGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? "Could not load the token migrations");
  return json.data as T;
}

export function fetchPublicMigrations(): Promise<PublicMigrationSummary[]> {
  return publicGet<PublicMigrationSummary[]>("/api/token-migrations/public");
}

export function fetchPublicMigration(slug: string): Promise<PublicMigration> {
  return publicGet<PublicMigration>(`/api/token-migrations/public?slug=${encodeURIComponent(slug)}`);
}

// ── Holder ───────────────────────────────────────────────────────────────────

/** What the holder's wallet signs (app/api/token-migrations/precheck). */
export type DepositPlan = {
  migration_id: string;
  lots: string;
  amount_base: string;
  units: string;
  deposit_owner: string;
  deposit_ata: string;
  old_mint: string;
  old_token_program: string;
  old_decimals: number;
  memo: string;
};

export function precheckDeposit(
  session: WalletSession | null | undefined,
  input: { migrationId: string; lots: bigint },
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<DepositPlan> {
  return signedFetch<DepositPlan>(session, "/api/token-migrations/precheck", "tokenMigration.precheck", {
    migration_id: input.migrationId,
    lots: input.lots.toString(),
  }, opts);
}

export type RecordedDeposit = { created: boolean; deposit: PublicDeposit & { id: string } };

export function recordMigrationDeposit(
  session: WalletSession | null | undefined,
  input: { migrationId: string; signature: string },
): Promise<RecordedDeposit> {
  return signedFetch<RecordedDeposit>(session, "/api/token-migrations/record", "tokenMigration.recordDeposit", {
    migration_id: input.migrationId,
    signature: input.signature,
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export type InspectAnswer = {
  old_mint: {
    ok: boolean;
    token_program: string;
    decimals: number;
    supply: string;
    mint_authority: string | null;
    freeze_authority: string | null;
    extensions: string[];
    refusals: { extension: string; reason: string }[];
    warnings: string[];
  };
  excluded: { address: string; kind: "token-account" | "owner"; amount: string }[];
  excluded_total: string;
  share_class: { shareClass: string; asset: string; issuer: string; mint: string; assetName: string; maxSupply: string | null } | null;
};

export function inspectOldToken(
  session: WalletSession | null | undefined,
  input: { oldMint: string; excludedWallets: readonly string[]; shareClassPda?: string | null },
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<InspectAnswer> {
  return signedFetch<InspectAnswer>(session, "/api/token-migrations/admin/inspect", "tokenMigration.adminInspect", {
    old_mint: input.oldMint,
    excluded_wallets: [...input.excludedWallets],
    share_class_pda: input.shareClassPda ?? null,
  }, opts);
}

export type AdminMigration = MigrationRow & { progress: MigrationProgress };

export async function listAdminMigrations(
  session: WalletSession | null | undefined,
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<AdminMigration[]> {
  const data = await signedFetch<{ migrations: AdminMigration[] }>(session, "/api/token-migrations/admin/list", "tokenMigration.adminList", {}, opts);
  return data.migrations ?? [];
}

export function readAdminMigration(
  session: WalletSession | null | undefined,
  id: string,
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<{ migration: MigrationRow; deposits: DepositRow[]; progress: MigrationProgress }> {
  return signedFetch(session, "/api/token-migrations/admin/list", "tokenMigration.adminList", { id }, opts);
}

export type DraftInput = {
  id?: string | null;
  slug: string;
  company_name: string;
  share_class_pda: string;
  old_mint: string;
  old_symbol: string;
  old_name: string;
  excluded_wallets: string[];
  excluded_manual_amount: string;
  excluded_note: string;
  equity_bps: number;
  granularity: number;
  source: string;
  unclaimed_policy: string;
  deposit_owner: string;
  treasury_wallet: string;
  window_opens_at: string;
  window_closes_at: string;
  terms_doc_sha256: string | null;
  terms_doc_url: string | null;
};

export function saveMigrationDraft(
  session: WalletSession | null | undefined,
  input: DraftInput,
): Promise<{ migration: MigrationRow; warnings: string[]; excluded: InspectAnswer["excluded"] }> {
  return signedFetch(session, "/api/token-migrations/admin/save", "tokenMigration.adminSave", { ...input, id: input.id ?? null });
}

export function transitionMigration(
  session: WalletSession | null | undefined,
  input: { id: string; to: "open" | "closed" | "cancelled" | "completed" },
): Promise<{ migration: MigrationRow }> {
  return signedFetch(session, "/api/token-migrations/admin/transition", "tokenMigration.adminTransition", input);
}

export type ReconcileAnswer = {
  /** Transactions this run read. */
  examined: number;
  /** True when the sweep reached the last examined point: nothing older is left unread. */
  complete: boolean;
  /** Why the run stopped early (a screen or a node that could not answer, a concurrent change), or null. */
  stopped: string | null;
  results: { signature: string; outcome: "recorded" | "already" | "not_a_deposit" | "other_campaign"; detail?: string; status?: string }[];
};

/** The next stretch of the deposit account's history, or (with `signature`) that one transaction. */
export function reconcileMigration(session: WalletSession | null | undefined, id: string, signature?: string): Promise<ReconcileAnswer> {
  return signedFetch<ReconcileAnswer>(session, "/api/token-migrations/admin/reconcile", "tokenMigration.adminReconcile", {
    id,
    ...(signature ? { signature } : {}),
  });
}

export type SettlementInput =
  | { id: string; kind: "delivery"; signature: string; deposit_ids?: string[] }
  | { id: string; kind: "refund"; signature: string; deposit_ids: string[]; compliance_cleared?: boolean }
  | { id: string; kind: "burn"; signature: string };

export function recordMigrationSettlement(
  session: WalletSession | null | undefined,
  input: SettlementInput,
): Promise<Record<string, unknown>> {
  return signedFetch(session, "/api/token-migrations/admin/record", "tokenMigration.adminRecord", input as unknown as Record<string, unknown>);
}
