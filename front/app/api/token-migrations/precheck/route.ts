// POST /api/token-migrations/precheck — the holder's last check before its
// wallet signs a deposit into an open token migration (lib/token-migration).
// The holder page builds the deposit from this answer: [create the deposit
// account (idempotent), the memo manci:migration:v1:<id>:<lots>,
// TransferChecked of exactly lots × lot from the holder's own token
// account]. The deposit itself is a plain SPL transfer that no Manci program
// sees and no pause bit covers, so THIS route is the platform's gate:
//   - the pilot module first (lib/features.ts tokenMigration: 403 before
//     the signature and before any database or chain work while it is off,
//     KYC-only mode included);
//   - the signer (a wallet session is enough: a session read like
//     compliance.screenWallet, whose only write is the compliance alert of a
//     hit on the caller's own wallet);
//   - the campaign is open and the window has started and not ended;
//   - the wallet is not one of the excluded wallets (their tokens were left
//     out of the qualified supply, so they cannot claim units);
//   - the sanctions screen of the signing wallet (lib/server/sanctions.ts:
//     403 on a hit, 503 on mainnet while the list cannot answer);
//   - the units cap still has room for the lots (deposits recorded so far);
//   - the wallet's own associated token account holds the amount (read from
//     chain at confirmed; 503 when it cannot be read) and is not frozen;
//   - on mainnet, the Terms in force accepted (lib/server/tos-gate.ts), last.
// Passing the precheck reserves nothing: two holders may race for the last
// units, and the one recorded second is recorded over the cap and refunded
// (record_token_migration_deposit). The record route verifies the deposit
// on chain whatever this route said.

import { NextResponse } from "next/server";
import { requireModule } from "@/lib/server/feature-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireSanctionsClear } from "@/lib/server/sanctions";
import { requireAcceptedTos } from "@/lib/server/tos-gate";
import { positiveIntegerParam, readDeposits, readMigration, unitsTaken, uuidParam } from "@/lib/server/token-migrations";
import { readHolderBalance } from "@/lib/server/token-migration-chain";
import { migrationMemoText, windowStateAt } from "@/lib/token-migration/model";
import { formatBaseUnits, formatUnits, U64_MAX } from "@/lib/token-migration/ratio";

export async function POST(request: Request) {
  try {
    // Pilot scope (lib/features.ts): the holder's entry into a token migration.
    requireModule("tokenMigration");
    const { wallet, params } = await verifySigned(request, "tokenMigration.precheck");
    const migrationId = uuidParam(params.migration_id, "migration_id");
    const sb = getSupabaseAdmin();
    const migration = await readMigration(sb, migrationId);
    const lot = BigInt(migration.lot_base_units);
    const lots = positiveIntegerParam(params.lots, "lots", U64_MAX / lot);
    const amount = lots * lot;
    const symbol = migration.old_symbol;

    if (migration.status !== "open") throw new SiwsError(409, "This campaign is not open for deposits");
    const window = windowStateAt(migration.window_opens_at, migration.window_closes_at, Date.now());
    if (window === "not_yet") throw new SiwsError(409, `The opt-in window opens on ${new Date(migration.window_opens_at).toUTCString()}`);
    if (window === "ended") throw new SiwsError(409, `The opt-in window closed on ${new Date(migration.window_closes_at).toUTCString()}`);
    if (migration.excluded_wallets.includes(wallet)) {
      throw new SiwsError(403, "This wallet is excluded from the campaign: its tokens were left out of the qualified supply, so they cannot be exchanged");
    }

    await requireSanctionsClear(sb, { route: "token-migrations/precheck", wallets: [{ wallet, role: "self" }] });

    const left = BigInt(migration.units_cap) - unitsTaken(await readDeposits(sb, [migration.id]));
    if (left <= BigInt(0)) throw new SiwsError(409, "Every unit of this campaign is already claimed");
    if (lots > left) throw new SiwsError(409, `Only ${formatUnits(left)} units are left in this campaign; deposit at most ${formatUnits(left)} lots`);

    const balance = await readHolderBalance({ holder: wallet, oldMint: migration.old_mint, program: migration.old_token_program });
    if (balance.frozen) throw new SiwsError(409, `Your ${symbol} token account is frozen, so it cannot send a deposit`);
    if (balance.amount < amount) {
      throw new SiwsError(400, `Your wallet holds ${formatBaseUnits(balance.amount, migration.old_decimals)} ${symbol} in its main token account, less than ${formatUnits(lots)} lots (${formatBaseUnits(amount, migration.old_decimals)} ${symbol})`);
    }

    await requireAcceptedTos(sb, wallet, "depositing into a token migration");

    return NextResponse.json(
      {
        ok: true,
        data: {
          migration_id: migration.id,
          lots: lots.toString(),
          amount_base: amount.toString(),
          units: lots.toString(),
          deposit_owner: migration.deposit_owner,
          deposit_ata: migration.deposit_ata,
          old_mint: migration.old_mint,
          old_token_program: migration.old_token_program,
          old_decimals: migration.old_decimals,
          memo: migrationMemoText(migration.id, lots),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
