/**
 * One step of one user: the account setup first, then the cohort's machine.
 * Errors that are not HTTP statuses (a failed simulation, an unresolved
 * signature, a builder refusing the state) are journalled and retried with
 * a backoff; a SimStopError ends the whole run.
 */
import { ChainAbortError, ChainGateError } from "@/scripts/chain/lib/safety";
import { SimRetryLater, SimTxError } from "../chain";
import { SimStopError } from "../safety";
import type { UserState } from "../state";
import { finish, retry, setupStep, type SimCtx } from "./common";
import { edgeStep } from "./edge";
import { buyStep } from "./investor";
import { issuerStep } from "./issuer";
import { dossierStep } from "./kyc";
import { traderStep } from "./trader";
import { transferStep } from "./transfer";

// transferStep handles its own failures (cohort X never strands lent units).
const MACHINES = [setupStep, dossierStep, issuerStep, buyStep, traderStep, edgeStep, transferStep];

export async function advance(ctx: SimCtx, u: UserState): Promise<void> {
  if (u.terminal) return;
  try {
    for (const machine of MACHINES) if (await machine(ctx, u)) return;
    finish(u, "failed", `unknown stage ${u.stage}`);
  } catch (error) {
    if (error instanceof SimStopError || error instanceof ChainAbortError) throw error;
    if (error instanceof SimRetryLater) {
      u.notBefore = ctx.now() + 60_000;
      return;
    }
    if (error instanceof SimTxError) return retry(ctx, u, error.message);
    // A builder or RPC refusal (public text only), e.g. "Sale share class and mint could not be verified".
    const message = error instanceof ChainGateError || error instanceof Error ? error.message : "unexpected error";
    ctx.journal.append({
      wave: u.plan.wave,
      user: u.plan.label,
      cohort: u.plan.cohort,
      step: u.stage,
      kind: "note",
      outcome: "tx-error",
      err: message.slice(0, 500),
    });
    retry(ctx, u, message.slice(0, 200));
  }
}
