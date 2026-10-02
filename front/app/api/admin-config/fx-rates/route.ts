// POST /api/admin-config/fx-rates — EUR rates of payment mints for the raise
// cap (0066 fx_rates, 0080 fx_auto_rates), current network.
//   read  "adminConfig.fxRatesRead"  — requireAdmin (a wallet session may authorize it)
//   write "adminConfig.fxRatesWrite" — requireSuperAdmin; op "upsert" | "delete"
// An EUR stablecoin is kind "eur_peg" (1 EUR per token, never stale). Any
// other mint is kind "rate" and is refused by reservations once `as_of` is
// older than its max age. Decimals are read from chain, never trusted, and
// the mint must pass the plain-payment rule (lib/server/payment-mint).
// Mainnet (Talas 4.2 §3.3, D18): only allowlisted payment mints, with the
// kind the allowlist fixes (USDC is "rate"), and a rate at most 7 days old.
// Deleting a row is always allowed.
//
// 0080: the network's USDC also has an AUTOMATIC rate (lib/server/fx-
// refresh.ts, every minute). The manual row written here is the fallback
// while the automatic rate is missing or stale, or, with `override_auto`,
// counts over it. Every answer lists one row per mint: the rate that counts
// (the fx_rates shape, so existing readers keep working) with `origin`
// (auto | manual | manual_override), `fresh`, the `manual` and `auto` rows
// behind it and the automatic job's last run (`auto_last`).
//
// Every manual write (upsert or delete) is audited on the server
// (writeServerAudit: "fx_rate_update" / "fx_rate_delete", category
// launchpad), with the kind, rate, max age and override flag, the manual row
// it replaced, and the automatic rate that was fresh at the time with the
// deviation from it. As for the other ledger writes
// (sale-approvals/treasury-revalue, spvs/record-issuance) the row is written
// first, so a failed audit insert is logged (console.error), never answered
// as a failed write that would invite a second submit.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork, type Network } from "@/lib/network";
import { addressParam } from "@/lib/server/sale-capacity";
import { assertAllowedPaymentMint, paymentMintInfo } from "@/lib/server/payment-mint";
import { MAINNET_MAX_RATE_AGE_DAYS, paymentMintLabel, requiredFxKind } from "@/lib/payment-mints";
import { effectiveRates, FxReadError, readFxTables, undefinedColumn } from "@/lib/server/fx-rates";
import { fxAutoFresh, gapToFreshAuto, type FxAutoRow, type FxManualRow } from "@/lib/fx-effective";

const RATE_RE = /^(0|[1-9]\d{0,9})(\.\d{1,10})?$/;

/** What the audit event records about the rows of one mint before a manual write; null when they could not be read. */
type Before = { manual: FxManualRow | null; auto: FxAutoRow | null; readAt: number } | null;

async function rowsBefore(sb: SupabaseClient, network: Network, mint: string): Promise<Before> {
  try {
    const tables = await readFxTables(sb, network, { mint });
    return { manual: tables.manual[0] ?? null, auto: tables.auto[0] ?? null, readAt: Date.now() };
  } catch {
    return null;
  }
}

/** The audit metadata about the rates around a manual write (public prices only). */
function rateContext(before: Before, written: { rate: string | null }) {
  if (!before) return { rows_read: false };
  const freshAuto = before.auto && fxAutoFresh(before.auto, before.readAt) ? before.auto : null;
  const gap = written.rate === null ? null : gapToFreshAuto(written.rate, freshAuto, before.readAt);
  return {
    rows_read: true,
    previous: before.manual
      ? { kind: before.manual.kind, eur_per_token: String(before.manual.eur_per_token), max_age: before.manual.max_age,
          as_of: before.manual.as_of, override_auto: before.manual.override_auto === true }
      : null,
    // The automatic rate that counted at the time (fresh), and how far the manual rate is from it.
    auto_fresh: freshAuto ? { eur_per_token: String(freshAuto.eur_per_token), as_of: freshAuto.as_of } : null,
    auto_deviation_pct: gap === null ? null : Math.round(gap * 10_000) / 100,
  };
}

type AutoLast = { observed_at: string; status: string; code: string | null };

/** One row per mint: the rate that counts, plus what lies behind it. */
async function ratesView(sb: SupabaseClient, network: Network) {
  let tables;
  try {
    tables = await readFxTables(sb, network);
  } catch (err) {
    if (err instanceof FxReadError) throw new SiwsError(500, "Could not load the rates");
    throw err;
  }
  const last = new Map<string, AutoLast>();
  if (tables.autoInstalled) {
    const obs = await sb.from("fx_rate_observations").select("payment_mint,observed_at,status,code")
      .eq("network", network).order("observed_at", { ascending: false }).limit(20)
      .abortSignal(AbortSignal.timeout(8_000));
    // The last run is informative only: an unreadable log hides it, nothing more.
    if (!obs.error) {
      for (const row of (obs.data ?? []) as (AutoLast & { payment_mint: string })[]) {
        if (!last.has(row.payment_mint)) last.set(row.payment_mint, { observed_at: row.observed_at, status: row.status, code: row.code });
      }
    }
  }
  const effective = effectiveRates(tables);
  return [...effective.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, e]) => ({
      ...e.row,
      origin: e.origin,
      fresh: e.fresh,
      manual: tables.manual.find((r) => r.payment_mint === mint) ?? null,
      auto: tables.auto.find((r) => r.payment_mint === mint) ?? null,
      auto_last: last.get(mint) ?? null,
    }));
}

export async function POST(request: Request) {
  try {
    const body = (await request.clone().json().catch(() => null)) as { payload?: { action?: unknown } } | null;
    const isWrite = body?.payload?.action === "adminConfig.fxRatesWrite";
    const { wallet, params, via } = await verifySigned(request, isWrite ? "adminConfig.fxRatesWrite" : "adminConfig.fxRatesRead");
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    if (isWrite) {
      await requireSuperAdmin(wallet);
      const mint = addressParam(params.payment_mint, "payment_mint");
      /** The server audit row of a manual write that succeeded (best effort after it: logged, never a failed answer). */
      const audit = (ixName: "fx_rate_update" | "fx_rate_delete", reason: string, metadata: Record<string, unknown>) =>
        writeServerAudit(sb, {
          ix_name: ixName, category: "launchpad", actor_wallet: wallet, actor_source: actorSourceOf(via),
          reason, target_label: mint, metadata: { network, payment_mint: mint, ...metadata },
        }).catch(() => console.error("[api/admin-config/fx-rates] audit row not written"));
      if (params.op === "delete") {
        const before = await rowsBefore(sb, network, mint);
        const { error } = await sb.from("fx_rates").delete().eq("network", network).eq("payment_mint", mint);
        if (error) throw new SiwsError(500, "Could not delete the rate");
        await audit("fx_rate_delete", `Manual EUR rate of ${paymentMintLabel(mint, network)} deleted`,
          { op: "delete", ...rateContext(before, { rate: null }) });
      } else {
        const kind = params.kind;
        if (kind !== "eur_peg" && kind !== "rate") throw new SiwsError(400, "kind must be eur_peg or rate");
        const rate = kind === "eur_peg" ? "1" : String(params.eur_per_token ?? "");
        if (!RATE_RE.test(rate) || Number(rate) <= 0) throw new SiwsError(400, "eur_per_token must be a positive decimal");
        const source = typeof params.source === "string" ? params.source.trim() : "";
        if (source.length < 1 || source.length > 200) throw new SiwsError(400, "source is required (at most 200 characters)");
        const maxAgeDays = typeof params.max_age_days === "number" ? params.max_age_days : 7;
        if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 90) throw new SiwsError(400, "max_age_days must be 1-90");
        if (params.override_auto !== undefined && typeof params.override_auto !== "boolean") {
          throw new SiwsError(400, "override_auto must be true or false");
        }
        // Only a rate can override the automatic rate; a peg needs no rate at all.
        const overrideAuto = kind === "rate" && params.override_auto === true;
        if (network === "mainnet") {
          assertAllowedPaymentMint(network, mint);
          const required = requiredFxKind(network, mint);
          if (kind !== required) {
            throw new SiwsError(400, `On mainnet the ${paymentMintLabel(mint, network)} rate must be kind ${required}`);
          }
          if (kind === "rate" && maxAgeDays > MAINNET_MAX_RATE_AGE_DAYS) {
            throw new SiwsError(400, `On mainnet max_age_days must be at most ${MAINNET_MAX_RATE_AGE_DAYS}`);
          }
        }
        const { decimals } = await paymentMintInfo(mint, network);
        const before = await rowsBefore(sb, network, mint);
        const now = new Date().toISOString();
        const row: Record<string, unknown> = {
          network, payment_mint: mint, kind, eur_per_token: rate, decimals, source,
          as_of: now, max_age: `${maxAgeDays} days`, updated_by: wallet, updated_at: now,
        };
        // /admin/limits always sends the flag (false clears an earlier override).
        if (typeof params.override_auto === "boolean") row.override_auto = overrideAuto;
        let { error } = await sb.from("fx_rates").upsert(row, { onConflict: "network,payment_mint" });
        // A database before 0080 has no override_auto column (a front deployed
        // ahead of the migration): a plain manual row needs none, so it is
        // written without it; only an actual override has to wait for 0080.
        if (error && "override_auto" in row && undefinedColumn(error)) {
          if (overrideAuto) throw new SiwsError(409, "The automatic rate is not installed yet (migration 0080): save it without the override");
          delete row.override_auto;
          ({ error } = await sb.from("fx_rates").upsert(row, { onConflict: "network,payment_mint" }));
        }
        if (error) throw new SiwsError(500, "Could not save the rate");
        const label = paymentMintLabel(mint, network);
        await audit("fx_rate_update",
          kind === "eur_peg" ? `Manual EUR peg of ${label} saved`
            : `Manual EUR rate of ${label} saved${overrideAuto ? " as an override of the automatic rate" : ""}: ${rate} EUR`,
          {
            op: "upsert", kind, eur_per_token: rate, decimals, source, max_age_days: maxAgeDays, override_auto: overrideAuto,
            // false: a database before 0080 took the row without the column (no override possible there).
            override_column_written: "override_auto" in row,
            ...rateContext(before, { rate: kind === "rate" ? rate : null }),
          });
      }
    } else {
      await requireAdmin(wallet);
    }
    return NextResponse.json({ ok: true, data: await ratesView(sb, network) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
