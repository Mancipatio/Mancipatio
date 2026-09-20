import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountEmailToken } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse, verifyAccountEmail } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.email.verify");
    accountParams(params, ["token"]);
    const network = detectNetwork();
    await verifyAccountEmail(wallet, network, accountEmailToken(params.token));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}

