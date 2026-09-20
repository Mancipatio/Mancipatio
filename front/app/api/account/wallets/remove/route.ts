import { detectNetwork } from "@/lib/network";
import { verifySigned } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountWalletAddress, accountId } from "@/lib/server/account-validation";
import { accountErrorResponse, accountResponse } from "@/lib/server/account-profile";
import { removeAccountWallet } from "@/lib/server/account-wallets";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "account.wallets.remove");
    accountParams(params, ["wallet", "account_id"]);
    const network = detectNetwork();
    await removeAccountWallet(wallet, network, accountWalletAddress(params.wallet), accountId(params.account_id));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}
