import { detectNetwork } from "@/lib/network";
import { readActor, actorWho } from "@/lib/server/account-auth";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountDisplayName, accountId } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse, updateAccountName } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const actor = await readActor(await boundedRequest(request, 4096), "account.update");
    const params = actor.params;
    const wallet = actorWho(actor);
    accountParams(params, ["display_name", "account_id"]);
    const network = detectNetwork();
    await updateAccountName(wallet, network, accountDisplayName(params.display_name), accountId(params.account_id));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}
