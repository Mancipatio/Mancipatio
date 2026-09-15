"use client";
import { useChainClock } from "@/lib/use-chain-clock";

import { custodyAuthorityRecord } from "@/lib/custody-authority";

import { WalletRequired } from "@/components/wallet-required";

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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMaybeCustodyVault,
  findAssetPda,
  findOpenCustodyVaultEscrowPda,
  getDepositToCustodyVaultInstruction,
  getReturnCustodyVaultInstructionAsync,
  VaultState,
  type Asset,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { loadHoldings } from "@/lib/holdings";
import { getAssetProfiles } from "@/lib/asset-profiles";
import { slugForEnum } from "@/lib/asset-types";
import {
  cancelDeliveryRequest,
  createDeliveryRequest,
  listMyDeliveryRequests,
  markDeliveryDeposited,
  reclaimDeliveryRequest,
  type DeliveryRequest,
  type DeliveryStatus,
} from "@/lib/delivery";
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

/** Asset categories whose tokens can be redeemed for the physical underlying. */
const DELIVERABLE_CATEGORIES = new Set(["commodity", "physical"]);

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  requested: "Requested",
  vault_opened: "Vault opened",
  deposited: "Deposited",
  in_delivery: "In delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned",
};

const STATUS_BADGE: Record<DeliveryStatus, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  vault_opened: "bg-brand-100 text-brand-800 border-brand-200",
  deposited: "bg-emerald-100 text-emerald-800 border-emerald-200",
  in_delivery: "bg-amber-100 text-amber-800 border-amber-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  returned: "bg-slate-200 text-slate-800 border-slate-300",
};

const STATUS_HINT: Record<DeliveryStatus, string> = {
  requested: "Waiting for Manci to review your request.",
  vault_opened: "Escrow vault is ready — deposit your tokens to continue.",
  deposited: "Tokens are in escrow — delivery is being arranged.",
  in_delivery: "Delivery in progress — Manci confirms on completion.",
  delivered: "Delivery confirmed — your tokens were burned.",
  cancelled: "Request cancelled — no tokens were moved.",
  returned: "Delivery cancelled after deposit — your tokens were returned.",
};

type DeliverableHolding = {
  shareClassPda: string;
  mint: string;
  assetPda: string;
  label: string;
  balance: bigint;
};

export default function DeliveryPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const network = detectNetwork();
  const nowSec = useChainClock();
  const recovery = useChainRecordRecovery(
    "delivery",
    network,
    wallet?.toString(),
  );
  const returnRecovery = useChainRecordRecovery(
    "delivery_return",
    network,
    wallet?.toString(),
  );
  const returnBusy = useRef(false);
  const [returnActionBusy, setReturnActionBusy] = useState(false);
  const depositBusy = useRef(false);
  const [depositActionBusy, setDepositActionBusy] = useState(false);
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [deliverable, setDeliverable] = useState<DeliverableHolding[]>([]);
  // Own KYC status, folded into the signed list response. undefined = not yet
  // loaded; null = wallet not linked to any client.
  const [kycStatus, setKycStatus] = useState<string | null | undefined>(
    undefined,
  );
  const [showRequest, setShowRequest] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<DeliveryRequest | null>(
    null,
  );
  // vault_pda → live on-chain vault {state, deadline} for rows awaiting or
  // holding a deposit. A row can say vault_opened/deposited while the vault was
  // already closed on-chain (admin cancel / permissionless return after the
  // deadline). Token-2022 would happily transfer into a closed escrow — and no
  // instruction could get the tokens out — so deposit is disabled unless the
  // vault is live; and once the deadline passes, a deposited row can be
  // reclaimed permissionlessly (flows v2 §6.1.15).
  const [vaultInfos, setVaultInfos] = useState<
    Map<string, { state: VaultState; deadline: bigint }>
  >(new Map());

  // Signed list — separate from the chain refresh so a data reload never
  // silently re-prompts for a signature; call sites decide when to re-list.
  const loadRequests = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const { requests: rows, kycStatus: ks } = await listMyDeliveryRequests(
        conn.wallet,
      );
      setRequests(rows);
      setKycStatus(ks);
      setListError(null);
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Could not load your requests",
      );
    }
  }, [conn.wallet]);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      // Resolve asset PDA → Asset.
      const am = new Map<string, Asset>();
      for (const a of network.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        am.set(pda.toString(), a);
      }

      if (wallet) {
        const holdings = await loadHoldings(client.runtime.rpc, wallet);
        const balanceByMint = new Map(holdings.map((h) => [h.mint, h.balance]));
        const profiles = await getAssetProfiles([...am.keys()]);

        // Share classes the wallet holds, restricted to deliverable categories.
        const refs: DeliverableHolding[] = [];
        for (const sc of network.shareClasses) {
          if (!sc.mintInitialized) continue;
          const balance = balanceByMint.get(sc.mint.toString());
          if (balance === undefined) continue;
          const asset = am.get(sc.asset.toString());
          if (!asset) continue;
          const assetPda = sc.asset.toString();
          const category =
            profiles.get(assetPda)?.category ?? slugForEnum(asset.assetType);
          if (!DELIVERABLE_CATEGORIES.has(category)) continue;
          const scPda = await findShareClassPda(sc.asset, sc.classIndex);
          refs.push({
            shareClassPda: scPda.toString(),
            mint: sc.mint.toString(),
            assetPda,
            label: `${asset.name} · #${sc.classIndex} · ${asset.assetId}`,
            balance,
          });
        }
        setDeliverable(refs);
      }
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void loadRequests();
  }, [refresh, loadRequests]);

  // Load live vault state + deadline for rows with an escrow (vault_opened /
  // deposited). deposit() and reclaim() re-check on-chain anyway; this drives
  // the button states.
  useEffect(() => {
    let cancelled = false;
    async function loadStates() {
      const targets = requests.filter(
        (r) =>
          (r.status === "vault_opened" ||
            r.status === "deposited" ||
            r.status === "in_delivery") &&
          r.vault_pda,
      );
      const entries: Array<[string, { state: VaultState; deadline: bigint }]> =
        [];
      await Promise.all(
        targets.map(async (r) => {
          try {
            const maybe = await fetchMaybeCustodyVault(
              client.runtime.rpc,
              address(r.vault_pda!),
            );
            if (maybe.exists) {
              entries.push([
                r.vault_pda!,
                { state: maybe.data.state, deadline: maybe.data.deadline },
              ]);
            }
          } catch {
            // unknown — leave buttons as-is; deposit()/reclaim() re-check
          }
        }),
      );
      if (!cancelled) setVaultInfos(new Map(entries));
    }
    void loadStates();
    return () => {
      cancelled = true;
    };
  }, [requests, client]);

  // Only onboarded (KYC-verified) clients may request delivery.
  const eligible = kycStatus === "verified";
  const canRequest = eligible && deliverable.length > 0;

  async function finishDepositRecord(receipt: PendingChainRecord) {
    if (
      !conn.wallet ||
      receipt.wallet !== wallet?.toString() ||
      receipt.network !== network
    ) {
      throw new Error("Connect the wallet and network that sent this deposit.");
    }
    const marked = await markDeliveryDeposited(
      conn.wallet,
      receipt.entityId,
      receipt.signature,
    );
    if (!marked) {
      throw new Error(
        "The deposit receipt is waiting for confirmation or recording. Use Retry recording; do not deposit again.",
      );
    }
    setRequests((rows) =>
      rows.map((row) =>
        row.id === receipt.entityId
          ? {
              ...row,
              deposit_tx: receipt.signature,
              status: row.status === "vault_opened" ? "deposited" : row.status,
            }
          : row,
      ),
    );
    recovery.forget(receipt);
    void loadRequests();
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

  async function deposit(req: DeliveryRequest) {
    if (!wallet || !conn.wallet || !req.vault_pda || depositBusy.current)
      return;
    if (req.network !== network || req.holder_wallet !== wallet.toString()) {
      toast.showError(
        "Request belongs to another wallet or network",
        "Reload your requests before continuing.",
      );
      return;
    }
    const scope = {
      kind: "delivery" as const,
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
    const pendingId = toast.showPending(
      `Depositing ${req.amount} units into the delivery escrow…`,
    );
    try {
      assertChainRecordStorageAvailable();
      // Re-check the vault on-chain right before transferring: a deposit into a
      // closed (Returned/Reverted) vault's escrow would SUCCEED at the
      // Token-2022 level and permanently strand the tokens — no instruction can
      // move funds out of a terminal vault. (Delivery vaults have deadlines and
      // a permissionless post-deadline return, so a stale vault_opened row can
      // point at an already-closed vault.)
      const vaultBefore = await fetchMaybeCustodyVault(
        client.runtime.rpc,
        address(req.vault_pda),
      );
      if (!vaultBefore.exists || vaultBefore.data.state !== VaultState.Active) {
        toast.dismiss(pendingId);
        toast.showError(
          "Escrow vault is not active",
          "The delivery vault was closed on-chain (cancelled or expired) — depositing now would strand your tokens. Contact Manci.",
        );
        void loadRequests();
        return;
      }
      // `deposit_to_custody_vault` refuses a DeliveryEscrow deposit from
      // anyone but the vault's beneficiary — the ledger it writes is what
      // lets `return_custody_vault` refund KYC-free, so it may only ever
      // record the beneficiary's own units. Surface that before the wallet
      // prompt instead of letting it fail on-chain.
      if (vaultBefore.data.beneficiary.toString() !== wallet.toString()) {
        toast.dismiss(pendingId);
        toast.showError(
          "This vault is not yours to fund",
          `The delivery vault names ${vaultBefore.data.beneficiary} as beneficiary, and only the beneficiary may deposit into it. Contact Manci.`,
        );
        void loadRequests();
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
      // the same tokens but records nothing, and `return_custody_vault` only
      // refunds up to the recorded ledger without a receiver-KYC check —
      // un-ledgered units are released solely to a receiver whose KycEntry
      // passes, so a lapsed passport would strand the holder's own deposit.
      // The escrow is owned by the vault PDA, whose EscrowMarker exempts the
      // incoming leg from receiver-KYC when the mint is gated.
      const baseIx = getDepositToCustodyVaultInstruction({
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
      const sig = await tx.send({
        instructions: [depositIx],
        feePayer: signer,
      });
      sentSignature = sig;
      const receipt = recovery.remember(req.id, sig);
      await finishDepositRecord(receipt);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Deposit recorded" });
      void recordAudit({
        ix_name: "delivery_deposit",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Holder deposited tokens into the delivery escrow",
        target_label: req.asset_label,
        tx_signature: sig,
        metadata: { delivery_request_id: req.id, vault_pda: req.vault_pda },
      });
      void loadRequests();
    } catch (err) {
      toast.dismiss(pendingId);
      if (sentSignature) {
        toast.showTx(sentSignature, {
          title: "Deposit sent — recording pending",
        });
        toast.showError(
          "Retry recording the existing deposit",
          explainSendError(err),
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
      receipt.wallet !== wallet?.toString() ||
      receipt.network !== network ||
      receipt.kind !== "delivery_return"
    ) {
      throw new Error("Connect the wallet and network that sent this return.");
    }
    await reclaimDeliveryRequest(
      conn.wallet,
      receipt.entityId,
      receipt.signature,
    );
    returnRecovery.forget(receipt);
    setRequests((rows) =>
      rows.map((row) =>
        row.id === receipt.entityId
          ? { ...row, outcome_tx: receipt.signature, status: "returned" }
          : row,
      ),
    );
    void loadRequests();
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
  async function reclaim(req: DeliveryRequest) {
    if (!wallet || !conn.wallet || !req.vault_pda || returnBusy.current) return;
    const scope = {
      kind: "delivery_return" as const,
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
    const pendingId = toast.showPending("Reclaiming your tokens from escrow…");
    try {
      assertChainRecordStorageAvailable();
      const before = await fetchMaybeCustodyVault(
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
      const sig = await tx.send({
        instructions: [createAtaIx, returnIx],
        feePayer: signer,
      });
      sentSignature = sig;
      const receipt = returnRecovery.remember(req.id, sig);
      // The proof endpoint verifies the actual holder transfer. Unrelated
      // surplus may keep the vault active after this deposit is fully returned.
      await finishReturnRecord(receipt);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Tokens reclaimed and return recorded" });
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Holder reclaimed tokens after the delivery deadline",
        target_label: req.asset_label,
        tx_signature: sig,
        metadata: { delivery_request_id: req.id, vault_pda: req.vault_pda },
      });
      void loadRequests();
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

  async function cancelRequest(req: DeliveryRequest) {
    if (!wallet) return;
    const pendingId = toast.showPending("Cancelling delivery request…");
    const ok = await cancelDeliveryRequest(conn.wallet, req.id);
    toast.dismiss(pendingId);
    if (!ok) {
      toast.showError("Cancel failed", "Could not update the request.");
      return;
    }
    toast.show({ kind: "success", title: "Request cancelled" });
    void recordAudit({
      ix_name: "delivery_cancel",
      category: "custody",
      actor_wallet: wallet.toString(),
      reason: "Holder cancelled before deposit",
      target_label: req.asset_label,
      metadata: { delivery_request_id: req.id },
    });
    setConfirmCancel(null);
    void loadRequests();
  }

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Delivery
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Delivery requests
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Redeem deliverable-asset tokens for the physical underlying —
            deposit into escrow, tokens are burned once delivery is confirmed.
          </p>
        </div>
        <button
          type="button"
          disabled={!canRequest}
          onClick={() => setShowRequest(true)}
          title={
            kycStatus !== undefined && !eligible
              ? "Delivery is available to onboarded, KYC-verified clients only."
              : deliverable.length === 0
                ? "You don't hold any deliverable-asset tokens."
                : undefined
          }
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          + Request delivery
        </button>
      </div>

      {kycStatus !== undefined && !eligible && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Delivery is available to onboarded clients only. Your wallet
          isn&apos;t linked to a KYC-verified client — contact Manci to
          complete onboarding before requesting delivery.
        </div>
      )}

      <ChainRecordRecoveryPanel
        receipts={recovery.receipts}
        busy={depositActionBusy || tx.isSending}
        onRetry={retryDepositRecord}
      />

      <ChainRecordRecoveryPanel
        receipts={returnRecovery.receipts}
        busy={returnActionBusy || tx.isSending}
        onRetry={retryReturnRecord}
      />

      {listError && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {listError}{" "}
          <button
            type="button"
            onClick={() => void loadRequests()}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : requests.length === 0 ? (
        <Empty
          onClick={() => setShowRequest(true)}
          canRequest={canRequest}
          eligible={eligible}
        />
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Transactions</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
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
                      {recovery.receipts.some(
                        (receipt) => receipt.entityId === r.id,
                      )
                        ? "Deposit sent — retry recording its saved receipt above."
                        : STATUS_HINT[r.status]}
                      {r.status === "cancelled" && r.admin_note
                        ? ` Note: ${r.admin_note}`
                        : ""}
                    </p>
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
                  <td className="space-x-3 px-4 py-3 text-right text-xs">
                    {r.status === "vault_opened" &&
                      (recovery.receipts.some(
                        (receipt) => receipt.entityId === r.id,
                      ) ? (
                        <span className="text-brand-700">
                          Receipt saved — retry recording above
                        </span>
                      ) : r.vault_pda &&
                        vaultInfos.get(r.vault_pda)?.state !== undefined &&
                        vaultInfos.get(r.vault_pda)?.state !==
                          VaultState.Active ? (
                        <span
                          className="text-amber-700"
                          title="The escrow vault was closed on-chain. Depositing is disabled."
                        >
                          Vault closed — deposit disabled
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
                    {(r.status === "deposited" || r.status === "in_delivery") &&
                      r.vault_pda &&
                      vaultInfos.get(r.vault_pda)?.state ===
                        VaultState.Active &&
                      (vaultInfos.get(r.vault_pda)?.deadline ?? BigInt(0)) >
                        BigInt(0) &&
                      nowSec >= vaultInfos.get(r.vault_pda)!.deadline && (
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
                        disabled={tx.isSending}
                        onClick={() => setConfirmCancel(r)}
                        className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Cancel request
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRequest && eligible && (
        <RequestDeliveryModal
          holdings={deliverable}
          onClose={() => setShowRequest(false)}
          onSuccess={() => {
            void loadRequests();
            setShowRequest(false);
          }}
        />
      )}

      {confirmCancel && (
        <ConfirmModal
          open
          onClose={() => setConfirmCancel(null)}
          onConfirm={() => cancelRequest(confirmCancel)}
          title="Cancel delivery request"
          kind="warning"
          confirmLabel="Cancel request"
          requireReason={false}
          description={
            <p>
              Cancelling marks the request as Cancelled. No tokens have been
              deposited yet, so nothing moves on-chain.
            </p>
          }
          busy={tx.isSending}
        />
      )}

      <p className="mt-6 text-xs text-slate-400">
        After Manci approves your request and opens the escrow vault,
        deposit your tokens here. They are returned if the delivery is cancelled
        and burned once delivery is confirmed.
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

function RequestDeliveryModal({
  holdings,
  onClose,
  onSuccess,
}: {
  holdings: DeliverableHolding[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [selectedPda, setSelectedPda] = useState(
    holdings[0]?.shareClassPda ?? "",
  );
  const [amount, setAmount] = useState("");
  const [details, setDetails] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = holdings.find((h) => h.shareClassPda === selectedPda);
  const amountOk =
    amount.trim() !== "" &&
    /^\d+$/.test(amount.trim()) &&
    selected !== undefined &&
    BigInt(amount.trim()) > BigInt(0) &&
    BigInt(amount.trim()) <= selected.balance;

  async function submit() {
    if (!wallet || !selected || !amountOk) return;
    setBusy(true);
    try {
      // Signed route — the server re-checks the KYC gate and derives the
      // holder wallet + client from the signature.
      await createDeliveryRequest(conn.wallet, {
        share_class_pda: selected.shareClassPda,
        mint: selected.mint,
        asset_pda: selected.assetPda,
        asset_label: selected.label,
        amount: Number(amount.trim()),
        delivery_details: details.trim(),
        contact: contact.trim(),
      });
    } catch (err) {
      setBusy(false);
      toast.showError(
        "Request failed",
        err instanceof Error
          ? err.message
          : "Could not save the delivery request.",
      );
      return;
    }
    setBusy(false);
    toast.show({
      kind: "success",
      title: "Delivery requested",
      description: "Manci will review your request.",
    });
    onSuccess();
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Request delivery
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Redeem share-class units for the physical underlying. Only
            deliverable assets you hold appear here.
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
                Amount must be between 1 and your balance.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Delivery details
            </span>
            <textarea
              value={details}
              rows={4}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Delivery address and any handling instructions…"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Contact (email / phone)
            </span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="How Manci reaches you about this delivery"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>

          <p className="text-[11px] text-slate-400">
            After approval you&apos;ll deposit the tokens into a smart-contract
            escrow. They are returned if the delivery is cancelled and burned
            once delivery is confirmed.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
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
            disabled={busy || !amountOk || !details.trim() || !contact.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty({
  onClick,
  canRequest,
  eligible,
}: {
  onClick: () => void;
  canRequest: boolean;
  eligible: boolean;
}) {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        You haven&apos;t requested any deliveries yet.
      </p>
      {canRequest ? (
        <button
          type="button"
          onClick={onClick}
          className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Request your first delivery →
        </button>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          {eligible
            ? "You need to hold tokens of a deliverable asset (fungible or non-fungible category) first."
            : "Onboard as a client and hold deliverable-asset tokens to request delivery."}
        </p>
      )}
    </div>
  );
}
