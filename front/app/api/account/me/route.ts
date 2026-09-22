import { detectNetwork } from "@/lib/network";
import { readActor, actorWho } from "@/lib/server/account-auth";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const actor = await readActor(await boundedRequest(request, 4096), "account.me");
    const params = actor.params;
    const wallet = actorWho(actor);
    accountParams(params, []);
    const network = detectNetwork();
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}

