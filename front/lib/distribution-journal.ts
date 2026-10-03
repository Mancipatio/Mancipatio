// "Send to wallets": the run journal that makes a distribution resumable and
// never sends a row twice (design §3, "Journal and resume").
//
// A run is one list of wallets and amounts, sent by one wallet from one mint.
// Its id is a hash of (network, mint, sender, the list sorted by wallet), so
// pasting the same list again resumes the same run instead of sending it
// twice; "start as a new run" adds a nonce on purpose.
//
// The journal lives in this browser (localStorage) and is written for every
// transaction AFTER the wallet signed it and BEFORE it is broadcast: its
// signature and last valid block height are known before the network can
// see it. On reopen each journalled transaction is asked for
// (getSignatureStatuses with history) and decided:
//   confirmed / finalized → its rows are done, never sent again;
//   failed               → nothing moved, its rows are sent again;
//   unknown and the finalized block height is past its last valid block
//   height                → it can never land, its rows are sent again;
//   otherwise            → still pending: wait, send nothing.
// The backstop: the treasury token account's signatures since the run
// started, decoded for transfer_checked (only the treasury's owner can move
// it), mark rows done when the journal missed them. Recipients' balances are
// never used for this (they move freely). No Memo instruction is needed.
//
// Pure and node-safe (the storage is passed in): tests/distribution-journal.test.ts.
import { getBase58Encoder, type Address } from "@solana/kit";
import { normalizedRows } from "@/lib/distribution-rows";

export const JOURNAL_PREFIX = "mancipatio:distribution:v1:";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Token-2022 TransferChecked. */
const TRANSFER_CHECKED = 12;

// ── Run id ──────────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256(network | mint | sender | rows sorted by wallet [| nonce]), hex. */
export async function distributionRunId(input: {
  network: string;
  mint: string;
  sender: string;
  rows: readonly { wallet: string; amount: bigint }[];
  nonce?: string | null;
}): Promise<string> {
  const text = [input.network, input.mint, input.sender, normalizedRows(input.rows as { wallet: Address; amount: bigint }[]), input.nonce ?? ""].join("|");
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The first 8 characters: the run's name in the reason and on screen. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

// ── Journal ─────────────────────────────────────────────────────────────────

export type JournalTxStatus = "signed" | "sent" | "confirmed" | "failed" | "expired";

export type JournalTx = {
  signature: string;
  /** Decimal string (bigint). */
  lastValidBlockHeight: string;
  /** The wallets this transaction pays. */
  rows: string[];
  status: JournalTxStatus;
  error?: string;
  at: string;
};

export type JournalMint = {
  signature: string;
  lastValidBlockHeight: string;
  amount: string;
  reservationId: string;
  status: "sent" | "confirmed" | "failed" | "expired";
};

export type DistributionJournal = {
  v: 1;
  runId: string;
  network: string;
  mint: string;
  sender: string;
  rows: { wallet: string; amount: string }[];
  nonce: string | null;
  createdAt: string;
  mintTx: JournalMint | null;
  txs: JournalTx[];
  /** Set once every row is confirmed. */
  finishedAt: string | null;
};

/** What the journal needs of window.localStorage (tests pass a Map-backed one). */
export type JournalStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function journalKey(network: string, runId: string): string {
  return `${JOURNAL_PREFIX}${network}:${runId}`;
}

export function newJournal(input: {
  runId: string;
  network: string;
  mint: string;
  sender: string;
  rows: readonly { wallet: string; amount: bigint }[];
  nonce?: string | null;
  now?: Date;
}): DistributionJournal {
  return {
    v: 1,
    runId: input.runId,
    network: input.network,
    mint: input.mint,
    sender: input.sender,
    rows: input.rows.map((r) => ({ wallet: r.wallet, amount: r.amount.toString() })),
    nonce: input.nonce ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
    mintTx: null,
    txs: [],
    finishedAt: null,
  };
}

const STATUSES: readonly string[] = ["signed", "sent", "confirmed", "failed", "expired"];

/** A stored journal, or null when missing or malformed. */
export function parseJournal(raw: string | null): DistributionJournal | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<DistributionJournal>;
    if (
      j?.v !== 1 ||
      typeof j.runId !== "string" ||
      typeof j.network !== "string" ||
      typeof j.mint !== "string" ||
      typeof j.sender !== "string" ||
      !Array.isArray(j.rows) ||
      !j.rows.every((r) => r && typeof r.wallet === "string" && typeof r.amount === "string" && /^\d+$/.test(r.amount)) ||
      !Array.isArray(j.txs) ||
      !j.txs.every(
        (t) =>
          t &&
          typeof t.signature === "string" &&
          typeof t.lastValidBlockHeight === "string" &&
          /^\d+$/.test(t.lastValidBlockHeight) &&
          Array.isArray(t.rows) &&
          STATUSES.includes(t.status),
      ) ||
      typeof j.createdAt !== "string"
    ) {
      return null;
    }
    return { ...j, nonce: j.nonce ?? null, mintTx: j.mintTx ?? null, finishedAt: j.finishedAt ?? null } as DistributionJournal;
  } catch {
    return null;
  }
}

/** window.localStorage, or null when this browser refuses storage (a private window, blocked site data). */
export function browserJournalStore(): JournalStore | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Throws unless the journal can be written: checked before anything is signed. */
export function assertJournalWritable(store: JournalStore | null): asserts store is JournalStore {
  try {
    if (!store) throw new Error("no storage");
    const probe = `${JOURNAL_PREFIX}probe:${Date.now()}:${Math.random()}`;
    store.setItem(probe, "1");
    if (store.getItem(probe) !== "1") throw new Error("storage write failed");
    store.removeItem(probe);
  } catch {
    throw new Error(
      "This browser does not let the page save its progress (private window or blocked site data). Allow site data and try again — the distribution needs it to resume safely without sending anything twice.",
    );
  }
}

export function readJournal(store: JournalStore, network: string, runId: string): DistributionJournal | null {
  const j = parseJournal(store.getItem(journalKey(network, runId)));
  return j && j.runId === runId && j.network === network ? j : null;
}

/** Saves the journal; throws when the browser refuses (the caller stops before broadcasting). */
export function writeJournal(store: JournalStore, journal: DistributionJournal): void {
  const key = journalKey(journal.network, journal.runId);
  const raw = JSON.stringify(journal);
  store.setItem(key, raw);
  if (store.getItem(key) !== raw) throw new Error("The distribution journal could not be saved in this browser.");
}

/** Every journal of this network, mint and sender, newest first. */
export function listJournals(store: JournalStore, scope: { network: string; mint: string; sender: string }): DistributionJournal[] {
  const prefix = `${JOURNAL_PREFIX}${scope.network}:`;
  const out: DistributionJournal[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const j = parseJournal(store.getItem(key));
    if (j && j.mint === scope.mint && j.sender === scope.sender && key === journalKey(j.network, j.runId)) out.push(j);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The journal with one transaction added or replaced (by signature). */
export function withTx(journal: DistributionJournal, tx: JournalTx): DistributionJournal {
  const txs = journal.txs.filter((t) => t.signature !== tx.signature);
  return { ...journal, txs: [...txs, tx] };
}

/** The journal with the statuses of `outcomes` applied. */
export function withOutcomes(journal: DistributionJournal, outcomes: ReadonlyMap<string, TxOutcome>): DistributionJournal {
  return {
    ...journal,
    txs: journal.txs.map((t) => {
      const o = outcomes.get(t.signature);
      if (!o || o === "pending") return t;
      return { ...t, status: o };
    }),
  };
}

// ── Resume decisions ────────────────────────────────────────────────────────

export type SignatureStatusLike = { err: unknown; confirmationStatus?: string | null } | null | undefined;
export type TxOutcome = "confirmed" | "failed" | "expired" | "pending";

/**
 * One journalled transaction, decided from its status (getSignatureStatuses
 * with history) and the FINALIZED block height: confirmed or finalized →
 * done; an error → failed (nothing moved); unknown past its last valid block
 * height → expired (it can never land); anything else → pending.
 */
export function txOutcome(status: SignatureStatusLike, lastValidBlockHeight: bigint, finalizedBlockHeight: bigint): TxOutcome {
  if (status?.err) return "failed";
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return "confirmed";
  if (status) return "pending";
  return finalizedBlockHeight > lastValidBlockHeight ? "expired" : "pending";
}

export type RowState =
  | { state: "done"; signature: string; via: "journal" | "backstop" }
  | { state: "pending"; signature: string }
  | { state: "todo" };

/** A decoded transfer out of the treasury (the backstop). */
export type TreasuryTransfer = { signature: string; destination: string; amount: bigint; blockTime: number | null };

/**
 * Each row's state: done when a confirmed transaction of the journal paid it
 * (or, the backstop, a confirmed transfer of exactly its amount to its token
 * account since the run started that the journal does not explain); pending
 * while a journalled transaction may still land; otherwise still to send.
 * `destinationOf(wallet)` is the wallet's token account for the mint.
 */
export function rowStates(
  journal: Pick<DistributionJournal, "rows" | "txs">,
  outcomes: ReadonlyMap<string, TxOutcome>,
  destinationOf: ReadonlyMap<string, string>,
  backstop: readonly TreasuryTransfer[] = [],
): Map<string, RowState> {
  const states = new Map<string, RowState>();
  for (const r of journal.rows) states.set(r.wallet, { state: "todo" });
  const outcomeOf = (t: JournalTx): TxOutcome =>
    outcomes.get(t.signature) ?? (t.status === "confirmed" ? "confirmed" : t.status === "failed" || t.status === "expired" ? t.status : "pending");
  for (const t of journal.txs) {
    const o = outcomeOf(t);
    for (const wallet of t.rows) {
      const current = states.get(wallet);
      if (!current || current.state === "done") continue;
      if (o === "confirmed") states.set(wallet, { state: "done", signature: t.signature, via: "journal" });
      else if (o === "pending") states.set(wallet, { state: "pending", signature: t.signature });
    }
  }
  const explained = new Set(journal.txs.map((t) => t.signature));
  const used = new Set<string>();
  for (const r of journal.rows) {
    const current = states.get(r.wallet);
    if (!current || current.state !== "todo") continue;
    const destination = destinationOf.get(r.wallet);
    const amount = BigInt(r.amount);
    const hit = backstop.find(
      (t) => !explained.has(t.signature) && t.destination === destination && t.amount === amount && !used.has(`${t.signature}:${t.destination}`),
    );
    if (hit) {
      used.add(`${hit.signature}:${hit.destination}`);
      states.set(r.wallet, { state: "done", signature: hit.signature, via: "backstop" });
    }
  }
  return states;
}

export function countStates(states: ReadonlyMap<string, RowState>): { done: number; pending: number; todo: number } {
  let done = 0;
  let pending = 0;
  let todo = 0;
  for (const s of states.values()) {
    if (s.state === "done") done++;
    else if (s.state === "pending") pending++;
    else todo++;
  }
  return { done, pending, todo };
}

// ── Backstop decoder ────────────────────────────────────────────────────────

/** getTransaction(…, { encoding: "json" }) as far as the decoder reads it. */
export type RawTransaction = {
  blockTime?: number | bigint | null;
  meta?: { err?: unknown } | null;
  transaction: {
    message: {
      accountKeys: readonly string[];
      instructions: readonly { programIdIndex: number; accounts: readonly number[]; data: string }[];
    };
  };
};

/**
 * The transfer_checked instructions of one confirmed transaction that move
 * `mint` out of `source`: [source, mint, destination, authority, …hook],
 * data [12, amount u64 LE, decimals]. A failed transaction moved nothing.
 */
export function transfersFromTransaction(
  tx: RawTransaction,
  input: { signature: string; source: string; mint: string },
): TreasuryTransfer[] {
  if (tx.meta?.err) return [];
  const keys = tx.transaction.message.accountKeys.map(String);
  const out: TreasuryTransfer[] = [];
  const encoder = getBase58Encoder();
  for (const ix of tx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== TOKEN_2022) continue;
    let data: Uint8Array;
    try {
      data = Uint8Array.from(encoder.encode(ix.data));
    } catch {
      continue;
    }
    if (data.length < 10 || data[0] !== TRANSFER_CHECKED) continue;
    const [source, mint, destination] = ix.accounts.slice(0, 3).map((i) => keys[i]);
    if (source !== input.source || mint !== input.mint || !destination) continue;
    const amount = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
    out.push({
      signature: input.signature,
      destination,
      amount,
      blockTime: tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime),
    });
  }
  return out;
}
