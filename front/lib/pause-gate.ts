// Read the emergency pause BEFORE a wallet signs (lansiranje-6). The program
// refuses a paused entry flow with PlatformPaused, but only after the user
// built the transaction, opened the wallet and signed or simulated; this
// reads `Platform.pause_flags` first and refuses with the same words.
//
// THE map of pause bits to flows is PAUSE_BIT_FLOWS below: each bit of
// lib/pause-flags.ts and the program instructions that check it
// (`platform.is_paused(PAUSE_X)` in program/programs/asset_registry/src/
// instructions/*.rs; tests/pause-gate.test.ts keeps the two equal for every
// bit the front defines). A new bit (8.3: 0x40 PAUSE_PAYOUT_MODULES, 0x80
// the bootstrap bit) is one constant in lib/pause-flags.ts plus one entry
// here; nothing else changes.
//
// Enforcement stays on-chain. This is a display gate: the read is cached for
// a few seconds and fails OPEN (a failed read lets the transaction go on to
// the program, which is the authority). Exits never read the flags, so only
// the instructions below are ever held back.
//
// Called for every wallet transaction from lib/verified-solana-client.ts
// (prepare and prepareAndSend, before any wallet prompt); pages that want to
// say it before the user starts use pausedFlowFor / readPauseFlags.

import type { Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  fetchMaybePlatform,
  findPlatformPda,
  getOpenCustodyVaultInstructionDataDecoder,
  identifyAssetRegistryInstruction,
  RealizeAction,
  VaultType,
} from "@/lib/generated/asset_registry";
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

/** Pause bit → the instructions it stops. The one place to add a bit. */
export const PAUSE_BIT_FLOWS: ReadonlyArray<{ bit: number; instructions: readonly AssetRegistryInstruction[] }> = [
  {
    bit: PAUSE_ONBOARDING,
    instructions: [Ix.RegisterIssuer, Ix.CreateAsset, Ix.AddShareClass, Ix.InitializeShareClassMint],
  },
  { bit: PAUSE_PRIMARY, instructions: [Ix.OpenSale, Ix.Buy, Ix.MintToTreasury] },
  {
    bit: PAUSE_SECONDARY,
    instructions: [Ix.CreateOffer, Ix.DepositToOfferEscrow, Ix.TakeOffer, Ix.CreateOtcDeal, Ix.DepositOtcAsset, Ix.DepositOtcPayment],
  },
  { bit: PAUSE_CUSTODY_ENTRY, instructions: [Ix.OpenCustodyVault, Ix.DepositToCustodyVault] },
  {
    bit: PAUSE_DISTRIBUTIONS,
    instructions: [
      Ix.CreateDistribution, Ix.DistributeBatch, Ix.RouteYield, Ix.DepositToVestingEscrow,
      Ix.CreateRightsIssuance, Ix.PublishMilestone,
    ],
  },
  { bit: PAUSE_ISSUER_PROCEEDS, instructions: [Ix.CloseSale, Ix.ReleasePayout, Ix.ClaimFounderYield] },
];

/**
 * Instructions the program lets through a set bit for some arguments. A
 * burn-only quarantine vault (RedemptionQueue + BurnAndAttest) stays
 * openable under PAUSE_CUSTODY_ENTRY: clawback needs one as its destination.
 */
const PAUSE_EXEMPT: Partial<Record<AssetRegistryInstruction, (data: Uint8Array) => boolean>> = {
  [Ix.OpenCustodyVault]: (data) => {
    try {
      const args = getOpenCustodyVaultInstructionDataDecoder().decode(data);
      return args.vaultType === VaultType.RedemptionQueue && args.realizeAction === RealizeAction.BurnAndAttest;
    } catch {
      return false;
    }
  },
};

const BIT_BY_INSTRUCTION = new Map<AssetRegistryInstruction, number>(
  PAUSE_BIT_FLOWS.flatMap(({ bit, instructions }) => instructions.map((ix) => [ix, bit] as const)),
);

/** The pause bit that stops `instruction`, or null when it never reads the flags. */
export function pauseBitFor(instruction: AssetRegistryInstruction): number | null {
  return BIT_BY_INSTRUCTION.get(instruction) ?? null;
}

type InstructionLike = { programAddress: Address | string; data?: Uint8Array | ArrayLike<number> };

/**
 * The first instruction of `instructions` that `flags` holds back, as
 * { instruction, bit }, or null. Instructions of other programs, and ones
 * this program does not recognize, pass.
 */
export function pausedInstruction(
  flags: number,
  instructions: readonly InstructionLike[],
): { instruction: AssetRegistryInstruction; bit: number } | null {
  for (const ix of instructions) {
    if (ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !ix.data) continue;
    const data = ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data);
    let instruction: AssetRegistryInstruction;
    try {
      instruction = identifyAssetRegistryInstruction(data);
    } catch {
      continue;
    }
    const bit = pauseBitFor(instruction);
    if (bit === null || !isPaused(flags, bit)) continue;
    if (PAUSE_EXEMPT[instruction]?.(data)) continue;
    return { instruction, bit };
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

/** For a page's own banner: the refusal for `instruction` under `flags`, or null. */
export function pausedFlowFor(flags: number | null, instruction: AssetRegistryInstruction): string | null {
  if (flags === null) return null;
  const bit = pauseBitFor(instruction);
  return bit !== null && isPaused(flags, bit) ? pausedFlowMessage(bit) : null;
}
