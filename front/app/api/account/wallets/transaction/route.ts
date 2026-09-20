import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams } from "@/lib/server/account-validation";
import { accountErrorResponse, getAccountProfile } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.wallets.transaction");
    accountParams(params, []);
    const network = detectNetwork();
    const profile = await getAccountProfile(wallet, network);
    return NextResponse.json({ ok: true, data: {
      wallet, network, account_id: profile.id, primary_wallet: profile.primary_wallet,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return accountErrorResponse(error); }
}

