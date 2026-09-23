"use client";
import { useCallback, useEffect, useState } from "react";
import { type Address, type Instruction } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { fetchMaybeIssuer, fetchMaybePlatform, findPlatformPda } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { featureDisabledMessage, features } from "@/lib/features";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import {
  buildCancelIssuerRecovery,
  buildProposeIssuerRecovery,
  bundleWithSync,
  collectIssuerSyncTargets,
  describeRecoveryState,
  fetchIssuerRecovery,
  fetchPendingIssuerTransfer,
  formatCountdown,
  formatUtc,
  issuerAuthorityActions,
  issuerRecoveryState,
  issuerSyncInstructions,
  adminKeyRuleError,
  issuerTransferState,
  proposedIssuerAuthorityError,
  sendBatches,
  type IssuerRecoveryRecord,
  type PendingIssuerTransfer,
} from "@/lib/issuer-authority";
import { loadPayoutVaults } from "@/lib/payout-vault";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { LOCAL_CLOCK_NOTE, useChainAlignedClock } from "@/lib/use-chain-aligned-clock";
import { walletSigner } from "@/lib/wallet-signer";

const ENABLED = features().issuerRotation;

type Action = { kind: "propose"; newAuthority: string } | { kind: "cancel" } | { kind: "sync" };

/**
 * Super-admin view of an issuer's key: the pending regular rotation
 * (read-only: only the issuer proposes / accepts it), the timelocked recovery
 * of a LOST key (propose with a re-typed key, cancel, a chain-time
 * countdown), and a "Sync all" for the issuer's open sales and payout vaults
 * after the key moved. The program enforces every rule; the buttons only
 * appear for the wallet the program would accept.
 */
export function IssuerRecoveryPanel({
  issuer,
  authority: indexedAuthority,
  otherAuthorities,
  canEdit,
}: {
  issuer: Address;
  authority: Address;
  /** Authorities of every OTHER issuer (one issuer per wallet). */
  otherAuthorities: readonly string[];
  canEdit: boolean;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const { now, fromChain } = useChainAlignedClock(client.runtime.rpc);
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const [recovery, setRecovery] = useState<IssuerRecoveryRecord | null>(null);
  const [transfer, setTransfer] = useState<PendingIssuerTransfer | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [retyped, setRetyped] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [syncs, setSyncs] = useState<Instruction[] | null>(null);
  // The LIVE issuer authority: the `authority` prop comes from indexer-first
  // data, which lags an accept / execute by a few seconds, exactly when the
  // sync check and the recovery state matter most.
  const [liveAuthority, setLiveAuthority] = useState<Address | null>(null);
  const authority = liveAuthority ?? indexedAuthority;

  const readLiveAuthority = useCallback(async (): Promise<Address | null> => {
    const record = await fetchMaybeIssuer(client.runtime.rpc, issuer, { commitment: "confirmed" });
    return record.exists ? record.data.authority : null;
  }, [client, issuer]);

  const refresh = useCallback(async () => {
    if (!ENABLED) return;
    try {
      const [platformPda] = await findPlatformPda();
      const [r, t, platform, live] = await Promise.all([
        fetchIssuerRecovery(client.runtime.rpc, issuer),
        fetchPendingIssuerTransfer(client.runtime.rpc, issuer),
        fetchMaybePlatform(client.runtime.rpc, platformPda),
        readLiveAuthority(),
      ]);
      setRecovery(r);
      setTransfer(t);
      setLiveAuthority(live);
      setPlatformAdmin(platform.exists ? platform.data.admin.toString() : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, issuer, readLiveAuthority]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (!ENABLED) {
    return (
      <section className="mt-5 rounded-lg border border-slate-200 p-4 text-xs text-slate-500">
        {featureDisabledMessage("issuerRotation")}
      </section>
    );
  }

  const recoveryState =
    now === null
      ? ({ kind: "none" } as const)
      : issuerRecoveryState(recovery, { address: issuer.toString(), authority: authority.toString() }, platformAdmin, now);
  const transferState = issuerTransferState(issuer.toString(), authority.toString(), transfer);
  const can = issuerAuthorityActions(wallet, {
    issuerAuthority: authority.toString(),
    platformAdmin,
    transfer: transferState,
    recovery: recoveryState,
  });
  const keyError = proposedIssuerAuthorityError(newKey, authority.toString(), otherAuthorities);
  const retypeMatches = newKey.trim() !== "" && newKey.trim() === retyped.trim();

  async function checkSync() {
    try {
      const network = await loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc));
      const vaults = await loadPayoutVaults(client.runtime.rpc);
      const targets = await collectIssuerSyncTargets(network, vaults, issuer);
      const live = (await readLiveAuthority()) ?? authority;
      setLiveAuthority(live);
      setSyncs(issuerSyncInstructions({ issuer, issuerAuthority: live, ...targets }));
    } catch (err) {
      toast.showError("Could not check sales and payout vaults", err instanceof Error ? err.message : undefined);
    }
  }

  async function run(current: Action, reason: string) {
    if (!conn.wallet || !wallet) return;
    const signer = walletSigner(conn.wallet);
    const ixName =
      current.kind === "propose"
        ? "propose_issuer_recovery"
        : current.kind === "cancel"
          ? "cancel_issuer_recovery"
          : "sync_issuer_snapshots";
    const metadata: Record<string, unknown> = { issuer: issuer.toString(), authority: authority.toString() };
    const pendingId = toast.showPending(`${ixName.replaceAll("_", " ")}…`, reason);
    try {
      let batches: Instruction[][];
      if (current.kind === "propose") {
        metadata.new_authority = current.newAuthority;
        const adminError = await adminKeyRuleError(
          client.runtime.rpc,
          "recovery",
          authority,
          current.newAuthority as Address,
        );
        if (adminError) throw new Error(adminError);
        batches = [[
          await buildProposeIssuerRecovery({
            superAdminSigner: signer,
            issuer,
            newAuthority: current.newAuthority as Address,
          }),
        ]];
      } else if (current.kind === "cancel") {
        if (!recovery) throw new Error("No recovery to cancel");
        metadata.new_authority = recovery.newAuthority;
        batches = [[
          await buildCancelIssuerRecovery({
            cancellerSigner: signer,
            issuer,
            proposer: recovery.proposedBy as Address,
          }),
        ]];
      } else {
        if (!syncs?.length) throw new Error("Nothing to sync");
        metadata.syncs = syncs.length;
        batches = bundleWithSync([], syncs, { feePayer: signer.address, order: "primary-first" });
      }
      const result = await sendBatches(batches, (instructions) => tx.send({ instructions, feePayer: signer }));
      const signature = result.signature;
      toast.dismiss(pendingId);
      toast.showTx(signature, { title: ixName.replaceAll("_", " ") });
      if (result.error) {
        metadata.syncs_pending = result.pending;
        metadata.sync_error = explainSendError(result.error);
        toast.showError(
          `${result.pending} sync${result.pending === 1 ? "" : "s"} did not land`,
          "The first transaction landed. Check the sales and payout vaults again and sync the rest.",
        );
      }
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: issuer.toString(),
        tx_signature: signature || undefined,
        status: "success",
        metadata,
      });
      setAction(null);
      if (current.kind === "propose") {
        setNewKey("");
        setRetyped("");
      }
      if (current.kind === "sync") setSyncs(null);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError(`${ixName.replaceAll("_", " ")} failed`, detail);
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: issuer.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="issuer-key-heading">
      <h3 id="issuer-key-heading" className="text-sm font-semibold text-slate-900">
        Issuer key and recovery
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        The issuer rotates its own key (propose, then the new wallet accepts). If the key is LOST, the Super Admin
        proposes a recovery here; the new wallet can execute it only after a 7-day waiting period, and the
        issuer&apos;s current wallet can cancel it until then.
      </p>
      {error && <p className="mt-2 text-xs text-red-600">Could not read the issuer key state: {error}</p>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-slate-500">Authority</dt>
        <dd className="break-all font-mono text-slate-800">{authority.toString()}</dd>
        <dt className="text-slate-500">Rotation</dt>
        <dd className="text-slate-800">
          {transferState.kind === "none" ? (
            "None pending"
          ) : (
            <>
              proposed to <span className="break-all font-mono">{transferState.newAuthority}</span>
              {transferState.kind === "stale" ? " (stale)" : " (waiting for that wallet to accept)"}
            </>
          )}
        </dd>
        <dt className="text-slate-500">Recovery</dt>
        <dd className="text-slate-800">
          {now === null ? (
            "Reading chain time…"
          ) : recoveryState.kind === "none" ? (
            "None pending"
          ) : (
            <>
              to <span className="break-all font-mono">{recoveryState.newAuthority}</span>. {describeRecoveryState(recoveryState)}
              {recoveryState.kind === "waiting" && (
                <span className="ml-1 font-mono font-semibold">({formatCountdown(recoveryState.remaining)} left)</span>
              )}
              {!fromChain && <span className="mt-0.5 block text-[11px] text-slate-500">{LOCAL_CLOCK_NOTE}</span>}
            </>
          )}
        </dd>
        {recovery && (
          <>
            <dt className="text-slate-500">Timeline</dt>
            <dd className="text-slate-800">
              proposed {formatUtc(recovery.proposedAt)} · executable from {formatUtc(recovery.eta)} · expires{" "}
              {formatUtc(recovery.expiresAt)}
            </dd>
          </>
        )}
      </dl>

      {canEdit && can.canProposeRecovery && (
        <div className="mt-3 space-y-2">
          <input
            aria-label="New issuer authority"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="New issuer wallet (identity verified off-chain)"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs"
          />
          <input
            aria-label="Re-type the new issuer authority"
            value={retyped}
            onChange={(e) => setRetyped(e.target.value)}
            onPaste={(e) => e.preventDefault()}
            placeholder="Type the new wallet again"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs"
          />
          {keyError && <p className="text-xs text-red-600">{keyError}</p>}
          {!keyError && retyped && !retypeMatches && (
            <p className="text-xs text-red-600">The two addresses do not match.</p>
          )}
          <button
            type="button"
            disabled={tx.isSending || !retypeMatches || keyError !== null}
            onClick={() => setAction({ kind: "propose", newAuthority: newKey.trim() })}
            className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {recovery ? "Replace recovery (restarts the 7 days)" : "Propose recovery"}
          </button>
        </div>
      )}
      {canEdit && can.canCancelRecovery && (
        <button
          type="button"
          disabled={tx.isSending}
          onClick={() => setAction({ kind: "cancel" })}
          className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel recovery
        </button>
      )}

      <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <p>
          After a key moves, the issuer&apos;s open sales and payout vaults still name the old wallet until they
          are synced (any wallet can pay for this). A recovery also closes the lost key&apos;s operating
          permissions: grant them again above after review.
        </p>
        {syncs === null ? (
          <button
            type="button"
            onClick={() => void checkSync()}
            className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            Check sales and payout vaults
          </button>
        ) : syncs.length === 0 ? (
          <p className="mt-2 text-emerald-700">Every open sale and payout vault already names the current key.</p>
        ) : (
          <button
            type="button"
            disabled={tx.isSending || !wallet}
            onClick={() => setAction({ kind: "sync" })}
            className="mt-2 rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            Sync all ({syncs.length})
          </button>
        )}
      </div>

      {action && (
        <ConfirmModal
          open
          busy={tx.isSending}
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(action, reason)}
          title={
            action.kind === "propose"
              ? "Propose an issuer key recovery"
              : action.kind === "cancel"
                ? "Cancel the issuer recovery"
                : "Sync sales and payout vaults"
          }
          kind={action.kind === "propose" ? "destructive" : action.kind === "cancel" ? "warning" : "info"}
          confirmLabel={action.kind === "propose" ? "Propose recovery" : action.kind === "cancel" ? "Cancel recovery" : "Sync"}
          description={
            action.kind === "propose" ? (
              <p>
                Stage <span className="break-all font-mono">{action.newAuthority}</span> as the issuer&apos;s new key.
                It can execute from {now === null ? "7 days from now" : formatUtc(now + 604_800)} for 14 days. Tell the
                issuer through its registered contact now: its current wallet can cancel during the wait. The
                recovered key starts with no operating permissions.
              </p>
            ) : action.kind === "cancel" ? (
              <p>Withdraw the recovery. The rent returns to the Super Admin who proposed it.</p>
            ) : (
              <p>Copy the current issuer key into {syncs?.length ?? 0} sale / payout-vault record(s).</p>
            )
          }
        />
      )}
    </section>
  );
}
