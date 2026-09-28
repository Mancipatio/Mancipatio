// Read the emergency pause and the pilot scope BEFORE a wallet signs
// (lansiranje-6). The program refuses a paused entry flow with PlatformPaused,
// but only after the user built the transaction, opened the wallet and signed
// or simulated; this reads `Platform.pause_flags` first and refuses with the
// same words. A pilot-scope module that is switched off (lib/features.ts) is
// refused here as well: its on-chain entries have no server route that could
// answer 403 (an OTC offer, a proposal, a Rights-Token issuance).
//
// THE map of pause bits to flows is PAUSE_BIT_FLOWS below: one entry per
// program check, `platform.is_paused(MASK)` in program/programs/
// asset_registry/src/instructions/*.rs (tests/pause-gate.test.ts keeps the
// two equal for every bit the front defines). The model the program uses:
//   - one instruction may be stopped by several bits: a combined mask
//     (`is_paused(PAUSE_DISTRIBUTIONS | PAUSE_PAYOUT_MODULES)`) or two
//     separate checks are one entry per bit, and the instruction is held
//     back when ANY of its bits is set (pauseMaskFor ORs them);
//   - a check the program makes only in some cases (`quarantine ||
//     !is_paused(..)`, `raise_type != Startup || !is_paused(..)`) is an entry
//     with `when`: true (held back), false (not), or null when the front
//     cannot tell from the instruction data and the facts a page passes (a
//     field of an account decides); null lets the transaction go on to the
//     program, which decides (fail open, like a failed read).
// A new bit (8.3: 0x40 PAUSE_PAYOUT_MODULES) is its constant in
// lib/pause-flags.ts plus its entries here, one per check, with `when` for
// the conditional ones; nothing else changes. Bit 0x80 (8.3's one-way
// PLATFORM_BOOTSTRAP_OPEN marker) is not a pause bit and gets no entry.
//
// The pilot-scope map is MODULE_FLOWS below: each module switch and the
// on-chain instructions that START its activity (new offers and trades,
// proposals and votes, issuances, series, distributions, custody vaults).
// What finishes, closes or pays out what already exists (cancels, expiries,
// claims, withdrawals, the batches of an existing distribution) is in no
// module, like the exits of a pause.
//
// Enforcement stays on-chain (the pause) and on the server (the module
// routes). This is a display gate: the pause read is cached for a few
// seconds and fails OPEN (a failed read lets the transaction go on to the
// program, which is the authority). Exits never read the flags, so only the
// instructions below are ever held back.
//
// Called for every wallet transaction from lib/verified-solana-client.ts
// (prepare and prepareAndSend, before any wallet prompt); pages that want to
// say it before the user starts use pausedFlowFor / readPauseFlags and
// lib/features.ts moduleEnabled.

import type { Address } from "@solana/kit";
import {
  moduleDisabledMessage,
  moduleEnabled,
  type PilotModule,
} from "@/lib/features";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  fetchMaybePlatform,
  findPlatformPda,
  getOpenCustodyVaultInstructionDataDecoder,
  identifyAssetRegistryInstruction,
  RealizeAction,
  VaultType,
  type RaiseType,
} from "@/lib/generated/asset_registry";
import { detectNetwork, type Network } from "@/lib/network";
import {
  PAUSE_CUSTODY_ENTRY,
  PAUSE_DISTRIBUTIONS,
  PAUSE_EXITS_OPEN,
  PAUSE_FLAGS,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
  isPaused,
} from "@/lib/pause-flags";

const Ix = AssetRegistryInstruction;

/**
 * What a conditional check may look at: the instruction's data (null when a
 * page asks about an instruction it has not built yet), and facts a page
 * knows about the accounts the instruction will name (the sale's raise type).
 * A field is added here when a new conditional check needs it.
 */
export type GateFacts = { raiseType?: RaiseType };
export type GateSubject = { data: Uint8Array | null; facts: GateFacts };
/** true: held back; false: not; null: cannot tell here (the program decides). */
export type GateCondition = (subject: GateSubject) => boolean | null;

/** One program check: `bit` stops `instructions` (only when `when` says so, if given). */
export type PauseFlow = {
  bit: number;
  instructions: readonly AssetRegistryInstruction[];
  when?: GateCondition;
};

/** A custody vault that is not the burn-only quarantine vault clawback needs. */
const notQuarantineVault: GateCondition = ({ data }) => {
  if (!data) return null;
  try {
    const args = getOpenCustodyVaultInstructionDataDecoder().decode(data);
    return !(args.vaultType === VaultType.RedemptionQueue && args.realizeAction === RealizeAction.BurnAndAttest);
  } catch {
    return null;
  }
};

/** Pause bit → the instructions it stops, one entry per program check. The one place to add a bit. */
export const PAUSE_BIT_FLOWS: readonly PauseFlow[] = [
  {
    bit: PAUSE_ONBOARDING,
    instructions: [Ix.RegisterIssuer, Ix.CreateAsset, Ix.AddShareClass, Ix.InitializeShareClassMint],
  },
  { bit: PAUSE_PRIMARY, instructions: [Ix.OpenSale, Ix.Buy, Ix.MintToTreasury] },
  {
    bit: PAUSE_SECONDARY,
    instructions: [Ix.CreateOffer, Ix.DepositToOfferEscrow, Ix.TakeOffer, Ix.CreateOtcDeal, Ix.DepositOtcAsset, Ix.DepositOtcPayment],
  },
  { bit: PAUSE_CUSTODY_ENTRY, instructions: [Ix.DepositToCustodyVault] },
  // The program lets a burn-only quarantine vault (RedemptionQueue +
  // BurnAndAttest) through: clawback needs one as its destination.
  { bit: PAUSE_CUSTODY_ENTRY, instructions: [Ix.OpenCustodyVault], when: notQuarantineVault },
  {
    bit: PAUSE_DISTRIBUTIONS,
    instructions: [
      Ix.CreateDistribution, Ix.DistributeBatch, Ix.RouteYield, Ix.DepositToVestingEscrow,
      Ix.CreateRightsIssuance, Ix.PublishMilestone,
    ],
  },
  { bit: PAUSE_ISSUER_PROCEEDS, instructions: [Ix.CloseSale, Ix.ReleasePayout, Ix.ClaimFounderYield] },
];

const FLOWS_BY_INSTRUCTION = new Map<AssetRegistryInstruction, PauseFlow[]>();
for (const flow of PAUSE_BIT_FLOWS) {
  for (const instruction of flow.instructions) {
    FLOWS_BY_INSTRUCTION.set(instruction, [...(FLOWS_BY_INSTRUCTION.get(instruction) ?? []), flow]);
  }
}

/** The program's checks of `instruction`, in map order (none: it never reads the flags). */
export function pauseFlowsFor(instruction: AssetRegistryInstruction): readonly PauseFlow[] {
  return FLOWS_BY_INSTRUCTION.get(instruction) ?? [];
}

/**
 * Every bit that can stop `instruction`, ORed (0 when it never reads the
 * flags). Conditional checks count: a set bit MAY hold it back.
 */
export function pauseMaskFor(instruction: AssetRegistryInstruction): number {
  return pauseFlowsFor(instruction).reduce((mask, flow) => mask | flow.bit, 0);
}

/**
 * The first bit of `flags` that holds `instruction` back for `subject`, or
 * null. A conditional check that cannot tell (null) does not hold it back.
 * `flows` defaults to PAUSE_BIT_FLOWS (tests pass their own).
 */
export function heldBit(
  flags: number,
  instruction: AssetRegistryInstruction,
  subject: GateSubject,
  flows: readonly PauseFlow[] = PAUSE_BIT_FLOWS,
): number | null {
  const checks = flows === PAUSE_BIT_FLOWS ? pauseFlowsFor(instruction) : flows.filter((f) => f.instructions.includes(instruction));
  for (const flow of checks) {
    if (!isPaused(flags, flow.bit)) continue;
    if (flow.when && flow.when(subject) !== true) continue;
    return flow.bit;
  }
  return null;
}

type InstructionLike = { programAddress: Address | string; data?: Uint8Array | ArrayLike<number> };

/** Each instruction of this program in `instructions`, identified, with its data. */
function registryInstructions(
  instructions: readonly InstructionLike[],
): { instruction: AssetRegistryInstruction; data: Uint8Array }[] {
  const out: { instruction: AssetRegistryInstruction; data: Uint8Array }[] = [];
  for (const ix of instructions) {
    if (ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !ix.data) continue;
    const data = ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data);
    try {
      out.push({ instruction: identifyAssetRegistryInstruction(data), data });
    } catch {
      // Not an instruction of this program version: the program decides.
    }
  }
  return out;
}

/**
 * The first instruction of `instructions` that `flags` holds back, as
 * { instruction, bit }, or null. Instructions of other programs, and ones
 * this program does not recognize, pass.
 */
export function pausedInstruction(
  flags: number,
  instructions: readonly InstructionLike[],
  facts: GateFacts = {},
): { instruction: AssetRegistryInstruction; bit: number } | null {
  for (const { instruction, data } of registryInstructions(instructions)) {
    const bit = heldBit(flags, instruction, { data, facts });
    if (bit !== null) return { instruction, bit };
  }
  return null;
}

/** The user-facing refusal for a paused bit (the program's own wording, plus the area). */
export function pausedFlowMessage(bit: number): string {
  const flag = PAUSE_FLAGS.find((f) => f.bit === bit);
  const area = flag ? `${flag.label} is paused on Manci (emergency pause). ` : "Manci has temporarily paused this action (emergency pause). ";
  return `${area}Nothing was sent to your wallet. ${PAUSE_EXITS_OPEN}`;
}

/** Thrown before any wallet prompt for a transaction the pause holds back. */
export class PausedFlowError extends Error {
  readonly bit: number;
  readonly instruction: AssetRegistryInstruction;
  constructor(bit: number, instruction: AssetRegistryInstruction) {
    super(pausedFlowMessage(bit));
    this.name = "PausedFlowError";
    this.bit = bit;
    this.instruction = instruction;
  }
}

// ── Pilot scope: module → the on-chain entries it owns ─────────────────────

/** One module's on-chain entries (only when `when` says so, if given). */
export type ModuleFlow = {
  module: PilotModule;
  instructions: readonly AssetRegistryInstruction[];
  when?: GateCondition;
};

/** A custody vault of `type` (null: the data could not be read). */
const vaultOfType = (type: VaultType): GateCondition => ({ data }) => {
  if (!data) return null;
  try {
    return getOpenCustodyVaultInstructionDataDecoder().decode(data).vaultType === type;
  } catch {
    return null;
  }
};

/** Module switch → the instructions that start its activity. The one place to add a module's entry. */
export const MODULE_FLOWS: readonly ModuleFlow[] = [
  {
    module: "secondaryTrading",
    instructions: [Ix.CreateOffer, Ix.DepositToOfferEscrow, Ix.TakeOffer, Ix.CreateOtcDeal, Ix.DepositOtcAsset, Ix.DepositOtcPayment],
  },
  { module: "governance", instructions: [Ix.CreateProposal, Ix.CastVote] },
  { module: "vesting", instructions: [Ix.CreateVestingSeries] },
  { module: "rights", instructions: [Ix.CreateRightsIssuance] },
  { module: "distributions", instructions: [Ix.CreateDistribution, Ix.RouteYield] },
  { module: "custodyConversion", instructions: [Ix.OpenCustodyVault], when: vaultOfType(VaultType.ConversionPending) },
  { module: "custodyDelivery", instructions: [Ix.OpenCustodyVault], when: vaultOfType(VaultType.DeliveryEscrow) },
];

/** The switched-off module that holds `instruction` back for `subject`, or null. */
export function heldModule(
  instruction: AssetRegistryInstruction,
  subject: GateSubject,
  network: Network = detectNetwork(),
): PilotModule | null {
  for (const flow of MODULE_FLOWS) {
    if (!flow.instructions.includes(instruction) || moduleEnabled(flow.module, network)) continue;
    if (flow.when && flow.when(subject) !== true) continue;
    return flow.module;
  }
  return null;
}

/** The first instruction a switched-off module holds back, as { instruction, module }, or null. */
export function outOfScopeInstruction(
  instructions: readonly InstructionLike[],
  network: Network = detectNetwork(),
): { instruction: AssetRegistryInstruction; module: PilotModule } | null {
  for (const { instruction, data } of registryInstructions(instructions)) {
    const held = heldModule(instruction, { data, facts: {} }, network);
    if (held) return { instruction, module: held };
  }
  return null;
}

/** Thrown before any wallet prompt for an entry of a switched-off module. */
export class ModuleDisabledFlowError extends Error {
  readonly module: PilotModule;
  readonly instruction: AssetRegistryInstruction;
  constructor(module: PilotModule, instruction: AssetRegistryInstruction, network: Network = detectNetwork()) {
    super(`${moduleDisabledMessage(module, network)} Nothing was sent to your wallet.`);
    this.name = "ModuleDisabledFlowError";
    this.module = module;
    this.instruction = instruction;
  }
}

/** Throws ModuleDisabledFlowError when an instruction belongs to a switched-off module. No chain read. */
export function assertInstructionsInScope(
  instructions: readonly InstructionLike[],
  network: Network = detectNetwork(),
): void {
  const hit = outOfScopeInstruction(instructions, network);
  if (hit) throw new ModuleDisabledFlowError(hit.module, hit.instruction, network);
}

// ── The cached read ───────────────────────────────────────────────────────

/** How long a read of the flags is reused (display gate; the program re-checks). */
export const PAUSE_FLAGS_TTL_MS = 10_000;

type PlatformReader = (rpc: unknown) => Promise<number | null>;

let cached: { rpc: unknown; at: number; flags: number | null } | null = null;
let inflight: { rpc: unknown; promise: Promise<number | null> } | null = null;

async function readFromChain(rpc: unknown): Promise<number | null> {
  const [pda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc as Parameters<typeof fetchMaybePlatform>[0], pda, {
    commitment: "confirmed",
    abortSignal: AbortSignal.timeout(5_000),
  });
  if (!platform.exists || platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
  return platform.data.pauseFlags;
}

/**
 * `Platform.pause_flags`, at most PAUSE_FLAGS_TTL_MS old, or null when it
 * could not be read (no Platform yet, RPC trouble): callers treat null as
 * "not paused" — the program decides.
 */
export async function readPauseFlags(
  rpc: unknown,
  opts: { now?: number; read?: PlatformReader } = {},
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  if (cached && cached.rpc === rpc && now - cached.at < PAUSE_FLAGS_TTL_MS) return cached.flags;
  if (inflight && inflight.rpc === rpc) return inflight.promise;
  const read = opts.read ?? readFromChain;
  const promise = read(rpc)
    .catch(() => null)
    .then((flags) => {
      // A failed read is not cached: the next transaction asks again.
      if (flags !== null) cached = { rpc, at: now, flags };
      return flags;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { rpc, promise };
  return promise;
}

/** Forget the cached flags (after this wallet itself changed them, and in tests). */
export function clearPauseFlagsCache(): void {
  cached = null;
  inflight = null;
}

/**
 * Throws PausedFlowError when one of `instructions` is held back by the
 * current pause flags; resolves otherwise, including when the flags could
 * not be read (fail open: the program is the authority).
 */
export async function assertInstructionsNotPaused(
  rpc: unknown,
  instructions: readonly InstructionLike[],
  opts: { read?: PlatformReader; now?: number } = {},
): Promise<void> {
  const gated = instructions.some((ix) => ix.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS);
  if (!gated) return;
  const flags = await readPauseFlags(rpc, opts);
  if (flags === null || flags === 0) return;
  const hit = pausedInstruction(flags, instructions);
  if (hit) throw new PausedFlowError(hit.bit, hit.instruction);
}

/**
 * For a page's own banner: the refusal for `instruction` under `flags`, or
 * null. `facts` are what the page knows about the accounts (a conditional
 * check without them cannot tell, and shows nothing).
 */
export function pausedFlowFor(flags: number | null, instruction: AssetRegistryInstruction, facts: GateFacts = {}): string | null {
  if (flags === null) return null;
  const bit = heldBit(flags, instruction, { data: null, facts });
  return bit === null ? null : pausedFlowMessage(bit);
}
