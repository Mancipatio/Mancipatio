// "Send to wallets": reading a run's journal back against the network (the
// resume, design §3) and the per-transaction audit rows.
//
// evaluateRun asks the network about every journalled transaction
// (getSignatureStatuses with history, ≤ 256 per call) and the FINALIZED
// block height, decides each one (lib/distribution-journal txOutcome), adds
// the backstop — the treasury token account's transfers since the run
// started that the journal does not explain — and returns every row's state
// with the journal updated. A row whose transfer is confirmed is never sent
// again; a pending one is waited for; only failed or expired ones go back on
// the list.
//
// Node-safe (rpc and audit are passed in): tests/distribution-journal.test.ts.
import type {
  Address,
  GetBlockHeightApi,
  GetSignaturesForAddressApi,
  GetSignatureStatusesApi,
  GetTransactionApi,
  Rpc,
  Signature,
} from "@solana/kit";
import {
  rowStates,
  txOutcome,
  withOutcomes,
  type DistributionJournal,
  type RowState,
  type TreasuryTransfer,
  type TxOutcome,
} from "@/lib/distribution-journal";
import { recentTreasuryTransfers } from "@/lib/distribution-chain";

const STATUS_CHUNK = 256;
/** The backstop looks this far before the run's start (clock skew between the browser and block times). */
const BACKSTOP_SKEW_SEC = 120;

export type RunRpc = Rpc<GetSignatureStatusesApi & GetBlockHeightApi & GetSignaturesForAddressApi & GetTransactionApi>;

export type RunEvaluation = {
  journal: DistributionJournal;
  states: Map<string, RowState>;
  outcomes: Map<string, TxOutcome>;
  /** The run's treasury mint, when it has one: a pending mint is waited for, never made twice. */
  mint: TxOutcome | null;
};

/** Every journalled transaction decided, the backstop applied, the journal updated (not saved). */
export async function evaluateRun(
  rpc: RunRpc,
  journal: DistributionJournal,
  input: {
    /** The treasury token account the transfers leave from. */
    source: Address;
    /** Each row's token account (by wallet). */
    destinations: ReadonlyMap<string, string>;
    /** Skip the backstop scan (it costs one call per recent transaction). */
    backstop?: boolean;
    now?: Date;
  },
): Promise<RunEvaluation> {
  const signatures = [...journal.txs.map((t) => t.signature), ...(journal.mintTx ? [journal.mintTx.signature] : [])];
  const statuses: ({ err: unknown; confirmationStatus?: string | null } | null)[] = [];
  for (let i = 0; i < signatures.length; i += STATUS_CHUNK) {
    const { value } = await rpc
      .getSignatureStatuses(signatures.slice(i, i + STATUS_CHUNK) as Signature[], { searchTransactionHistory: true })
      .send();
    statuses.push(...value.map((v) => (v ? { err: v.err, confirmationStatus: v.confirmationStatus } : null)));
  }
  const height = signatures.length > 0 ? BigInt(await rpc.getBlockHeight({ commitment: "finalized" }).send()) : BigInt(0);
  const outcomes = new Map<string, TxOutcome>();
  journal.txs.forEach((t, i) => outcomes.set(t.signature, txOutcome(statuses[i], BigInt(t.lastValidBlockHeight), height)));
  const mint = journal.mintTx
    ? txOutcome(statuses[journal.txs.length], BigInt(journal.mintTx.lastValidBlockHeight), height)
    : null;

  let states = rowStates(journal, outcomes, input.destinations);
  const unexplained = [...states.values()].some((s) => s.state === "todo");
  let backstop: TreasuryTransfer[] = [];
  if (input.backstop !== false && unexplained && (journal.txs.length > 0 || journal.mintTx)) {
    backstop = await recentTreasuryTransfers(rpc, {
      source: input.source,
      mint: journal.mint as Address,
      sinceSec: Math.floor(Date.parse(journal.createdAt) / 1000) - BACKSTOP_SKEW_SEC,
      // The run's own transactions (its mint too) are explained already.
      skip: new Set(signatures),
    });
    states = rowStates(journal, outcomes, input.destinations, backstop);
  }
  let next = withOutcomes(journal, outcomes);
  if (next.mintTx && mint && mint !== "pending") next = { ...next, mintTx: { ...next.mintTx, status: mint } };
  const allDone = [...states.values()].every((s) => s.state === "done");
  if (allDone && !next.finishedAt) next = { ...next, finishedAt: (input.now ?? new Date()).toISOString() };
  return { journal: next, states, outcomes, mint };
}

/** One audit row per distribution transaction (pending on send, then success or failed). */
export function distributionAuditRow(input: {
  actor: string;
  reason: string;
  scPda: string;
  runId: string;
  mint: string;
  signature: string;
  status: "pending" | "success" | "failed";
  rows: readonly { wallet: string; amount: bigint }[];
  extra?: Record<string, unknown>;
}) {
  return {
    ix_name: "share_class_distribution",
    category: "share-class" as const,
    actor_wallet: input.actor,
    reason: input.reason,
    target_label: input.scPda,
    tx_signature: input.signature,
    status: input.status,
    metadata: {
      run_id: input.runId,
      mint: input.mint,
      decimals: 0,
      recipients: input.rows.map((r) => ({ to: r.wallet, amount: r.amount.toString() })),
      total: input.rows.reduce((sum, r) => sum + r.amount, BigInt(0)).toString(),
      ...input.extra,
    },
  };
}
