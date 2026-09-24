// Synthetic json-encoded finalized transactions for the alarm and ledger
// tests: top-level instructions, inner (CPI) instructions, address lookup
// table keys and program logs, built the way getTransaction returns them.
import { getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import { EVENT_SPECS, eventSize } from "@/lib/server/onchain-events";

export const KEY = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

export type Ix = { program: string; accounts: string[]; data: Uint8Array };
export type TxSpec = {
  signature: string;
  /** The fee payer (first static key, a signer). */
  payer?: string;
  signers?: number;
  /** Top-level instructions, each with its inner (CPI) instructions. */
  instructions: { ix: Ix; inner?: Ix[] }[];
  /** Keys that are only in the loaded (ALT) section. */
  loaded?: { writable?: string[]; readonly?: string[] };
  logs?: string[] | null;
  err?: unknown;
  blockTime?: number | null;
  postTokenBalances?: { accountIndex: number; mint: string; owner?: string }[];
};

/** Builds the transaction; returns it with the resolved key list. */
export function buildTx(spec: TxSpec) {
  const loaded = [...(spec.loaded?.writable ?? []), ...(spec.loaded?.readonly ?? [])];
  const staticKeys: string[] = [];
  const all = () => [...staticKeys, ...loaded];
  const index = (key: string) => {
    const at = all().indexOf(key);
    if (at >= 0) return at;
    staticKeys.push(key);
    return all().indexOf(key);
  };
  const b58 = getBase58Decoder();
  const compile = (ix: Ix) => ({
    programIdIndex: index(ix.program), accounts: ix.accounts.map(index), data: b58.decode(ix.data),
  });
  // Static keys first: every non-loaded key must precede the loaded ones.
  if (spec.payer) staticKeys.push(spec.payer);
  for (const { ix, inner } of spec.instructions) {
    for (const x of [ix, ...(inner ?? [])]) {
      for (const key of [x.program, ...x.accounts]) if (!loaded.includes(key) && !staticKeys.includes(key)) staticKeys.push(key);
    }
  }
  const instructions = spec.instructions.map(({ ix }) => compile(ix));
  const innerInstructions = spec.instructions
    .map(({ inner }, i) => ({ index: i, instructions: (inner ?? []).map(compile) }))
    .filter((g) => g.instructions.length);
  const tx = {
    slot: 100,
    blockTime: spec.blockTime === undefined ? 1_700_000_000 : spec.blockTime,
    transaction: {
      signatures: [spec.signature],
      message: { accountKeys: staticKeys, header: { numRequiredSignatures: spec.signers ?? 1 }, instructions },
    },
    meta: {
      err: spec.err ?? null,
      loadedAddresses: { writable: spec.loaded?.writable ?? [], readonly: spec.loaded?.readonly ?? [] },
      innerInstructions,
      logMessages: spec.logs === undefined ? null : spec.logs,
      postTokenBalances: spec.postTokenBalances ?? [],
    },
  };
  return { tx, keys: all() };
}

/** Log lines of an invocation tree: `invoke [depth]`, data lines, `success`. */
export function logTree(frames: { program: string; data?: string[]; children?: Parameters<typeof logTree>[0] }[], depth = 1): string[] {
  const lines: string[] = [];
  for (const f of frames) {
    lines.push(`Program ${f.program} invoke [${depth}]`);
    for (const d of f.data ?? []) lines.push(`Program data: ${d}`);
    lines.push(...logTree(f.children ?? [], depth + 1));
    lines.push(`Program ${f.program} success`);
  }
  return lines;
}

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Encodes an event from the same spec (little-endian, as Anchor/Borsh). */
export function encodeEvent(name: string, values: Record<string, unknown>): Uint8Array {
  const spec = EVENT_SPECS.find((s) => s.name === name)!;
  const out = new Uint8Array(eventSize(spec));
  out.set(spec.discriminator, 0);
  const view = new DataView(out.buffer);
  let o = 8;
  for (const [field, type] of spec.fields) {
    const v = values[field];
    switch (type) {
      case "u8": case "ClawbackReason": case "IssuerAuthorityChangeKind": out[o] = Number(v ?? 0); o += 1; break;
      case "bool": out[o] = v ? 1 : 0; o += 1; break;
      case "pubkey": out.set(getAddressEncoder().encode((v ?? KEY) as Address), o); o += 32; break;
      case "u64": view.setBigUint64(o, BigInt((v as string | number | bigint | undefined) ?? 0), true); o += 8; break;
      case "i64": view.setBigInt64(o, BigInt((v as string | number | bigint | undefined) ?? 0), true); o += 8; break;
      case "bytes128": o += 128; break;
    }
  }
  return out;
}

