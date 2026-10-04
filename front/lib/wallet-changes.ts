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

// ── What a wallet may change in a distribution, accepted within bounds ──────
//
// A transaction a distribution journals and broadcasts (lib/verified-solana-
// client prepareAndSendAll) may differ from the one built in two ways only.
//
// 1. Guard instructions. Phantom on mainnet adds Lighthouse assertions to the
//    transactions it signs, before and/or after the app's instructions, and
//    the Lighthouse program key with them; it leaves Manci's compute budget
//    as built (every Manci mainnet transaction it signed). They are set apart
//    only when ALL of these hold: the program is exactly
//    LIGHTHOUSE_PROGRAM_ADDRESS (look-alike addresses circulate); the first
//    data byte is an assertion that only reads its accounts
//    (LIGHTHOUSE_ASSERTIONS: never MemoryWrite or MemoryClose, never one
//    that calls another program, never an unknown one) and the second a log
//    level that calls no other program (LIGHTHOUSE_LOG_LEVELS); each sits
//    before the app's first instruction or after its last, never between
//    them; each names only accounts the built message has, in the same
//    role; and the Lighthouse key is a read-only non-signer that no
//    instruction names as an account. An assertion reads its accounts and
//    fails the transaction when it does not hold; it moves nothing.
// 2. The compute budget (a wallet that sets its own): the price at or under
//    Manci's cap for the network (lib/priority-fee), the limit at or above
//    what the simulation consumed (plus LIGHTHOUSE_GUARD_UNITS per guard),
//    and nothing else set (one limit and one price at most; no heap frame,
//    no loaded-data limit).
//
// With those removed from both (and the Compute Budget and Lighthouse
// program keys, where nothing else uses them), the two messages must be the
// same transaction: version, fee payer, blockhash, every other instruction
// in the same order with the same program, data and accounts, every account
// with the same signer/writable role, the same lookup tables. What is
// journalled and broadcast is then the wallet's signature over the wallet's
// message: the same blockhash, so the same expiry height. The network's
// preflight simulates that exact message, guards included, before it can
// land; one that lands and fails an assertion is a failed transaction
// (nothing moved; lib/distribution-run sends its rows again).
//
// A guard holds only against the state the wallet simulated when it signed.
// Phantom's on the fee payer (its mainnet transactions): lamports at least
// the balance it saw less the fee, 1.1 × the rent the transaction pays and
// 0.005 SOL, so another transaction that spends more than that slack (4 new
// token accounts or more) and lands first makes it fail. Transactions with
// guards are therefore not independent: lib/verified-solana-client never
// sends several of them signed together (the batch falls back to one prompt
// per transaction) and asks for each signature only once the previous
// transaction is confirmed.

/** Lighthouse, the assertion program Phantom adds (immutable on mainnet: its program data has no upgrade authority). */
export const LIGHTHOUSE_PROGRAM_ADDRESS = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * The Lighthouse instructions that only read their accounts and call no
 * other program, by their first data byte (lighthouse-sdk 2.1.0
 * LighthouseInstruction; each names its target accounts read-only). 0
 * MemoryWrite and 1 MemoryClose write; 16 AssertMerkleTreeAccount (it calls
 * the account-compression program) and 17 AssertBubblegumTreeConfigAccount
 * check compressed-NFT trees, which no Manci transaction has. None of them
 * is here. Phantom on mainnet: 6 on the fee payer and the accounts a
 * transaction creates or reads, 10 on a token account.
 */
const LIGHTHOUSE_ASSERTIONS: Record<number, string> = {
  2: "AssertAccountData",
  3: "AssertAccountDataMulti",
  4: "AssertAccountDelta",
  5: "AssertAccountInfo",
  6: "AssertAccountInfoMulti",
  7: "AssertMintAccount",
  8: "AssertMintAccountMulti",
  9: "AssertTokenAccount",
  10: "AssertTokenAccountMulti",
  11: "AssertStakeAccount",
  12: "AssertStakeAccountMulti",
  13: "AssertUpgradeableLoaderAccount",
  14: "AssertUpgradeableLoaderAccountMulti",
  15: "AssertSysvarClock",
};

/**
 * The log levels (an assertion's second data byte, lighthouse LogLevel) that
 * only log: 0 Silent, 1 PlaintextMessage, 2 EncodedMessage, 4
 * FailedPlaintextMessage (Phantom's), 5 FailedEncodedMessage. 3 EncodedNoop
 * and 6 FailedEncodedNoop log through a call to the SPL Noop program.
 */
const LIGHTHOUSE_LOG_LEVELS: ReadonlySet<number> = new Set([0, 1, 2, 4, 5]);

/**
 * The compute units allowed for each Lighthouse assertion: the most one cost
 * on mainnet (6,471, an AssertTokenAccountMulti; the fee payer's
 * AssertAccountInfoMulti 1,002 to 1,818), rounded up. The gate's simulation
 * ran without the guards, so a limit below the simulated need plus this much
 * per guard may run out on chain. Manci's own limit (at least 200,000 and
 * 1.1 × the simulated need, below the 1.4M cap) leaves 10 % of the need (and
 * whatever the 200,000 floor adds) for them; a distribution's adds
 * DISTRIBUTION_GUARD_HEADROOM_UNITS on top.
 */
export const LIGHTHOUSE_GUARD_UNITS = 7_000;

/**
 * Compute units a "Send to wallets" transaction's limit carries on top of
 * 1.1 × its simulated need (lib/verified-solana-client prepareAndSendAll
 * computeUnitHeadroom): room for four wallet guards (Phantom adds two or
 * three on mainnet) on any transaction, also a large one whose 10 % margin
 * alone would not cover them — judgeWalletRewrite requires the need plus
 * LIGHTHOUSE_GUARD_UNITS per guard, and refuses a copy whose limit is short
 * of it. The limit is then max(200,000, ceil(1.1 × need) + 28,000), at most
 * 1,400,000.
 *
 * Fee: the priority fee is paid on the limit, so it costs at most 28,000 ×
 * the price more per transaction: 2,800 lamports (0.0000028 SOL) at the
 * mainnet price of 100,000 micro-lamports per compute unit, less when the
 * 200,000 floor already covered part of it, nothing when it covered all of
 * it (a transaction that needs under ~156,000).
 */
export const DISTRIBUTION_GUARD_HEADROOM_UNITS = 4 * LIGHTHOUSE_GUARD_UNITS;

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

/**
 * What a refusal is about, for the words the user gets: "compute-budget"
 * when only the wallet's own fee or limit is out of bounds (a wallet setting
 * can fix that), "guards" when the Lighthouse assertions the wallet added
 * cannot be accepted (one Manci does not accept, or more than the
 * transaction's own limit or packet has room for: no wallet setting fixes
 * that), "transaction" when the wallet changed anything else.
 */
export type WalletRewriteRefusal = "compute-budget" | "guards" | "transaction";

export type WalletRewriteVerdict =
  | { kind: "identical" }
  | { kind: "accepted"; change: string; units: number | null; microLamports: bigint; guards: number }
  | { kind: "refused"; change: string; about: WalletRewriteRefusal };

type Role = "signer-writable" | "signer" | "writable" | "readonly";
type BudgetSettings = { limit: number | null; price: bigint | null; problem: string | null; summary: string[] };
type Guard = {
  label: string;
  /**
   * null when it is an assertion Manci accepts (LIGHTHOUSE_ASSERTIONS, with
   * a log level from LIGHTHOUSE_LOG_LEVELS), else what it is, for the refusal.
   */
  unaccepted: string | null;
  /** How many of the app's instructions come before it. */
  position: number;
  /** Its accounts, resolved with their roles. */
  accounts: string[];
};
type Normalized = {
  version: string;
  feePayer: string;
  lifetime: string;
  lookups: string;
  /**
   * Every static account but the Compute Budget program (when only its
   * instructions use it) and, in a wallet's copy, the Lighthouse program
   * (when only its guards use it), with its role.
   */
  accounts: Map<string, Role>;
  /** Every account an instruction can name, resolved with its role (static and looked up). */
  names: Set<string>;
  /** The other instructions, in order: program, data and resolved accounts with their roles. */
  instructions: { program: string; data: string; accounts: string }[];
  budget: BudgetSettings;
  /** The Lighthouse instructions a wallet added (a wallet's copy only), in order. */
  guards: Guard[];
  /** The Lighthouse program key's role when the guards were set apart, else null. */
  guardKeyRole: Role | null;
  summary: string[];
};

function hex(data: ArrayLike<number> | undefined): string {
  if (!data) return "";
  let out = "";
  for (let i = 0; i < data.length; i++) out += data[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * The message taken apart for judgeWalletRewrite. In a wallet's copy
 * (`walletCopy`) Lighthouse instructions are set apart as guards; in the
 * message Manci built they would stay ordinary instructions.
 */
function normalize(messageBytes: ReadonlyUint8Array, walletCopy = false): Normalized {
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
  const guards: Guard[] = [];
  const summary: string[] = [];
  // Whether anything but a Compute Budget instruction names the Compute Budget program.
  let budgetKeyUsedElsewhere = false;
  // Whether any instruction names the Lighthouse program as an account.
  let guardKeyNamed = false;
  for (const ix of message.instructions) {
    const program = staticAccounts[ix.programAddressIndex];
    if (!program) throw new Error("program index out of range");
    const indices = ix.accountIndices ?? [];
    const accounts = indices.map(resolve);
    if (indices.some((i) => staticAccounts[i] === LIGHTHOUSE_PROGRAM_ADDRESS)) guardKeyNamed = true;
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
    if (indices.some((i) => staticAccounts[i] === COMPUTE_BUDGET_PROGRAM_ADDRESS)) budgetKeyUsedElsewhere = true;
    if (walletCopy && program === LIGHTHOUSE_PROGRAM_ADDRESS) {
      const kind = ix.data?.[0];
      const name = kind === undefined ? undefined : LIGHTHOUSE_ASSERTIONS[kind];
      const label = `Lighthouse.${name ?? `#${kind ?? "?"}`}`;
      const level = ix.data?.[1];
      const unaccepted =
        name === undefined ? label
        : level === undefined || !LIGHTHOUSE_LOG_LEVELS.has(level) ? `${label} with log level ${level ?? "none"}`
        : null;
      summary.push(label);
      guards.push({ label, unaccepted, position: instructions.length, accounts });
      continue;
    }
    summary.push(short(program));
    instructions.push({ program, data: hex(ix.data), accounts: accounts.join(",") });
  }

  const guardKeySetApart = guards.length > 0 && !guardKeyNamed;
  let guardKeyRole: Role | null = null;
  const accounts = new Map<string, Role>();
  const names = new Set<string>([...writableLookups.map((a) => `${a}:writable`), ...readonlyLookups.map((a) => `${a}:readonly`)]);
  staticAccounts.forEach((account, i) => {
    names.add(`${account}:${staticRole(i)}`);
    if (account === COMPUTE_BUDGET_PROGRAM_ADDRESS && !budgetKeyUsedElsewhere) return;
    if (account === LIGHTHOUSE_PROGRAM_ADDRESS && guardKeySetApart) {
      guardKeyRole = staticRole(i);
      return;
    }
    accounts.set(account, staticRole(i));
  });
  return {
    version: String(message.version),
    feePayer: staticAccounts[0],
    lifetime: String(message.lifetimeToken),
    lookups: JSON.stringify(lookups.map((t) => [t.lookupTableAddress, [...t.writableIndexes], [...t.readonlyIndexes]])),
    accounts,
    names,
    instructions,
    budget,
    guards,
    guardKeyRole,
    summary,
  };
}

function sameAccounts(a: Map<string, Role>, b: Map<string, Role>): boolean {
  if (a.size !== b.size) return false;
  for (const [account, role] of a) if (b.get(account) !== role) return false;
  return true;
}

/** Why the guards in the wallet's copy cannot be accepted, or null when they can. */
function guardProblem(built: Normalized, signed: Normalized): string | null {
  const appCount = signed.instructions.length;
  for (const guard of signed.guards) {
    if (guard.unaccepted !== null) return `added a Lighthouse instruction Manci does not accept (${guard.unaccepted})`;
    if (guard.position !== 0 && guard.position !== appCount) {
      return `put a Lighthouse instruction (${guard.label}) between the transaction's own instructions`;
    }
    const unknown = guard.accounts.find((account) => !built.names.has(account));
    if (unknown !== undefined) {
      const at = unknown.lastIndexOf(":");
      return `added a Lighthouse instruction (${guard.label}) that names ${short(unknown.slice(0, at))} as ${unknown.slice(at + 1)}, which the transaction does not`;
    }
  }
  if (signed.guardKeyRole !== null && signed.guardKeyRole !== "readonly") {
    return `gave the Lighthouse program a ${signed.guardKeyRole} role`;
  }
  return null;
}

/**
 * Whether the message a wallet signed (`after`) may be journalled and
 * broadcast in place of the one Manci built (`before`): identical, or the
 * same transaction with only Lighthouse assertions added and/or its compute
 * budget rewritten within `bounds`. A refusal names what the wallet changed,
 * in words for the user.
 */
export function judgeWalletRewrite(
  before: ReadonlyUint8Array,
  after: ReadonlyUint8Array,
  bounds: ComputeBudgetBounds,
): WalletRewriteVerdict {
  if (sameBytes(before, after)) return { kind: "identical" };
  const refused = (change: string, about: WalletRewriteRefusal = "transaction"): WalletRewriteVerdict => ({ kind: "refused", change, about });
  let a: Normalized;
  let b: Normalized;
  try {
    a = normalize(before);
    b = normalize(after, true);
  } catch {
    return refused("the wallet changed the transaction before signing it");
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
  if (parts.length === 0) {
    const problem = guardProblem(a, b);
    if (problem) return refused(`the wallet ${problem} before signing`, "guards");
  }
  if (parts.length === 0 && !sameAccounts(a.accounts, b.accounts)) parts.push("changed its accounts or their signer/writable roles");
  if (parts.length > 0) return refused(`the wallet ${parts.join(" and ")} before signing`);

  // The same transaction: only guards were added and/or the compute budget differs.
  const rewrite = `[${a.budget.summary.join(", ")}] → [${b.budget.summary.join(", ")}]`;
  if (b.budget.problem) return refused(`the wallet ${b.budget.problem} before signing`, "compute-budget");
  const price = b.budget.price ?? BigInt(0);
  if (price > bounds.maxComputeUnitPrice) {
    return refused(
      `the wallet raised the priority fee to ${price} micro-lamports per compute unit, above Manci's cap of ${bounds.maxComputeUnitPrice}, before signing ${rewrite}`,
      "compute-budget",
    );
  }
  const guards = b.guards.length;
  const guardList = `${guards} Lighthouse instruction${guards === 1 ? "" : "s"} [${b.guards.map((g) => g.label).join(", ")}]`;
  // The simulation ran without the guards: the limit must leave room for them too.
  const needed = bounds.minComputeUnitLimit !== null ? bounds.minComputeUnitLimit + guards * LIGHTHOUSE_GUARD_UNITS : a.budget.limit;
  if (b.budget.limit === null) {
    if (a.budget.limit !== null) {
      return refused(`the wallet removed the compute unit limit before signing ${rewrite}`, "compute-budget");
    }
  } else if (needed !== null && b.budget.limit < needed) {
    // A wallet that kept Manci's compute budget (Phantom) has no setting that makes room: only its guards are short of it.
    const keptBudget = a.budget.summary.join() === b.budget.summary.join();
    return refused(
      guards > 0
        ? `the wallet added ${guardList}, and the compute unit limit of ${b.budget.limit} is below the ${needed} the transaction needs with them, before signing ${rewrite}`
        : `the wallet lowered the compute unit limit to ${b.budget.limit}, below the ${needed} this transaction needs, before signing ${rewrite}`,
      guards > 0 && keptBudget ? "guards" : "compute-budget",
    );
  }
  const changes: string[] = [];
  if (guards > 0) changes.push(`added ${guardList}`);
  if (a.budget.summary.join() !== b.budget.summary.join()) changes.push(`changed its compute budget ${rewrite}`);
  if (changes.length === 0) changes.push("reordered its accounts");
  return {
    kind: "accepted",
    change: `the wallet ${changes.join(" and ")} before signing`,
    units: b.budget.limit,
    microLamports: price,
    guards,
  };
}
