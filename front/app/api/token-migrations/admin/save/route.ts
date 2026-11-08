// POST /api/token-migrations/admin/save — an Admin creates a token migration
// draft, or edits one (only while it is a draft: migration 0085 freezes what
// a campaign published once it opens). Signed with a fresh signature, admin
// gate on chain right after it. Usable in KYC-only mode like the rest of the
// admin console: a draft is preparation, not a holder-facing entry (opening
// the campaign is, admin/transition).
//
// Nothing from the browser's calculator is trusted: the server reads again,
// at confirmed, the share class (registry-owned, initialized 0-decimal
// Token-2022 mint, its asset and issuer PDAs), the old mint (refused with
// the reason for an extension V1 cannot handle: lib/token-migration/
// old-mint.ts) and the balance behind each excluded address, then computes
// the ratio with lib/token-migration/ratio.ts (the lot rounded up so the
// effective equity never exceeds E) and derives the deposit account (the
// deposit owner's ATA of the old mint; a Squads vault, a program address
// off the curve, is allowed and recommended). The database CHECKs repeat the
// ratio's invariants and the 60–90 day window.

import { NextResponse } from "next/server";
import { isOffCurveAddress, address } from "@solana/kit";
import { requireAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  addressListParam,
  addressText,
  baseUnitsParam,
  dbFailure,
  instantParam,
  MIGRATIONS,
  slugParam,
  textParam,
  uuidParam,
} from "@/lib/server/token-migrations";
import { readExcludedBalances, readOldMint, readShareClassFacts } from "@/lib/server/token-migration-chain";
import {
  MIGRATION_SOURCES,
  SHA256_HEX_RE,
  UNCLAIMED_POLICIES,
  validWindow,
  WINDOW_MAX_DAYS,
  WINDOW_MIN_DAYS,
  type MigrationSource,
  type UnclaimedPolicy,
} from "@/lib/token-migration/model";
import { computeMigrationRatio, formatUnits, MIGRATION_GRANULARITIES, RatioInputError } from "@/lib/token-migration/ratio";
import { MIGRATION_SELECT, parseMigrationRow } from "@/lib/token-migration/rows";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";

export const maxDuration = 60;

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new SiwsError(400, `${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function equityParam(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new SiwsError(400, "equity_bps must be a whole number of basis points between 1 and 10000");
  }
  return value;
}

function granularityParam(value: unknown): bigint {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : typeof value === "string" && /^\d{1,9}$/.test(value) ? BigInt(value) : null;
  if (raw === null || !MIGRATION_GRANULARITIES.includes(raw)) {
    throw new SiwsError(400, "granularity must be 10000, 100000, 1000000 or 10000000");
  }
  return raw;
}

function termsHashParam(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value.trim().toLowerCase())) {
    throw new SiwsError(400, "terms_doc_sha256 must be the document's SHA-256 as 64 hexadecimal characters");
  }
  return value.trim().toLowerCase();
}

function termsUrlParam(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let url: URL;
  try {
    if (typeof value !== "string" || value.length > 500) throw new Error();
    url = new URL(value.trim());
  } catch {
    throw new SiwsError(400, "terms_doc_url must be an https link of at most 500 characters");
  }
  if (url.protocol !== "https:" || url.username || url.password || /\s/.test(url.href)) {
    throw new SiwsError(400, "terms_doc_url must be an https link of at most 500 characters");
  }
  return url.href;
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "tokenMigration.adminSave");
    await requireAdmin(wallet);

    const id = params.id === undefined || params.id === null ? null : uuidParam(params.id, "id");
    const slug = slugParam(params.slug);
    const companyName = textParam(params.company_name, "company_name", { min: 1, max: 120 });
    const shareClassPda = addressText(params.share_class_pda, "share_class_pda");
    const oldMint = addressText(params.old_mint, "old_mint");
    const oldSymbol = textParam(params.old_symbol, "old_symbol", { min: 1, max: 16 });
    const oldName = textParam(params.old_name, "old_name", { min: 1, max: 80 });
    const excludedWallets = addressListParam(params.excluded_wallets, "excluded_wallets", 100);
    const excludedManual = baseUnitsParam(params.excluded_manual_amount, "excluded_manual_amount");
    const excludedNote = params.excluded_note === undefined || params.excluded_note === null ? "" : textParam(params.excluded_note, "excluded_note", { min: 0, max: 2000 });
    const equityBps = equityParam(params.equity_bps);
    const granularity = granularityParam(params.granularity);
    const source = oneOf<MigrationSource>(params.source, "source", MIGRATION_SOURCES);
    const unclaimedPolicy = oneOf<UnclaimedPolicy>(params.unclaimed_policy, "unclaimed_policy", UNCLAIMED_POLICIES);
    const depositOwner = addressText(params.deposit_owner, "deposit_owner");
    const treasuryWallet = addressText(params.treasury_wallet, "treasury_wallet");
    const opensAt = instantParam(params.window_opens_at, "window_opens_at");
    const closesAt = instantParam(params.window_closes_at, "window_closes_at");
    const termsSha = termsHashParam(params.terms_doc_sha256);
    const termsUrl = termsUrlParam(params.terms_doc_url);
    if (!validWindow(opensAt, closesAt)) {
      throw new SiwsError(400, `The opt-in window must last between ${WINDOW_MIN_DAYS} and ${WINDOW_MAX_DAYS} days`);
    }
    if (Date.parse(closesAt) <= Date.now()) throw new SiwsError(400, "The opt-in window must end in the future");
    if (excludedWallets.includes(depositOwner)) throw new SiwsError(400, "The deposit owner cannot be an excluded wallet");

    // The chain, read again (never the calculator's numbers).
    const shareClass = await readShareClassFacts(shareClassPda);
    const verdict = await readOldMint(oldMint);
    if (!verdict.ok) {
      throw new SiwsError(409, `This token cannot be migrated by V1: ${verdict.refusals.map((r) => r.reason).join(" ")}`);
    }
    if (oldMint === shareClass.mint) throw new SiwsError(400, "The old token cannot be the share class's own mint");
    const excluded = await readExcludedBalances(oldMint, verdict.tokenProgram, excludedWallets);
    const excludedWalletAmount = excluded.reduce((sum, e) => sum + e.amount, BigInt(0));
    let ratio;
    try {
      ratio = computeMigrationRatio({
        oldTotalSupply: verdict.supply,
        excludedAmount: excludedWalletAmount + excludedManual,
        equityBps,
        granularity,
        decimals: verdict.decimals,
      });
    } catch (err) {
      if (err instanceof RatioInputError) throw new SiwsError(400, err.message);
      throw err;
    }
    if (ratio.unitsCap < BigInt(1)) throw new SiwsError(409, ratio.warnings[0]?.text ?? "No unit could be delivered with these figures");
    if (shareClass.maxSupply !== null && shareClass.maxSupply < ratio.unitsCap) {
      throw new SiwsError(409, `The share class's supply cap (${formatUnits(shareClass.maxSupply)} units) is below the campaign's units cap (${formatUnits(ratio.unitsCap)})`);
    }
    const depositAta = await associatedTokenAccount(depositOwner, oldMint, verdict.tokenProgram);

    const warnings = [...verdict.warnings, ...ratio.warnings.map((w) => w.text)];
    if (depositOwner === wallet) {
      warnings.push("The deposit owner is your own wallet: one key could then move every deposit. A Squads vault is recommended.");
    } else if (!isOffCurveAddress(address(depositOwner))) {
      warnings.push("The deposit owner is a regular wallet, not a program address: a Squads vault is recommended so no single key holds the deposits.");
    }
    for (const e of excluded) if (e.amount === BigInt(0)) warnings.push(`The excluded address ${e.address} holds none of this token.`);

    const row = {
      slug,
      company_name: companyName,
      issuer_pda: shareClass.issuer,
      asset_pda: shareClass.asset,
      share_class_pda: shareClass.shareClass,
      new_mint: shareClass.mint,
      old_chain: "solana",
      old_mint: oldMint,
      old_token_program: verdict.tokenProgram,
      old_decimals: verdict.decimals,
      old_symbol: oldSymbol,
      old_name: oldName,
      old_total_supply: verdict.supply.toString(),
      excluded_wallets: excludedWallets,
      excluded_wallet_amount: excludedWalletAmount.toString(),
      excluded_manual_amount: excludedManual.toString(),
      excluded_amount: (excludedWalletAmount + excludedManual).toString(),
      excluded_note: excludedNote,
      supply_read_at: new Date().toISOString(),
      equity_bps: equityBps,
      granularity: Number(granularity),
      lot_base_units: ratio.lot.toString(),
      units_cap: ratio.unitsCap.toString(),
      source,
      unclaimed_policy: unclaimedPolicy,
      deposit_owner: depositOwner,
      deposit_ata: depositAta,
      window_opens_at: opensAt,
      window_closes_at: closesAt,
      terms_doc_sha256: termsSha,
      terms_doc_url: termsUrl,
      treasury_wallet: treasuryWallet,
      updated_by: wallet,
    };
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    let saved: unknown;
    if (id === null) {
      const { data, error } = await sb.from(MIGRATIONS).insert({ ...row, network, created_by: wallet }).select(MIGRATION_SELECT).single();
      if (error?.code === "23505") throw new SiwsError(409, "That address (slug) is already taken by another campaign");
      if (error || !data) dbFailure(error, "draft");
      saved = data;
    } else {
      const { data, error } = await sb.from(MIGRATIONS).update(row).eq("network", network).eq("id", id).eq("status", "draft").select(MIGRATION_SELECT).maybeSingle();
      if (error?.code === "23505") throw new SiwsError(409, "That address (slug) is already taken by another campaign");
      if (error) dbFailure(error, "draft");
      if (!data) throw new SiwsError(409, "Only a draft can be edited: this campaign has opened, or it does not exist");
      saved = data;
    }
    const migration = parseMigrationRow(saved);

    try {
      await writeServerAudit(sb, {
        ix_name: id === null ? "token_migration_draft_create" : "token_migration_draft_update",
        category: "share-class",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: `Token migration draft ${slug}: ${formatUnits(ratio.unitsCap)} units, lot ${ratio.lot.toString()} base units`,
        target_label: shareClass.shareClass,
        metadata: { migration_id: migration.id, slug, old_mint: oldMint, equity_bps: equityBps, granularity: Number(granularity), lot_base_units: ratio.lot.toString(), units_cap: ratio.unitsCap.toString() },
      });
    } catch {
      // Best effort: the draft row itself is the record.
    }

    return NextResponse.json(
      { ok: true, data: { migration, warnings, excluded: excluded.map((e) => ({ address: e.address, kind: e.kind, amount: e.amount.toString() })) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
