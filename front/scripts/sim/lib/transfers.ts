/**
 * Direct Token-2022 transfers of a share-class mint between holders
 * (docs/mainnet-readiness/sim/design-transfers.md §B, §D.3): the builder
 * with the hook's extra accounts, its probe variants, the probe table (what
 * each probe asks the chain and what the chain must answer), the probe
 * classifier and the pre-send snapshot rule every sent transfer follows.
 *
 * - Sends go through TxExecutor.run (paced, journalled, one in flight, polled
 *   to finalized). Probes are signed at MAX CU and simulated with sigVerify;
 *   the simulator never sends a probe.
 * - The two programs share custom numbers (6003 is SenderBlocked in the hook
 *   and AssetNotDraft in the registry), so a match needs the program AND the
 *   code. Token-2022 (TokenzQd…) refusals are `token_2022`; runtime errors
 *   without a custom code match by name.
 * - Token-2022 rows follow spl-token-2022 11.0.0. The devnet program may be
 *   another release: a row that disagrees on the first run is a mismatch to
 *   pin (the row changes), not a site bug. P1 already accepts the 6.x answer.
 */
import {
  AccountRole,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
  getTokenSize,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token-2022";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findEscrowMarkerPda, findKycEntryPda } from "@/lib/generated/asset_registry";
import { findConfigPda } from "@/lib/generated/transfer_hook";
import { hookTransferMetas, type HookTransferMeta } from "@/lib/hook-metas";
import { TRANSFER_HOOK_PROGRAM, findBlockEntryPda, findExtraMetasPda } from "@/lib/pdas";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import { classifyFailure, describeFailure, type ChainFailure } from "@/scripts/chain/lib/e2e/errors";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";
import type { SimulationResult } from "@/scripts/chain/lib/tx";
import type { XferSnapshot } from "./state";

// ── Builder ──────────────────────────────────────────────────────────────────

/** The hook tail a transfer carries: the app's own (`hook`), or a probe's defect. */
export type TailSpec =
  | { kind: "hook" }
  | { kind: "none" }
  | { kind: "hook-program-only" }
  | { kind: "block-entry-of"; owner: Address }
  | { kind: "kyc-shaped"; registry: Address };

export type TransferSpec = {
  /** The class mint: its hook tail and the owners' ATAs. */
  mint: Address;
  /** The mint account the instruction names (P7 names another class mint). */
  mintAccount?: Address;
  decimals?: number;
  srcOwner: Address;
  /** Source token account; the owner's ATA unless set (E1: the offer escrow). */
  src?: Address;
  dstOwner: Address;
  /** Destination token account; the owner's ATA unless set (E2: the offer escrow). */
  dst?: Address;
  /** P8: a fresh account for dstOwner WITHOUT ImmutableOwner, created in the same transaction. */
  freshDst?: boolean;
  authority: TransactionSigner;
  /** D1/D2: `authority` is approved as a delegate first, by this source owner. */
  approveBy?: TransactionSigner;
  payer: TransactionSigner;
  amount: bigint;
  /** Creates the destination ATA first (idempotent, paid by `payer`). */
  createDst?: boolean;
  tail?: TailSpec;
  /** L1: the legacy unchecked `Transfer` (no mint account). */
  unchecked?: boolean;
};

export async function ataOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022 });
  return ata;
}

/**
 * A Token-2022 account for a hook mint without ImmutableOwner: the base plus
 * TransferHookAccount, which Token-2022 needs on both sides of a hook transfer.
 */
export const PLAIN_HOOK_ACCOUNT_SIZE = getTokenSize([{ __kind: "TransferHookAccount", transferring: false }]);

const ro = (address: Address): HookTransferMeta => ({ address, role: AccountRole.READONLY });

async function tailFor(rpc: ChainRpc, spec: TransferSpec, src: Address, dst: Address): Promise<HookTransferMeta[]> {
  const tail = spec.tail ?? { kind: "hook" };
  switch (tail.kind) {
    case "hook":
      // The app's own mode-aware tail (lib/hook-metas.ts), as every page builds it.
      return hookTransferMetas(rpc, spec.mint, {
        sourceTokenAccount: src,
        destTokenAccount: dst,
        transferAuthority: spec.authority.address,
        sourceOwner: spec.srcOwner,
        destOwner: spec.dstOwner,
      });
    case "none":
      return [];
    case "hook-program-only":
      return [ro(TRANSFER_HOOK_PROGRAM)];
    case "block-entry-of":
      return [ro(await findBlockEntryPda(tail.owner)), ro(await findExtraMetasPda(spec.mint)), ro(TRANSFER_HOOK_PROGRAM)];
    case "kyc-shaped": {
      // The KycGated order of lib/hook-metas.ts, whatever the mint's mode (a stale-cache tail).
      const [config] = await findConfigPda({ mint: spec.mint });
      const [kycEntry] = await findKycEntryPda({ kycRegistry: tail.registry, holder: spec.dstOwner });
      const [dstMarker] = await findEscrowMarkerPda({ offer: spec.dstOwner });
      const [srcMarker] = await findEscrowMarkerPda({ offer: spec.srcOwner });
      return [
        ro(await findBlockEntryPda(spec.srcOwner)),
        ro(config),
        ro(tail.registry),
        ro(ASSET_REGISTRY_PROGRAM_ADDRESS),
        ro(kycEntry),
        ro(dstMarker),
        ro(srcMarker),
        ro(await findExtraMetasPda(spec.mint)),
        ro(TRANSFER_HOOK_PROGRAM),
      ];
    }
  }
}

/**
 * `[create destination ATA?] [fresh account?] [approve?] transfer_checked + tail`.
 * The default is exactly a holder's direct transfer: the owners' ATAs,
 * decimals 0, the app's hook tail. Keys a probe generates (P8's fresh
 * account, D1/D2's delegate) live in memory only and are never written.
 */
export async function buildDirectTransfer(rpc: ChainRpc, spec: TransferSpec): Promise<Instruction[]> {
  const out: Instruction[] = [];
  const src = spec.src ?? (await ataOf(spec.srcOwner, spec.mint));
  let dst = spec.dst ?? (await ataOf(spec.dstOwner, spec.mint));
  if (spec.createDst) {
    out.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: spec.payer, owner: spec.dstOwner, mint: spec.mint, tokenProgram: TOKEN_2022 }));
  }
  if (spec.freshDst) {
    const account = await generateKeyPairSigner();
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(PLAIN_HOOK_ACCOUNT_SIZE)).send();
    out.push(
      getCreateAccountInstruction({ payer: spec.payer, newAccount: account, lamports, space: PLAIN_HOOK_ACCOUNT_SIZE, programAddress: TOKEN_2022 }),
      getInitializeAccount3Instruction({ account: account.address, mint: spec.mint, owner: spec.dstOwner }, { programAddress: TOKEN_2022 }),
    );
    dst = account.address;
  }
  if (spec.approveBy) {
    out.push(getApproveInstruction({ source: src, delegate: spec.authority.address, owner: spec.approveBy, amount: spec.amount }, { programAddress: TOKEN_2022 }));
  }
  const base = spec.unchecked
    ? getTransferInstruction({ source: src, destination: dst, authority: spec.authority, amount: spec.amount }, { programAddress: TOKEN_2022 })
    : getTransferCheckedInstruction(
        { source: src, mint: spec.mintAccount ?? spec.mint, destination: dst, authority: spec.authority, amount: spec.amount, decimals: spec.decimals ?? 0 },
        { programAddress: TOKEN_2022 },
      );
  const tail = await tailFor(rpc, spec, src, dst);
  out.push({ ...base, accounts: [...base.accounts, ...tail] });
  return out;
}

// ── Resume rule for a sent transfer (design-transfers §D.5) ──────────────────

/** The balances moved in a way that is neither "not sent" nor "landed": nothing is sent. */
export class XferDiverged extends Error {
  constructor(
    readonly label: string,
    readonly detail: string,
  ) {
    super(`${label}: ${detail}`);
    this.name = "XferDiverged";
  }
}

/**
 * The tri-state `done()` of a sent transfer, over fresh finalized balances
 * (null = no account, read as 0): the snapshot's post-state → landed (true,
 * never re-sent — this covers a false "dropped"); its pre-state → not sent
 * (false); anything else → XferDiverged (a consistency finding, no send).
 */
export function transferLanded(label: string, snap: XferSnapshot, balances: readonly (bigint | null)[]): boolean {
  const src = balances[0] ?? BigInt(0);
  const dst = balances[1] ?? BigInt(0);
  const amount = BigInt(snap.amount);
  const srcBefore = BigInt(snap.srcBefore);
  const dstBefore = BigInt(snap.dstBefore);
  if (src === srcBefore - amount && dst === dstBefore + amount) return true;
  if (src === srcBefore && dst === dstBefore) return false;
  throw new XferDiverged(label, `balances moved outside the simulator: source ${srcBefore}→${src}, destination ${dstBefore}→${dst} (a ${amount}-unit transfer expected)`);
}

// ── Probe expectations and classification ────────────────────────────────────

export type ProbeProgram = "asset_registry" | "transfer_hook" | "token_2022";

export type ProbeExpect =
  | { ok: true; hookInvoked?: boolean }
  | { ok: false; program: ProbeProgram; code: number | null; names: readonly string[] };

/** ok / expected-error: as expected; tx-error: another refusal; unexpected-accept: a refusal simulated OK. */
export type ProbeOutcome = "ok" | "expected-error" | "tx-error" | "unexpected-accept";

export type ProbeResult = { ok: boolean; failure: ChainFailure | null; hookInvoked: boolean };

/** Token-2022 custom codes the probes meet (spl-token-2022 TokenError; TLV AccountResolutionError). */
export const TOKEN_2022_ERRORS: ReadonlyMap<number, string> = new Map([
  [1, "InsufficientFunds"],
  [3, "MintMismatch"],
  [4, "OwnerMismatch"],
  [17, "AccountFrozen"],
  [18, "MintDecimalsMismatch"],
  [31, "MintRequiredForTransfer"],
  [2_724_315_840, "IncorrectAccount"],
]);
export const INCORRECT_ACCOUNT = 2_724_315_840;

/** classifyFailure (the e2e matcher) with Token-2022 named `token_2022`. */
export function classifyProbeFailure(err: unknown, logs: readonly string[]): ChainFailure {
  const failure = classifyFailure(err, logs);
  if (failure.program !== TOKEN_2022) return failure;
  return { program: "token_2022", code: failure.code, name: failure.code === null ? failure.name : (TOKEN_2022_ERRORS.get(failure.code) ?? failure.name) };
}

export function probeResult(simulation: Pick<SimulationResult, "ok" | "err" | "logs">): ProbeResult {
  return {
    ok: simulation.ok,
    failure: simulation.ok ? null : classifyProbeFailure(simulation.err, simulation.logs),
    // Any depth: the hook runs as Token-2022's CPI ("invoke [2]").
    hookInvoked: simulation.logs.some((line) => line.startsWith(`Program ${TRANSFER_HOOK_PROGRAM} invoke`)),
  };
}

export function matchProbe(expect: ProbeExpect, result: ProbeResult): ProbeOutcome {
  if (expect.ok) {
    if (!result.ok) return "tx-error";
    if (expect.hookInvoked !== undefined && expect.hookInvoked !== result.hookInvoked) return "tx-error";
    return "ok";
  }
  if (result.ok || !result.failure) return "unexpected-accept";
  const f = result.failure;
  if (f.program !== expect.program) return "tx-error";
  if (expect.code !== null) return f.code === expect.code ? "expected-error" : "tx-error";
  return f.code === null && f.name !== null && expect.names.includes(f.name) ? "expected-error" : "tx-error";
}

export function describeExpect(expect: ProbeExpect): string {
  if (expect.ok) return expect.hookInvoked === undefined ? "ok" : `ok, hook ${expect.hookInvoked ? "invoked" : "not invoked"}`;
  const names = expect.names.join(" | ");
  return expect.code === null ? `${expect.program}: ${names}` : `${expect.program}: ${names} (${expect.code})`;
}

export function describeResult(result: ProbeResult): string {
  return result.ok ? `ok, hook ${result.hookInvoked ? "invoked" : "not invoked"}` : describeFailure(result.failure);
}

/**
 * A simulation that says nothing about the transfer (retried later, never a
 * finding): an unknown blockhash, or a transaction-level error with no logs
 * that is not the fee payer's (a payer without SOL is a real failure).
 */
export function simulationInfraFailure(simulation: Pick<SimulationResult, "ok" | "err" | "logs">): string | null {
  if (simulation.ok) return null;
  const err = simulation.err;
  const name =
    typeof err === "string" ? err : err && typeof err === "object" && !("InstructionError" in err) ? (Object.keys(err)[0] ?? null) : null;
  if (name === "BlockhashNotFound") return name;
  if (name !== null && simulation.logs.length === 0 && name !== "AccountNotFound" && name !== "InsufficientFundsForFee") return name;
  return null;
}

// ── The probe table (design-transfers §B.1, plus the delegate and legacy rows) ─

/** What a probe needs of its pair (the offer only in the escrow stage). */
export type ProbePair = {
  hub: KeyPairSigner;
  peer: KeyPairSigner;
  mint: Address;
  /** Class B (another hook mint), for P7; null when the e2e state has none. */
  mintB: Address | null;
  /** The registry B4's KycGated-shaped tail names. */
  registry: Address;
  /** The peer's class A balance, read when a probe is built (P4 only). */
  peerBalance: () => Promise<bigint>;
  offer?: { pda: Address; escrow: Address };
};

export type ProbeDef = {
  id: string;
  /** The user whose stage runs it and whose journal line and verdict it is. */
  runner: "hub" | "peer";
  stage: "xfer.p1" | "xfer.probes" | "xfer.escrow";
  what: string;
  expect: ProbeExpect;
  /** Null: not drivable with this pair (journalled as a note, not a finding). */
  spec: (p: ProbePair) => Promise<TransferSpec | null>;
};

const t22 = (code: number | null, ...names: string[]): ProbeExpect => ({ ok: false, program: "token_2022", code, names });
const hook = (code: number, name: string): ProbeExpect => ({ ok: false, program: "transfer_hook", code, names: [name] });
const ONE = BigInt(1);

/** peer → hub, 1 unit, the app's tail: the base most rows change in one place. */
const peerToHub = (p: ProbePair): TransferSpec => ({ mint: p.mint, srcOwner: p.peer.address, dstOwner: p.hub.address, authority: p.peer, payer: p.peer, amount: ONE });

export const PROBES: readonly ProbeDef[] = [
  {
    id: "P1",
    runner: "hub",
    stage: "xfer.p1",
    what: "hub → peer, whose ATA does not exist yet (no create instruction)",
    // spl-token-2022 11 checks the destination's program first; 6.x unpacks it after the owner check.
    expect: t22(null, "IncorrectProgramId", "InvalidAccountData"),
    spec: async (p) => ({ mint: p.mint, srcOwner: p.hub.address, dstOwner: p.peer.address, authority: p.hub, payer: p.hub, amount: ONE }),
  },
  {
    id: "P2",
    runner: "peer",
    stage: "xfer.probes",
    what: "hub → its own ATA (self-transfer): Token-2022 returns before the hook CPI",
    expect: { ok: true, hookInvoked: false },
    spec: async (p) => ({ mint: p.mint, srcOwner: p.hub.address, dstOwner: p.hub.address, authority: p.hub, payer: p.hub, amount: ONE }),
  },
  {
    id: "P3",
    runner: "peer",
    stage: "xfer.probes",
    what: "hub → peer, amount 0: no zero check, the hook runs and ignores the amount",
    expect: { ok: true, hookInvoked: true },
    spec: async (p) => ({ mint: p.mint, srcOwner: p.hub.address, dstOwner: p.peer.address, authority: p.hub, payer: p.hub, amount: BigInt(0) }),
  },
  {
    id: "P4",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub, one unit more than the peer holds",
    expect: t22(1, "InsufficientFunds"),
    spec: async (p) => ({ ...peerToHub(p), amount: (await p.peerBalance()) + ONE }),
  },
  {
    id: "P5",
    runner: "peer",
    stage: "xfer.probes",
    what: "the peer signs for the hub's ATA (neither its owner nor a delegate)",
    expect: t22(4, "OwnerMismatch"),
    spec: async (p) => ({ mint: p.mint, srcOwner: p.hub.address, dstOwner: p.peer.address, authority: p.peer, payer: p.peer, amount: ONE }),
  },
  {
    id: "P6",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub with decimals 6 (the class mint has 0)",
    expect: t22(18, "MintDecimalsMismatch"),
    spec: async (p) => ({ ...peerToHub(p), decimals: 6 }),
  },
  {
    id: "P7",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub (class A accounts) naming the class B mint",
    expect: t22(3, "MintMismatch"),
    spec: async (p) => (p.mintB ? { ...peerToHub(p), mintAccount: p.mintB } : null),
  },
  {
    id: "P8",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → a fresh hub-owned account without ImmutableOwner (created in the simulated tx)",
    expect: hook(6011, "ImmutableOwnerRequired"),
    spec: async (p) => ({ ...peerToHub(p), freshDst: true }),
  },
  {
    id: "B1",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub with no hook tail at all (the hook program is not in the transaction)",
    // A runtime answer ("Unknown program"): pinned at the first devnet run.
    expect: t22(null, "MissingAccount"),
    spec: async (p) => ({ ...peerToHub(p), tail: { kind: "none" } }),
  },
  {
    id: "B2",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub, tail = [hook program] only (no meta list, nothing resolved)",
    expect: hook(6002, "MissingExtraAccount"),
    spec: async (p) => ({ ...peerToHub(p), tail: { kind: "hook-program-only" } }),
  },
  {
    id: "B3",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub, BlockEntry keyed on the destination owner",
    // Token-2022 resolves the meta list first; the hook's own 6013 is unreachable.
    expect: t22(INCORRECT_ACCOUNT, "IncorrectAccount"),
    spec: async (p) => ({ ...peerToHub(p), tail: { kind: "block-entry-of", owner: p.hub.address } }),
  },
  {
    id: "B4",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub, a KycGated-shaped 9-account tail on the Open mint (a stale mode cache)",
    expect: { ok: true, hookInvoked: true },
    spec: async (p) => ({ ...peerToHub(p), tail: { kind: "kyc-shaped", registry: p.registry } }),
  },
  {
    id: "D1",
    runner: "peer",
    stage: "xfer.probes",
    what: "approve(peer → a fresh delegate) + transfer by the delegate, BlockEntry of the source owner",
    expect: { ok: true, hookInvoked: true },
    spec: async (p) => ({ ...peerToHub(p), authority: await generateKeyPairSigner(), approveBy: p.peer }),
  },
  {
    id: "D2",
    runner: "peer",
    stage: "xfer.probes",
    what: "the same delegate transfer with the BlockEntry keyed on the delegate",
    // The hook keys the blocklist on the source OWNER, never the authority.
    expect: t22(INCORRECT_ACCOUNT, "IncorrectAccount"),
    spec: async (p) => {
      const delegate = await generateKeyPairSigner();
      return { ...peerToHub(p), authority: delegate, approveBy: p.peer, tail: { kind: "block-entry-of", owner: delegate.address } };
    },
  },
  {
    id: "L1",
    runner: "peer",
    stage: "xfer.probes",
    what: "peer → hub with the legacy unchecked Transfer (no mint account)",
    expect: t22(31, "MintRequiredForTransfer"),
    spec: async (p) => ({ ...peerToHub(p), unchecked: true }),
  },
  {
    id: "E1",
    runner: "peer",
    stage: "xfer.escrow",
    what: "the peer signs for the hub's offer escrow (owner: the offer PDA)",
    expect: t22(4, "OwnerMismatch"),
    spec: async (p) =>
      p.offer ? { mint: p.mint, srcOwner: p.offer.pda, src: p.offer.escrow, dstOwner: p.peer.address, authority: p.peer, payer: p.peer, amount: ONE } : null,
  },
  {
    id: "E2",
    runner: "peer",
    stage: "xfer.escrow",
    what: "peer → the offer escrow, a raw transfer_checked (accepted in Open mode)",
    // Never sent: nothing strands in Open mode (the tail has no config, so cancel pays the
    // whole escrow to the maker), but the peer's unit would end at the hub and break S6/S7.
    expect: { ok: true, hookInvoked: true },
    spec: async (p) =>
      p.offer ? { mint: p.mint, srcOwner: p.peer.address, dstOwner: p.offer.pda, dst: p.offer.escrow, authority: p.peer, payer: p.peer, amount: ONE } : null,
  },
];

export const probeDef = (id: string): ProbeDef => {
  const def = PROBES.find((p) => p.id === id);
  if (!def) throw new Error(`unknown transfer probe ${id}`);
  return def;
};
