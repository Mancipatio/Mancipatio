import { detectNetwork } from "@/lib/network";
import { readActor, actorWho } from "@/lib/server/account-auth";
import { boundedRequest } from "@/lib/server/bounded-request";
import { accountParams, accountEmailToken } from "@/lib/server/account-validation";
import { accountResponse, accountErrorResponse, verifyAccountEmail } from "@/lib/server/account-profile";

export async function POST(request: Request) {
  try {
    const actor = await readActor(await boundedRequest(request, 4096), "account.email.verify");
    const params = actor.params;
    const wallet = actorWho(actor);
    accountParams(params, ["token"]);
    const network = detectNetwork();
    await verifyAccountEmail(wallet, network, accountEmailToken(params.token));
    return await accountResponse(wallet, network);
  } catch (error) { return accountErrorResponse(error); }
}

