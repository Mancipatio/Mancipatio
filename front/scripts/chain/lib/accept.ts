/**
 * Tool 7: `chain:accept`. The bootstrap steps a role key signs itself, on
 * the CLI with that key's Ledger (or its keypair file), without the operator
 * front, SIWS or the database:
 *
 *   op                             step  instruction                       signer (role map)
 *   add-admin                      A3    add_admin (signed by the NEW key)  a key of admins[]
 *   accept-blocklist-authority     X3    accept_blocklist_authority         blocklistAuthority
 *   accept-kyc-registry-authority  X2    accept_kyc_registry_authority      kyc.authority
 *   accept-platform-admin          X1    accept_platform_admin              superAdmin
 *   close-bootstrap-window         S5c   set_pause_flags(0, 0x80)           superAdmin
 *   first-unpause                  S6    set_pause_flags(0, unpauseMask)    superAdmin
 *
 * Why a CLI path: the front asks every wallet for a SIWS message signature
 * before it lets it send a transaction, and a Ledger behind Phantom or
 * Solflare cannot sign an off-chain message. The Ledger Solana app does sign
 * transactions (blind signing for our programs), so these steps talk to the
 * device directly through ./ledger.ts, as chain:emergency does.
 *
 * Each op is the chain:bootstrap step of the same id: planRoleStep plans it
 * from the bootstrap's own step definitions (skip, waits-for, proposal window
 * and preconditions), judged against the chain alone. So A3 lands before X1
 * (X1 makes the deployer's staged grants stale), X1 before S5c, and every role
 * step before S6, the first unpause. An expired, stale or foreign proposal,
 * or none, is refused before any signature; `chain:bootstrap` proposes again.
 * The signer must be the role map's key for the op (CHAIN_ACCEPT_SIGNER,
 * typed out); the plan digest carries the role map's sha256.
 *
 * A dry run (the default) probes at finalized, simulates and prints the
 * digest; a send needs CHAIN_SEND=1, CHAIN_CONFIRM_PLAN=<digest> and one
 * signer, CHAIN_SIGNER (`usb://ledger?key=N`: the device must answer with the
 * expected key) or CHAIN_KEYPAIR. The send re-probes, re-checks the steps it
 * waits for and the window, simulates the signed transaction with signature
 * verification, journals, sends and checks the result at finalized, through
 * the same pipeline as the other tools. On mainnet the guarded source must be
 * clean and the live canonical IDL must define the instruction exactly as
 * front/idl does, without the overrides chain:emergency has (nothing here is
 * an incident). The live Release tag (v1.0.0-rc.1) predates this tool, so a
 * mainnet run comes from the reviewed commit that has it, whose program,
 * front/idl and front/lib equal that tag (runbook §5, "Which checkout").
 */
import { createNoopSigner, isAddress, type Address } from "@solana/kit";
import { getAdminSize } from "@/lib/generated/asset_registry";
import { formatPauseFlags } from "@/lib/pause-flags";
import {
  FEE_MARGIN,
  ROLE_STEP_OPS,
  SIGNATURE_FEE,
  bootstrapWindowLine,
  planBootstrap,
  planRoleStep,
  probeBootstrapState,
  roleStepOp,
  type BootstrapState,
  type RoleStepOp,
} from "./bootstrap-plan";
import type { ToolContext, ToolStatus } from "./context";
import { checkInstructionIdl, guardMainnetSource, loadRoleSigner } from "./emergency";
import { loadRoleMap, type RoleMap } from "./role-map";
import { ChainGateError, ChainPlanError, type ProgramName } from "./safety";
import {
  buildMessage,
  executePlan,
  planDigest,
  simulateUnsigned,
  summarizeSimulation,
  type StepRecord,
} from "./tx";

export const ACCEPT_OPS = Object.keys(ROLE_STEP_OPS) as RoleStepOp[];

/**
 * Where a mainnet chain:accept run comes from (its source and IDL refusals
 * name it): not the live Release tag, which predates the tool.
 */
export const ACCEPT_CHECKOUT = "the reviewed chain:accept commit whose program, front/idl and front/lib equal the live Release tag (runbook §5, Which checkout)";

export type AcceptRequest = { op: RoleStepOp; signer: Address };

/** Reads CHAIN_ACCEPT_OP and CHAIN_ACCEPT_SIGNER (the role key, typed out). */
export function readAcceptRequest(env: ToolContext["env"]): AcceptRequest {
  const op = env.CHAIN_ACCEPT_OP?.trim() as RoleStepOp | undefined;
  if (!op || !ACCEPT_OPS.includes(op)) throw new ChainGateError(`CHAIN_ACCEPT_OP must be one of ${ACCEPT_OPS.join(", ")}`);
  const signer = env.CHAIN_ACCEPT_SIGNER?.trim();
  if (!signer || !isAddress(signer) || signer === "11111111111111111111111111111111") {
    throw new ChainGateError("CHAIN_ACCEPT_SIGNER must be a valid address (the role key that signs)");
  }
  return { op, signer };
}

export type AcceptTarget = {
  /** The bootstrap step id (`A3:<key>`, `A3k`, X3, X2, X1, S5c, S6). */
  stepId: string;
  role: string;
  program: ProgramName;
  instruction: string;
  /** Account sizes the signer pays rent for (its new Admin record). */
  rentSizes: number[];
};

/**
 * The step `req.op` runs and the role it needs. Refuses a signer that is not
 * the role map's key for that role, and an op the map does not have.
 */
export function acceptTarget(req: AcceptRequest, map: RoleMap): AcceptTarget {
  const S = req.signer;
  const must = (key: Address, role: string) => {
    if (S !== key) throw new ChainGateError(`${req.op}: ${S} is not the role map's ${role} (${key})`);
  };
  const registry = (stepId: string, role: string, instruction: string, rentSizes: number[] = []): AcceptTarget => ({
    stepId,
    role,
    program: "asset_registry",
    instruction,
    rentSizes,
  });
  switch (req.op) {
    case "add-admin":
      if (map.admins.includes(S)) return registry(`A3:${S}`, "admin", "add_admin", [getAdminSize()]);
      if (map.kyc.tempAdminGrant && S === map.kyc.authority) {
        return registry("A3k", "kyc.authority (temporary Admin grant)", "add_admin", [getAdminSize()]);
      }
      throw new ChainGateError(`add-admin: ${S} is not an Admin of the role map (admins[]: ${map.admins.join(", ") || "none"})`);
    case "accept-blocklist-authority":
      must(map.blocklistAuthority, "blocklistAuthority");
      return { stepId: "X3", role: "blocklistAuthority", program: "transfer_hook", instruction: "accept_blocklist_authority", rentSizes: [] };
    case "accept-kyc-registry-authority":
      must(map.kyc.authority, "kyc.authority");
      return registry("X2", "kyc.authority", "accept_kyc_registry_authority");
    case "accept-platform-admin":
      must(map.superAdmin, "superAdmin");
      if (map.superAdmin === map.deployer) throw new ChainGateError("accept-platform-admin: the deployer is the super admin in this role map; there is no X1");
      // The accept closes the old Admin record and creates the super admin's.
      return registry("X1", "superAdmin", "accept_platform_admin", [getAdminSize()]);
    case "close-bootstrap-window":
      must(map.superAdmin, "superAdmin");
      return registry("S5c", "superAdmin", "set_pause_flags");
    case "first-unpause":
      must(map.superAdmin, "superAdmin");
      if (map.unpauseBy === "deployer" || map.superAdmin === map.deployer) {
        throw new ChainGateError("first-unpause: this role map unpauses by the deployer (S6d, a chain:bootstrap step)");
      }
      return registry("S6", "superAdmin", "set_pause_flags");
    default:
      throw new ChainGateError(`unknown accept op ${String(req.op)}`);
  }
}

/**
 * The next bootstrap actions: the deployer's next cycle, and each role step
 * with its chain:accept command, marked `now` when planRoleStep accepts it
 * against the chain as it is, else `later` with the reason (often the
 * deployer's cycle it waits for).
 */
async function nextActions(ctx: ToolContext, state: BootstrapState, map: RoleMap) {
  const plan = await planBootstrap(state, map, { deployer: createNoopSigner(map.deployer), rehearsal: {} }, {
    rpc: ctx.rpc,
    handover: { requested: false, confirmVault: null, whilePaused: false, inventoryBlockers: null },
  });
  const roleSteps = [];
  for (const action of plan.awaiting) {
    const op = roleStepOp(action.id);
    let blocker: string | null = null;
    if (op) {
      try {
        await planRoleStep(state, map, action.id, createNoopSigner(action.key), ctx.rpc);
      } catch (error) {
        if (!(error instanceof ChainPlanError)) throw error;
        blocker = error.message;
      }
    }
    roleSteps.push({ id: action.id, op, key: action.key, now: op !== null && blocker === null, blocker });
  }
  const next = {
    deployerSteps: plan.steps.map((step) => step.id),
    roleSteps,
    waiting: plan.blocked,
    handover: plan.handover,
    stops: plan.stops,
  };
  if (next.deployerSteps.length) ctx.log(`next: chain:bootstrap (deployer) plans ${next.deployerSteps.join(", ")}`);
  for (const step of roleSteps) {
    if (!step.op) ctx.log(`next: ${step.id}: the super admin ${step.key} on the operator front`);
    else if (step.now) ctx.log(`next: ${step.id}: CHAIN_ACCEPT_OP=${step.op} CHAIN_ACCEPT_SIGNER=${step.key} npm run chain:accept`);
    else ctx.log(`later: ${step.id} (CHAIN_ACCEPT_OP=${step.op}): ${step.blocker}`);
  }
  for (const wait of next.waiting) ctx.log(`waiting: ${wait.id}: ${wait.reason}`);
  if (!next.deployerSteps.length && !roleSteps.length && next.handover.reason) ctx.log(`next: S7 (handover): ${next.handover.reason}`);
  return next;
}

export async function acceptTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  const req = readAcceptRequest(ctx.env);
  evidence.request = req;
  const loaded = await loadRoleMap(config.roleMapPath!, { network: config.network, genesis: config.expectedGenesis });
  const map = loaded.map;
  evidence.roleMapSha256 = loaded.sha256;
  evidence.roleMapWarnings = loaded.warnings;
  for (const warning of loaded.warnings) ctx.log(`warning: ${warning}`);
  const target = acceptTarget(req, map);
  evidence.step = target.stepId;
  evidence.role = target.role;
  // The mainnet source guard of the other sending tools, with no override.
  guardMainnetSource(ctx, null, ACCEPT_CHECKOUT);
  ctx.log(`source    commit ${typeof evidence.headCommit === "string" ? evidence.headCommit : "unknown"} (compare with the reviewed chain:accept commit, runbook §5)`);

  ctx.phase = "probe";
  const state = await probeBootstrapState(ctx.rpc, map);
  evidence.state = state;
  const window = bootstrapWindowLine(state);
  if (window) ctx.log(window);
  const draft = await planRoleStep(state, map, target.stepId, createNoopSigner(req.signer), ctx.rpc);
  ctx.log(`op        ${req.op} (${target.stepId}): ${draft.title}`);
  ctx.log(`signer    ${req.signer} (the role map's ${target.role})`);
  if (target.stepId === "S6") {
    ctx.log(`note: S6 clears exactly the role map's unpauseMask ${formatPauseFlags(map.unpauseMask)}; the areas outside it stay paused and the payout modules (0x40) stay off.`);
  }

  ctx.phase = "idl";
  await checkInstructionIdl(ctx, target.program, target.instruction, null, ACCEPT_CHECKOUT);

  if (draft.noop) {
    ctx.log(`nothing to do: ${draft.noop}`);
    evidence.noop = draft.noop;
    evidence.next = await nextActions(ctx, state, map);
    return "completed";
  }

  // The role key pays the fee (and the rent of its Admin record for A3 / X1).
  ctx.phase = "balance";
  const balance = (await ctx.rpc.getBalance(req.signer, { commitment: "finalized" }).send()).value;
  let need = SIGNATURE_FEE + (config.cuPrice ? (config.cuPrice * BigInt(200_000)) / BigInt(1_000_000) : BigInt(0));
  for (const size of target.rentSizes) need += await ctx.rpc.getMinimumBalanceForRentExemption(BigInt(size), { commitment: "finalized" }).send();
  evidence.signerBalance = { lamports: balance.toString(), needLamports: need.toString() };
  if (balance < need) {
    throw new ChainPlanError(`${req.signer} holds ${balance} lamports, below the ${need} this step needs (fee${target.rentSizes.length ? " and the rent of its Admin record" : ""}); fund it from an address taken from the role map or its device`);
  }
  if (balance < need + FEE_MARGIN) ctx.log(`note: ${req.signer} holds ${balance} lamports; keep at least ${need + FEE_MARGIN} for the steps after this one`);

  const digest = planDigest({
    network: config.network,
    genesis: config.expectedGenesis,
    roleMapSha256: loaded.sha256,
    releaseSha256Sums: null,
    steps: [draft.step!],
  });
  evidence.planDigest = digest;
  evidence.plan = { id: draft.step!.id, title: draft.step!.title, signerRole: draft.signerRole, preconditions: draft.step!.preconditions.map((p) => p.label) };

  if (!config.send) {
    ctx.phase = "simulate";
    const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    const result = await simulateUnsigned(
      ctx.rpc,
      buildMessage({ feePayer: draft.step!.signer, ixs: draft.step!.ixs, blockhash, cuLimit: 1_400_000, cuPrice: config.cuPrice }),
    );
    const text = result.ok ? `simulated ok, ${result.unitsConsumed ?? "?"} CU` : `SIMULATION FAILED ${summarizeSimulation(result)}`;
    evidence.simulation = text;
    ctx.log(`${draft.step!.id.padEnd(9)} ${draft.step!.title}  [${text}]`);
    for (const p of draft.step!.preconditions) ctx.log(`  requires ${p.label}`);
    ctx.log(`plan digest: ${digest}`);
    if (!result.ok) throw new ChainPlanError("the accept transaction failed simulation; see the plan output");
    ctx.log("dry run: nothing sent. Send with CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest> and CHAIN_SIGNER=usb://ledger?key=<n> (or CHAIN_KEYPAIR=<file>).");
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainPlanError("CHAIN_CONFIRM_PLAN does not match the recomputed plan digest");

  ctx.phase = "signers";
  const { signer, device } = await loadRoleSigner(ctx, req.signer, target.role);
  try {
    const plan = await planRoleStep(state, map, target.stepId, signer, ctx.rpc);
    if (!plan.step) throw new ChainPlanError("the step landed while the signer was loaded; run the dry run again");
    const again = planDigest({ network: config.network, genesis: config.expectedGenesis, roleMapSha256: loaded.sha256, releaseSha256Sums: null, steps: [plan.step] });
    if (again !== digest) throw new ChainPlanError("the plan changed while the signer was loaded; run the dry run again");
    ctx.phase = "send";
    const journal = ctx.beginSend();
    journal.append({ event: "plan", digest, steps: [plan.step.id] });
    const records: StepRecord[] = [];
    evidence.steps = records;
    await executePlan([plan.step], {
      rpc: ctx.rpc,
      drainRpc: ctx.drainRpc,
      journal,
      cuPrice: config.cuPrice,
      signal: ctx.signal,
      timing: ctx.timing,
      log: ctx.log,
      records,
      probe: () => probeBootstrapState(ctx.rpc, map),
    });
  } finally {
    await device?.close().catch(() => {});
  }
  ctx.phase = "after";
  const after = await probeBootstrapState(ctx.rpc, map);
  evidence.stateAfter = after;
  evidence.next = await nextActions(ctx, after, map);
  return "completed";
}
