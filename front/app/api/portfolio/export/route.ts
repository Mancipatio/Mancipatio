// POST /api/portfolio/export — the signer's own records for the portfolio
// export (/portfolio/history, "Export CSV"; lib/portfolio-export.ts builds
// the file in the browser, with the wallet's on-chain history from
// lib/portfolio-chain.ts). Signed (SIWS) and a session read
// (lib/siws-session.ts): one sign-in, then no prompt. Every query is bound
// to the VERIFIED signer and the active network, so no caller can read
// another wallet's rows:
//   purchases    the wallet's commitments with verified on-chain evidence
//                (evidence_verified, settled): units, the amount in payment
//                base units, the payment mint and its decimals, the
//                transaction; the sale's mint and share class come from the
//                sales mirror;
//   otc          the OTC deals the wallet is a party to that reached an
//                escrow (created, completed, cancelled, expired), from its
//                own side: never the counterparty's wallet;
//   conversions  the wallet's conversion requests without the contact, the
//                note or the admin's note (PII and free text the export does
//                not need);
//   fx           the platform's EUR rate of the network's USDC for each UTC
//                day of the last PORTFOLIO_EXPORT_FX_WINDOW_DAYS
//                (fx_rate_observations keeps 30 days): the day's last
//                accepted automatic rate, else the manual rate dated that
//                day. Public market data.
// Read-only, no write of any kind: it stays open in KYC-only mode and
// whatever the module switches say (the holder's own records, like
// /api/conversion/list-mine). A record read that fails answers 503: an export
// without some purchases would be wrong, not partial. Unreadable EUR rates
// only leave the EUR columns empty. Each list is read newest first and capped
// at RECORD_LIMIT rows: reaching the cap drops the oldest rows, sets
// `truncated`, and the file says older records may be missing.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork, type Network } from "@/lib/network";
import { USDC } from "@/lib/payment-mints";
import { tableMissing } from "@/lib/server/fx-rates";
import { withTimeout } from "@/lib/server/with-timeout";
import {
  PORTFOLIO_EXPORT_FX_WINDOW_DAYS,
  type ExportConversionRecord,
  type ExportFxRate,
  type ExportOtcRecord,
  type ExportPurchaseRecord,
  type PortfolioExportRecords,
} from "@/lib/portfolio-export";

export const maxDuration = 30;

const RECORD_LIMIT = 1_000;
const READ_TIMEOUT_MS = 10_000;
const FX_CONCURRENCY = 8;
const DAY_MS = 86_400_000;
const UNAVAILABLE = "Your records are unavailable right now — try again in a moment";

type Row = Record<string, unknown>;

/** A whole number from a numeric column (PostgREST answers numbers or strings); null otherwise. */
function digits(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Every row must read cleanly: a skipped row would make the export silently wrong. */
function required<T>(value: T | null): T {
  if (value === null) throw new SiwsError(503, UNAVAILABLE);
  return value;
}

async function readPurchases(sb: SupabaseClient, network: Network, wallet: string, signal: AbortSignal) {
  const { data, error } = await sb
    .from("commitments")
    .select("id, created_at, sale_pubkey, units, amount_atomic, payment_mint, payment_decimals, settled_tx")
    .eq("network", network)
    .eq("investor_wallet", wallet)
    .eq("evidence_verified", true)
    .eq("status", "settled")
    .order("created_at", { ascending: false })
    .limit(RECORD_LIMIT)
    .abortSignal(signal);
  if (error) throw new SiwsError(503, UNAVAILABLE);
  const rows = (data ?? []) as Row[];
  const sales = [...new Set(rows.map((r) => text(r.sale_pubkey)).filter((s): s is string => s !== null))];
  const bySale = new Map<string, { share_class_pda: string | null; mint: string | null }>();
  if (sales.length > 0) {
    const mirror = await sb
      .from("sales")
      .select("pda, share_class_pda, mint")
      .eq("network", network)
      .in("pda", sales)
      .abortSignal(signal);
    if (mirror.error) throw new SiwsError(503, UNAVAILABLE);
    for (const sale of (mirror.data ?? []) as Row[]) {
      const pda = text(sale.pda);
      if (pda) bySale.set(pda, { share_class_pda: text(sale.share_class_pda), mint: text(sale.mint) });
    }
  }
  const purchases: ExportPurchaseRecord[] = rows.map((r) => {
    const sale = required(text(r.sale_pubkey));
    const decimals = Number(r.payment_decimals);
    return {
      id: required(text(r.id)),
      created_at: required(text(r.created_at)),
      sale,
      share_class_pda: bySale.get(sale)?.share_class_pda ?? null,
      mint: bySale.get(sale)?.mint ?? null,
      units: required(digits(r.units)),
      amount_atomic: required(digits(r.amount_atomic)),
      payment_mint: required(text(r.payment_mint)),
      payment_decimals: required(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null),
      signature: required(text(r.settled_tx)),
    };
  });
  return { rows: purchases, capped: rows.length >= RECORD_LIMIT };
}

const OTC_COLUMNS =
  "id, created_at, updated_at, share_class_pda, mint, asset_label, seller_wallet, buyer_wallet, amount, price, payment_mint, status, deal_pda";

async function readOtc(sb: SupabaseClient, network: Network, wallet: string, signal: AbortSignal) {
  // Two plain filters (seller, buyer) instead of a built `or` string.
  const sides = await Promise.all(
    (["seller_wallet", "buyer_wallet"] as const).map((column) =>
      sb
        .from("otc_requests")
        .select(OTC_COLUMNS)
        .eq("network", network)
        .eq(column, wallet)
        .in("status", ["created", "completed", "cancelled", "expired"])
        .order("created_at", { ascending: false })
        .limit(RECORD_LIMIT)
        .abortSignal(signal),
    ),
  );
  if (sides.some((side) => side.error)) throw new SiwsError(503, UNAVAILABLE);
  const seen = new Set<string>();
  const deals: ExportOtcRecord[] = [];
  for (const row of sides.flatMap((side) => (side.data ?? []) as Row[])) {
    const id = required(text(row.id));
    if (seen.has(id)) continue;
    seen.add(id);
    deals.push({
      id,
      created_at: required(text(row.created_at)),
      updated_at: required(text(row.updated_at)),
      share_class_pda: required(text(row.share_class_pda)),
      mint: required(text(row.mint)),
      asset_label: text(row.asset_label) ?? "",
      // The wallet's own side only: the counterparty's wallet is not returned.
      side: row.seller_wallet === wallet ? "seller" : "buyer",
      amount: required(digits(row.amount)),
      price: required(digits(row.price)),
      payment_mint: required(text(row.payment_mint)),
      status: required(text(row.status)),
      deal_pda: text(row.deal_pda),
    });
  }
  return { rows: deals, capped: sides.some((side) => (side.data ?? []).length >= RECORD_LIMIT) };
}

async function readConversions(sb: SupabaseClient, network: Network, wallet: string, signal: AbortSignal) {
  const { data, error } = await sb
    .from("conversion_requests")
    .select("id, created_at, updated_at, share_class_pda, mint, asset_label, amount, status, vault_pda, deposit_tx, outcome_tx")
    .eq("network", network)
    .eq("holder_wallet", wallet)
    .order("created_at", { ascending: false })
    .limit(RECORD_LIMIT)
    .abortSignal(signal);
  if (error) throw new SiwsError(503, UNAVAILABLE);
  const rows = (data ?? []) as Row[];
  const conversions: ExportConversionRecord[] = rows.map((r) => ({
    id: required(text(r.id)),
    created_at: required(text(r.created_at)),
    updated_at: required(text(r.updated_at)),
    share_class_pda: required(text(r.share_class_pda)),
    mint: required(text(r.mint)),
    asset_label: text(r.asset_label) ?? "",
    amount: required(digits(r.amount)),
    status: required(text(r.status)),
    vault_pda: text(r.vault_pda),
    deposit_tx: text(r.deposit_tx),
    outcome_tx: text(r.outcome_tx),
  }));
  return { rows: conversions, capped: rows.length >= RECORD_LIMIT };
}

const rateText = (value: unknown): string | null => {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  return raw !== null && /^\d{1,9}(\.\d{1,18})?$/.test(raw) && Number(raw) > 0 ? raw : null;
};

/** The network's USDC rate per UTC day of the window (see the header). Throws when a read fails. */
async function readDailyRates(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<PortfolioExportRecords["fx"]> {
  const usdc = USDC[network];
  if (!usdc) return { payment_mint: null, rates: [], available: true };
  const manual = await sb
    .from("fx_rates")
    .select("kind, eur_per_token, as_of")
    .eq("network", network)
    .eq("payment_mint", usdc.mint)
    .abortSignal(signal)
    .maybeSingle();
  if (manual.error) throw new Error("fx_rates unavailable");
  const manualRow = manual.data as Row | null;
  const manualRate = rateText(manualRow?.eur_per_token);
  const manualDay = typeof manualRow?.as_of === "string" ? manualRow.as_of.slice(0, 10) : null;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days = Array.from({ length: PORTFOLIO_EXPORT_FX_WINDOW_DAYS }, (_, i) => today - i * DAY_MS);
  const rates: ExportFxRate[] = [];
  let autoInstalled = true;
  for (let i = 0; i < days.length && autoInstalled; i += FX_CONCURRENCY) {
    const answers = await Promise.all(
      days.slice(i, i + FX_CONCURRENCY).map(async (start) => {
        const { data, error } = await sb
          .from("fx_rate_observations")
          .select("eur_per_token, observed_at")
          .eq("network", network)
          .eq("payment_mint", usdc.mint)
          .eq("status", "accepted")
          .gte("observed_at", new Date(start).toISOString())
          .lt("observed_at", new Date(start + DAY_MS).toISOString())
          .order("observed_at", { ascending: false })
          .limit(1)
          .abortSignal(signal);
        return { start, data: (data ?? []) as Row[], error };
      }),
    );
    for (const answer of answers) {
      if (answer.error) {
        // Before 0080 there are no automatic rates: the manual one still counts.
        if (tableMissing(answer.error)) {
          autoInstalled = false;
          break;
        }
        throw new Error("fx_rate_observations unavailable");
      }
      const day = new Date(answer.start).toISOString().slice(0, 10);
      const auto = rateText(answer.data[0]?.eur_per_token);
      if (auto) rates.push({ day, eur_per_token: auto, source: "auto" });
    }
  }
  if (manualRate) {
    for (const start of days) {
      const day = new Date(start).toISOString().slice(0, 10);
      if (rates.some((r) => r.day === day)) continue;
      // An EUR stablecoin's peg holds every day; a manual rate only on the day it is dated.
      if (manualRow?.kind === "eur_peg" || day === manualDay) rates.push({ day, eur_per_token: manualRate, source: "manual" });
    }
  }
  rates.sort((a, b) => a.day.localeCompare(b.day));
  return { payment_mint: usdc.mint, rates, available: true };
}

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "portfolio.export");
    const network = detectNetwork();
    const sb = getSupabaseAdmin();
    const records = await withTimeout(READ_TIMEOUT_MS, (signal) =>
      Promise.all([
        readPurchases(sb, network, wallet, signal),
        readOtc(sb, network, wallet, signal),
        readConversions(sb, network, wallet, signal),
      ]),
    ).catch((error: unknown) => {
      if (error instanceof SiwsError) throw error;
      throw new SiwsError(503, UNAVAILABLE);
    });
    const [purchases, otc, conversions] = records;
    let fx: PortfolioExportRecords["fx"];
    try {
      fx = await withTimeout(READ_TIMEOUT_MS, (signal) => readDailyRates(sb, network, Date.now(), signal));
    } catch {
      fx = { payment_mint: USDC[network]?.mint ?? null, rates: [], available: false };
    }
    const data: PortfolioExportRecords = {
      network,
      wallet,
      purchases: purchases.rows,
      otc: otc.rows,
      conversions: conversions.rows,
      fx,
      truncated: purchases.capped || otc.capped || conversions.capped,
    };
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
