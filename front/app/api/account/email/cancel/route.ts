import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountId } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse, cancelAccountEmail } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.email.cancel");
    accountParams(params, ["account_id"]);
    const network = detectNetwork();
    await cancelAccountEmail(wallet, network, null, accountId(params.account_id));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}
