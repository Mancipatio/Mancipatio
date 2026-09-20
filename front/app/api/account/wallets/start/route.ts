import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountWalletAddress, accountId } from "@/lib/server/account-validation";
import { accountErrorResponse } from "@/lib/server/account-profile";
import { startAccountWalletLink } from "@/lib/server/account-wallets";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.wallets.start");
    accountParams(params, ["target_wallet", "account_id"]);
    const network = detectNetwork();
    return await startAccountWalletLink(wallet, network, accountWalletAddress(params.target_wallet), accountId(params.account_id));
  } catch (error) { return accountErrorResponse(error); }
}
