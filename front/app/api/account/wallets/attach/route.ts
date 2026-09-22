// POST /api/account/wallets/attach — add the connected wallet to the account
// the browser is signed in to (email/Google). Needs BOTH: a fresh wallet
// signature ("account.wallets.attach", proves wallet ownership) and the live
// account session cookie (proves account ownership).

import { detectNetwork } from "@/lib/network";
import { verifySigned, SiwsError } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountId } from "@/lib/server/account-validation";
import { accountErrorResponse, accountResponse } from "@/lib/server/account-profile";
import { attachAccountWallet } from "@/lib/server/account-wallets";
import { readAccountSession } from "@/lib/server/account-auth";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const bounded = await boundedRequest(request, 4096);
    const session = readAccountSession(bounded);
    if (!session) throw new SiwsError(401, "Sign in to your account first, then add the wallet.");
    const { wallet, params } = await verifySigned(bounded, "account.wallets.attach");
    accountParams(params, ["account_id"]);
    if (accountId(params.account_id) !== session.a) throw new SiwsError(403, "You are signed in to a different account.");
    const network = detectNetwork();
    await attachAccountWallet(session.a, network, wallet);
    // An account that already went through identity verification asks for
    // the on-chain passport of the new wallet (issued from /admin/kyc).
    const sb = getSupabaseAdmin();
    const { data: dossier } = await sb.from("clients").select("id,jurisdiction,kyc_status,type,types")
      .eq("account_id", session.a).eq("network", network).maybeSingle();
    const roles = dossier ? (Array.isArray(dossier.types) && dossier.types.length ? dossier.types : [dossier.type]) : [];
    if (dossier && roles.includes("investor") && !["suspended", "rejected"].includes(dossier.kyc_status)) {
      const { data: open } = await sb.from("passport_requests").select("id").eq("wallet", wallet).in("status", ["new", "in_review"]).limit(1);
      const jurisdiction = Number.parseInt(String(dossier.jurisdiction ?? ""), 10);
      if ((!open || open.length === 0) && Number.isInteger(jurisdiction) && jurisdiction > 0) {
        await sb.from("passport_requests").insert({ wallet, jurisdiction, note: "Wallet added to a verified account" });
      }
    }
    return await accountResponse({ accountId: session.a }, network);
  } catch (error) { return accountErrorResponse(error); }
}
