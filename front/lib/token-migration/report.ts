// Token migration (V1): the final report of a completed campaign. Pure and
// isomorphic. Completing a campaign stores this exact text and its SHA-256
// (migration 0085 keeps both immutable from then on); the public route serves
// the text as stored, so anyone can hash what they downloaded and compare it
// with the published hash, and recompute the totals from the proof table.
//
// Deterministic: the same campaign row and deposits always give the same
// bytes. Object keys are sorted at every level, there is no whitespace,
// every amount is a decimal string (base units for the old token, whole
// units for the class), deposits are in chain order (slot, then signature),
// and the only clock in it is `completed_at`, which the caller passes in and
// the database stores.

import { formatPercentE4 } from "@/lib/token-migration/ratio";
import { chainOrder, migrationProgress, type DepositRow, type MigrationRow } from "@/lib/token-migration/rows";

export const FINAL_REPORT_KIND = "manci.token-migration.final-report";
export const FINAL_REPORT_VERSION = 1;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Sorted keys, no whitespace (JSON.stringify for every scalar). */
export function canonicalReportJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReportJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalReportJson(value[k])}`).join(",")}}`;
}

/** The report's text: refuses (throws) a campaign that is not ready to complete. */
export function buildFinalReport(row: MigrationRow, deposits: readonly DepositRow[], completedAt: string): string {
  if (!Number.isFinite(Date.parse(completedAt))) throw new Error("Invalid completion time");
  if (deposits.some((d) => d.migration_id !== row.id)) throw new Error("A deposit of another campaign was passed in");
  if (deposits.some((d) => d.status === "accepted" || d.status === "irregular")) {
    throw new Error("Every deposit must be delivered or refunded before the campaign completes");
  }
  const progress = migrationProgress(deposits);
  const unitsDelivered = BigInt(progress.unitsDelivered);
  const unitsCap = BigInt(row.units_cap);
  const granularity = BigInt(row.granularity);
  const report: Json = {
    kind: FINAL_REPORT_KIND,
    version: FINAL_REPORT_VERSION,
    network: row.network,
    completed_at: new Date(completedAt).toISOString(),
    campaign: {
      id: row.id,
      slug: row.slug,
      company_name: row.company_name,
      issuer_pda: row.issuer_pda,
      asset_pda: row.asset_pda,
      share_class_pda: row.share_class_pda,
      new_mint: row.new_mint,
      treasury_wallet: row.treasury_wallet,
      source: row.source,
      unclaimed_policy: row.unclaimed_policy,
      terms_doc_sha256: row.terms_doc_sha256,
      terms_doc_url: row.terms_doc_url,
      window_opens_at: new Date(row.window_opens_at).toISOString(),
      window_closes_at: new Date(row.window_closes_at).toISOString(),
      opened_at: row.opened_at ? new Date(row.opened_at).toISOString() : null,
      closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    },
    old_token: {
      chain: row.old_chain,
      mint: row.old_mint,
      token_program: row.old_token_program,
      decimals: row.old_decimals,
      symbol: row.old_symbol,
      name: row.old_name,
      total_supply: row.old_total_supply,
      supply_read_at: new Date(row.supply_read_at).toISOString(),
      excluded_wallets: [...row.excluded_wallets].sort(),
      excluded_wallet_amount: row.excluded_wallet_amount,
      excluded_manual_amount: row.excluded_manual_amount,
      excluded_amount: row.excluded_amount,
      excluded_note: row.excluded_note,
      deposit_owner: row.deposit_owner,
      deposit_ata: row.deposit_ata,
      burn_tx: row.old_tokens_burn_tx,
      burned: row.old_tokens_burned,
    },
    ratio: {
      equity_bps: row.equity_bps,
      granularity: row.granularity.toString(),
      lot_base_units: row.lot_base_units,
      units_cap: row.units_cap,
      qualified_supply: (BigInt(row.old_total_supply) - BigInt(row.excluded_amount)).toString(),
      cap_equity_percent: formatPercentE4((unitsCap * BigInt(1_000_000)) / granularity),
    },
    totals: {
      deposits: deposits.length,
      holders: progress.holders,
      old_tokens_exchanged: progress.depositedBase,
      units_delivered: progress.unitsDelivered,
      units_unclaimed: (unitsCap - unitsDelivered).toString(),
      delivered_equity_percent: formatPercentE4((unitsDelivered * BigInt(1_000_000)) / granularity),
      old_tokens_refunded: progress.refundedBase,
    },
    deposits: [...deposits].sort(chainOrder).map((d) => ({
      deposit_tx: d.deposit_tx,
      slot: d.deposit_slot,
      block_time: new Date(d.block_time).toISOString(),
      holder_wallet: d.holder_wallet,
      amount_base: d.amount_base,
      units: d.units_due,
      status: d.status,
      reason_code: d.reason_code,
      delivery_tx: d.delivery_tx,
      refund_tx: d.refund_tx,
      recorded_via: d.recorded_via,
    })),
  };
  return canonicalReportJson(report);
}

/** SHA-256 of the report's UTF-8 bytes, lowercase hex (WebCrypto: Node 22 and every browser). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
