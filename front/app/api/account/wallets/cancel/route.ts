import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountEmailToken, accountId, accountWalletAddress } from "@/lib/server/account-validation";
import { accountErrorResponse } from "@/lib/server/account-profile";
import { cancelAccountWalletLink } from "@/lib/server/account-wallets";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.wallets.cancel");
    accountParams(params, ["token", "account_id", "requested_by", "target_wallet"]);
    await cancelAccountWalletLink(wallet, detectNetwork(), {
      token: accountEmailToken(params.token), account_id: accountId(params.account_id),
      requested_by: accountWalletAddress(params.requested_by), target_wallet: accountWalletAddress(params.target_wallet),
    });
    return NextResponse.json({ ok: true, data: { cancelled: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return accountErrorResponse(error); }
}
