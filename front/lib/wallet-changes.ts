// What a wallet changed in a transaction while signing it.
//
// @solana/client accepts a wallet's modified message (modifyAndSignTransactions)
// and sends that one. Wallets do this to add their own priority fee or
// guard instructions; when the result is invalid for the network (a second
// compute-budget instruction, another network's blockhash), the RPC refuses
// it before execution with no program logs, and the error alone does not
// say why. The guarded wallet session (lib/guarded-wallet-connectors) keeps
// a one-line description of the latest change here, logs it to the console,
// and lib/tx-error adds it to the explanation of such a refusal (once).
// The note is cleared when a signing or a verified send starts and when a
// verified send succeeds, so it describes the latest signing only; two sends
// signed at the same moment can still share it.
import { getCompiledTransactionMessageDecoder, type ReadonlyUint8Array } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, decodeComputeBudgetInstruction } from "@/lib/compute-budget";

type MessageSummary = { lifetime: string; instructions: string[] };

const COMPUTE_BUDGET_KINDS: Record<number, string> = {
  0: "RequestUnits",
  1: "RequestHeapFrame",
  4: "SetLoadedAccountsDataSizeLimit",
};

function short(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function summarize(messageBytes: ReadonlyUint8Array): MessageSummary {
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const accounts = message.staticAccounts;
  const instructions = message.instructions.map((ix) => {
    const program = accounts[ix.programAddressIndex];
    if (!program) return "(lookup-table program)";
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const decoded = decodeComputeBudgetInstruction({ programAddress: program, data: ix.data });
      if (decoded?.kind === "limit") return `SetComputeUnitLimit(${decoded.units})`;
      if (decoded?.kind === "price") return `SetComputeUnitPrice(${decoded.microLamports})`;
      const kind = ix.data?.[0];
      return `ComputeBudget.${(kind !== undefined && COMPUTE_BUDGET_KINDS[kind]) || `#${kind ?? "?"}`}`;
    }
    return short(program);
  });
  return { lifetime: String(message.lifetimeToken), instructions };
}

function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * One line naming what the wallet changed between the message it was given
 * and the one it signed, or null when they are identical.
 */
export function describeWalletChange(
  before: ReadonlyUint8Array | undefined,
  after: ReadonlyUint8Array | undefined,
): string | null {
  if (!before || !after || sameBytes(before, after)) return null;
  let a: MessageSummary;
  let b: MessageSummary;
  try {
    a = summarize(before);
    b = summarize(after);
  } catch {
    return "the wallet changed the transaction before signing it";
  }
  const parts: string[] = [];
  if (a.lifetime !== b.lifetime) parts.push("replaced its blockhash");
  if (a.instructions.join() !== b.instructions.join()) {
    parts.push(`changed its instructions [${a.instructions.join(", ")}] → [${b.instructions.join(", ")}]`);
  }
  if (parts.length === 0) parts.push("changed its accounts or header");
  return `the wallet ${parts.join(" and ")} before signing`;
}

/** How long a noted change is attached to a failed send's explanation. */
export const WALLET_CHANGE_TTL_MS = 120_000;

let latest: { at: number; text: string } | null = null;

/** Called by the guarded session before each signing request. */
export function clearWalletChange(): void {
  latest = null;
}

/** Called by the guarded session when the wallet returned a different message. */
export function noteWalletChange(text: string, now: number = Date.now()): void {
  latest = { at: now, text };
}

/** The change noted for the latest signing request, if it is recent. */
export function recentWalletChange(now: number = Date.now()): string | null {
  return latest && now - latest.at <= WALLET_CHANGE_TTL_MS ? latest.text : null;
}

/** recentWalletChange, then cleared: a note explains one failure at most. */
export function takeWalletChange(now: number = Date.now()): string | null {
  const text = recentWalletChange(now);
  latest = null;
  return text;
}

// ── A wallet's compute-budget rewrite, accepted within bounds ────────────────
//
// Phantom (mainnet) rewrites the compute budget of the transactions it signs:
// its own SetComputeUnitLimit and SetComputeUnitPrice in place of Manci's.
// A transaction a distribution journals and broadcasts (lib/verified-solana-
// client prepareAndSendAll) may differ from the one built in that, and only
// in that: with every Compute Budget instruction removed from both (and the
// Compute Budget program key, where nothing else uses it), the two messages
// must be the same transaction — version, fee payer, blockhash, every other
// instruction in the same order with the same program, data and accounts,
// every account with the same signer/writable role, the same lookup tables.
// The wallet's price must stay at or under Manci's cap for the network
// (lib/priority-fee), its limit at or above what the simulation consumed,
// and it may set nothing else (one limit and one price at most; no heap
// frame, no loaded-data limit). What is journalled and broadcast is then the
// wallet's signature over the wallet's message: the same blockhash, so the
// same expiry height.

/** The bounds a wallet's compute budget must stay within. */
export type ComputeBudgetBounds = {
  /** The highest SetComputeUnitPrice a wallet may set, in micro-lamports per compute unit. */
  maxComputeUnitPrice: bigint;
  /**
   * The fewest compute units the transaction needs (the simulation's
   * consumption), or null to require the limit the built message carries.
   */
  minComputeUnitLimit: number | null;
};

export type WalletRewriteVerdict =
  | { kind: "identical" }
  | { kind: "compute-budget"; change: string; units: number | null; microLamports: bigint }
  | { kind: "refused"; change: string };

type Role = "signer-writable" | "signer" | "writable" | "readonly";
type BudgetSettings = { limit: number | null; price: bigint | null; problem: string | null; summary: string[] };
type Normalized = {
  version: string;
  feePayer: string;
  lifetime: string;
  lookups: string;
  /** Every static account but the Compute Budget program (when only its instructions use it), with its role. */
  accounts: Map<string, Role>;
  /** The other instructions, in order: program, data and resolved accounts with their roles. */
  instructions: { program: string; data: string; accounts: string }[];
  budget: BudgetSettings;
  summary: string[];
};

function hex(data: ArrayLike<number> | undefined): string {
  if (!data) return "";
  let out = "";
  for (let i = 0; i < data.length; i++) out += data[i].toString(16).padStart(2, "0");
  return out;
}

function normalize(messageBytes: ReadonlyUint8Array): Normalized {
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const { header, staticAccounts } = message;
  const signerCount = header.numSignerAccounts;
  const writableSignerEnd = signerCount - header.numReadonlySignerAccounts;
  const writableEnd = staticAccounts.length - header.numReadonlyNonSignerAccounts;
  if (staticAccounts.length === 0 || writableSignerEnd < 1 || signerCount > staticAccounts.length || writableEnd < signerCount) {
    throw new Error("malformed header");
  }
  const lookups = "addressTableLookups" in message ? (message.addressTableLookups ?? []) : [];
  const writableLookups: string[] = [];
  const readonlyLookups: string[] = [];
  for (const table of lookups) {
    for (const index of table.writableIndexes) writableLookups.push(`${table.lookupTableAddress}#${index}`);
    for (const index of table.readonlyIndexes) readonlyLookups.push(`${table.lookupTableAddress}#${index}`);
  }
  const staticRole = (i: number): Role =>
    i < signerCount ? (i < writableSignerEnd ? "signer-writable" : "signer") : i < writableEnd ? "writable" : "readonly";
  function resolve(index: number): string {
    if (index < staticAccounts.length) return `${staticAccounts[index]}:${staticRole(index)}`;
    const j = index - staticAccounts.length;
    if (j < writableLookups.length) return `${writableLookups[j]}:writable`;
    const r = j - writableLookups.length;
    if (r < readonlyLookups.length) return `${readonlyLookups[r]}:readonly`;
    throw new Error("account index out of range");
  }

  const instructions: Normalized["instructions"] = [];
  const budget: BudgetSettings = { limit: null, price: null, problem: null, summary: [] };
  const summary: string[] = [];
  // Whether anything but a Compute Budget instruction names the Compute Budget program.
  let budgetKeyUsedElsewhere = false;
  for (const ix of message.instructions) {
    const program = staticAccounts[ix.programAddressIndex];
    if (!program) throw new Error("program index out of range");
    const indices = ix.accountIndices ?? [];
    const accounts = indices.map(resolve);
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const decoded = decodeComputeBudgetInstruction({ programAddress: program, data: ix.data });
      const kind = ix.data?.[0];
      const label =
        decoded?.kind === "limit" ? `SetComputeUnitLimit(${decoded.units})`
        : decoded?.kind === "price" ? `SetComputeUnitPrice(${decoded.microLamports})`
        : `ComputeBudget.${(kind !== undefined && COMPUTE_BUDGET_KINDS[kind]) || `#${kind ?? "?"}`}`;
      summary.push(label);
      budget.summary.push(label);
      if (budget.problem) continue;
      if (!decoded || indices.length > 0) {
        budget.problem = `added a compute-budget instruction Manci does not accept (${label})`;
      } else if (decoded.kind === "limit") {
        if (budget.limit !== null) budget.problem = "set the compute unit limit twice";
        budget.limit = decoded.units;
      } else {
        if (budget.price !== null) budget.problem = "set the compute unit price twice";
        budget.price = decoded.microLamports;
      }
      continue;
    }
    summary.push(short(program));
    if (indices.some((i) => staticAccounts[i] === COMPUTE_BUDGET_PROGRAM_ADDRESS)) budgetKeyUsedElsewhere = true;
    instructions.push({ program, data: hex(ix.data), accounts: accounts.join(",") });
  }

  const accounts = new Map<string, Role>();
  staticAccounts.forEach((account, i) => {
    if (account === COMPUTE_BUDGET_PROGRAM_ADDRESS && !budgetKeyUsedElsewhere) return;
    accounts.set(account, staticRole(i));
  });
  return {
    version: String(message.version),
    feePayer: staticAccounts[0],
    lifetime: String(message.lifetimeToken),
    lookups: JSON.stringify(lookups.map((t) => [t.lookupTableAddress, [...t.writableIndexes], [...t.readonlyIndexes]])),
    accounts,
    instructions,
    budget,
    summary,
  };
}

function sameAccounts(a: Map<string, Role>, b: Map<string, Role>): boolean {
  if (a.size !== b.size) return false;
  for (const [account, role] of a) if (b.get(account) !== role) return false;
  return true;
}

/**
 * Whether the message a wallet signed (`after`) may be journalled and
 * broadcast in place of the one Manci built (`before`): identical, or the
 * same transaction with only its compute budget rewritten within `bounds`.
 * A refusal names what the wallet changed, in words for the user.
 */
export function judgeWalletRewrite(
  before: ReadonlyUint8Array,
  after: ReadonlyUint8Array,
  bounds: ComputeBudgetBounds,
): WalletRewriteVerdict {
  if (sameBytes(before, after)) return { kind: "identical" };
  let a: Normalized;
  let b: Normalized;
  try {
    a = normalize(before);
    b = normalize(after);
  } catch {
    return { kind: "refused", change: "the wallet changed the transaction before signing it" };
  }

  const parts: string[] = [];
  if (a.version !== b.version) parts.push("changed its version");
  if (a.lifetime !== b.lifetime) parts.push("replaced its blockhash");
  if (a.feePayer !== b.feePayer) parts.push("changed its fee payer");
  if (a.instructions.map((ix) => ix.program).join() !== b.instructions.map((ix) => ix.program).join()) {
    parts.push(`changed its instructions [${a.summary.join(", ")}] → [${b.summary.join(", ")}]`);
  } else {
    a.instructions.forEach((ix, i) => {
      const label = `instruction ${i + 1 + a.budget.summary.length} (${short(ix.program)})`;
      if (ix.data !== b.instructions[i].data) parts.push(`changed the data of ${label}`);
      if (ix.accounts !== b.instructions[i].accounts) parts.push(`changed the accounts of ${label}`);
    });
  }
  if (a.lookups !== b.lookups) parts.push("changed its address lookup tables");
  if (parts.length === 0 && !sameAccounts(a.accounts, b.accounts)) parts.push("changed its accounts or their signer/writable roles");
  if (parts.length > 0) return { kind: "refused", change: `the wallet ${parts.join(" and ")} before signing` };

  // The same transaction: only the compute budget differs.
  const rewrite = `[${a.budget.summary.join(", ")}] → [${b.budget.summary.join(", ")}]`;
  if (b.budget.problem) return { kind: "refused", change: `the wallet ${b.budget.problem} before signing` };
  const price = b.budget.price ?? BigInt(0);
  if (price > bounds.maxComputeUnitPrice) {
    return {
      kind: "refused",
      change: `the wallet raised the priority fee to ${price} micro-lamports per compute unit, above Manci's cap of ${bounds.maxComputeUnitPrice}, before signing ${rewrite}`,
    };
  }
  const needed = bounds.minComputeUnitLimit ?? a.budget.limit;
  if (b.budget.limit === null) {
    if (a.budget.limit !== null) {
      return { kind: "refused", change: `the wallet removed the compute unit limit before signing ${rewrite}` };
    }
  } else if (needed !== null && b.budget.limit < needed) {
    return {
      kind: "refused",
      change: `the wallet lowered the compute unit limit to ${b.budget.limit}, below the ${needed} this transaction needs, before signing ${rewrite}`,
    };
  }
  return {
    kind: "compute-budget",
    change: `the wallet changed its compute budget ${rewrite} before signing`,
    units: b.budget.limit,
    microLamports: price,
  };
}
