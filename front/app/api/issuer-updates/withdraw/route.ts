// POST /api/issuer-updates/withdraw — withdraw a PUBLISHED update, with a
// reason. Signed "issuerUpdates.withdraw"; params { id, reason }
// (lib/issuer-updates.ts parseWithdrawReason: 10–500 characters).
//
// Two kinds of caller, checked on chain (fail closed):
//   - the update's issuer authority (requireProfileOwner) withdraws its own
//     update: withdrawn_by_role "issuer";
//   - a platform admin withdraws any update (moderation, ops/runbook-mainnet
//     "Investor relations"): withdrawn_by_role "admin", plus a server audit
//     row (category "issuers", ix_name "issuer_update_withdraw").
// A wallet that is both is recorded as the issuer. The record stays (who,
// when, as what, why; 0090 makes it final) and is served to nobody but the
// issuer and the admins from then on: the public list, the holder read and
// every document link stop at once. A take-down: open in KYC-only mode.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { isProfileAdmin } from "@/lib/server/profile-read";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { parseWithdrawReason } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  isIssuerAuthority,
  loadUpdate,
  parseOrRefuse,
  readUuid,
  recordOf,
  unavailable,
} from "@/lib/server/issuer-updates";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "issuerUpdates.withdraw");
    const id = readUuid(params.id);
    const reason = parseOrRefuse(parseWithdrawReason, params.reason);
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const update = await loadUpdate(sb, id);
    if (!update) throw new SiwsError(404, "Update not found");

    const role = (await isIssuerAuthority(wallet, update.issuer_pda))
      ? "issuer"
      : (await isProfileAdmin(wallet)) ? "admin" : null;
    if (!role) throw new SiwsError(403, "Only the issuer or a platform admin can withdraw this update");
    if (update.status === "withdrawn") throw new SiwsError(409, "This update is already withdrawn");
    if (update.status !== "published") throw new SiwsError(409, "A draft is discarded, not withdrawn");

    const { data, error } = await sb.from(UPDATES_TABLE)
      .update({ status: "withdrawn", withdrawn_by: wallet, withdrawn_by_role: role, withdrawn_reason: reason })
      .eq("network", detectNetwork()).eq("id", id).eq("status", "published")
      .select("id").maybeSingle();
    if (error) unavailable();
    if (!data) throw new SiwsError(409, "This update was withdrawn meanwhile. Reload it.");

    if (role === "admin") {
      // Moderation is recorded on the row itself; the audit row is the
      // operator's trail beside it (best effort: the withdrawal stands).
      try {
        await writeServerAudit(sb, {
          ix_name: "issuer_update_withdraw",
          category: "issuers",
          actor_wallet: wallet,
          actor_source: actorSourceOf(via),
          reason: `Withdrew an issuer update: ${reason}`,
          target_label: `issuer-update:${id}`,
          metadata: { update_id: id, issuer_pda: update.issuer_pda, asset_pda: update.asset_pda, title: update.title },
        });
      } catch {
        console.error("[api/issuer-updates/withdraw] audit row not written for", id);
      }
    }
    return NextResponse.json({ ok: true, data: { update: await recordOf(sb, id) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
