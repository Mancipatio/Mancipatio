"use client";
import { useChainClock } from "@/lib/use-chain-clock";

import { custodyAuthorityRecord } from "@/lib/custody-authority";
import { WalletRequired } from "@/components/wallet-required";

// Conversion requests — the holder-side mirror of
// app/portfolio/delivery/page.tsx. A holder asks to convert share-class
// tokens into the off-chain right (share-register entry / titled ownership);
// admin opens a conversion escrow (a DeliveryEscrow-type custody vault — the
// only type whose on-chain exits are return-to-holder / burn-on-confirm), the
// holder deposits here, and the tokens are burned once the off-chain
// conversion is executed — or returned to the holder if it falls through.
//
// Eligibility gate: a share class is convertible when it has a conversion
// target recorded ON-CHAIN (`convertible_to`, set jointly by the platform
// and the issuer via `set_convertible_to`). Category is deliberately NOT
// the gate — convertible revenue-share structures (v2 doc §5.2.11) convert
// into company shares exactly like equity does.
//
// NOTE: unlike delivery, the requests LIST is loaded through a SIGNED route
// (conversion_requests has no anon SELECT — rows carry contact PII). It is a
// session read: one wallet sign-in per session, then no prompt. The page
// re-lists every 20 s while a request is in progress and when the tab comes
// back, and those reads never prompt (interactive: false): when the session
// has lapsed they stop and the page offers "Sign in".
//
// The signed list also carries the holder's KYC verdict from the SAME
// resolver the create route's gate uses, so "+ Request conversion" is enabled
// exactly when /api/conversion/create would accept, and the reason it is not
// is always written next to it (lib/conversion-holder.ts conversionRequestGate).

import Link from "next/link";
import { address, type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AssetRegistryInstruction,
  findAssetPda,
  findOpenCustodyVaultEscrowPda,
  getDepositToCustodyVaultInstruction,
  findPlatformPda,
  getReturnCustodyVaultInstructionAsync,
  VaultState,
  type Asset,
} from "@/lib/generated/asset_registry";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { kycOnly, moduleEnabled } from "@/lib/features";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { pausedFlowFor } from "@/lib/pause-gate";
import { usePauseFlags } from "@/lib/use-pause-flags";
import {
  conversionRequestGate,
  conversionRowsLive,
  HOLDER_CONVERSION_POLL_MS,
  latestConversionRead,
  loadConversionBalances,
  nextConversionStep,
  shouldPollConversions,
  sortConversionRequests,
  validConversionAmount,
  type ConversionKycVerdict,
  type ConversionListError,
} from "@/lib/conversion-holder";
import {
  cancelConversionRequest,
  createConversionRequest,
  listMyConversionRequests,
  markConversionDeposited,
  reclaimConversionRequest,
  type ConversionRequest,
  type ConversionStatus,
} from "@/lib/conversion";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { hookTransferMetas } from "@/lib/hook-metas";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { findShareClassPda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";
import {
  assertChainRecordStorageAvailable,
  readPendingChainRecord,
  type PendingChainRecord,
} from "@/lib/chain-record-recovery";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { ChainRecordRecoveryPanel } from "@/components/chain-record-recovery-panel";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const STATUS_LABEL: Record<ConversionStatus, string> = {
  requested: "Requested",
  vault_opened: "Vault opened",
  deposited: "Deposited",
  converted: "Converted",
  cancelled: "Cancelled",
  returned: "Returned",
};

const STATUS_BADGE: Record<ConversionStatus, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  vault_opened: "bg-brand-100 text-brand-800 border-brand-200",
  deposited: "bg-emerald-100 text-emerald-800 border-emerald-200",
  converted: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  returned: "bg-slate-200 text-slate-800 border-slate-300",
};

const STATUS_HINT: Record<ConversionStatus, string> = {
  requested: "Waiting for Manci to review your request.",
  vault_opened: "Escrow vault is ready — deposit your tokens to continue.",
  deposited:
    "Tokens are in escrow — the off-chain conversion is being executed.",
  converted:
    "Conversion executed — your tokens were burned and the off-chain right was transferred to you.",
  cancelled: "Request cancelled — no tokens were moved.",
  returned: "Conversion cancelled after deposit — your tokens were returned.",
};

/** The routine 0x08 window, in the holder's words (not the emergency wording of pausedFlowMessage). */
const CUSTODY_WINDOW_CLOSED =
  "Custody window is closed — Manci opens it for your deposit. Try again when Manci confirms it is open.";

type ConvertibleHolding = {
  shareClassPda: string;
  mint: string;
  assetPda: string;
  label: string;
  balance: bigint;
};

// "interactive": the automatic first load (may start the wallet session once,
// never signs the read itself); "manual": a click or a re-list after the
// holder's own action (may also sign the read itself when no session can be
// started, so the list always loads); "background": timers and the tab
// coming back (never prompts).
type ListMode = "interactive" | "manual" | "background";

// What the holder reads when a sent deposit or return could not be recorded
// (lib/use-chain-record-recovery recordFinalized outcomes).
const DEPOSIT_FAILED_MESSAGE =
  "The deposit transaction failed on the network — nothing moved and the receipt was discarded. Deposit again.";
const DEPOSIT_NOT_FINALIZED_MESSAGE =
  "The deposit is not finalized yet. Use Retry recording in a minute; do not deposit again.";
const RETURN_FAILED_MESSAGE =
  "The return transaction failed on the network — nothing moved and the receipt was discarded. Reclaim again.";
const RETURN_NOT_FINALIZED_MESSAGE =
  "The return is not finalized yet. Use Retry recording in a minute; do not reclaim again.";

function formatDeadline(deadline: bigint | undefined): string | null {
  if (deadline === undefined || deadline <= BigInt(0)) return null;
  return new Date(Number(deadline) * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function ConversionPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  // Hydration and auto-connect: a placeholder, not a "connect a wallet" card
  // that would flash on every navigation.
  if (!conn.isReady || (conn.connecting && !wallet)) {
    return (
      <main className="min-w-0 flex-1" aria-busy="true">
        <p role="status" className="text-sm text-slate-500">
          Connecting your wallet…
        </p>
        <div className="mt-6">
          <SkeletonTable rows={3} cols={4} />
        </div>
      </main>
    );
  }
  if (!wallet) {
    return <main className="min-w-0 flex-1"><WalletRequired /></main>;
  }
  // Private requests, verification, balances and open forms belong to this
  // wallet/network. A switch mounts a fresh workspace before any new read.
  return <ConversionWorkspace key={`${detectNetwork()}:${wallet}`} />;
}

function ConversionWorkspace() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const network = detectNetwork();
  const mounted = useRef(false);
  const [requestsRead] = useState(latestConversionRead);
  const [holdingsRead] = useState(latestConversionRead);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestsRead.invalidate();
      holdingsRead.invalidate();
    };
  }, [requestsRead, holdingsRead]);
  const isCurrent = useCallback(() => {
    const current = client.store.getState().wallet;
    return mounted.current && detectNetwork() === network && current.status === "connected" && current.session === conn.wallet;
  }, [client, conn.wallet, network]);
  const nowSec = useChainClock();
  const recovery = useChainRecordRecovery(
    "conversion",
    network,
    wallet?.toString(),
  );
  const returnRecovery = useChainRecordRecovery(
    "conversion_return",
    network,
    wallet?.toString(),
  );
  const returnBusy = useRef(false);
  const [returnActionBusy, setReturnActionBusy] = useState(false);
  const depositBusy = useRef(false);
  const [depositActionBusy, setDepositActionBusy] = useState(false);
  const [requests, setRequests] = useState<ConversionRequest[]>([]);
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [listError, setListError] = useState<ConversionListError | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const listInFlight = useRef(0);
  const lastListAt = useRef(0);
  // null until the chain answered; a failure stays visible in the toolbar.
  const [convertible, setConvertible] = useState<ConvertibleHolding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  // Own KYC verdict, folded into the signed list response (the create gate's
  // resolver). undefined = not yet loaded; null = the server could not check.
  const [kyc, setKyc] = useState<ConversionKycVerdict | null | undefined>(
    undefined,
  );
  const [showRequest, setShowRequest] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<ConversionRequest | null>(
    null,
  );
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const pauseFlags = usePauseFlags();
  const gateId = useId();
  // vault_pda → on-chain vault state for rows awaiting deposit. A row can
  // say vault_opened while the vault was already closed on-chain (admin
  // cancel / permissionless return after the deadline). Token-2022 would
  // happily transfer into the orphaned escrow — and no instruction could
  // ever get the tokens out — so the deposit button is disabled unless the
  // vault account is live.
  const [vaultDeadlines, setVaultDeadlines] = useState<Map<string, bigint>>(
    new Map(),
  );
  const [vaultStates, setVaultStates] = useState<Map<string, VaultState>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    async function loadStates() {
      const targets = requests.filter(
        (r) =>
          (r.status === "vault_opened" || r.status === "deposited") &&
          r.vault_pda,
      );
      const entries: Array<[string, VaultState]> = [];
      const deadlines: Array<[string, bigint]> = [];
      await Promise.all(
        targets.map(async (r) => {
          try {
            const maybe = await fetchMaybeLiveCustodyVault(
              client.runtime.rpc,
              address(r.vault_pda!),
            );
            if (maybe.exists) {
              entries.push([r.vault_pda!, maybe.data.state]);
              deadlines.push([r.vault_pda!, maybe.data.deadline]);
            }
          } catch {
            // unknown — leave the button enabled; deposit() re-checks anyway
          }
        }),
      );
      if (!cancelled) {
        setVaultStates(new Map(entries));
        setVaultDeadlines(new Map(deadlines));
      }
    }
    void loadStates();
    return () => {
      cancelled = true;
    };
  }, [requests, client]);

  // Signed list — separate from the chain refresh so a data reload never
  // silently re-prompts for a signature; call sites decide when to re-list.
  // "interactive" (the first load) may start the wallet session — one prompt
  // at most, never a per-read signature, so a declined sign-in shows the
  // Sign in state; "manual" (a click, a re-list after the holder's own
  // action) also falls back to signing the read itself when no session can
  // be started (sessions off, or /api/auth/session failing), so an explicit
  // click always loads; "background" (a timer, the tab coming back) never
  // prompts and keeps the last rows when it cannot read.
  const loadRequests = useCallback(async (mode: ListMode = "interactive") => {
    if (!conn.wallet || !isCurrent()) return;
    // A timer never overlaps another read; a click supersedes one (the
    // revision guard below drops the older answer).
    if (mode === "background" && listInFlight.current > 0) return;
    listInFlight.current += 1;
    const current = requestsRead.begin(isCurrent);
    if (mode !== "background") {
      setListBusy(true);
      setListError(null);
    }
    try {
      const { requests: rows, kyc: verdict } = await listMyConversionRequests(conn.wallet, {
        interactive: mode === "manual" ? true : mode === "interactive" ? "session-only" : false,
      });
      if (!current()) return;
      lastListAt.current = Date.now();
      setRequests(sortConversionRequests(rows.filter((row) => row.holder_wallet === wallet?.toString() && row.network === network)));
      setKyc(verdict);
      setRequestsLoaded(true);
      setListError(null);
    } catch (err) {
      if (!current()) return;
      const sessionLost = err instanceof WalletSessionRequiredError;
      // A timer's other failures keep the last rows; the next poll tries again.
      if (mode === "background" && !sessionLost) return;
      setListError({
        kind: sessionLost ? "session" : "error",
        message: err instanceof Error ? err.message : "Could not load your requests",
      });
    } finally {
      listInFlight.current -= 1;
      if (mode !== "background") setListBusy(false);
    }
  }, [conn.wallet, isCurrent, requestsRead, wallet, network]);

  const refresh = useCallback(async () => {
    if (!wallet || !isCurrent()) return;
    const current = holdingsRead.begin(isCurrent);
    setHoldingsError(null);
    try {
      // The network (indexer first, a retried RPC read behind it) and the
      // wallet's Token-2022 balances load side by side.
      const [network, balanceByMint] = await Promise.all([
        loadNetworkPreferIndexer(() =>
          withRpcReadRetry(() => loadNetwork(client.runtime.rpc)),
        ),
        loadConversionBalances(client.runtime.rpc, wallet),
      ]);

      // Share classes the wallet holds that have an on-chain conversion
      // target (`convertible_to`, set jointly by platform + issuer).
      const held = network.shareClasses.filter(
        (sc) =>
          sc.mintInitialized &&
          sc.convertibleTo.__option !== "None" &&
          (balanceByMint.get(sc.mint.toString()) ?? BigInt(0)) > BigInt(0),
      );
      const refs: ConvertibleHolding[] = [];
      if (held.length > 0) {
        // Resolve asset PDA → Asset, only once something is held.
        const pdas = await Promise.all(
          network.assets.map((a) =>
            findAssetPda({ issuer: a.issuer, assetId: a.assetId }),
          ),
        );
        const am = new Map<string, Asset>();
        network.assets.forEach((a, i) => am.set(pdas[i][0].toString(), a));
        for (const sc of held) {
          const asset = am.get(sc.asset.toString());
          if (!asset) continue;
          const assetPda = sc.asset.toString();
          const scPda = await findShareClassPda(sc.asset, sc.classIndex);
          refs.push({
            shareClassPda: scPda.toString(),
            mint: sc.mint.toString(),
            assetPda,
            label: `${asset.name} · #${sc.classIndex} · ${asset.assetId}`,
            balance: balanceByMint.get(sc.mint.toString()) ?? BigInt(0),
          });
        }
      }
      if (!current()) return;
      setConvertible(refs);
    } catch {
      if (current()) setHoldingsError("Could not read your token holdings.");
    }
  }, [client, wallet, isCurrent, holdingsRead]);

  // Pilot scope (lib/features.ts): with the module off (and in KYC-only mode)
  // this is a notice page: no new request; cancels, reclaims and recovery
  // stay. A deposit into an approved escrow is refused while KYC-only mode is
  // on (lib/pause-gate.ts KYC_ONLY_FLOWS), so its button says so; the routine
  // custody-entry window (0x08, read with the display gate, fail open) does
  // the same with its own words.
  const requestsOpen = moduleEnabled("custodyConversion");
  const depositsPaused = kycOnly();
  const entryClosed =
    pausedFlowFor(pauseFlags, AssetRegistryInstruction.DepositToCustodyVault) !== null;

  // Two effects: a wallet-session change must not reload the chain, and a
  // chain reload must not re-list. The chain only feeds the request button,
  // so with the module off nothing is read.
  useEffect(() => {
    if (!requestsOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh, requestsOpen]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequests();
  }, [loadRequests]);

  // Background re-list: every 20 s while a row is in progress, and when the
  // tab comes back (whatever the rows, so a fresh KYC verdict arrives too);
  // only for a visible tab, an idle page and a live session — a timer must
  // never raise a wallet prompt.
  const live = requestsLoaded && conversionRowsLive(requests);
  const actionBusy =
    tx.isSending || depositActionBusy || returnActionBusy || cancelBusy !== null;
  const sessionLost = listError?.kind === "session";
  useEffect(() => {
    if (!requestsLoaded) return;
    const poll = (force: boolean) => {
      const due = shouldPollConversions({
        live: force || live,
        visible: document.visibilityState === "visible",
        busy: actionBusy,
        sessionLost,
        lastReadAt: lastListAt.current,
        now: Date.now(),
      });
      if (due) void loadRequests("background");
    };
    const onVisible = () => poll(true);
    document.addEventListener("visibilitychange", onVisible);
    const timer = live ? window.setInterval(() => poll(false), HOLDER_CONVERSION_POLL_MS) : null;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [requestsLoaded, live, actionBusy, sessionLost, loadRequests]);

  // Exactly one reason next to the request button; only "ready" enables it.
  const gate = conversionRequestGate({
    requestsLoaded,
    listError,
    kyc,
    holdings: convertible,
    holdingsError,
  });
  const canRequest = gate.kind === "ready";
  const nextStep = requestsLoaded ? nextConversionStep(requests) : null;

  async function finishDepositRecord(receipt: PendingChainRecord) {
    if (
      !conn.wallet ||
      !isCurrent() ||
      receipt.wallet !== wallet?.toString() ||
      receipt.network !== network
    ) {
      throw new Error("Connect the wallet and network that sent this deposit.");
    }
    // Wait for the deposit to finalize (plain RPC reads, no prompt), then one
    // signed record; a server whose node lags is retried after a backoff. A
    // failed transaction discards the receipt: nothing moved. The record
    // throws with the server's words, and a refusal is read as one.
    const session = conn.wallet;
    const outcome = await recovery.recordFinalized(receipt, async () => {
      await markConversionDeposited(session, receipt.entityId, receipt.signature);
    });
    if (outcome === "failed") throw new Error(DEPOSIT_FAILED_MESSAGE);
    if (outcome === "not_finalized") throw new Error(DEPOSIT_NOT_FINALIZED_MESSAGE);
    setRequests((rows) =>
      sortConversionRequests(
        rows.map((row) =>
          row.id === receipt.entityId
            ? {
                ...row,
                deposit_tx: receipt.signature,
                status: row.status === "vault_opened" ? "deposited" : row.status,
              }
            : row,
        ),
      ),
    );
    recovery.forget(receipt);
    void loadRequests("manual");
  }

  // A receipt whose transaction failed or can no longer land is removed after
  // one fresh read of the network; a pending or landed one is kept.
  async function discardReceipt(
    hook: typeof recovery,
    receipt: PendingChainRecord,
    again: string,
  ) {
    const { discarded, state } = await hook.discard(receipt);
    if (discarded) {
      toast.show({ kind: "success", title: "Receipt discarded", description: `Nothing moved on the network. You can ${again} again.` });
      return;
    }
    toast.showError(
      "Receipt kept",
      state === "pending"
        ? "The transaction is still pending on the network."
        : state === "landed"
          ? "The transaction landed — use Retry recording instead."
          : "The network could not be asked. Try again in a moment.",
    );
  }

  async function retryDepositRecord(receipt: PendingChainRecord) {
    if (depositBusy.current) return;
    depositBusy.current = true;
    setDepositActionBusy(true);
    const pendingId = toast.showPending(
      "Recording your existing deposit receipt…",
    );
    try {
      await finishDepositRecord(receipt);
      toast.show({ kind: "success", title: "Deposit recorded" });
    } catch (err) {
      toast.showError(
        "Deposit recording pending",
        err instanceof Error
          ? err.message
          : "Retry recording this receipt later.",
      );
    } finally {
      toast.dismiss(pendingId);
      depositBusy.current = false;
      setDepositActionBusy(false);
    }
  }

  async function deposit(req: ConversionRequest) {
    if (!wallet || !conn.wallet || !isCurrent() || !req.vault_pda || depositBusy.current)
      return;
    if (req.network !== network || req.holder_wallet !== wallet.toString()) {
      toast.showError(
        "Request belongs to another wallet or network",
        "Reload your requests before continuing.",
      );
      return;
    }
    const scope = {
      kind: "conversion" as const,
      network,
      wallet: wallet.toString(),
      entityId: req.id,
    };
    const existing =
      recovery.receipts.find((receipt) => receipt.entityId === req.id) ??
      readPendingChainRecord(scope);
    if (existing) {
      await retryDepositRecord(existing);
      return;
    }
    depositBusy.current = true;
    setDepositActionBusy(true);
    let sentSignature: string | null = null;
    let pendingId = toast.showPending(
      `Depositing ${req.amount} units into the conversion escrow…`,
    );
    try {
      assertChainRecordStorageAvailable();
      // Re-check the vault on-chain right before transferring: a deposit
      // into a closed (Returned/Reverted) vault's escrow would SUCCEED at
      // the Token-2022 level and permanently strand the tokens — no
      // instruction can move funds out of a terminal vault.
      const vaultBefore = await fetchMaybeLiveCustodyVault(
        client.runtime.rpc,
        address(req.vault_pda),
      );
      if (!vaultBefore.exists || vaultBefore.data.state !== VaultState.Active) {
        toast.dismiss(pendingId);
        toast.showError(
          "Escrow vault is not active",
          "The conversion vault was closed on-chain (cancelled or expired) — depositing now would strand your tokens. Contact Manci.",
        );
        void loadRequests("manual");
        return;
      }
      // Conversion vaults are `DeliveryEscrow`-typed, and
      // `deposit_to_custody_vault` accepts a DeliveryEscrow deposit ONLY from
      // the vault's beneficiary — the ledger it writes is the evidence
      // `return_custody_vault` uses to refund without a receiver-KYC check.
      if (vaultBefore.data.beneficiary.toString() !== wallet.toString()) {
        toast.dismiss(pendingId);
        toast.showError(
          "This vault is not yours to fund",
          `The conversion vault names ${vaultBefore.data.beneficiary} as beneficiary, and only the beneficiary may deposit into it. Contact Manci.`,
        );
        void loadRequests("manual");
        return;
      }
      if (vaultBefore.data.deposited > BigInt(0)) {
        throw new Error(
          "This vault already has an on-chain deposit. Recover its transaction receipt to update the request; do not deposit again.",
        );
      }
      const signer = walletSigner(conn.wallet);
      const mint = address(req.mint);
      const vaultPda = address(req.vault_pda);
      const [holderAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      // Deposit leg: holder wallet → custody escrow, through the PROGRAM so
      // `custody_vault.deposited` is credited. A bare `transfer_checked` moves
      // the same tokens but records nothing, and if the conversion falls
      // through `return_custody_vault` refunds only up to the recorded
      // ledger without a receiver-KYC check. The escrow is owned by the vault
      // PDA, whose EscrowMarker exempts the incoming leg from receiver-KYC.
      // Emergency-pause gate (read-only) — the last named account.
      const [platform] = await findPlatformPda();
      const baseIx = getDepositToCustodyVaultInstruction({
        platform,
        depositor: signer,
        shareClass: vaultBefore.data.shareClass,
        custodyVault: vaultPda,
        mint,
        escrow,
        depositorShareAccount: holderAta,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount: BigInt(req.amount),
      });
      const depositIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, mint, {
            sourceTokenAccount: holderAta,
            destTokenAccount: escrow,
            transferAuthority: wallet,
            sourceOwner: wallet,
            destOwner: vaultPda,
          })),
        ],
      };
      // The returned signature identifies the submitted transaction; the
      // evidence endpoint waits for finalization before advancing the request.
      if (!isCurrent()) throw new Error("Your connected wallet changed. Reload before continuing.");
      const sig = await tx.send({
        instructions: [depositIx],
        feePayer: signer,
      });
      sentSignature = sig;
      const receipt = recovery.remember(req.id, sig);
      toast.dismiss(pendingId);
      pendingId = toast.showPending(
        "Deposit sent — waiting for Solana to finalize (usually 15–30 s). Keep this page open; you will sign once to record it.",
      );
      await finishDepositRecord(receipt);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Deposit recorded" });
      void recordAudit({
        ix_name: "conversion_deposit",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Holder deposited tokens into the conversion escrow",
        target_label: req.asset_label,
        tx_signature: sig,
        metadata: { conversion_request_id: req.id, vault_pda: req.vault_pda },
      });
      void refresh();
      void loadRequests("manual");
    } catch (err) {
      toast.dismiss(pendingId);
      if (sentSignature) {
        toast.showTx(sentSignature, {
          title: "Deposit sent — recording pending",
        });
        // The transaction is out; what failed is the recording, and the
        // server's words say whether to retry (explainSendError would add a
        // wrong-network hint to a session message that mentions "expired").
        toast.showError(
          "Retry recording the existing deposit",
          err instanceof Error ? err.message : explainSendError(err),
        );
      } else {
        toast.showError("Deposit needs attention", explainSendError(err));
      }
    } finally {
      depositBusy.current = false;
      setDepositActionBusy(false);
    }
  }

  async function finishReturnRecord(receipt: PendingChainRecord) {
    if (
      !conn.wallet ||
      !isCurrent() ||
      receipt.wallet !== wallet?.toString() ||
      receipt.network !== network ||
      receipt.kind !== "conversion_return"
    ) {
      throw new Error("Connect the wallet and network that sent this return.");
    }
    const session = conn.wallet;
    const outcome = await returnRecovery.recordFinalized(receipt, async () => {
      await reclaimConversionRequest(session, receipt.entityId, receipt.signature);
    });
    if (outcome === "failed") throw new Error(RETURN_FAILED_MESSAGE);
    if (outcome === "not_finalized") throw new Error(RETURN_NOT_FINALIZED_MESSAGE);
    returnRecovery.forget(receipt);
    setRequests((rows) =>
      sortConversionRequests(
        rows.map((row) =>
          row.id === receipt.entityId
            ? { ...row, outcome_tx: receipt.signature, status: "returned" }
            : row,
        ),
      ),
    );
    void loadRequests("manual");
  }

  async function retryReturnRecord(receipt: PendingChainRecord) {
    if (returnBusy.current) return;
    returnBusy.current = true;
    setReturnActionBusy(true);
    try {
      await finishReturnRecord(receipt);
      toast.show({ kind: "success", title: "Return recorded" });
    } catch (error) {
      toast.showError("Return recording pending", explainSendError(error));
    } finally {
      returnBusy.current = false;
      setReturnActionBusy(false);
    }
  }

  // Permissionless post-deadline reclaim (flows v2 §6.1.15): after the vault
  // deadline passes, the holder can send `return_custody_vault` themselves —
  // no dependency on the platform — then flip the row to returned.
  async function reclaim(req: ConversionRequest) {
    if (!wallet || !conn.wallet || !isCurrent() || !req.vault_pda || returnBusy.current) return;
    const scope = {
      kind: "conversion_return" as const,
      network,
      wallet: wallet.toString(),
      entityId: req.id,
    };
    const pending =
      returnRecovery.receipts.find((r) => r.entityId === req.id) ??
      readPendingChainRecord(scope);
    if (pending) return retryReturnRecord(pending);
    if (
      !returnRecovery.ready ||
      req.network !== network ||
      req.holder_wallet !== wallet.toString()
    )
      return;
    returnBusy.current = true;
    setReturnActionBusy(true);
    let sentSignature: string | undefined;
    let pendingId = toast.showPending("Reclaiming your tokens from escrow…");
    try {
      assertChainRecordStorageAvailable();
      const before = await fetchMaybeLiveCustodyVault(
        client.runtime.rpc,
        address(req.vault_pda),
        { commitment: "finalized" },
      );
      if (!before.exists || before.data.deposited === BigInt(0)) {
        throw new Error(
          "No holder deposit remains in this vault. Record the existing return transaction instead of sending another return.",
        );
      }
      const signer = walletSigner(conn.wallet);
      const mint = address(req.mint);
      const vaultPda = address(req.vault_pda);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const [holderAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      // escrowMarker is auto-derived by the async builder. Beneficiary is the
      // holder (self) — after the deadline this call is permissionless.
      const baseIx = await getReturnCustodyVaultInstructionAsync({
        signer,
        shareClass: address(req.share_class_pda),
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint,
        escrow,
        beneficiaryTokenAccount: holderAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      // The escrow pays out via transfer_checked of a hook mint — append the
      // mode-aware hook tail for the return leg (source authority = vault PDA).
      const returnIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, mint, {
            sourceTokenAccount: escrow,
            destTokenAccount: holderAta,
            transferAuthority: vaultPda,
            sourceOwner: vaultPda,
            destOwner: wallet,
          })),
        ],
      };
      if (!isCurrent()) throw new Error("Your connected wallet changed. Reload before continuing.");
      const sig = await tx.send({
        instructions: [createAtaIx, returnIx],
        feePayer: signer,
      });
      sentSignature = sig;
      const receipt = returnRecovery.remember(req.id, sig);
      toast.dismiss(pendingId);
      pendingId = toast.showPending(
        "Return sent — waiting for Solana to finalize (usually 15–30 s). Keep this page open; you will sign once to record it.",
      );
      // The proof endpoint verifies the actual holder transfer. Unrelated
      // surplus may keep the vault active after this deposit is fully returned.
      await finishReturnRecord(receipt);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Tokens reclaimed and return recorded" });
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Holder reclaimed tokens after the conversion deadline",
        target_label: req.asset_label,
        tx_signature: sig,
        metadata: { conversion_request_id: req.id, vault_pda: req.vault_pda },
      });
      void loadRequests("manual");
    } catch (err) {
      toast.dismiss(pendingId);
      if (sentSignature)
        toast.showTx(sentSignature, {
          title: "Return sent — recording pending",
        });
      toast.showError(
        sentSignature
          ? "Retry recording the existing return"
          : "Failed to reclaim",
        explainSendError(err),
      );
    } finally {
      returnBusy.current = false;
      setReturnActionBusy(false);
    }
  }

  async function cancelRequest(req: ConversionRequest) {
    if (!wallet || !isCurrent() || req.holder_wallet !== wallet.toString() || req.network !== network) return;
    if (cancelBusy !== null) return;
    setCancelBusy(req.id);
    const pendingId = toast.showPending("Cancelling conversion request…");
    try {
      await cancelConversionRequest(conn.wallet, req.id);
      toast.show({ kind: "success", title: "Request cancelled" });
      void recordAudit({
        ix_name: "conversion_cancel",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Holder cancelled before deposit",
        target_label: req.asset_label,
        metadata: { conversion_request_id: req.id },
      });
    } catch (err) {
      // The server's words: a 409 means the vault was opened meanwhile, and
      // the re-list below shows the deposit step instead.
      toast.showError(
        "Cancel failed",
        err instanceof Error ? err.message : "The request was not cancelled.",
      );
    } finally {
      toast.dismiss(pendingId);
      setConfirmCancel(null);
      setCancelBusy(null);
      void loadRequests("manual");
    }
  }

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  const receiptSavedFor = (id: string) =>
    recovery.receipts.some((receipt) => receipt.entityId === id);
  const vaultClosedFor = (r: ConversionRequest) =>
    !!r.vault_pda &&
    vaultStates.get(r.vault_pda) !== undefined &&
    vaultStates.get(r.vault_pda) !== VaultState.Active;
  const nextDeadline = formatDeadline(
    nextStep?.vault_pda ? vaultDeadlines.get(nextStep.vault_pda) : undefined,
  );

  return (
    <main className="min-w-0 flex-1">
      <div className="max-w-xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Conversion
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Conversion requests
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Convert tokens with a recorded conversion target into the off-chain
          right — deposit into escrow, tokens are burned once the conversion
          is executed and attested.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Confirming a conversion also needs your approved on-chain investor
          passport. Without one, your deposit is returned to your wallet.
        </p>
      </div>

      <ChainRecordRecoveryPanel
        receipts={recovery.receipts}
        busy={depositActionBusy || tx.isSending}
        onRetry={retryDepositRecord}
        states={recovery.states}
        onDiscard={(receipt) => discardReceipt(recovery, receipt, "deposit")}
      />

      <ChainRecordRecoveryPanel
        receipts={returnRecovery.receipts}
        busy={returnActionBusy || tx.isSending}
        onRetry={retryReturnRecord}
        states={returnRecovery.states}
        onDiscard={(receipt) => discardReceipt(returnRecovery, receipt, "reclaim")}
      />

      {listError && (
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between">
          <span role="alert">
            {listError.kind === "session"
              ? "Sign in with your wallet to load your requests. One signature; nothing is sent on-chain."
              : `Could not load your private requests or verification status: ${listError.message}`}
          </span>
          <button
            type="button"
            onClick={() => void loadRequests("manual")}
            disabled={listBusy}
            className="min-h-10 shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            {listError.kind === "session" ? "Sign in" : "Retry loading"}
          </button>
        </div>
      )}

      {/* The holder's one step, never hidden in a table row. */}
      {nextStep && (
        <section
          aria-labelledby="conversion-next-step"
          className="mt-6 rounded-xl border border-brand-200 bg-brand-50 p-4 sm:p-5"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">
            Next step
          </p>
          {nextStep.status === "vault_opened" ? (
            <>
              <h2 id="conversion-next-step" className="mt-1 text-base font-semibold text-slate-900">
                Your escrow is ready — deposit {nextStep.amount} units
                {nextDeadline ? ` before ${nextDeadline}` : ""}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {nextStep.asset_label || "Share class"} · request {nextStep.id.slice(0, 8)}.
                The deposit goes into a smart-contract escrow; tokens are
                returned if the conversion is cancelled.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                {receiptSavedFor(nextStep.id) ? (
                  <p className="text-sm text-brand-800" role="status">
                    Deposit sent — retry recording its saved receipt above.
                  </p>
                ) : vaultClosedFor(nextStep) ? (
                  <p className="text-sm text-amber-800" role="status">
                    The escrow vault was closed on-chain, so this deposit is disabled. Contact Manci.
                  </p>
                ) : depositsPaused ? (
                  <p className="text-sm text-slate-600" role="status">
                    Deposits are paused for now.
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={
                        entryClosed || tx.isSending || depositActionBusy || !recovery.ready
                      }
                      onClick={() => void deposit(nextStep)}
                      className="min-h-10 w-full shrink-0 whitespace-nowrap rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 sm:w-auto"
                    >
                      Deposit {nextStep.amount} units
                    </button>
                    {entryClosed && (
                      <p className="text-sm text-amber-800" role="status">
                        {CUSTODY_WINDOW_CLOSED}
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          ) : nextStep.status === "requested" ? (
            <>
              <h2 id="conversion-next-step" className="mt-1 text-base font-semibold text-slate-900">
                Waiting for Manci to open your escrow
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {nextStep.asset_label || "Share class"} · {nextStep.amount} units.
                Manci reviews the request and opens the escrow vault; the
                deposit step appears here. Updates every 20 s while this page
                is open.
              </p>
            </>
          ) : (
            <>
              <h2 id="conversion-next-step" className="mt-1 text-base font-semibold text-slate-900">
                Deposit received — waiting for Manci to confirm the conversion
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {nextStep.asset_label || "Share class"} · {nextStep.amount} units in escrow.
                {nextDeadline
                  ? ` If the conversion is not confirmed by ${nextDeadline}, you can reclaim your tokens from the row below.`
                  : ""}
              </p>
            </>
          )}
        </section>
      )}

      {/* The request button lives with the requests it creates, with its reason beside it. */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-xs text-slate-600">
          {requestsOpen ? (
            <p id={gateId} role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {gate.kind === "checking" ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
                  />
                  <span>Checking your verification and holdings…</span>
                </>
              ) : gate.kind === "sign" ? (
                <>
                  <span>Sign in with your wallet to check eligibility</span>
                  <button
                    type="button"
                    onClick={() => void loadRequests("manual")}
                    disabled={listBusy}
                    className="font-medium text-slate-900 underline underline-offset-2 disabled:opacity-50"
                  >
                    Sign in
                  </button>
                </>
              ) : gate.kind === "list-error" ? (
                <>
                  <span>Could not load —</span>
                  <button
                    type="button"
                    onClick={() => void loadRequests("manual")}
                    disabled={listBusy}
                    className="font-medium text-slate-900 underline underline-offset-2 disabled:opacity-50"
                  >
                    Retry
                  </button>
                </>
              ) : gate.kind === "holdings-error" ? (
                <>
                  <span>{gate.message} —</span>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="font-medium text-slate-900 underline underline-offset-2"
                  >
                    Retry
                  </button>
                </>
              ) : gate.kind === "kyc-unknown" ? (
                <>
                  <span>Could not check your verification —</span>
                  <button
                    type="button"
                    onClick={() => void loadRequests("manual")}
                    disabled={listBusy}
                    className="font-medium text-slate-900 underline underline-offset-2 disabled:opacity-50"
                  >
                    Retry
                  </button>
                </>
              ) : gate.kind === "verify" ? (
                <>
                  <span className="text-amber-800">{gate.message}</span>
                  {gate.contactCompliance ? (
                    <span>Contact the compliance team.</span>
                  ) : (
                    <Link href="/verify" className="font-medium text-slate-900 underline underline-offset-2">
                      Verify your identity →
                    </Link>
                  )}
                </>
              ) : gate.kind === "no-tokens" ? (
                <span>
                  You don&apos;t hold convertible tokens yet — only share classes
                  with a recorded conversion target qualify.
                </span>
              ) : (
                <span>
                  Ready — {gate.count} convertible {gate.count === 1 ? "holding" : "holdings"}
                </span>
              )}
            </p>
          ) : null}
          {live && (
            <p className="mt-1 text-[11px] text-slate-400">
              Updates every 20 s while a request is in progress.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => {
              void loadRequests("manual");
              if (requestsOpen) void refresh();
            }}
            disabled={listBusy}
            className="min-h-10 w-full shrink-0 whitespace-nowrap rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 sm:w-auto"
          >
            {listBusy ? "Refreshing…" : "Refresh"}
          </button>
          {requestsOpen && (
            <button
              type="button"
              disabled={!canRequest}
              aria-describedby={gateId}
              onClick={() => setShowRequest(true)}
              className="min-h-10 w-full shrink-0 whitespace-nowrap rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 sm:w-auto"
            >
              + Request conversion
            </button>
          )}
        </div>
      </div>

      {!requestsLoaded && !listError ? (
        <div className="mt-3">
          <SkeletonTable rows={3} cols={4} />
        </div>
      ) : !requestsLoaded ? null : requests.length === 0 ? (
        <Empty />
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Transactions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.map((r) => (
                <tr key={r.id} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {r.asset_label || "—"}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                      {new Date(r.created_at).toISOString().slice(0, 10)} ·{" "}
                      {r.id.slice(0, 8)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{r.amount}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                    <p className="mt-1 max-w-56 text-[11px] leading-snug text-slate-500">
                      {receiptSavedFor(r.id)
                        ? "Deposit sent — retry recording its saved receipt above."
                        : r.status === "vault_opened" && entryClosed
                          ? "Escrow vault is ready — Manci opens the custody window for your deposit."
                          : STATUS_HINT[r.status]}
                      {r.status === "cancelled" && r.admin_note
                        ? ` Note: ${r.admin_note}`
                        : ""}
                    </p>
                    {/* Actions sit under the status, not in a trailing column, so a
                        holder on a phone reaches them without horizontal scrolling. */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs empty:hidden">
                      {r.status === "vault_opened" &&
                        (receiptSavedFor(r.id) ? (
                          <span className="text-brand-700">
                            Receipt saved — retry recording above
                          </span>
                        ) : vaultClosedFor(r) ? (
                          <span
                            className="text-amber-700"
                            title="The escrow vault was closed on-chain. Depositing is disabled."
                          >
                            Vault closed — deposit disabled
                          </span>
                        ) : depositsPaused ? (
                          <span className="text-slate-500">Deposits are paused</span>
                        ) : entryClosed ? (
                          <span className="text-amber-700" title={CUSTODY_WINDOW_CLOSED}>
                            Custody window closed — see the next step above
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              tx.isSending || depositActionBusy || !recovery.ready
                            }
                            onClick={() => void deposit(r)}
                            className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Deposit tokens
                          </button>
                        ))}
                      {r.status === "deposited" &&
                        r.vault_pda &&
                        vaultStates.get(r.vault_pda) === VaultState.Active &&
                        (vaultDeadlines.get(r.vault_pda) ?? BigInt(0)) >
                          BigInt(0) &&
                        nowSec >= vaultDeadlines.get(r.vault_pda)! && (
                          <button
                            type="button"
                            disabled={
                              tx.isSending ||
                              returnActionBusy ||
                              !returnRecovery.ready
                            }
                            onClick={() => void reclaim(r)}
                            className="text-brand-800 underline disabled:opacity-50"
                          >
                            Reclaim tokens after deadline
                          </button>
                        )}
                      {r.status === "requested" && (
                        <button
                          type="button"
                          disabled={cancelBusy !== null}
                          onClick={() => setConfirmCancel(r)}
                          className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Cancel request
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-x-3 text-xs">
                      {r.deposit_tx && (
                        <TxLink sig={r.deposit_tx} label="deposit" />
                      )}
                      {r.outcome_tx && (
                        <TxLink sig={r.outcome_tx} label="outcome" />
                      )}
                      {!r.deposit_tx && !r.outcome_tx && (
                        <span className="text-slate-400">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRequest && canRequest && requestsOpen && (
        <RequestConversionModal
          holdings={convertible ?? []}
          isCurrent={isCurrent}
          onClose={() => setShowRequest(false)}
          onSuccess={async ({ request }) => {
            // The created row first, then the reload, before the form closes:
            // the list never shows an empty state that invites a second request.
            if (
              request &&
              request.holder_wallet === wallet.toString() &&
              request.network === network
            ) {
              setRequests((rows) =>
                sortConversionRequests([request, ...rows.filter((row) => row.id !== request.id)]),
              );
            }
            await loadRequests("manual");
            setShowRequest(false);
          }}
        />
      )}

      {confirmCancel && (
        <ConfirmModal
          open
          onClose={() => setConfirmCancel(null)}
          onConfirm={() => cancelRequest(confirmCancel)}
          title="Cancel conversion request"
          kind="warning"
          confirmLabel="Cancel request"
          requireReason={false}
          description={
            <p>
              Cancelling marks the request as Cancelled. No tokens have been
              deposited yet, so nothing moves on-chain.
            </p>
          }
          busy={cancelBusy !== null}
        />
      )}

      <p className="mt-6 text-xs text-slate-400">
        After Manci approves your request and opens the escrow vault,
        deposit your tokens here. They are returned if the conversion is
        cancelled and burned once the off-chain conversion is executed.
      </p>
    </main>
  );
}

function TxLink({ sig, label }: { sig: string; label: string }) {
  return (
    <a
      href={explorerTxUrl(sig, detectNetwork())}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-slate-600 underline-offset-2 hover:underline"
    >
      {sig.slice(0, 8)}…{sig.slice(-6)} {label} ↗
    </a>
  );
}

function RequestConversionModal({
  holdings,
  isCurrent,
  onClose,
  onSuccess,
}: {
  holdings: ConvertibleHolding[];
  isCurrent: () => boolean;
  onClose: () => void;
  /** Runs after the request is saved and before the form closes (the busy state stays on meanwhile). */
  onSuccess: (created: { id: string; request: ConversionRequest | null }) => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [selectedPda, setSelectedPda] = useState(
    holdings[0]?.shareClassPda ?? "",
  );
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const selected = holdings.find((h) => h.shareClassPda === selectedPda);
  const amountOk = selected !== undefined && validConversionAmount(amount, selected.balance);
  const contactOk = contact.trim() !== "";
  const blocker = busy
    ? saved
      ? "Saved — refreshing your requests…"
      : "Saving your request…"
    : !selected
      ? "Select a share class."
      : !amountOk
        ? "Enter an amount between 1 and your balance."
        : !contactOk
          ? "Add a contact so Manci can reach you."
          : null;

  async function submit() {
    if (!wallet || !isCurrent() || !selected || !amountOk || !contactOk || busy) return;
    setBusy(true);
    let created: { id: string; request: ConversionRequest | null };
    try {
      // Signed route — the server re-checks the KYC gate, the balance and the
      // wallet's open requests of the class, and derives the holder wallet +
      // client from the signature.
      created = await createConversionRequest(conn.wallet, {
        share_class_pda: selected.shareClassPda,
        mint: selected.mint,
        asset_pda: selected.assetPda,
        asset_label: selected.label,
        amount: Number(amount.trim()),
        contact: contact.trim(),
        note: note.trim(),
      });
    } catch (err) {
      setBusy(false);
      toast.showError(
        "Request failed",
        err instanceof Error
          ? err.message
          : "Could not save the conversion request.",
      );
      return;
    }
    setSaved(true);
    toast.show({
      kind: "success",
      title: "Conversion requested",
      description: "Manci will review your request.",
    });
    try {
      await onSuccess(created);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto my-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Request conversion
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Convert share-class units into the off-chain right they carry
            (equity: entry in the company&apos;s share register; real estate:
            titled ownership; convertible revenue share: company shares). Only
            classes with a conversion target recorded on-chain appear here.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Share class
            </span>
            <select
              value={selectedPda}
              onChange={(e) => setSelectedPda(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {holdings.map((h) => (
                <option key={h.shareClassPda} value={h.shareClassPda}>
                  {h.label} · balance {String(h.balance)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Amount (share units)
            </span>
            <input
              value={amount}
              inputMode="numeric"
              maxLength={16}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            {selected && (
              <span className="mt-1 block text-[11px] text-slate-400">
                You hold {String(selected.balance)} units of this share class.
              </span>
            )}
            {amount.trim() !== "" && !amountOk && (
              <span className="mt-1 block text-[11px] text-amber-700">
                Amount must be between 1 and your balance, up to {Number.MAX_SAFE_INTEGER.toLocaleString()} units per request.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Contact (email or phone) <span aria-hidden="true">*</span>
            </span>
            <input
              value={contact}
              required
              aria-required="true"
              onChange={(e) => setContact(e.target.value)}
              placeholder="How Manci reaches you about this conversion"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            {!contactOk && (
              <span className="mt-1 block text-[11px] text-slate-500">
                Required — Manci confirms the conversion details with you here.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Note (optional)
            </span>
            <textarea
              value={note}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything Manci should know — registry details, timing, counsel…"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          <p className="text-[11px] text-slate-400">
            After approval you&apos;ll deposit the tokens into a smart-contract
            escrow. They are returned if the conversion is cancelled and burned
            once the off-chain conversion is executed.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          {blocker && (
            <p className="mr-auto text-[11px] text-slate-500" role="status">
              {blocker}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !amountOk || !contactOk}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        You haven&apos;t requested any conversions yet.
      </p>
    </div>
  );
}
