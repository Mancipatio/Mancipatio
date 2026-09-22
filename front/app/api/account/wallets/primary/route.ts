import { detectNetwork } from "@/lib/network";
import { readActor, actorWho } from "@/lib/server/account-auth";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountWalletAddress, accountId } from "@/lib/server/account-validation";
import { accountErrorResponse, accountResponse } from "@/lib/server/account-profile";
import { setAccountPrimaryWallet } from "@/lib/server/account-wallets";

export async function POST(request: Request) {
  try {
    const actor = await readActor(await boundedRequest(request, 4096), "account.wallets.primary");
    const params = actor.params;
    const wallet = actorWho(actor);
    accountParams(params, ["wallet", "account_id"]);
    const network = detectNetwork();
    await setAccountPrimaryWallet(wallet, network, accountWalletAddress(params.wallet), accountId(params.account_id));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}
