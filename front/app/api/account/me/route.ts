import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.me");
    accountParams(params, []);
    const network = detectNetwork();
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}

