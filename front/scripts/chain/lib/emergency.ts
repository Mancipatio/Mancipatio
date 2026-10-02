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
 *   freeze-issuer freeze_issuer_proceeds     any Admin or the super admin
 *                (D1, v1.0.0-rc: stops that issuer's sales and proceeds
 *                exits; only the super admin lifts it, never this tool)
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
  ISSUER_DISCRIMINATOR,
  ISSUER_FREEZE_DISCRIMINATOR,
  KYC_REGISTRY_DISCRIMINATOR,
  PLATFORM_DISCRIMINATOR,
  findAdminRecordPda,
  findIssuerFreezePda,
  findPlatformPda,
  getAdminDecoder,
  getFreezeIssuerProceedsInstructionAsync,
  getIssuerFreezeDecoder,
  getPlatformDecoder,
  getSetPauseFlagsInstructionAsync,
} from "@/lib/generated/asset_registry";
import { hashHex } from "@/lib/issuer-freeze";
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
import {
  PAUSE_FLAGS_ALL,
  PAUSE_PAYOUT_MODULES,
  RESUME_EVERYTHING_MASK,
  describePausedAreas,
  formatPauseFlags,
} from "@/lib/pause-flags";
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

export const EMERGENCY_OPS = ["pause", "unpause", "block", "unblock", "hook-mode", "freeze-issuer"] as const;
export type EmergencyOp = (typeof EMERGENCY_OPS)[number];

/** CHAIN_PAUSE_BITS names (lib/pause-flags.ts bits). */
export const PAUSE_BIT_NAMES: Record<string, number> = {
  onboarding: 0x01,
  primary: 0x02,
  secondary: 0x04,
  "custody-entry": 0x08,
  distributions: 0x10,
  "issuer-proceeds": 0x20,
  /** D2: stays set on mainnet; clears only on its own (never with `all`). */
  "payout-modules": PAUSE_PAYOUT_MODULES,
};

export type EmergencyRequest =
  | { op: "pause"; signer: Address; mask: number }
  | { op: "unpause"; signer: Address; mask: number | "all" }
  | { op: "block" | "unblock"; signer: Address; wallet: Address; confirmWallet: Address | null }
  | { op: "hook-mode"; signer: Address; mint: Address; mode: RestrictionMode; registry: Address | null }
  | { op: "freeze-issuer"; signer: Address; issuer: Address; reasonHash: Uint8Array };

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
  if (op === "unpause") {
    const mask = parsePauseBits(env.CHAIN_PAUSE_BITS, true);
    // The program clears the payout modules only in a call of its own (6154).
    if (mask !== "all" && (mask & PAUSE_PAYOUT_MODULES) !== 0 && mask !== PAUSE_PAYOUT_MODULES) {
      throw new ChainGateError("CHAIN_PAUSE_BITS: payout-modules (0x40) is cleared only on its own; unpause it in a separate call");
    }
    return { op, signer, mask };
  }
  if (op === "freeze-issuer") {
    // Only the SHA-256 of the case-file reason goes on chain (the same rule as
    // /admin/issuers: lib/issuer-freeze.ts freezeReasonHash, UTF-8 of the
    // trimmed text); the text itself stays in the incident record.
    const hash = env.CHAIN_FREEZE_REASON_SHA256?.trim().toLowerCase();
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new ChainGateError("CHAIN_FREEZE_REASON_SHA256 must be the 64-hex SHA-256 of the case-file reason (printf %s \"<trimmed reason>\" | shasum -a 256)");
    }
    return { op, signer, issuer: address(env, "CHAIN_ISSUER"), reasonHash: Uint8Array.from(Buffer.from(hash, "hex")) };
  }
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

/**
 * D2: on mainnet the payout / Merkle modules (0x40) stay off; switching them
 * on is an owner decision after a vote of at least 7 days, never an incident
 * step (the /admin/platform panel refuses it on mainnet as well). An unpause
 * that clears 0x40 on mainnet therefore needs the explicit override
 * CHAIN_ENABLE_PAYOUT_MODULES=<the signing super admin, typed out>, which the
 * evidence records. Returns whether the override was used.
 */
export function assertPayoutModulesClearAllowed(req: EmergencyRequest, network: string, env: ToolContext["env"]): boolean {
  if (req.op !== "unpause" || req.mask === "all" || (req.mask & PAUSE_PAYOUT_MODULES) === 0) return false;
  if (network !== "mainnet") return false;
  const confirm = env.CHAIN_ENABLE_PAYOUT_MODULES?.trim();
  if (confirm !== req.signer) {
    throw new ChainGateError(
      "CHAIN_PAUSE_BITS: clearing payout-modules (0x40) on mainnet switches on Startup raises, yield routing, Rights-Token issuances and milestones (D2: an owner decision after a vote of at least 7 days, never an emergency step). With that decision recorded, set CHAIN_ENABLE_PAYOUT_MODULES=<the signing super admin> (recorded)",
    );
  }
  return true;
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
  /** freeze-issuer: the Issuer account is live (owner and discriminator). */
  issuerLive?: boolean | null;
  /** freeze-issuer: the issuer's live IssuerFreeze, or null. */
  issuerFreeze?: { frozenBy: Address; frozenAt: bigint; reasonHash: string } | null;
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
  const issuer = req.op === "freeze-issuer" ? req.issuer : null;
  const freeze = issuer ? (await findIssuerFreezePda({ issuer }))[0] : null;
  const wanted = [platform, adminRecord, ba, entry, config, registry, issuer, freeze].filter((a): a is Address => a !== null);
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
  if (issuer && freeze) {
    const i = get(issuer);
    state.issuerLive = Boolean(i && i.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(i.data, ISSUER_DISCRIMINATOR));
    const f = get(freeze);
    // Any data at the PDA counts as frozen (the program's is_unset is fail-closed).
    if (f && f.data.length) {
      const value = f.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(f.data, ISSUER_FREEZE_DISCRIMINATOR) ? getIssuerFreezeDecoder().decode(f.data) : null;
      state.issuerFreeze = value
        ? { frozenBy: value.frozenBy, frozenAt: value.frozenAt, reasonHash: hashHex(value.reasonHash) }
        : { frozenBy: f.owner, frozenAt: BigInt(0), reasonHash: "" };
    } else state.issuerFreeze = null;
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
    signerRole: req.op === "pause" || req.op === "freeze-issuer" ? "admin" : req.op === "unpause" ? "superAdmin" : "blocklistAuthority",
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
    // `all`: every emergency area (and the bootstrap marker, which any clear
    // closes anyway), never the payout modules.
    const mask = req.mask === "all" ? RESUME_EVERYTHING_MASK : req.mask;
    if (req.mask === "all" && (flags & PAUSE_PAYOUT_MODULES) !== 0) {
      notes.push("The payout modules (0x40) stay off; they are cleared only on their own (CHAIN_PAUSE_BITS=payout-modules), and on mainnet only with CHAIN_ENABLE_PAYOUT_MODULES (D2).");
    }
    const done = (s: EmergencyState) => Boolean(s.platform && (s.platform.pauseFlags & mask) === 0);
    const summary = `clear ${formatPauseFlags(mask)} (${describePausedAreas(mask) || "undefined bits"}); now ${formatPauseFlags(flags)}`;
    const plan: EmergencyPlan = { step: null, role: "super admin", program: "asset_registry", instruction: "set_pause_flags", summary, noop: null, notes };
    if (done(state)) return { ...plan, noop: `none of the requested bits is set (${formatPauseFlags(flags)})` };
    const ixs = [await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: 0, clearMask: mask })];
    return { ...plan, step: step("unpause", `set_pause_flags(clear ${formatPauseFlags(mask)})`, ixs, [pre(`platform.admin=${S}`, isSa)], done) };
  }

  if (req.op === "freeze-issuer") {
    if (!state.platform) throw new ChainPlanError("The Platform account does not exist on this network");
    const may = (s: EmergencyState) => Boolean(s.platform && (s.platform.admin === S || s.signerIsAdmin));
    if (!may(state)) throw new ChainPlanError(`${S} is neither the super admin nor an Admin: it cannot freeze an issuer's proceeds`);
    if (!state.issuerLive) throw new ChainPlanError(`${req.issuer} is not a live Issuer account`);
    const done = (s: EmergencyState) => Boolean(s.issuerFreeze);
    const plan: EmergencyPlan = {
      step: null,
      role: "Admin or super admin",
      program: "asset_registry",
      instruction: "freeze_issuer_proceeds",
      summary: `freeze the proceeds of issuer ${req.issuer} (reason sha256 ${hashHex(req.reasonHash)})`,
      noop: null,
      notes,
    };
    if (state.issuerFreeze) {
      // A second freeze is refused on-chain (the account is in use); the first freezer and reason stay.
      return { ...plan, noop: `issuer ${req.issuer} is already frozen by ${state.issuerFreeze.frozenBy} (reason sha256 ${state.issuerFreeze.reasonHash || "unknown"})` };
    }
    notes.push(
      "The freeze refuses open_sale, buy, close_sale, open_payout_vault, release_payout and claim_founder_yield of this issuer (6143); investors' refunds and claims stay open.",
      "It does not stop the issuer wallet's own secondary sales (offers, OTC) or transfers: block that wallet too (op=block, the BA; freeze SOP O-9 in runbook §11).",
      "Only the super admin lifts it (unfreeze_issuer_proceeds on /admin/issuers, or chain:squads-export registry-ix when the super admin is the vault); the freezer pays the rent and gets it back then.",
    );
    const ixs = [await getFreezeIssuerProceedsInstructionAsync({ authority: signer, issuer: req.issuer, reasonHash: req.reasonHash })];
    return {
      ...plan,
      step: step("freeze-issuer", `freeze_issuer_proceeds(${req.issuer})`, ixs, [pre(`signer ${S} is the super admin or an Admin`, may), pre(`issuer ${req.issuer} is not frozen`, (s) => !s.issuerFreeze)], done),
    };
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

/**
 * The live canonical IDL must define `instruction` exactly as front/idl does.
 * On mainnet anything else refuses, unless `override` names a variable set
 * to 1 (recorded); elsewhere it is recorded (`idlUnchecked`) and warned.
 */
export async function checkInstructionIdl(ctx: ToolContext, program: ProgramName, instruction: string, override: string | null): Promise<IdlCheck> {
  const source = { label: "head" as const, bytes: readLocalIdl(ctx.frontDir)[program] };
  const probe = await probeIdl(ctx.rpc, program, source);
  const check = compareIdlInstruction(probe, instruction);
  ctx.evidence.idl = { ...idlProbeEvidence(probe), instruction, check };
  if (check === "match") return check;
  const text = `the live canonical IDL of ${program} ${check === "differs" ? "defines" : "cannot confirm"} ${instruction} ${check === "differs" ? "differently from" : "against"} front/idl (${check})`;
  const overridden = override !== null && ctx.env[override]?.trim() === "1";
  if (ctx.config.network === "mainnet" && !overridden) {
    throw new ChainGateError(`${text}; run the checkout of the live Release tag${override ? `, or set ${override}=1 (recorded)` : ""}`);
  }
  ctx.evidence.idlUnchecked = true;
  ctx.log(`warning: ${text}`);
  return check;
}

// ── Signer and source guard (shared with chain:accept) ───────────────────────

/**
 * The mainnet source guard of the other sending tools, for the role-key
 * tools that need no Release: the guarded source (front/lib builds the
 * instruction, front/scripts/chain signs it) must be clean. `override` names
 * the variable that waives it (recorded in the evidence), or null for none.
 */
export function guardMainnetSource(ctx: ToolContext, override: string | null): void {
  if (ctx.config.network !== "mainnet") return;
  const dirty = (ctx.deps.sourceDirty ?? dirtySourcePaths)(ctx.root);
  if (!dirty.length) return;
  const text = `The working tree has uncommitted changes under ${SOURCE_INTEGRITY_PATHS.join(", ")} (${dirty.length} paths): run from a clean checkout of the live Release tag`;
  if (override === null || ctx.env[override]?.trim() !== "1") {
    throw new ChainGateError(override ? `${text}, or set ${override}=1 (recorded)` : text);
  }
  ctx.evidence.sourceDirtyOverride = dirty;
  ctx.log(`warning: ${override}=1: the guarded source has ${dirty.length} uncommitted paths (recorded in the evidence)`);
}

/**
 * The signer of a role-key tool: a noop signer in a dry run; in a send, the
 * keypair file (CHAIN_KEYPAIR) or the Ledger (CHAIN_SIGNER), whose key at the
 * derivation path must be `expected` before anything is signed.
 */
export async function loadRoleSigner(ctx: ToolContext, expected: Address, role: string): Promise<{ signer: TransactionSigner; device: LedgerDevice | null }> {
  const { config } = ctx;
  if (!config.send) return { signer: createNoopSigner(expected), device: null };
  if (config.keypairPath) return { signer: await loadHotSigner(config.keypairPath, expected, role), device: null };
  const device = await (ctx.deps.ledger ?? openNodeHidLedger)();
  try {
    const signer = await ledgerSigner({ device, path: ledgerDerivationPath(config.signerUrl!), expected, log: ctx.log });
    return { signer, device };
  } catch (error) {
    await device.close().catch(() => {});
    throw error;
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export async function emergencyTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  const req = readEmergencyRequest(ctx.env);
  evidence.request = req;
  if (assertPayoutModulesClearAllowed(req, config.network, ctx.env)) {
    evidence.payoutModulesOverride = req.signer;
    ctx.log("warning: CHAIN_ENABLE_PAYOUT_MODULES: the payout modules (0x40) are cleared on mainnet (D2 owner decision; recorded in the evidence)");
  }
  // The mainnet source guard of the other sending tools: the IDL check below
  // covers one instruction definition, not the code that builds and signs it.
  guardMainnetSource(ctx, "CHAIN_EMERGENCY_DIRTY_OK");

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
  await checkInstructionIdl(ctx, draft.program, draft.instruction, "CHAIN_EMERGENCY_IDL_UNCHECKED");

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
  const { signer, device } = await loadRoleSigner(ctx, req.signer, draft.role);
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
