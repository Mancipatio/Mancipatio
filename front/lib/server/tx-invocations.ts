// Pure: every program invocation of a finalized transaction (top-level and
// inner, including address-lookup-table keys), in execution order, and the
// `Program data:` (Anchor event) lines each invocation of one program logged.
//
// Detection never depends on logs: logs can be truncated, and a CPI caller
// (Squads, any wrapper) must not hide an instruction. Events only add detail,
// and are accepted only from frames of the program itself: a `Program data:`
// line written while another program is on top of the invoke stack (a
// spoof) is never attributed.

import { getBase58Encoder } from "@solana/kit";

type Index = number | bigint;
type CompiledIx = { programIdIndex: Index; accounts: readonly Index[]; data: string; stackHeight?: Index | null };

/** The subset of a json-encoded getTransaction result this module reads. */
export type InvocationTx = {
  blockTime?: Index | null;
  transaction: {
    signatures: readonly string[];
    message: { accountKeys: readonly string[]; header?: { numRequiredSignatures: Index }; instructions: readonly CompiledIx[] };
  };
  meta: null | {
    err: unknown;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
    innerInstructions?: readonly { index: Index; instructions: readonly CompiledIx[] }[] | null;
    logMessages?: readonly string[] | null;
  };
};

export type Invocation = {
  /** Position in execution order, from 0. */
  ordinal: number;
  programId: string;
  accounts: string[];
  data: Uint8Array;
  inner: boolean;
  /** The top-level instruction this runs under. */
  topIndex: number;
};

export type EventState = "complete" | "truncated" | "missing" | "mismatch";
export type AttributedInvocation = Invocation & { events: Uint8Array[]; eventState: EventState };

/** Static keys, then loaded writable, then loaded readonly (the v0 order). */
export function resolveAccountKeys(tx: InvocationTx): string[] {
  return [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
}

function keyAt(keys: readonly string[], value: Index): string {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n >= keys.length) throw new Error("Invalid transaction account index");
  return keys[n];
}

/** Execution order: top[i], then the inner instructions recorded under i. */
export function flattenInvocations(tx: InvocationTx): Invocation[] {
  const keys = resolveAccountKeys(tx);
  const encoder = getBase58Encoder();
  const inner = new Map<number, readonly CompiledIx[]>();
  for (const group of tx.meta?.innerInstructions ?? []) inner.set(Number(group.index), group.instructions);
  const out: Invocation[] = [];
  const push = (ix: CompiledIx, isInner: boolean, topIndex: number) => {
    out.push({
      ordinal: out.length,
      programId: keyAt(keys, ix.programIdIndex),
      accounts: ix.accounts.map((a) => keyAt(keys, a)),
      data: new Uint8Array(encoder.encode(ix.data)),
      inner: isInner,
      topIndex,
    });
  };
  tx.transaction.message.instructions.forEach((ix, i) => {
    push(ix, false, i);
    for (const child of inner.get(i) ?? []) push(child, true, i);
  });
  return out;
}

export type ProgramFrames = {
  /** One entry per invocation of `program`, in invoke order: its data lines. */
  frames: string[][];
  /** Whether each frame's success/failure line was seen. */
  closed: boolean[];
  truncated: boolean;
  /** False when the invoke stack in the logs is inconsistent. */
  consistent: boolean;
};

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\S+) (success|failed: .*)$/;
const DATA = /^Program data: (\S+)$/;

/** Rebuilds the invoke stack from the logs and attributes `Program data:`
 * lines to the frame on top, keeping only `program`'s frames. */
export function attributeProgramData(logs: readonly string[], program: string): ProgramFrames {
  const stack: { program: string; frame: number | null }[] = [];
  const frames: string[][] = [];
  const closed: boolean[] = [];
  let consistent = true;
  for (const line of logs) {
    if (line.startsWith("Log truncated")) return { frames, closed, truncated: true, consistent };
    const invoke = INVOKE.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) consistent = false;
      let frame: number | null = null;
      if (invoke[1] === program) {
        frame = frames.length;
        frames.push([]);
        closed.push(false);
      }
      stack.push({ program: invoke[1], frame });
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      const top = stack.pop();
      if (!top || top.program !== exit[1]) consistent = false;
      else if (top.frame !== null) closed[top.frame] = true;
      continue;
    }
    const data = DATA.exec(line);
    if (data) {
      const top = stack[stack.length - 1];
      if (top && top.program === program && top.frame !== null) frames[top.frame].push(data[1]);
    }
  }
  if (stack.length) consistent = false;
  return { frames, closed, truncated: false, consistent };
}

function base64Bytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Every invocation, with the events of `program`'s invocations: the k-th
 * frame of `program` in the logs belongs to its k-th invocation. */
export function transactionInvocations(tx: InvocationTx, program: string): AttributedInvocation[] {
  const invocations = flattenInvocations(tx);
  const logs = tx.meta?.logMessages;
  const ours = invocations.filter((i) => i.programId === program);
  const attributed = logs ? attributeProgramData(logs, program) : null;
  const countsMatch = attributed !== null && !attributed.truncated && attributed.frames.length === ours.length;
  let k = 0;
  return invocations.map((inv) => {
    if (inv.programId !== program) return { ...inv, events: [], eventState: "complete" as const };
    const index = k++;
    if (!attributed) return { ...inv, events: [], eventState: "missing" as const };
    if (!attributed.consistent || (!attributed.truncated && !countsMatch)) {
      return { ...inv, events: [], eventState: "mismatch" as const };
    }
    const frame = attributed.frames[index];
    // Truncated: only a frame whose exit line was logged is whole.
    if (attributed.truncated && (!frame || !attributed.closed[index])) {
      return { ...inv, events: (frame ?? []).map(base64Bytes).filter((b): b is Uint8Array => b !== null), eventState: "truncated" as const };
    }
    const events = frame.map(base64Bytes);
    if (events.some((e) => e === null)) return { ...inv, events: [], eventState: "mismatch" as const };
    return { ...inv, events: events as Uint8Array[], eventState: "complete" as const };
  });
}
