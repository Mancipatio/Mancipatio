/**
 * Tool 6: `chain:emergency` (Talas 8.2; uloge-runbook-6, ops-qa-8,
 * prog-vlast-8). The out-of-band path for the actions an incident cannot wait
 * for when the front, the database or SIWS is down (or is the incident):
 *
 *   pause      set_pause_flags(set)          any Admin or the super admin
 *   unpause    set_pause_flags(clear)        the super admin only
 *   block      add_to_blocklist(wallet)      the BlocklistAuthority
 *   unblock    remove_from_blocklist(wallet) the BlocklistAuthority
 *   hook-mode  update_transfer_hook_config   the BlocklistAuthority
 *
 * No front, no database, no role map: the signer's role is read from the
 * chain at finalized. A dry run (the default) probes, builds, simulates and
 * prints the plan digest; a send needs CHAIN_SEND=1, CHAIN_CONFIRM_PLAN=<digest>
 * and one signer, CHAIN_KEYPAIR (a keypair file) or CHAIN_SIGNER
 * (`usb://ledger?key=N`, see ./ledger.ts). The send re-probes, simulates the
 * signed transaction with signature verification, journals it, sends it and
 * checks the result at finalized, through the same pipeline as the other tools.
 * On mainnet the guarded source (SOURCE_INTEGRITY_PATHS: front/lib builds the
 * instruction, front/scripts/chain signs it) must be clean, as for every other
 * sending tool (or CHAIN_EMERGENCY_DIRTY_OK=1, recorded), and the live
 * canonical IDL must define the instruction exactly as front/idl does (or
 * CHAIN_EMERGENCY_IDL_UNCHECKED=1, recorded).
 */
import {
  createNoopSigner,
  isAddress,
  isOffCurveAddress,
  unwrapOption,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  ADMIN_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KYC_REGISTRY_DISCRIMINATOR,
  PLATFORM_DISCRIMINATOR,
  findAdminRecordPda,
  findPlatformPda,
  getAdminDecoder,
  getPlatformDecoder,
  getSetPauseFlagsInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  BLOCK_ENTRY_DISCRIMINATOR,
  RestrictionMode,
  TRANSFER_HOOK_CONFIG_DISCRIMINATOR,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlockEntryPda,
  findBlocklistAuthorityPda,
  findConfigPda,
  getAddToBlocklistInstructionAsync,
  getBlockEntryDecoder,
  getBlocklistAuthorityDecoder,
  getRemoveFromBlocklistInstructionAsync,
  getTransferHookConfigDecoder,
  getUpdateTransferHookConfigInstructionAsync,
} from "@/lib/generated/transfer_hook";
import { PAUSE_FLAGS_ALL, describePausedAreas, formatPauseFlags, unknownPauseBits } from "@/lib/pause-flags";
import { fetchRawAccounts, hasDiscriminator } from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import { idlProbeEvidence, probeIdl, type IdlProbe } from "./idl-plan";
import { ledgerSigner, openNodeHidLedger, type LedgerDevice } from "./ledger";
import type { ChainRpc } from "./rpc";
import {
  ChainGateError,
  ChainPlanError,
  SOURCE_INTEGRITY_PATHS,
  canonicalJson,
  dirtySourcePaths,
  ledgerDerivationPath,
  loadHotSigner,
  readLocalIdl,
  type ProgramName,
} from "./safety";
import {
  buildMessage,
  executePlan,
  planDigest,
  simulateUnsigned,
  summarizeSimulation,
  type PlanStep,
  type Precondition,
  type StepRecord,
} from "./tx";

export const EMERGENCY_OPS = ["pause", "unpause", "block", "unblock", "hook-mode"] as const;
export type EmergencyOp = (typeof EMERGENCY_OPS)[number];

/** CHAIN_PAUSE_BITS names (lib/pause-flags.ts bits). */
export const PAUSE_BIT_NAMES: Record<string, number> = {
  onboarding: 0x01,
  primary: 0x02,
  secondary: 0x04,
  "custody-entry": 0x08,
  distributions: 0x10,
  "issuer-proceeds": 0x20,
};

export type EmergencyRequest =
  | { op: "pause"; signer: Address; mask: number }
  | { op: "unpause"; signer: Address; mask: number | "all" }
  | { op: "block" | "unblock"; signer: Address; wallet: Address; confirmWallet: Address | null }
  | { op: "hook-mode"; signer: Address; mint: Address; mode: RestrictionMode; registry: Address | null };

function address(env: ToolContext["env"], name: string): Address {
  const value = env[name]?.trim();
  if (!value || !isAddress(value) || value === "11111111111111111111111111111111") {
    throw new ChainGateError(`${name} must be a valid address`);
  }
  return value;
}

/** `all`, comma-separated names or one integer (0x.. or decimal). */
export function parsePauseBits(value: string | undefined, allowAll: boolean): number | "all" {
  const text = value?.trim().toLowerCase();
  if (!text) throw new ChainGateError(`CHAIN_PAUSE_BITS is required (all, or ${Object.keys(PAUSE_BIT_NAMES).join(", ")})`);
  if (text === "all") return allowAll ? "all" : PAUSE_FLAGS_ALL;
  let mask: number;
  if (/^(0x[0-9a-f]{1,2}|\d{1,3})$/.test(text)) mask = Number(text);
  else {
    mask = 0;
    for (const part of text.split(",").map((p) => p.trim())) {
      const bit = PAUSE_BIT_NAMES[part];
      if (bit === undefined) throw new ChainGateError(`CHAIN_PAUSE_BITS: unknown area "${part}"`);
      mask |= bit;
    }
  }
  if (!Number.isInteger(mask) || mask <= 0 || mask > 0xff) throw new ChainGateError("CHAIN_PAUSE_BITS must name at least one bit (1-255)");
  return mask;
}

/** Reads CHAIN_EMERGENCY_OP and its inputs. */
export function readEmergencyRequest(env: ToolContext["env"]): EmergencyRequest {
  const op = env.CHAIN_EMERGENCY_OP?.trim() as EmergencyOp | undefined;
  if (!op || !EMERGENCY_OPS.includes(op)) throw new ChainGateError(`CHAIN_EMERGENCY_OP must be one of ${EMERGENCY_OPS.join(", ")}`);
  const signer = address(env, "CHAIN_EMERGENCY_SIGNER");
  if (op === "pause") {
    const mask = parsePauseBits(env.CHAIN_PAUSE_BITS, false) as number;
    if (mask & ~PAUSE_FLAGS_ALL) throw new ChainGateError(`pause sets only defined bits (${formatPauseFlags(PAUSE_FLAGS_ALL)})`);
    return { op, signer, mask };
  }
  if (op === "unpause") return { op, signer, mask: parsePauseBits(env.CHAIN_PAUSE_BITS, true) };
  if (op === "block" || op === "unblock") {
    const confirm = env.CHAIN_CONFIRM_WALLET?.trim();
    return { op, signer, wallet: address(env, "CHAIN_WALLET"), confirmWallet: confirm && isAddress(confirm) ? confirm : null };
  }
  const modeRaw = env.CHAIN_HOOK_MODE?.trim();
  if (modeRaw !== "open" && modeRaw !== "kyc-gated") throw new ChainGateError("CHAIN_HOOK_MODE must be open or kyc-gated");
  const mode = modeRaw === "open" ? RestrictionMode.Open : RestrictionMode.KycGated;
  const registryRaw = env.CHAIN_KYC_REGISTRY?.trim();
  if (mode === RestrictionMode.Open && registryRaw) throw new ChainGateError("CHAIN_KYC_REGISTRY must be unset for open (the hook stores None)");
  const registry = mode === RestrictionMode.KycGated ? address(env, "CHAIN_KYC_REGISTRY") : null;
  return { op, signer, mint: address(env, "CHAIN_MINT"), mode, registry };
}

// ── State ────────────────────────────────────────────────────────────────────

export type EmergencyState = {
  platform: { admin: Address; pauseFlags: number } | null;
  /** The signer has a live Admin record. */
  signerIsAdmin: boolean;
  blocklistAuthority: Address | null;
  /** block / unblock: the wallet's BlockEntry exists. */
  blocked: boolean | null;
  /** hook-mode: the mint's TransferHookConfig. */
  hookConfig: { mode: RestrictionMode; registry: Address | null } | null;
  /** hook-mode kyc-gated: the target registry is a live KycRegistry. */
  registryLive: boolean | null;
};

/** Finalized probe of every account the request depends on (one call). */
export async function probeEmergencyState(rpc: ChainRpc, req: EmergencyRequest): Promise<EmergencyState> {
  const [platform] = await findPlatformPda();
  const [adminRecord] = await findAdminRecordPda({ authority: req.signer });
  const [ba] = await findBlocklistAuthorityPda();
  const wallet = req.op === "block" || req.op === "unblock" ? req.wallet : null;
  const entry = wallet ? (await findBlockEntryPda({ wallet }))[0] : null;
  const config = req.op === "hook-mode" ? (await findConfigPda({ mint: req.mint }))[0] : null;
  const registry = req.op === "hook-mode" ? req.registry : null;
  const wanted = [platform, adminRecord, ba, entry, config, registry].filter((a): a is Address => a !== null);
  const accounts = await fetchRawAccounts(rpc, wanted);
  const get = (a: Address | null) => (a ? accounts.get(a) ?? null : null);

  const state: EmergencyState = { platform: null, signerIsAdmin: false, blocklistAuthority: null, blocked: null, hookConfig: null, registryLive: null };
  const p = get(platform);
  if (p && p.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(p.data, PLATFORM_DISCRIMINATOR)) {
    const value = getPlatformDecoder().decode(p.data);
    state.platform = { admin: value.admin, pauseFlags: value.pauseFlags };
  }
  const a = get(adminRecord);
  state.signerIsAdmin = Boolean(
    a && a.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(a.data, ADMIN_DISCRIMINATOR) && getAdminDecoder().decode(a.data).admin === req.signer,
  );
  const b = get(ba);
  if (b && b.owner === TRANSFER_HOOK_PROGRAM_ADDRESS && hasDiscriminator(b.data, BLOCKLIST_AUTHORITY_DISCRIMINATOR)) {
    state.blocklistAuthority = getBlocklistAuthorityDecoder().decode(b.data).authority;
  }
  if (entry && wallet) {
    const e = get(entry);
    state.blocked = Boolean(
      e && e.owner === TRANSFER_HOOK_PROGRAM_ADDRESS && hasDiscriminator(e.data, BLOCK_ENTRY_DISCRIMINATOR) && getBlockEntryDecoder().decode(e.data).wallet === wallet,
    );
  }
  if (config) {
    const c = get(config);
    if (c && c.owner === TRANSFER_HOOK_PROGRAM_ADDRESS && hasDiscriminator(c.data, TRANSFER_HOOK_CONFIG_DISCRIMINATOR)) {
      const value = getTransferHookConfigDecoder().decode(c.data);
      state.hookConfig = { mode: value.restrictionMode, registry: unwrapOption(value.kycRegistry) };
    }
  }
  if (registry) {
    const r = get(registry);
    state.registryLive = Boolean(r && r.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(r.data, KYC_REGISTRY_DISCRIMINATOR));
  }
  return state;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export type EmergencyPlan = {
  /** null: the chain already has the requested state. */
  step: PlanStep<EmergencyState> | null;
  role: "Admin or super admin" | "super admin" | "blocklist authority";
  program: ProgramName;
  instruction: string;
  summary: string;
  noop: string | null;
  notes: string[];
};

const pre = (label: string, holds: (s: EmergencyState) => boolean): Precondition<EmergencyState> => ({ label, holds });
const modeName = (mode: RestrictionMode) => (mode === RestrictionMode.Open ? "Open" : "KycGated");

/**
 * Checks the signer's live role and builds the one-instruction step. Refuses
 * (ChainPlanError) what the program would refuse, before any signature.
 */
export async function planEmergency(req: EmergencyRequest, state: EmergencyState, signer: TransactionSigner): Promise<EmergencyPlan> {
  const S = req.signer;
  if (signer.address !== S) throw new ChainGateError("The loaded signer is not CHAIN_EMERGENCY_SIGNER");
  const notes: string[] = [];
  const step = (
    id: string,
    title: string,
    ixs: Instruction[],
    preconditions: Precondition<EmergencyState>[],
    done: (s: EmergencyState) => boolean,
  ): PlanStep<EmergencyState> => ({
    id,
    title,
    signer,
    signerRole: req.op === "pause" ? "admin" : req.op === "unpause" ? "superAdmin" : "blocklistAuthority",
    ixs,
    preconditions,
    simulate: "now",
    idempotency: "replay-safe",
    required: "finalized",
    skip: done,
    postCheck: done,
  });

  if (req.op === "pause" || req.op === "unpause") {
    if (!state.platform) throw new ChainPlanError("The Platform account does not exist on this network");
    const flags = state.platform.pauseFlags;
    if (req.op === "pause") {
      const may = (s: EmergencyState) => Boolean(s.platform && (s.platform.admin === S || s.signerIsAdmin));
      if (!may(state)) throw new ChainPlanError(`${S} is neither the super admin nor an Admin: it cannot pause`);
      const mask = req.mask;
      const done = (s: EmergencyState) => Boolean(s.platform && (s.platform.pauseFlags & mask) === mask);
      const summary = `pause ${formatPauseFlags(mask)} (${describePausedAreas(mask)}); now ${formatPauseFlags(flags)}`;
      const plan: EmergencyPlan = { step: null, role: "Admin or super admin", program: "asset_registry", instruction: "set_pause_flags", summary, noop: null, notes };
      if (done(state)) return { ...plan, noop: `every requested bit is already set (${formatPauseFlags(flags)})` };
      const ixs = [await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: mask, clearMask: 0 })];
      notes.push("Pausing stops platform entry flows only; exits and wallet-to-wallet transfers keep working (the hook does not read the pause).");
      return { ...plan, step: step("pause", `set_pause_flags(set ${formatPauseFlags(mask)})`, ixs, [pre(`signer ${S} is the super admin or an Admin`, may)], done) };
    }
    const isSa = (s: EmergencyState) => s.platform?.admin === S;
    if (!isSa(state)) throw new ChainPlanError(`Only the super admin clears pause bits; ${S} is not the super admin (${state.platform.admin})`);
    const mask = req.mask === "all" ? PAUSE_FLAGS_ALL | unknownPauseBits(flags) : req.mask;
    const done = (s: EmergencyState) => Boolean(s.platform && (s.platform.pauseFlags & mask) === 0);
    const summary = `clear ${formatPauseFlags(mask)} (${describePausedAreas(mask) || "undefined bits"}); now ${formatPauseFlags(flags)}`;
    const plan: EmergencyPlan = { step: null, role: "super admin", program: "asset_registry", instruction: "set_pause_flags", summary, noop: null, notes };
    if (done(state)) return { ...plan, noop: `none of the requested bits is set (${formatPauseFlags(flags)})` };
    const ixs = [await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: 0, clearMask: mask })];
    return { ...plan, step: step("unpause", `set_pause_flags(clear ${formatPauseFlags(mask)})`, ixs, [pre(`platform.admin=${S}`, isSa)], done) };
  }

  const isBa = (s: EmergencyState) => s.blocklistAuthority === S;
  if (!state.blocklistAuthority) throw new ChainPlanError("The BlocklistAuthority account does not exist on this network");
  if (!isBa(state)) throw new ChainPlanError(`${S} is not the blocklist authority (${state.blocklistAuthority})`);

  if (req.op === "block" || req.op === "unblock") {
    const wallet = req.wallet;
    const blocking = req.op === "block";
    if (blocking && isOffCurveAddress(wallet)) {
      // prog-vlast-8: a blocked escrow PDA stops the exits that move tokens out of it.
      if (req.confirmWallet !== wallet) {
        throw new ChainPlanError(`${wallet} is off-curve (a program account such as an escrow): blocking it stops exits from it; set CHAIN_CONFIRM_WALLET=${wallet} to proceed`);
      }
      notes.push(`${wallet} is off-curve (a program account): blocking it stops transfers out of it until it is unblocked.`);
    }
    const done = (s: EmergencyState) => s.blocked === blocking;
    const instruction = blocking ? "add_to_blocklist" : "remove_from_blocklist";
    const plan: EmergencyPlan = {
      step: null,
      role: "blocklist authority",
      program: "transfer_hook",
      instruction,
      summary: `${instruction}(${wallet}); now ${state.blocked ? "blocked" : "not blocked"}`,
      noop: null,
      notes,
    };
    if (done(state)) return { ...plan, noop: `${wallet} is already ${blocking ? "blocked" : "not blocked"}` };
    const ixs = [
      blocking
        ? await getAddToBlocklistInstructionAsync({ authority: signer, wallet })
        : await getRemoveFromBlocklistInstructionAsync({ authority: signer, wallet }),
    ];
    if (blocking) notes.push("The hook blocks the sender only; claw back what the wallet holds with the clawback flow (runbook §11).");
    return { ...plan, step: step(req.op, `${instruction}(${wallet})`, ixs, [pre(`blocklist.authority=${S}`, isBa)], done) };
  }

  if (req.op !== "hook-mode") throw new ChainGateError(`unknown emergency op ${String(req.op)}`);
  if (!state.hookConfig) throw new ChainPlanError(`${req.mint} has no TransferHookConfig (not a Manci share-class mint)`);
  if (req.mode === RestrictionMode.KycGated && !state.registryLive) {
    throw new ChainPlanError(`${req.registry} is not a live KycRegistry`);
  }
  const target = { mode: req.mode, registry: req.registry };
  const done = (s: EmergencyState) => Boolean(s.hookConfig && s.hookConfig.mode === target.mode && s.hookConfig.registry === target.registry);
  const plan: EmergencyPlan = {
    step: null,
    role: "blocklist authority",
    program: "transfer_hook",
    instruction: "update_transfer_hook_config",
    summary: `${req.mint}: ${modeName(state.hookConfig.mode)}${state.hookConfig.registry ? ` (${state.hookConfig.registry})` : ""} → ${modeName(target.mode)}${target.registry ? ` (${target.registry})` : ""}`,
    noop: null,
    notes,
  };
  if (done(state)) return { ...plan, noop: `${req.mint} is already ${modeName(target.mode)}` };
  if (target.mode === RestrictionMode.Open) notes.push("Open: any wallet may receive this class; the KYC passport stops being checked.");
  else notes.push(`KycGated: only wallets with a live passport in ${target.registry} receive this class from now on.`);
  const ixs = [
    await getUpdateTransferHookConfigInstructionAsync({
      authority: signer,
      mint: req.mint,
      restrictionMode: target.mode,
      kycRegistry: target.registry,
      ...(target.registry ? { kycRegistryAccount: target.registry } : {}),
    }),
  ];
  const preconditions = [
    pre(`blocklist.authority=${S}`, isBa),
    pre(`hookConfig(${req.mint}) exists`, (s) => s.hookConfig !== null),
    ...(target.registry ? [pre(`kycRegistry(${target.registry}) live`, (s: EmergencyState) => s.registryLive === true)] : []),
  ];
  return { ...plan, step: step("hook-mode", `update_transfer_hook_config(${req.mint} → ${modeName(target.mode)})`, ixs, preconditions, done) };
}

// ── IDL check (mainnet) ──────────────────────────────────────────────────────

export type IdlCheck = "match" | "differs" | "no-canonical-idl" | "unreadable";

/** Whether the live canonical IDL defines `instruction` exactly as the local one. */
export function compareIdlInstruction(probe: IdlProbe, instruction: string): IdlCheck {
  if (!probe.onChain) return probe.status === "init" ? "no-canonical-idl" : "unreadable";
  const pick = (bytes: Uint8Array) => {
    const idl = JSON.parse(Buffer.from(bytes).toString("utf8")) as { instructions?: { name: string }[] };
    const ix = idl.instructions?.find((entry) => entry.name === instruction);
    return ix ? canonicalJson(ix) : null;
  };
  try {
    const live = pick(probe.onChain);
    const local = pick(probe.source.bytes);
    if (!live || !local) return "unreadable";
    return live === local ? "match" : "differs";
  } catch {
    return "unreadable";
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────────

async function loadSigner(ctx: ToolContext, req: EmergencyRequest, role: string): Promise<{ signer: TransactionSigner; device: LedgerDevice | null }> {
  const { config } = ctx;
  if (!config.send) return { signer: createNoopSigner(req.signer), device: null };
  if (config.keypairPath) return { signer: await loadHotSigner(config.keypairPath, req.signer, role), device: null };
  const device = await (ctx.deps.ledger ?? openNodeHidLedger)();
  try {
    const signer = await ledgerSigner({ device, path: ledgerDerivationPath(config.signerUrl!), expected: req.signer, log: ctx.log });
    return { signer, device };
  } catch (error) {
    await device.close().catch(() => {});
    throw error;
  }
}

export async function emergencyTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  const req = readEmergencyRequest(ctx.env);
  evidence.request = req;
  // The mainnet source guard of the other sending tools: the IDL check below
  // covers one instruction definition, not the code that builds and signs it.
  if (config.network === "mainnet") {
    const dirty = (ctx.deps.sourceDirty ?? dirtySourcePaths)(ctx.root);
    if (dirty.length) {
      if (ctx.env.CHAIN_EMERGENCY_DIRTY_OK?.trim() !== "1") {
        throw new ChainGateError(
          `The working tree has uncommitted changes under ${SOURCE_INTEGRITY_PATHS.join(", ")} (${dirty.length} paths): run from a clean checkout of the live Release tag, or set CHAIN_EMERGENCY_DIRTY_OK=1 (recorded)`,
        );
      }
      evidence.sourceDirtyOverride = dirty;
      ctx.log(`warning: CHAIN_EMERGENCY_DIRTY_OK=1: the guarded source has ${dirty.length} uncommitted paths (recorded in the evidence)`);
    }
  }

  ctx.phase = "probe";
  const state = await probeEmergencyState(ctx.rpc, req);
  evidence.state = state;
  const draft = await planEmergency(req, state, createNoopSigner(req.signer));
  evidence.role = draft.role;
  ctx.log(`op        ${req.op}: ${draft.summary}`);
  ctx.log(`signer    ${req.signer} (${draft.role}, checked on-chain at finalized)`);
  for (const note of draft.notes) ctx.log(`note: ${note}`);

  // The live canonical IDL must define the instruction as front/idl does.
  ctx.phase = "idl";
  const source = { label: "head" as const, bytes: readLocalIdl(ctx.frontDir)[draft.program] };
  const probe = await probeIdl(ctx.rpc, draft.program, source);
  const idlCheck = compareIdlInstruction(probe, draft.instruction);
  evidence.idl = { ...idlProbeEvidence(probe), instruction: draft.instruction, check: idlCheck };
  if (idlCheck !== "match") {
    const text = `the live canonical IDL of ${draft.program} ${idlCheck === "differs" ? "defines" : "cannot confirm"} ${draft.instruction} ${idlCheck === "differs" ? "differently from" : "against"} front/idl (${idlCheck})`;
    const unchecked = ctx.env.CHAIN_EMERGENCY_IDL_UNCHECKED?.trim() === "1";
    if (config.network === "mainnet" && !unchecked) {
      throw new ChainGateError(`${text}; run the checkout of the live Release tag, or set CHAIN_EMERGENCY_IDL_UNCHECKED=1 (recorded)`);
    }
    evidence.idlUnchecked = true;
    ctx.log(`warning: ${text}`);
  }

  if (draft.noop) {
    ctx.log(`nothing to do: ${draft.noop}`);
    evidence.noop = draft.noop;
    return "completed";
  }
  const digest = planDigest({
    network: config.network,
    genesis: config.expectedGenesis,
    roleMapSha256: null,
    releaseSha256Sums: null,
    steps: [draft.step!],
  });
  evidence.planDigest = digest;
  evidence.plan = { id: draft.step!.id, title: draft.step!.title, preconditions: draft.step!.preconditions.map((p) => p.label) };

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
    ctx.log(`plan digest: ${digest}`);
    if (!result.ok) throw new ChainPlanError("the emergency transaction failed simulation; see the plan output");
    ctx.log("dry run: nothing sent. Send with CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest> and CHAIN_KEYPAIR=<file> or CHAIN_SIGNER=usb://ledger?key=<n>.");
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainPlanError("CHAIN_CONFIRM_PLAN does not match the recomputed plan digest");

  ctx.phase = "signers";
  const { signer, device } = await loadSigner(ctx, req, draft.role);
  try {
    const plan = await planEmergency(req, state, signer);
    const again = planDigest({ network: config.network, genesis: config.expectedGenesis, roleMapSha256: null, releaseSha256Sums: null, steps: [plan.step!] });
    if (again !== digest) throw new ChainPlanError("the plan changed while the signer was loaded; run the dry run again");
    ctx.phase = "send";
    const journal = ctx.beginSend();
    journal.append({ event: "plan", digest, steps: [plan.step!.id] });
    const records: StepRecord[] = [];
    evidence.steps = records;
    await executePlan([plan.step!], {
      rpc: ctx.rpc,
      drainRpc: ctx.drainRpc,
      journal,
      cuPrice: config.cuPrice,
      signal: ctx.signal,
      timing: ctx.timing,
      log: ctx.log,
      records,
      probe: () => probeEmergencyState(ctx.rpc, req),
    });
  } finally {
    await device?.close().catch(() => {});
  }
  ctx.phase = "after";
  evidence.stateAfter = await probeEmergencyState(ctx.rpc, req);
  return "completed";
}
