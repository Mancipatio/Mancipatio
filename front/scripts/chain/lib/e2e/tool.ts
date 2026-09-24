/**
 * `npm run chain:e2e` (Talas 6.3, design-6.3 §E): the e2e matrix with real
 * signatures, on a local validator (every role local, group 0 bootstraps the
 * platform) or on devnet (the CLI Admin pays; the Super Admin signs once in
 * the browser at checkpoint C1).
 *
 * Dry run (no CHAIN_SEND): prints the steps and the plan digest. Send mode
 * (CHAIN_SEND=1, CHAIN_KEYPAIR, CHAIN_CONFIRM_PLAN=<digest>) runs the groups
 * in order, one transaction at a time, resuming from state.json.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { fetchMaybeAdmin, findAdminRecordPda } from "@/lib/generated/asset_registry";
import type { ToolContext, ToolStatus } from "../context";
import { ChainGateError, loadHotSigner, toJson } from "../safety";
import { DEFAULT_TIMING } from "../tx";
import { readE2eConfig, type E2eConfig } from "./config";
import { loadOrCreateRoleKey } from "./keys";
import { e2ePlanDigest, stepsFor } from "./matrix";
import { E2eRunner } from "./runner";
import { assertStateMatches, loadState, newState, saveState, type E2eState } from "./state";
import type { Roles, World } from "./world";
import { runGroup0 } from "./groups/g0";
import { runGroup1 } from "./groups/g1";
import { runGroup2 } from "./groups/g2";
import { runGroup3 } from "./groups/g3";

/** Groups this version implements (6.3a); later groups arrive with 6.3b/6.3c. */
export const IMPLEMENTED_GROUPS = [0, 1, 2, 3];

function assertIgnoredDir(dir: string, root: string): void {
  const relative = path.relative(root, path.join(dir, "state.json"));
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside) return;
  const result = spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: root });
  if (result.status !== 0) throw new ChainGateError("E2E_DIR is inside the repository and not git-ignored");
}

async function loadRoles(e2e: E2eConfig, payer: Awaited<ReturnType<typeof loadHotSigner>>): Promise<Roles> {
  const key = (role: string) => loadOrCreateRoleKey(e2e.dir, role);
  const buyers = [await key("buyer1"), await key("buyer2"), await key("buyer3"), await key("buyer4")] as Roles["buyers"];
  if (e2e.network === "devnet") {
    return {
      funder: payer,
      admin: payer,
      issuer: payer,
      superAdmin: null,
      blocklistAuthority: null,
      kycAuthority: await key("kyc-authority"),
      buyers,
      paymentMint: await key("payment-mint"),
    };
  }
  return {
    funder: payer,
    admin: await key("admin"),
    issuer: await key("issuer"),
    superAdmin: await key("super-admin"),
    blocklistAuthority: await key("blocklist-authority"),
    kycAuthority: await key("kyc-authority"),
    buyers,
    paymentMint: await key("payment-mint"),
  };
}

function writeSummary(dir: string, state: E2eState, runner: E2eRunner, status: ToolStatus, network: string): void {
  const rows = runner.results;
  const summary = { network, runId: state.runId, status, finishedUtc: new Date().toISOString(), results: rows, steps: state.steps };
  fs.writeFileSync(path.join(dir, "summary.json"), `${toJson(summary)}\n`, { mode: 0o600 });
  const explorer = (sig: string) =>
    network === "devnet" ? `[${sig.slice(0, 10)}…](https://explorer.solana.com/tx/${sig}?cluster=devnet)` : `${sig.slice(0, 10)}…`;
  const lines = [
    `# e2e ${network} — run ${state.runId} (${status})`,
    "",
    "| step | title | outcome | actual | signature |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.title} | ${r.outcome} | ${r.actual} | ${r.signature ? explorer(r.signature) : ""} |`),
    "",
  ];
  fs.writeFileSync(path.join(dir, "summary.md"), lines.join("\n"), { mode: 0o600 });
}

export async function e2eTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  const e2e = readE2eConfig(ctx.env, config.network, ctx.root);
  const unsupported = e2e.groups.filter((g) => !IMPLEMENTED_GROUPS.includes(g));
  if (unsupported.length) throw new ChainGateError(`E2E_GROUPS ${unsupported.join(",")} are not implemented yet`);
  assertIgnoredDir(e2e.dir, ctx.root);
  const existing = loadState(e2e.dir);
  if (existing) assertStateMatches(existing, { network: e2e.network, genesis: config.expectedGenesis, runId: e2e.runId });
  const runId = existing?.runId ?? e2e.runId ?? randomBytes(4).toString("hex").slice(0, 6);
  const digest = e2ePlanDigest({ network: e2e.network, genesis: config.expectedGenesis, payer: e2e.payer, runId, groups: e2e.groups });
  const steps = stepsFor(e2e.network, e2e.groups);
  Object.assign(evidence, { runId, groups: e2e.groups, planDigest: digest, payer: e2e.payer, stepCount: steps.length });
  ctx.log(`e2e ${e2e.network} run ${runId}: groups ${e2e.groups.join(",")}, ${steps.length} steps`);
  for (const step of steps) {
    ctx.log(`  ${step.id.padEnd(6)} ${step.expect.ok ? "ok    " : `✗ ${step.expect.name}`.padEnd(6)} ${step.title}`);
  }
  ctx.log(`plan digest: ${digest}`);
  if (!config.send) {
    ctx.log(`dry run: nothing sent. Send with CHAIN_SEND=1 CHAIN_KEYPAIR=… CHAIN_CONFIRM_PLAN=${digest}${e2e.runId ? "" : ` E2E_RUN_ID=${runId}`}`);
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainGateError("CHAIN_CONFIRM_PLAN does not match the e2e plan digest");

  ctx.phase = "signers";
  const payer = await loadHotSigner(config.keypairPath!, e2e.payer, e2e.network === "devnet" ? "admin" : "deployer");
  const balance = (await ctx.rpc.getBalance(payer.address, { commitment: "confirmed" }).send()).value;
  if (balance < e2e.minPayerLamports) {
    throw new ChainGateError(`The payer holds ${balance} lamports; the run needs at least ${e2e.minPayerLamports} (E2E_MIN_PAYER_SOL)`);
  }
  if (e2e.network === "devnet") {
    const [record] = await findAdminRecordPda({ authority: payer.address });
    const admin = await fetchMaybeAdmin(ctx.rpc, record, { commitment: "finalized" });
    if (!admin.exists || admin.data.admin !== payer.address) {
      throw new ChainGateError("The devnet payer has no Admin record; the Super Admin must add it first (add_admin)");
    }
  }
  const roles = await loadRoles(e2e, payer);
  const state = existing ?? newState({ network: e2e.network, genesis: config.expectedGenesis, runId });
  const roleAddresses: Record<string, Address> = {
    funder: roles.funder.address,
    admin: roles.admin.address,
    issuer: roles.issuer.address,
    paymentMint: roles.paymentMint.address,
    ...Object.fromEntries(roles.buyers.map((b, i) => [`buyer${i + 1}`, b.address])),
    ...(roles.superAdmin ? { superAdmin: roles.superAdmin.address } : {}),
    ...(roles.blocklistAuthority ? { blocklistAuthority: roles.blocklistAuthority.address } : {}),
    ...(roles.kycAuthority ? { kycAuthority: roles.kycAuthority.address } : {}),
  };
  state.roles = roleAddresses;
  saveState(e2e.dir, state);
  evidence.roles = roleAddresses;

  ctx.phase = "send";
  const journal = ctx.beginSend();
  journal.append({ event: "plan", digest, runId, groups: e2e.groups, steps: steps.map((s) => s.id) });
  const runner = new E2eRunner({
    network: e2e.network,
    groups: e2e.groups,
    dir: e2e.dir,
    state,
    rpc: ctx.rpc,
    drainRpc: ctx.drainRpc,
    journal,
    cuPrice: config.cuPrice,
    signal: ctx.signal,
    timing: ctx.timing,
    log: ctx.log,
    requestCount: () => ctx.calls.length,
    maxRequests: e2e.maxRequests,
  });
  const world: World = {
    network: e2e.network,
    runId,
    runner,
    rpc: ctx.rpc,
    drainRpc: ctx.drainRpc,
    roles,
    config: e2e,
    log: ctx.log,
    sleep: ctx.timing?.sleep ?? DEFAULT_TIMING.sleep,
    signal: ctx.signal,
  };

  let status: ToolStatus = "completed";
  try {
    for (const group of e2e.groups) {
      ctx.phase = `group ${group}`;
      const outcome =
        group === 0
          ? (await runGroup0(world, { genesis: config.expectedGenesis, journal, cuPrice: config.cuPrice }), "completed")
          : group === 1
            ? await runGroup1(world)
            : group === 2
              ? await runGroup2(world)
              : await runGroup3(world);
      if (outcome === "awaiting") {
        status = "awaiting";
        ctx.log("awaiting: re-run the same command after the action above; passed steps are skipped");
        break;
      }
    }
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    evidence.results = runner.results;
    writeSummary(e2e.dir, state, runner, status, e2e.network);
  }
  return status;
}
