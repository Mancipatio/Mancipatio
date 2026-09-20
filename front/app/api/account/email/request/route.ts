import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountEmail, accountId } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse, requestAccountEmail } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.email.request");
    accountParams(params, ["email", "account_id"]);
    const network = detectNetwork();
    await requestAccountEmail(request, wallet, network, accountEmail(params.email), accountId(params.account_id));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}
