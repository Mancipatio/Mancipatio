"use client";

// Distribute → "Send to wallets" (design §3): the issuer pastes a list —
// "wallet amount" per line or a CSV export — and the tokens go out with as
// few inputs and wallet prompts as possible.
//
// Automatic: each row's share of the company (from the tokenize figures),
// merged duplicates, the per-row checks read from chain in batches
// (lib/distribution-checks), the sanctions screen of every recipient
// (/api/compliance/screen-recipients; a hit blocks that row), the shortfall
// the treasury lacks, its EUR value against the raise limit (tokenize price,
// else one "Value per token" field) and the re-pause of Primary issuance.
//
// The send:
//   0. every recipient screened again (the server records each screen) and
//      the server's evidence that each has a clear screening from the last
//      15 minutes (/api/compliance/distribution-evidence), taken again at plan
//      time when older than 10; no group is signed with a row whose evidence
//      is older than 15, and every audit row cites it per recipient
//      (lib/distribution-screening).
//   1. (only when the treasury holds less than the list) one message — the
//      raise-limit reservation — and ONE transaction: [create the treasury
//      token account, mint_to_treasury(shortfall), set_pause_flags(set 0x02)]
//      (lib/treasury-mint). The re-pause is left out while a sale of any
//      issuer is Open (it needs 0x02 clear), and the whole step stops with
//      who must act when 0x02 is set. Waited for until CONFIRMED.
//   2. the rows packed into transactions (lib/distribution-plan: 8 with
//      account creation, 15 without, 3 KycGated), each test-run; a refused
//      row is dropped with its reason and the rest repacked.
//   3. ONE wallet approval for up to 8 transactions (lib/verified-solana-
//      client prepareAndSendAll; one per transaction when the wallet cannot
//      sign them together; a Ledger confirms each on the device).
// The run journal (lib/distribution-journal) is written after signing and
// before broadcasting; reopening the page re-reads it against the network
// (lib/distribution-run evaluateRun), so a confirmed row is never sent twice.
// Beyond the run: a wallet this browser's other runs paid, one the
// treasury's recent history shows a transfer to (any browser, cleared site
// data, an edited list) or one that already holds tokens is not paid again
// until the issuer removes it or ticks "send to these wallets again"
// (priorReceipts; read again right before the send).
// A Ledger (remembered by lib/siws-signing) or a wallet set to "sign each
// transaction separately" (remembered per wallet) gets one prompt per
// transaction, each with a fresh blockhash; a batch that outlasted its
// blockhash falls back to that before anything is journalled or sent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import type { TransactionPrepareAndSendRequest } from "@solana/client";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { fetchMaybeShareClass, type Asset, type ShareClass } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { detectNetwork } from "@/lib/network";
import { USDC } from "@/lib/payment-mints";
import { isPaused, PAUSE_PRIMARY } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { usePauseFlags } from "@/lib/use-pause-flags";
import { APPROVED_SALE_HOLDS_ROOM, roomHeldByApprovedSale } from "@/lib/distribute-guidance";
import { PrimaryReopenLink } from "@/components/primary-reopen-link";
import { distributionEvidence, screenRecipients } from "@/lib/compliance";
import {
  evidenceDue,
  staleScreenings,
  staleScreeningText,
  type ScreeningEvidence,
} from "@/lib/distribution-screening";
import {
  freshUsdcEurRate,
  isApprovalLive,
  listSaleReservations,
  listShareClassSaleApprovals,
  readFxRates,
  reservedTreasuryUnits,
} from "@/lib/sale-approvals";
import { approvalUnits, mintRepausesPrimary, saleReferencePriceE6, treasuryValueE6 } from "@/lib/public-sale";
import { getBatchSender, SIGNING_TOO_SLOW } from "@/lib/verified-solana-client";
import { rememberSignsSeparately, signsSeparately } from "@/lib/wallet-standard-batch";
import { signingTarget, signsOffchainEnvelopes } from "@/lib/siws-signing";
import { simulateInstructions, waitForSignature } from "@/lib/simulation-gate";
import { formatTokens, parsePrice, perTokenPriceE6, primaryPausedNote, formatE6 } from "@/lib/tokenize-shares";
import type { HookMode } from "@/lib/tokenize-shares-chain";
import { shortAddress, tokenAccountOf } from "@/lib/share-transfer";
import {
  companyFiguresFrom,
  parseRecipients,
  percentOfCompany,
  type RecipientRow,
} from "@/lib/distribution-rows";
import {
  distributionClassChecks,
  distributionRowChecks,
  loadDistributionFacts,
  type DistributionFacts,
  type RowVerdict,
} from "@/lib/distribution-checks";
import { supplyVerdict, type SupplyFacts } from "@/lib/distribution-supply";
import { listOpenSales, openSaleRemaining, readLamports, readPlatformPause, recentTreasuryTransfers } from "@/lib/distribution-chain";
import { nowSeconds } from "@/lib/sale-liveness";
import { listOpenSalesWithFreezes } from "@/lib/open-sales-chain";
import {
  MAX_TRANSACTIONS_PER_PROMPT,
  lamportsNeeded,
  nextPromptMode,
  packRows,
  planWithSimulation,
  promptGroups,
  rowInstructions,
  solBeforeMint,
  type DroppedRow,
  type PackedTransaction,
  type PromptMode,
} from "@/lib/distribution-plan";
import {
  assertJournalWritable,
  auditsDue,
  browserJournalStore,
  dismissJournal,
  distributionRunId,
  listJournals,
  newJournal,
  priorReceipts,
  readJournal,
  shortRunId,
  unfinishedJournals,
  withAudited,
  withTx,
  writeJournal,
  type DistributionJournal,
  type PriorReceipt,
  type RowState,
  type TreasuryTransfer,
} from "@/lib/distribution-journal";
import { distributionAuditRow, evaluateRun } from "@/lib/distribution-run";
import { parseUsdPerToken, runTreasuryMint, treasuryMintEur } from "@/lib/treasury-mint";
import { formatLamportsAsSol } from "@/lib/compute-budget";

type Props = {
  asset: Asset;
  sc: ShareClass;
  scPda: Address;
  hook: HookMode | null;
  tokenize: Record<string, unknown> | null;
  /** The card's view of the supply (refreshed with the page). */
  supply: SupplyFacts;
  reservationsKnown: boolean;
  canCreate: boolean;
  onRefresh: () => Promise<void>;
  /** "Both": told the list's total as it changes (the sale offers what the list leaves). */
  onListTotal?: (total: bigint) => void;
};

type Checked =
  | { key: string; state: "checking" }
  | { key: string; state: "error"; text: string }
  /** `nowSec`: when the facts were read (a passport's expiry is checked against it, and again at send). */
  | { key: string; state: "done"; facts: DistributionFacts; nowSec: number };

type Resume = { runId: string; states: Map<string, RowState>; mint: "pending" | null };

/** The audit reason of a run (also stored in its journal). */
function runReason(runId: string, wallets: number): string {
  return `Distribution run ${shortRunId(runId)}: ${wallets} ${wallets === 1 ? "wallet" : "wallets"}`;
}

/** The treasury's recent transfers (the "paid before" check), per wallet, mint and refresh. */
type History = { key: string; state: "error"; text: string } | { key: string; state: "done"; transfers: TreasuryTransfer[] };

/** How many of the treasury token account's latest signatures the "paid before" check reads (any time). */
const PRIOR_HISTORY_LIMIT = 100;

function priorText(found: readonly PriorReceipt[]): string {
  const parts = found.map((p) =>
    p.via === "run"
      ? `sent in run ${shortRunId(p.runId)}`
      : p.via === "chain"
        ? `received ${formatTokens(p.amount)}${p.blockTime !== null ? ` on ${new Date(p.blockTime * 1000).toLocaleDateString("en-GB")}` : ""} (tx ${p.signature.slice(0, 8)}…)`
        : `holds ${formatTokens(p.amount)} already`,
  );
  return `Paid before: ${parts.join(" · ")}`;
}

const textareaClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs leading-relaxed focus:border-slate-400 focus:outline-none";

function rowsText(rows: readonly { wallet: string; amount: string | bigint }[]): string {
  return rows.map((r) => `${r.wallet} ${r.amount.toString()}`).join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SendToWalletsPanel({ asset, sc, scPda, hook, tokenize, supply, reservationsKnown, canCreate, onRefresh, onListTotal }: Props) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address ?? null;
  const [network] = useState(() => detectNetwork());
  // For the panel's own note (refreshed every 30 s); the send reads the flags fresh before creating anything.
  const flags = usePauseFlags();
  /** Who may reopen Primary issuance (the Platform's super admin), for the 0x02 note; null until read. */
  const [superAdmin, setSuperAdmin] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [nonce, setNonce] = useState<string | null>(null);
  const [vaultConfirmed, setVaultConfirmed] = useState(false);
  const [valueInput, setValueInput] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [screening, setScreening] = useState<Map<string, "clear" | "hit">>(() => new Map());
  const [runId, setRunId] = useState<string | null>(null);
  const [journals, setJournals] = useState<DistributionJournal[]>([]);
  const [resume, setResume] = useState<Resume | null>(null);
  const [estimate, setEstimate] = useState<{ key: string; transactions: number } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [dropped, setDropped] = useState<DroppedRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [separateChoice, setSeparateChoice] = useState<{ key: string; on: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [history, setHistory] = useState<History | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  /** The exact set of repeated wallets the issuer chose to pay again (bound to the run and the set). */
  const [sendAgainKey, setSendAgainKey] = useState<string | null>(null);
  /** A dismiss that was refused (the run still waits for the network), by run. */
  const [dismissProblem, setDismissProblem] = useState<{ runId: string; text: string } | null>(null);

  // The super admin named in the 0x02 note (one read; the send reads the Platform again).
  useEffect(() => {
    let cancelled = false;
    void readPlatformPause(rpc)
      .then((p) => {
        if (!cancelled && p) setSuperAdmin(p.superAdmin.toString());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // ── One prompt per transaction: a Ledger (lib/siws-signing's memory) or the remembered choice ──
  const targetKey = session && wallet ? `${signingTarget(session).connectorId}|${wallet}` : null;
  const { hardware, storedSeparate } = useMemo(() => {
    if (!session || !targetKey) return { hardware: false, storedSeparate: false };
    const target = signingTarget(session);
    return { hardware: signsOffchainEnvelopes(target), storedSeparate: signsSeparately(target) };
  }, [session, targetKey]);
  const signSeparately = hardware || (separateChoice && separateChoice.key === targetKey ? separateChoice.on : storedSeparate);
  const chooseSeparate = useCallback(
    (on: boolean) => {
      if (!session || !targetKey) return;
      rememberSignsSeparately(signingTarget(session), on);
      setSeparateChoice({ key: targetKey, on });
    },
    [session, targetKey],
  );

  const parsed = useMemo(() => parseRecipients(text), [text]);
  const figures = useMemo(() => companyFiguresFrom(tokenize), [tokenize]);
  const company = typeof tokenize?.company_name === "string" ? tokenize.company_name : asset.name;
  const clean = parsed.errors.length === 0 && parsed.rows.length > 0;
  const rowsKey = clean ? `${parsed.rows.map((r) => `${r.wallet}:${r.amount}`).join("|")}#${refreshKey}` : "";

  // ── Journals of this mint and wallet (this browser) ──
  const loadJournals = useCallback(() => {
    const store = browserJournalStore();
    if (!store || !wallet) return;
    try {
      setJournals(listJournals(store, { network, mint: sc.mint, sender: wallet }));
    } catch {
      setJournals([]);
    }
  }, [network, sc.mint, wallet]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJournals();
  }, [loadJournals, refreshKey]);

  // ── The treasury's recent transfers (any browser): read once a list is typed, again after each send ──
  const historyKey = wallet ? `${wallet}|${sc.mint}|${refreshKey}|${historyRetry}` : "";
  const historyLoaded = useRef<string | null>(null);
  useEffect(() => {
    // Once per key (the answer is stored under its key; a stale one is never read).
    if (!wallet || !clean || historyLoaded.current === historyKey) return;
    historyLoaded.current = historyKey;
    void (async () => {
      try {
        const { transfers } = await recentTreasuryTransfers(rpc, {
          source: await tokenAccountOf(wallet, sc.mint),
          mint: sc.mint,
          sinceSec: 0,
          limit: PRIOR_HISTORY_LIMIT,
        });
        setHistory({ key: historyKey, state: "done", transfers });
      } catch (err) {
        setHistory({ key: historyKey, state: "error", text: `Could not read your treasury's earlier transfers: ${errorText(err)}` });
      }
    })();
  }, [wallet, clean, historyKey, rpc, sc.mint]);

  // ── The run id of the list as typed ──
  useEffect(() => {
    if (!clean || !wallet) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRunId(null);
      return;
    }
    let cancelled = false;
    void distributionRunId({ network, mint: sc.mint, sender: wallet, rows: parsed.rows, nonce }).then((id) => {
      if (!cancelled) setRunId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [clean, parsed.rows, wallet, network, sc.mint, nonce]);

  const journal = runId ? (journals.find((j) => j.runId === runId) ?? null) : null;

  // ── Resume: a journalled run read back against the network ──
  const evaluate = useCallback(
    async (j: DistributionJournal): Promise<Resume | null> => {
      if (!wallet) return null;
      const store = browserJournalStore();
      const destinations = new Map<string, string>();
      for (const r of j.rows) destinations.set(r.wallet, await tokenAccountOf(r.wallet as Address, sc.mint));
      const result = await evaluateRun(rpc, j, { source: await tokenAccountOf(wallet, sc.mint), destinations });
      // The final audit rows a session that stopped early never wrote (only its "pending" row exists).
      // The retry worker may have appended its own by now (lib/server/distribution-audits); this page
      // cannot read audit_events, so that can make a second final row: readers keep one per signature
      // (lib/audit-feed collapseDistributionFinals).
      let evaluated = result.journal;
      const due = auditsDue(evaluated);
      if (due.length > 0 && evaluated.sender === wallet.toString()) {
        const amounts = new Map(evaluated.rows.map((r) => [r.wallet, BigInt(r.amount)]));
        const reason = evaluated.reason ?? runReason(evaluated.runId, evaluated.rows.length);
        const written = new Set<string>();
        for (const d of due) {
          const id =
            d.kind === "tx"
              ? await recordAudit(
                  distributionAuditRow({
                    actor: evaluated.sender,
                    reason,
                    scPda,
                    runId: evaluated.runId,
                    mint: evaluated.mint,
                    signature: d.signature,
                    status: d.status,
                    rows: d.rows.map((w) => ({ wallet: w, amount: amounts.get(w) ?? BigInt(0) })),
                    screening: evaluated.screening ?? null,
                    extra: { reconciled_on_resume: true },
                  }),
                )
              : await recordAudit({
                  ix_name: "mint_to_treasury",
                  category: "share-class",
                  actor_wallet: evaluated.sender,
                  reason,
                  target_label: scPda.toString(),
                  tx_signature: d.signature,
                  status: d.status,
                  metadata: {
                    destination: "issuer_treasury",
                    destination_wallet: evaluated.sender,
                    amount: d.amount,
                    reservation_id: d.reservationId,
                    distribution_run: evaluated.runId,
                    reconciled_on_resume: true,
                  },
                });
          if (id !== null) written.add(d.signature);
        }
        if (written.size > 0) evaluated = withAudited(evaluated, written);
      }
      if (store) {
        try {
          writeJournal(store, evaluated);
        } catch {
          /* the next send refuses without storage */
        }
      }
      const next = { runId: j.runId, states: result.states, mint: result.mint === "pending" ? ("pending" as const) : null };
      setResume(next);
      return next;
    },
    [rpc, sc.mint, wallet, scPda],
  );

  useEffect(() => {
    if (!journal || (resume && resume.runId === journal.runId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void evaluate(journal).catch(() => setProblem("Could not read the earlier run's transactions from the network. Try again."));
  }, [journal, resume, evaluate]);

  // ── Automatic checks: chain facts (no prompt) and the screen within an existing session ──
  useEffect(() => {
    if (!clean || !wallet) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setChecked({ key: rowsKey, state: "checking" });
        try {
          const facts = await loadDistributionFacts(rpc, { mint: sc.mint, sender: wallet, recipients: parsed.rows.map((r) => r.wallet) });
          if (cancelled) return;
          setChecked({ key: rowsKey, state: "done", facts, nowSec: Math.floor(Date.now() / 1000) });
        } catch (err) {
          if (!cancelled) setChecked({ key: rowsKey, state: "error", text: `Could not read the network: ${errorText(err)}` });
          return;
        }
        const unscreened = parsed.rows.map((r) => r.wallet).filter((w) => !screening.has(w));
        if (unscreened.length === 0 || !session) return;
        try {
          const hits = await screenRecipients(session, { shareClass: scPda, wallets: unscreened }, { interactive: false });
          if (cancelled) return;
          setScreening((prev) => {
            const next = new Map(prev);
            for (const w of unscreened) next.set(w, hits.has(w) ? "hit" : "clear");
            return next;
          });
        } catch {
          /* no session yet, or the screen is unavailable: it runs again when you send */
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // screening is read once per list on purpose: a new answer must not re-run the chain reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, wallet, rpc, sc.mint, scPda, session]);

  const current = checked && checked.key === rowsKey ? checked : null;
  const facts = current?.state === "done" ? current.facts : null;
  const states = resume && resume.runId === runId ? resume.states : null;
  const stateOf = (w: string): RowState => states?.get(w) ?? { state: "todo" };
  const factsAt = current?.state === "done" ? current.nowSec : 0;

  const verdicts = useMemo(() => {
    const out = new Map<string, RowVerdict>();
    if (!facts) return out;
    for (const r of parsed.rows) {
      out.set(r.wallet, distributionRowChecks(facts, r, { nowSec: factsAt, screening: screening.get(r.wallet) ?? "unknown", vaultConfirmed }));
    }
    return out;
  }, [facts, factsAt, parsed.rows, screening, vaultConfirmed]);

  const classChecks = facts ? distributionClassChecks(facts) : [];
  const classProblem = classChecks.find((c) => !c.ok)?.text ?? null;
  const toSend = parsed.rows.filter((r) => stateOf(r.wallet).state === "todo");
  const rowsTodo = toSend;
  const pendingRows = parsed.rows.filter((r) => stateOf(r.wallet).state === "pending");
  const doneRows = parsed.rows.filter((r) => stateOf(r.wallet).state === "done");
  const totalToSend = toSend.reduce((sum, r) => sum + r.amount, BigInt(0));
  // "Both": the sale panel offers what this list leaves.
  useEffect(() => {
    onListTotal?.(totalToSend);
  }, [onListTotal, totalToSend]);
  const balance = facts?.senderBalance ?? supply.treasuryBalance;
  const supplyNow = supplyVerdict(totalToSend, { ...supply, treasuryBalance: balance });
  const shortfall = supplyNow.shortfall;
  const vaultRows = parsed.rows.filter((r) => facts?.rows.get(r.wallet)?.recipientKind === "vault");
  // A failed check blocks the row; a screen still to run does not (it runs when you send).
  const blockedRows = toSend.filter((r) => verdicts.get(r.wallet)?.checks.some((c) => !c.ok));
  const newAccounts = toSend.filter((r) => verdicts.get(r.wallet)?.createsAccount).length;

  // The tokenize price per token (USD), else the one field.
  const tokenizePriceE6 = useMemo(() => {
    const total = typeof tokenize?.price_total === "string" ? parsePrice(tokenize.price_total) : null;
    if (!total?.ok || total.value === null || !figures) return null;
    return perTokenPriceE6(total.value, figures.tokens);
  }, [tokenize, figures]);
  const typedValueE6 = parseUsdPerToken(valueInput);
  const valueE6 = tokenizePriceE6 ?? typedValueE6;

  // ── How many transactions (and prompts) the rows take, measured (no signature) ──
  useEffect(() => {
    if (!facts || !wallet || facts.decimals !== 0 || toSend.length === 0) return;
    const key = `${rowsKey}|${toSend.length}`;
    let cancelled = false;
    void (async () => {
      try {
        const noop = createNoopSigner(wallet);
        const rows = await Promise.all(
          toSend.map((r) =>
            rowInstructions({
              mint: sc.mint,
              sender: noop,
              wallet: r.wallet,
              amount: r.amount,
              decimals: 0,
              hookConfig: facts.hookConfig,
              accountExists: facts.rows.get(r.wallet)?.recipientTokenAccountExists ?? false,
            }),
          ),
        );
        const packed = packRows(rows, { feePayer: wallet });
        if (!cancelled) setEstimate({ key, transactions: packed.length });
      } catch {
        if (!cancelled) setEstimate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // toSend follows rowsKey and the resume states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, wallet, rowsKey, toSend.length, sc.mint]);
  const transactions = estimate && estimate.key === `${rowsKey}|${toSend.length}` ? estimate.transactions : null;
  const approvals = transactions === null ? null : Math.ceil(transactions / MAX_TRANSACTIONS_PER_PROMPT);

  const previous = journal?.finishedAt ? journal : null;
  // Wallets paid before outside this run (this browser's other runs, the treasury's recent
  // history from any browser, a balance they hold): not paid again until removed or confirmed.
  const historyNow = history && history.key === historyKey ? history : null;
  const historyReady = historyNow?.state === "done";
  const prior = facts
    ? priorReceipts({
        rows: parsed.rows,
        runId,
        journals,
        history: historyNow?.state === "done" ? historyNow.transfers : [],
        destinations: new Map(parsed.rows.map((r) => [r.wallet as string, facts.rows.get(r.wallet)?.recipientTokenAccount ?? ""])),
        balances: new Map(parsed.rows.map((r) => [r.wallet as string, facts.rows.get(r.wallet)?.recipientBalance ?? BigInt(0)])),
      })
    : new Map<string, PriorReceipt[]>();
  const repeated = toSend.filter((r) => prior.has(r.wallet));
  const repeatedKey = repeated.length > 0 ? `${runId}|${repeated.map((r) => r.wallet).sort().join(",")}` : null;
  const sendAgain = repeatedKey !== null && sendAgainKey === repeatedKey;
  function removeRepeated() {
    const drop = new Set<string>(repeated.map((r) => r.wallet));
    setText(rowsText(parsed.rows.filter((r) => !drop.has(r.wallet))));
    setNonce(null);
    setProblem(null);
  }
  // A journalled run of this list must be read back from the network before anything is sent again.
  const resumeReady = !journal || resume?.runId === journal.runId;
  const unfinished = unfinishedJournals(journals, runId);
  const busy = working !== null || tx.isSending;
  const primaryPaused = flags !== null && isPaused(flags, PAUSE_PRIMARY);
  // An approved sale of this class not opened yet: 0x02 is reopened at its pre-clear check (else the pause panel).
  const saleApproved = (supply.approvedUnopened ?? BigInt(0)) > BigInt(0);
  // The room is 0 only because that approved sale holds it.
  const roomHeld = shortfall > BigInt(0) && roomHeldByApprovedSale({ ...supply, treasuryBalance: balance });
  const pausedBlocker =
    shortfall > BigInt(0) && canCreate && primaryPaused
      ? `Creating tokens is paused platform-wide (0x02); only ${superAdmin ? `the super admin (${shortAddress(superAdmin as Address)})` : "the super admin"} can reopen it.`
      : null;

  const blockers = [
    !clean ? null : !facts ? (current?.state === "error" ? current.text : "Checking…") : null,
    !resumeReady ? "Reading this list's earlier run from the network…" : null,
    clean && !historyReady ? (historyNow?.state === "error" ? historyNow.text : "Checking your treasury's earlier transfers…") : null,
    classProblem,
    previous ? "This exact list was already sent." : null,
    pendingRows.length > 0 ? "Some rows are still waiting for the network." : null,
    resume?.mint === "pending" ? "The tokens this run created are still waiting for the network." : null,
    blockedRows.length > 0 ? `${blockedRows.length} ${blockedRows.length === 1 ? "row does" : "rows do"} not pass the checks — remove ${blockedRows.length === 1 ? "it" : "them"} from the list.` : null,
    vaultRows.length > 0 && !vaultConfirmed ? "Confirm the program addresses below." : null,
    repeated.length > 0 && !sendAgain
      ? `${repeated.length} ${repeated.length === 1 ? "wallet was" : "wallets were"} paid before — remove ${repeated.length === 1 ? "it" : "them"} or confirm below that ${repeated.length === 1 ? "it gets" : "they get"} tokens again.`
      : null,
    roomHeld && supplyNow.problem ? `${APPROVED_SALE_HOLDS_ROOM} ${supplyNow.problem}` : supplyNow.problem,
    shortfall > BigInt(0) && !canCreate ? "Creating tokens needs an Admin issuer key; this wallet can send only what the treasury holds." : null,
    shortfall > BigInt(0) && canCreate && valueE6 === null ? "Enter the value per token (USD) for the tokens to create." : null,
    pausedBlocker,
    toSend.length === 0 && clean && facts && doneRows.length > 0 ? "Every row of this list is already sent." : null,
  ].filter((p): p is string => !!p);
  const ready = clean && !!facts && blockers.length === 0 && toSend.length > 0;

  // ── The send ──
  async function send() {
    if (!ready || !session || !wallet || !facts || !runId) return;
    setConfirmOpen(false);
    setProblem(null);
    setDropped([]);
    const sender = getBatchSender(client);
    const store = browserJournalStore();
    const actor = wallet.toString();
    try {
      if (!sender) throw new Error("This page cannot send several transactions; reload it and try again.");
      assertJournalWritable(store);

      // 0. This list's journal read back from the network right now: a confirmed row is never
      //    sent again, and nothing is sent while a transaction of the run may still land.
      let toSend = rowsTodo;
      const existing = readJournal(store, network, runId);
      if (existing) {
        setWorking("Reading this list's earlier run from the network…");
        const fresh = await evaluate(existing);
        if (!fresh) throw new Error("Could not read the earlier run of this list.");
        if (fresh.mint === "pending" || [...fresh.states.values()].some((st) => st.state === "pending")) {
          throw new Error("Some transactions of this run are still waiting for the network. Check again in a minute; nothing is sent twice.");
        }
        toSend = parsed.rows.filter((r) => fresh.states.get(r.wallet)?.state === "todo");
        if (toSend.length === 0) throw new Error("Every row of this list is already sent.");
      }
      const reason = runReason(runId, toSend.length);

      // 1. Every recipient screened (one sign-in at most: session reads), the screen recorded by the
      //    server, then the server's evidence that each one has a fresh clear screening (P1,
      //    lib/distribution-screening). Nothing is signed for a row without that evidence.
      let evidence: ScreeningEvidence = {};
      let evidenceAt = 0;
      const screenAndRecord = async (rows: readonly RecipientRow[]): Promise<boolean> => {
        setWorking("Screening the recipients…");
        const wallets = rows.map((r) => r.wallet as string);
        const hits = await screenRecipients(session, { shareClass: scPda, wallets, runId });
        setScreening((prev) => {
          const next = new Map(prev);
          for (const w of wallets) next.set(w, hits.has(w) ? "hit" : "clear");
          return next;
        });
        if (hits.size > 0) {
          setProblem(`${hits.size} ${hits.size === 1 ? "wallet" : "wallets"} cannot receive tokens through Manci (marked below). Remove ${hits.size === 1 ? "it" : "them"} and send again.`);
          return false;
        }
        setWorking("Recording the screening evidence…");
        evidence = { ...evidence, ...(await distributionEvidence(session, { shareClass: scPda, runId, wallets })) };
        evidenceAt = Date.now();
        return true;
      };
      if (!(await screenAndRecord(toSend))) return;

      // 2. Fresh chain facts for the rows still to send.
      setWorking("Checking every wallet on the network…");
      let fresh = await loadDistributionFacts(rpc, { mint: sc.mint, sender: wallet, recipients: toSend.map((r) => r.wallet) });
      const freshClass = distributionClassChecks(fresh).find((c) => !c.ok);
      if (freshClass) throw new Error(freshClass.text);
      const freshFail = toSend
        .map((r) => distributionRowChecks(fresh, r, { nowSec: Math.floor(Date.now() / 1000), screening: "clear", vaultConfirmed }))
        .find((v) => !v.ok);
      if (freshFail) throw new Error(`${shortAddress(freshFail.wallet)}: ${freshFail.problem}`);

      // 2b. Paid before, read again now (another browser may have sent since the page loaded):
      //     only the wallets the issuer chose to pay again go out.
      setWorking("Checking your treasury's earlier transfers…");
      const { transfers: freshHistory } = await recentTreasuryTransfers(rpc, {
        source: fresh.senderTokenAccount,
        mint: sc.mint,
        sinceSec: 0,
        limit: PRIOR_HISTORY_LIMIT,
      });
      const priorNow = priorReceipts({
        rows: toSend,
        runId,
        journals: listJournals(store, { network, mint: sc.mint, sender: actor }),
        history: freshHistory,
        destinations: new Map(toSend.map((r) => [r.wallet as string, fresh.rows.get(r.wallet)?.recipientTokenAccount ?? ""])),
        balances: new Map(toSend.map((r) => [r.wallet as string, fresh.rows.get(r.wallet)?.recipientBalance ?? BigInt(0)])),
      });
      const confirmedAgain = new Set<string>(sendAgain ? repeated.map((r) => r.wallet) : []);
      const unconfirmed = toSend.filter((r) => priorNow.has(r.wallet) && !confirmedAgain.has(r.wallet));
      if (unconfirmed.length > 0) {
        setHistory({ key: historyKey, state: "done", transfers: freshHistory });
        setProblem(
          `${unconfirmed.length} ${unconfirmed.length === 1 ? "wallet of this list was" : "wallets of this list were"} paid before (${unconfirmed
            .slice(0, 3)
            .map((r) => shortAddress(r.wallet))
            .join(", ")}${unconfirmed.length > 3 ? ", …" : ""}): this list may have been sent already, from this browser or another one. Nothing was sent; remove ${unconfirmed.length === 1 ? "it" : "them"} or confirm sending again.`,
        );
        return;
      }

      // 3. The journal: this run's, or a new one.
      let j = readJournal(store, network, runId) ?? newJournal({ runId, network, mint: sc.mint, sender: actor, rows: parsed.rows, nonce });
      j = { ...j, reason, dismissedAt: null, screening: { ...(j.screening ?? {}), ...evidence } };
      writeJournal(store, j);

      // 4. Create the shortfall (one message + one transaction), confirmed before anything is planned.
      const total = toSend.reduce((sum, r) => sum + r.amount, BigInt(0));
      const short = total > fresh.senderBalance ? total - fresh.senderBalance : BigInt(0);
      if (short > BigInt(0)) {
        // 4a. SOL first: a wallet that cannot pay for the transfers never creates tokens it then cannot send.
        setWorking("Checking your SOL for the transfers…");
        const estimateSigner = createNoopSigner(wallet);
        const estimated = packRows(
          await Promise.all(
            toSend.map((r) =>
              rowInstructions({
                mint: sc.mint,
                sender: estimateSigner,
                wallet: r.wallet,
                amount: r.amount,
                decimals: 0,
                hookConfig: fresh.hookConfig,
                accountExists: fresh.rows.get(r.wallet)?.recipientTokenAccountExists ?? false,
              }),
            ),
          ),
          { feePayer: wallet },
        );
        const neededFirst = solBeforeMint({
          newAccounts: toSend.filter((r) => !(fresh.rows.get(r.wallet)?.recipientTokenAccountExists ?? false)).length,
          transactions: estimated.length,
          treasuryAccountMissing: !fresh.senderAccountExists,
        });
        const lamportsFirst = await readLamports(rpc, wallet);
        if (lamportsFirst < neededFirst) {
          throw new Error(
            `Your wallet holds ${formatLamportsAsSol(lamportsFirst)} SOL; creating the tokens and sending them needs about ${formatLamportsAsSol(neededFirst)} SOL (new token accounts and fees). Nothing was created or sent.`,
          );
        }
        if (!canCreate) throw new Error("Creating tokens needs an Admin issuer key.");
        if (valueE6 === null) throw new Error("Enter the value per token (USD).");
        setWorking("Checking the supply and Primary issuance…");
        const [scNow, classSales, reservations, platform, classApprovals] = await Promise.all([
          fetchMaybeShareClass(rpc, scPda, { commitment: "confirmed" }),
          listOpenSales(rpc, { shareClass: scPda }),
          // Every row (newest first): the reserved treasury mints and the sale reference price of the floor.
          listSaleReservations(session, { share_class: scPda }),
          readPlatformPause(rpc),
          listShareClassSaleApprovals(rpc, scPda),
        ]);
        const liveApprovals = classApprovals.filter((a) => isApprovalLive(a));
        if (!scNow.exists) throw new Error("The share class could not be read.");
        if (!platform) throw new Error("Could not read the platform's pause flags; nothing was sent. Try again.");
        const verdict = supplyVerdict(total, {
          maxSupply: scNow.data.maxSupply.__option === "Some" ? scNow.data.maxSupply.value : null,
          lifetimeMinted: scNow.data.lifetimeMinted,
          version: scNow.data.version,
          supplyLocked: scNow.data.supplyLocked,
          mintablePostLaunch: scNow.data.mintablePostLaunch,
          openSaleRemaining: openSaleRemaining(classSales),
          // This run's own earlier mint, once confirmed, is in lifetime_minted already.
          reservedUnminted: reservedTreasuryUnits(reservations, new Set(j.mintTx?.status === "confirmed" ? [j.mintTx.reservationId] : [])),
          // A sale approved and not opened yet keeps its tokens: the top-up never eats into them.
          approvedUnopened: liveApprovals.reduce((sum, a) => sum + approvalUnits(a), BigInt(0)),
          treasuryBalance: fresh.senderBalance,
        });
        if (verdict.problem) throw new Error(verdict.problem);
        if (isPaused(platform.flags, PAUSE_PRIMARY)) throw new Error(primaryPausedNote(platform.superAdmin));
        const eurPerUsdc = freshUsdcEurRate(await readFxRates(session), USDC[network]?.mint ?? null);
        if (eurPerUsdc === null) {
          throw new Error("The USDC→EUR rate is missing or out of date, so the created tokens cannot be valued. Ask the operator to refresh it on Admin → Limits.");
        }
        // Never below the class's sale price: the ledger refuses a mint valued under it (TREASURY_VALUE_BELOW_FLOOR).
        const mintValueE6 = treasuryValueE6(valueE6, saleReferencePriceE6(reservations)) ?? valueE6;
        const amountEur = treasuryMintEur({ units: short, usdPerTokenE6: mintValueE6, eurPerUsdc });
        // Close Primary issuance again in the same transaction unless a sale needs it open: one Open that can
        // still take a buy (of any issuer; an ended or sold-out one only waits to be closed, a frozen issuer's
        // takes none, an unread freeze never keeps 0x02 open), or this class's approved sale waiting to be
        // opened ("Both": the sale opens after the sends). lib/public-sale mintRepausesPrimary.
        const repause = mintRepausesPrimary({
          sales: await listOpenSalesWithFreezes(rpc),
          nowSec: nowSeconds(),
          classLiveApprovals: liveApprovals.length,
        });
        // The send path's pause gate reads the flags again, not its 10 s cache.
        clearPauseFlagsCache();
        const minted = await runTreasuryMint({
          session,
          rpc,
          send: (request) => tx.send(request),
          sc,
          scPda,
          issuerPda: asset.issuer,
          amount: short,
          amountEur,
          reason,
          repause,
          audit: { distribution_run: runId, usd_per_token_e6: mintValueE6.toString(), eur_per_usdc: eurPerUsdc },
          onStage: (stage) =>
            setWorking(
              stage === "reserve"
                ? "Confirm in your wallet: reserve the value of the new tokens (a message)"
                : stage === "sign"
                  ? `Confirm in your wallet: create ${formatTokens(short)} tokens${repause ? " and close Primary issuance again" : ""}`
                  : "Waiting for the network to confirm the new tokens…",
            ),
          onSent: (m) => {
            j = {
              ...j,
              mintTx: {
                signature: m.signature,
                lastValidBlockHeight: m.lastValidBlockHeight.toString(),
                amount: short.toString(),
                reservationId: m.reservationId,
                status: "sent",
              },
            };
            writeJournal(store, j);
          },
        });
        // runTreasuryMint wrote the mint's audit row: final once decided, "pending" otherwise (a resume finishes it).
        const mintDecided = minted.outcome === "confirmed" || minted.outcome === "failed";
        j = {
          ...j,
          mintTx: j.mintTx
            ? {
                ...j.mintTx,
                status: minted.outcome === "confirmed" ? "confirmed" : minted.outcome === "failed" ? "failed" : "sent",
                audited: mintDecided ? "final" : "pending",
              }
            : null,
        };
        writeJournal(store, j);
        if (minted.outcome === "failed") throw new Error("The network refused the transaction that creates the tokens; nothing was created or sent.");
        if (minted.outcome !== "confirmed") {
          throw new Error("The new tokens are not confirmed yet. Open this page again in a minute: the run continues where it stopped, without creating them twice.");
        }
        toast.showTx(minted.signature, { title: `${formatTokens(short)} tokens created` });
        fresh = await loadDistributionFacts(rpc, { mint: sc.mint, sender: wallet, recipients: toSend.map((r) => r.wallet) });
      }

      // 5. The evidence is the plan's: one older than SCREENING_RECAPTURE_MS (a slow mint) is taken again (evidenceDue).
      if (evidenceDue(evidenceAt)) {
        if (!(await screenAndRecord(toSend))) return;
        j = { ...j, screening: { ...(j.screening ?? {}), ...evidence } };
        writeJournal(store, j);
      }

      // 5b. Pack and test-run every transaction; drop refused rows with their reason.
      setWorking("Test-running the transfers on the network…");
      const signer = walletSigner(session);
      const rows = await Promise.all(
        toSend.map((r) =>
          rowInstructions({
            mint: sc.mint,
            sender: signer,
            wallet: r.wallet,
            amount: r.amount,
            decimals: 0,
            hookConfig: fresh.hookConfig,
            accountExists: fresh.rows.get(r.wallet)?.recipientTokenAccountExists ?? false,
          }),
        ),
      );
      const plan = await planWithSimulation(rows, {
        feePayer: wallet,
        simulate: async (instructions) => (await simulateInstructions(rpc, { feePayer: wallet, instructions, network })).refusal,
      });
      setDropped(plan.dropped);
      if (plan.transactions.length === 0) throw new Error("The network would refuse every transfer of this list; nothing was sent.");

      // 6. SOL for the new token accounts and the fees, across all transactions.
      const created = rows.filter((r) => r.createsAccount && plan.transactions.some((t) => t.index.some((e) => e.row === r.row))).length;
      const needed = lamportsNeeded({ newAccounts: created, transactions: plan.transactions.length });
      const lamports = await readLamports(rpc, wallet);
      if (lamports < needed) {
        throw new Error(`Your wallet holds ${formatLamportsAsSol(lamports)} SOL; these transfers need about ${formatLamportsAsSol(needed)} SOL (new token accounts and fees).`);
      }

      // 7. One approval per group of transactions; journal before broadcast.
      const amounts = new Map(toSend.map((r) => [r.wallet as string, r.amount]));
      const rowsOf = (t: PackedTransaction) => t.index.map((e) => ({ wallet: e.row, amount: amounts.get(e.row) ?? BigInt(0) }));
      const sent: { signature: string; rows: { wallet: string; amount: bigint }[] }[] = [];
      const groups = promptGroups(plan.transactions);
      // A Ledger or the remembered choice: one prompt per transaction (a fresh blockhash each).
      let mode: PromptMode = signSeparately ? "per-transaction" : "auto";
      for (const [g, group] of groups.entries()) {
        // A row is signed for only with fresh clear screening evidence (a group may wait on the wallet).
        const stale = staleScreenings(evidence, group.flatMap((t) => t.index.map((e) => e.row)));
        if (stale.length > 0) {
          setProblem(staleScreeningText(stale.length));
          break;
        }
        const requests: TransactionPrepareAndSendRequest[] = group.map((t) => ({ instructions: t.instructions, feePayer: signer }));
        const result = await sender.prepareAndSendAll(requests, {
          mode,
          onPrompt: (p) =>
            setWorking(
              p.mode === "batch"
                ? `Confirm in your wallet: ${p.count} ${p.count === 1 ? "transaction" : "transactions"} in one approval${groups.length > 1 ? ` (${g + 1} of ${groups.length})` : ""}`
                : `Confirm in your wallet: transaction ${p.index + 1} of ${p.count}${groups.length > 1 ? ` (group ${g + 1} of ${groups.length})` : ""}`,
            ),
          onSigned: (signed) => {
            for (const s of signed) {
              j = withTx(j, {
                signature: s.signature,
                lastValidBlockHeight: s.lastValidBlockHeight.toString(),
                rows: group[s.index].index.map((e) => e.row),
                status: "signed",
                at: new Date().toISOString(),
              });
            }
            writeJournal(store, j);
          },
        });
        const groupSent: typeof sent = [];
        for (const o of result.outcomes) {
          if (!o.signature) continue;
          const t = j.txs.find((x) => x.signature === o.signature);
          // A send that failed in flight may still land: it stays "signed" until the network or its expiry decides.
          if (t && o.sent) j = withTx(j, { ...t, status: "sent" });
          if (o.sent) groupSent.push({ signature: o.signature, rows: rowsOf(group[o.index]) });
        }
        writeJournal(store, j);
        sent.push(...groupSent);
        if (result.fallbackReason) console.warn(`[distribution] ${result.fallbackReason}`);
        // Once a group fell back, the rest go one by one too; a batch that outlasted its
        // blockhash (a hardware wallet) is remembered for this wallet.
        mode = nextPromptMode(mode, result);
        if (result.fallbackReason?.includes(SIGNING_TOO_SLOW)) chooseSeparate(true);
        // One audit row per transaction, written one after another (the audit route's burst limit).
        const pendingAudited = new Set<string>();
        for (const s of groupSent) {
          const id = await recordAudit(
            distributionAuditRow({ actor, reason, scPda, runId, mint: sc.mint, signature: s.signature, status: "pending", rows: s.rows, screening: evidence }),
          );
          if (id !== null) pendingAudited.add(s.signature);
        }
        j = withAudited(j, pendingAudited, "pending");
        writeJournal(store, j);
        const unsent = result.outcomes.find((o) => !o.sent && o.error);
        if (unsent) {
          setProblem(`Not every transaction was sent: ${explainSendError(unsent.error)} Open this page again to continue the run.`);
          break;
        }
      }

      // 8. Wait for the network, then report each transaction.
      setWorking(`Waiting for the network to confirm ${sent.length} ${sent.length === 1 ? "transaction" : "transactions"}…`);
      const outcomes = await Promise.all(sent.map((s) => waitForSignature(rpc, s.signature, { timeoutMs: 60_000 })));
      const finalAudited = new Set<string>();
      for (const [i, s] of sent.entries()) {
        const t = j.txs.find((x) => x.signature === s.signature);
        if (t && (outcomes[i] === "confirmed" || outcomes[i] === "failed")) j = withTx(j, { ...t, status: outcomes[i] as "confirmed" | "failed" });
        if (outcomes[i] === "confirmed" || outcomes[i] === "failed") {
          const id = await recordAudit(
            distributionAuditRow({
              actor,
              reason,
              scPda,
              runId,
              mint: sc.mint,
              signature: s.signature,
              status: outcomes[i] === "confirmed" ? "success" : "failed",
              rows: s.rows,
              screening: evidence,
            }),
          );
          if (id !== null) finalAudited.add(s.signature);
        }
      }
      j = withAudited(j, finalAudited);
      writeJournal(store, j);
      const confirmedRows = sent.filter((_, i) => outcomes[i] === "confirmed").reduce((n, s) => n + s.rows.length, 0);
      if (confirmedRows > 0) {
        toast.show({ kind: "success", title: `Tokens sent to ${confirmedRows} ${confirmedRows === 1 ? "wallet" : "wallets"}` });
      }
      if (outcomes.some((o) => o !== "confirmed")) {
        setProblem((p) => p ?? "Some transfers are not confirmed yet. Open this page again in a minute; the run continues where it stopped and sends nothing twice.");
      }
    } catch (err) {
      setProblem(explainSendError(err instanceof Error && err.name === "TreasuryMintError" && err.cause ? err.cause : err));
    } finally {
      // Whatever happened, the rows' states come from the journal and the network again.
      const latest = store ? readJournal(store, network, runId) : null;
      if (latest) await evaluate(latest).catch(() => undefined);
      setWorking(null);
      loadJournals();
      setRefreshKey((k) => k + 1);
      await onRefresh().catch(() => undefined);
    }
  }

  /** Hides an unfinished run's banner once nothing of it waits for the network (its journal stays). */
  async function dismissRun(u: DistributionJournal) {
    const store = browserJournalStore();
    if (!store || !wallet) return;
    setDismissProblem(null);
    try {
      const destinations = new Map<string, string>();
      for (const r of u.rows) destinations.set(r.wallet, await tokenAccountOf(r.wallet as Address, sc.mint));
      const result = await evaluateRun(rpc, u, { source: await tokenAccountOf(wallet, sc.mint), destinations });
      const decided = dismissJournal(result.journal, result);
      if ("problem" in decided) {
        setDismissProblem({ runId: u.runId, text: decided.problem });
        return;
      }
      writeJournal(store, decided.journal);
      loadJournals();
    } catch (err) {
      setDismissProblem({ runId: u.runId, text: `Could not check that run on the network: ${errorText(err)}` });
    }
  }

  function resumeRun(j: DistributionJournal) {
    setNonce(j.nonce);
    setText(rowsText(j.rows));
    setResume(null);
  }

  async function loadFile(file: File | null) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setProblem("That file is larger than 1 MB; paste the wallet and amount columns instead.");
      return;
    }
    setText(await file.text());
  }

  if (!wallet) return null;

  return (
    <div className="mt-3 space-y-3">
      {unfinished.map((u) => (
        <div key={u.runId} className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-[13px] text-brand-900">
          Unfinished distribution from {new Date(u.createdAt).toLocaleString("en-GB")}: {u.rows.length}{" "}
          {u.rows.length === 1 ? "wallet" : "wallets"} (run <span className="font-mono">{shortRunId(u.runId)}</span>).{" "}
          <button type="button" onClick={() => resumeRun(u)} className="font-medium underline">
            Continue it
          </button>{" "}
          ·{" "}
          <button type="button" disabled={busy} onClick={() => void dismissRun(u)} className="text-brand-800 underline disabled:opacity-50">
            Dismiss
          </button>
          {dismissProblem?.runId === u.runId && <span className="mt-1 block text-[12px] text-amber-800">{dismissProblem.text}</span>}
        </div>
      ))}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Wallets and tokens</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNonce(null);
            setProblem(null);
          }}
          rows={6}
          spellCheck={false}
          autoComplete="off"
          placeholder={"One per line: wallet address and number of tokens\n7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2 100\n…or paste a CSV export (comma, semicolon or tab)"}
          className={textareaClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:border-slate-400">
          Load a CSV file
          <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => void loadFile(e.target.files?.[0] ?? null)} />
        </label>
        {parsed.header && <span>Header row skipped.</span>}
        {parsed.merged.length > 0 && (
          <span>
            {parsed.merged.length} {parsed.merged.length === 1 ? "wallet appears" : "wallets appear"} more than once — amounts added
            (lines {parsed.merged.map((m) => m.lines.join(" + ")).join(", ")}).
          </span>
        )}
      </div>

      {parsed.errors.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
          {parsed.errors.slice(0, 10).map((e) => (
            <li key={`${e.line}:${e.text}`}>{e.line > 0 ? `Line ${e.line}: ` : ""}{e.text}</li>
          ))}
          {parsed.errors.length > 10 && <li>…and {parsed.errors.length - 10} more.</li>}
        </ul>
      )}

      {clean && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-1.5 font-medium">Wallet</th>
                <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                <th className="px-3 py-1.5 text-right font-medium">% of company</th>
                <th className="px-3 py-1.5 font-medium">Check</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r) => (
                <Row
                  key={r.wallet}
                  row={r}
                  percent={percentOfCompany(r.amount, figures)}
                  verdict={verdicts.get(r.wallet) ?? null}
                  state={stateOf(r.wallet)}
                  dropped={dropped.find((d) => d.row === r.wallet)?.reason ?? null}
                  previously={prior.has(r.wallet) ? priorText(prior.get(r.wallet)!) : null}
                  checking={!facts}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {clean && (
        <p className="text-[13px] text-slate-700">
          {toSend.length} {toSend.length === 1 ? "wallet" : "wallets"} · <span className="font-mono">{formatTokens(totalToSend)}</span> tokens
          {percentOfCompany(totalToSend, figures) !== null && <> (= {percentOfCompany(totalToSend, figures)} % of {company})</>}
          {" "}· your treasury holds <span className="font-mono">{formatTokens(balance)}</span>
          {shortfall > BigInt(0) && (
            <>
              {" "}· <strong>{formatTokens(shortfall)}</strong> to create first
            </>
          )}
          {doneRows.length > 0 && <> · {doneRows.length} already sent</>}
        </p>
      )}

      {classProblem && <p className="text-[13px] text-red-700">{classProblem}</p>}
      {historyNow?.state === "error" && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {historyNow.text}{" "}
          <button type="button" onClick={() => setHistoryRetry((r) => r + 1)} className="font-medium underline">
            Try again
          </button>
        </p>
      )}
      {repeated.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <p>
            {repeated.length} of these {repeated.length === 1 ? "wallet was" : "wallets were"} paid before — by another run, a
            transfer from your treasury (from any browser) or tokens {repeated.length === 1 ? "it holds" : "they hold"} already (marked
            below). If this list was sent before, sending it again pays {repeated.length === 1 ? "it" : "them"} twice.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" onClick={removeRepeated} className="font-medium underline">
              Remove {repeated.length === 1 ? "it" : `these ${repeated.length}`} from the list
            </button>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sendAgain}
                onChange={(e) => setSendAgainKey(e.target.checked ? repeatedKey : null)}
              />
              <span>
                Send to {repeated.length === 1 ? "this wallet" : `these ${repeated.length} wallets`} again
              </span>
            </label>
          </div>
        </div>
      )}
      {hook === "kyc-gated" && (
        <p className="text-[12px] text-amber-800">
          This class is KYC-only: every recipient needs a valid investor passport (checked per row), and about 3 transfers fit
          in one transaction.
        </p>
      )}

      {vaultRows.length > 0 && (
        <label className="flex items-start gap-2 text-[13px] text-slate-700">
          <input type="checkbox" checked={vaultConfirmed} onChange={(e) => setVaultConfirmed(e.target.checked)} className="mt-0.5" />
          <span>
            {vaultRows.length === 1 ? "This address is a program address" : `These ${vaultRows.length} addresses are program addresses`} (
            {vaultRows.map((r) => shortAddress(r.wallet)).join(", ")}). I confirm {vaultRows.length === 1 ? "it is a vault" : "they are vaults"} that can
            move tokens (for example a Squads vault), not a mistyped address.
          </span>
        </label>
      )}

      {shortfall > BigInt(0) && canCreate && (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700">
          <p>
            The treasury holds {formatTokens(balance)}, so <strong>{formatTokens(shortfall)}</strong> new tokens are created first (one
            message to reserve their value against the raise limit, then one transaction that creates them and closes Primary
            issuance again).
            {!reservationsKnown && " The room left is checked again before they are created."}
          </p>
          {primaryPaused && (
            <p className="mt-1 text-[12px] text-amber-800">
              {primaryPausedNote(superAdmin)} <PrimaryReopenLink publicSale={saleApproved} className="mt-1" />
            </p>
          )}
          {tokenizePriceE6 !== null ? (
            <p className="mt-1 text-[12px] text-slate-500">
              Valued at your tokenize price: ${formatE6(tokenizePriceE6)} per token, at today&apos;s USDC rate in EUR.
            </p>
          ) : (
            <label className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-600">Value per token (USD)</span>
              <input
                value={valueInput}
                onChange={(e) => setValueInput(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 10"
                className="w-32 rounded-md border border-slate-300 px-2 py-1 text-right font-mono text-sm focus:border-slate-400 focus:outline-none"
              />
              <span className="text-[11px] text-slate-500">Counts the new tokens against the raise limit (EUR at today&apos;s USDC rate).</span>
            </label>
          )}
        </div>
      )}

      {previous && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          This exact list was already sent on {new Date(previous.finishedAt!).toLocaleString("en-GB")} (run{" "}
          <span className="font-mono">{shortRunId(previous.runId)}</span>).{" "}
          <button type="button" onClick={() => setNonce(new Date().toISOString())} className="font-medium underline">
            Send it again as a new run
          </button>
        </p>
      )}
      {!resumeReady && journal && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700">
          This list was started before (run <span className="font-mono">{shortRunId(journal.runId)}</span>); its transactions are
          read back from the network first, so nothing is sent twice.{" "}
          <button type="button" onClick={() => void evaluate(journal).catch(() => undefined)} className="font-medium underline">
            Read again
          </button>
        </p>
      )}
      {(pendingRows.length > 0 || resume?.mint === "pending") && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700">
          {pendingRows.length > 0
            ? `${pendingRows.length} ${pendingRows.length === 1 ? "row was" : "rows were"} sent and ${pendingRows.length === 1 ? "is" : "are"} waiting for the network.`
            : "The tokens this run created are waiting for the network."}{" "}
          Nothing is sent twice: a transaction that cannot land any more is offered again after its blockhash expires (about 2 minutes).{" "}
          <button type="button" onClick={() => journal && void evaluate(journal)} className="font-medium underline">
            Check again
          </button>
        </p>
      )}

      {ready && (
        <p className="text-[12px] text-slate-500">
          Wallet prompts: {shortfall > BigInt(0) ? "1 message + 1 transaction to create the tokens, then " : ""}
          {signSeparately
            ? transactions === null
              ? "one approval per transaction"
              : `${transactions} ${transactions === 1 ? "approval" : "approvals"}, one per transaction`
            : approvals === null
              ? "one approval for the transfers"
              : `${approvals === 1 ? "one approval" : `${approvals} approvals`} for ${transactions} ${transactions === 1 ? "transaction" : "transactions"}`}
          {signSeparately
            ? " (each with a fresh blockhash, so a Ledger has time to confirm it on the device)."
            : " (a wallet that cannot sign them together, or takes too long, asks once per transaction)."}
          {newAccounts > 0 && ` ${newAccounts} new token ${newAccounts === 1 ? "account" : "accounts"}: about ${formatLamportsAsSol(lamportsNeeded({ newAccounts, transactions: 0 }))} SOL rent, paid by you.`}
        </p>
      )}
      {clean && toSend.length > 0 && (
        <label className="flex items-start gap-2 text-[12px] text-slate-600">
          <input
            type="checkbox"
            checked={signSeparately}
            disabled={hardware || busy}
            onChange={(e) => chooseSeparate(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Sign each transaction separately
            {hardware
              ? " — this wallet signs with a hardware device (Ledger), so each transaction gets its own approval."
              : " (use it with a Ledger: confirming several transactions on the device can outlast their blockhash). Remembered for this wallet."}
          </span>
        </label>
      )}

      {problem && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800">
          <p>{problem}</p>
          {!signSeparately && /wallet/i.test(problem) && (
            <button type="button" onClick={() => chooseSeparate(true)} className="mt-1 text-[12px] font-medium underline">
              Sign each transaction separately next time
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => setConfirmOpen(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {toSend.length > 0 ? `Send ${formatTokens(totalToSend)} tokens to ${toSend.length} ${toSend.length === 1 ? "wallet" : "wallets"}` : "Send"}
        </button>
        {working && <p className="text-sm text-slate-600" aria-live="polite">{working}</p>}
        {!working && clean && blockers.length > 0 && (
          <p className="text-[12px] text-amber-700">
            {blockers[0]}
            {blockers[0] === pausedBlocker && (
              <>
                {" "}
                <PrimaryReopenLink publicSale={saleApproved} />
              </>
            )}
          </p>
        )}
      </div>

      <ConfirmModal
        open={confirmOpen && ready}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => send()}
        title="Send tokens to wallets"
        kind="info"
        confirmLabel="Send"
        requireReason={false}
        busy={busy}
        description={
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            <li>
              {formatTokens(totalToSend)} tokens to {toSend.length} {toSend.length === 1 ? "wallet" : "wallets"}
              {percentOfCompany(totalToSend, figures) !== null && ` (= ${percentOfCompany(totalToSend, figures)} % of ${company})`}.
            </li>
            {shortfall > BigInt(0) && (
              <li>
                First {formatTokens(shortfall)} new tokens are created in your treasury; their value counts against the raise limit
                and Primary issuance is closed again in the same transaction (unless a sale needs it open).
              </li>
            )}
            {repeated.length > 0 && (
              <li className="text-amber-900">
                Paid again: {repeated.length} {repeated.length === 1 ? "wallet" : "wallets"} that already received tokens (
                {repeated.slice(0, 8).map((r) => shortAddress(r.wallet)).join(", ")}
                {repeated.length > 8 ? ", …" : ""}).
              </li>
            )}
            {newAccounts > 0 && <li>{newAccounts} recipients get a token account (about 0.002 SOL rent each, paid by you).</li>}
            {signSeparately && <li>One wallet approval per transaction.</li>}
            <li>Every recipient is screened against the sanctions lists first; payment, if any, is handled outside Manci.</li>
            <li>The run is saved in this browser, so it can continue after a refresh without sending anything twice.</li>
          </ul>
        }
      />
    </div>
  );
}

function Row(props: {
  row: RecipientRow;
  percent: string | null;
  verdict: RowVerdict | null;
  state: RowState;
  dropped: string | null;
  /** Paid before outside this run (priorReceipts), in words. */
  previously: string | null;
  checking: boolean;
}) {
  const { row, verdict, state } = props;
  let status: { tone: "ok" | "bad" | "wait" | "warn" | "muted"; text: string };
  if (state.state === "done") status = { tone: "ok", text: "Sent ✓" };
  else if (state.state === "pending") status = { tone: "wait", text: "Waiting for the network" };
  else if (props.dropped) status = { tone: "bad", text: props.dropped };
  else if (props.checking || !verdict) status = { tone: "muted", text: "Checking…" };
  else if (verdict.checks.some((c) => !c.ok)) status = { tone: "bad", text: verdict.problem ?? "Does not pass the checks." };
  else if (props.previously) status = { tone: "warn", text: props.previously };
  else if (!verdict.ok) status = { tone: "muted", text: verdict.problem ?? "Ready" };
  else status = { tone: "ok", text: verdict.createsAccount ? "Ready · new token account" : "Ready" };
  const tone = { ok: "text-emerald-800", bad: "text-red-700", wait: "text-slate-700", warn: "text-amber-800", muted: "text-slate-500" }[status.tone];
  return (
    <tr className="border-b border-slate-50 last:border-0">
      <td className="px-3 py-1.5 font-mono" title={row.wallet}>
        {shortAddress(row.wallet)}
        {row.lines.length > 1 && <span className="ml-1 text-[10px] text-slate-400">merged</span>}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">{formatTokens(row.amount)}</td>
      <td className="px-3 py-1.5 text-right font-mono text-slate-600">{props.percent ?? "—"}</td>
      <td className={`px-3 py-1.5 ${tone}`}>{status.text}</td>
    </tr>
  );
}
