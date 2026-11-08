// POST /api/token-migrations/admin/inspect — the admin calculator's chain
// read, before a draft is saved: the old mint's verdict (program, decimals,
// supply, authorities, extensions, and the V1 refusals with their reasons:
// lib/token-migration/old-mint.ts), the balance behind each excluded address,
// and, when given, the share class the campaign would deliver (verified on
// chain). Admin only (on-chain admin gate after the signature). A session
// read: it reads the chain and writes nothing; the save route reads it all
// again, so nothing shown here is trusted later.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { addressListParam, addressText } from "@/lib/server/token-migrations";
import { readExcludedBalances, readOldMint, readShareClassFacts } from "@/lib/server/token-migration-chain";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "tokenMigration.adminInspect");
    await requireAdmin(wallet);
    const oldMint = addressText(params.old_mint, "old_mint");
    const excludedWallets = addressListParam(params.excluded_wallets, "excluded_wallets", 100);
    const shareClassPda = params.share_class_pda === undefined || params.share_class_pda === null || params.share_class_pda === ""
      ? null
      : addressText(params.share_class_pda, "share_class_pda");

    const verdict = await readOldMint(oldMint);
    const excluded = await readExcludedBalances(oldMint, verdict.tokenProgram, excludedWallets);
    const shareClass = shareClassPda ? await readShareClassFacts(shareClassPda) : null;
    return NextResponse.json(
      {
        ok: true,
        data: {
          old_mint: {
            ok: verdict.ok,
            token_program: verdict.tokenProgram,
            decimals: verdict.decimals,
            supply: verdict.supply.toString(),
            mint_authority: verdict.mintAuthority,
            freeze_authority: verdict.freezeAuthority,
            extensions: verdict.extensions,
            refusals: verdict.refusals,
            warnings: verdict.warnings,
          },
          excluded: excluded.map((e) => ({ address: e.address, kind: e.kind, amount: e.amount.toString() })),
          excluded_total: excluded.reduce((sum, e) => sum + e.amount, BigInt(0)).toString(),
          share_class: shareClass
            ? { ...shareClass, maxSupply: shareClass.maxSupply === null ? null : shareClass.maxSupply.toString() }
            : null,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
