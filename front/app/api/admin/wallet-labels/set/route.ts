// POST /api/admin/wallet-labels/set — names a wallet on /admin/admins (0092),
// or removes its name ("" label). Super Admin only, with a fresh wallet
// signature (never a session action); each write leaves a server audit row.
// A name grants nothing: roles come from the chain.
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { labelWriteParams, writeWalletLabelRow } from "@/lib/server/admin-wallet-labels";
import { boundedRequest } from "@/lib/server/bounded-request";
import { siwsErrorResponse, verifySigned } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  let response: NextResponse;
  try {
    const { wallet, params, via } = await verifySigned(await boundedRequest(request, 4096), "admin.walletLabelSet");
    await requireSuperAdmin(wallet);
    const { wallet: target, label } = labelWriteParams(params);
    const sb = getSupabaseAdmin();
    const stored = await writeWalletLabelRow(sb, detectNetwork(), target, label, wallet);
    // Best effort: the name is already saved, and it grants nothing.
    await writeServerAudit(sb, {
      ix_name: "admin_wallet_label",
      category: "admins",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: stored === null ? "Wallet name removed" : `Wallet named "${stored}"`,
      target_label: target,
    }).catch(() => undefined);
    response = NextResponse.json({ ok: true, data: { label: stored } });
  } catch (err) {
    response = siwsErrorResponse(err);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
