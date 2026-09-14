"use client";

import Link from "next/link";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import {
  fetchMaybePlatform,
  findPlatformPda,
  getSetPauseInstructionAsync,
  type Platform,
} from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";

export function PlatformStatusCard() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [platform, setPlatform] = useState<Platform | null | undefined>(
    undefined,
  );
  const [confirmPause, setConfirmPause] = useState(false);

  const refresh = useCallback(async () => {
    const [pda] = await findPlatformPda();
    const maybe = await fetchMaybePlatform(client.runtime.rpc, pda);
    setPlatform(maybe.exists ? maybe.data : null);
  }, [client]);

  useEffect(() => {
    // Async fetch on mount — switch to SWR / React Query when added to stack.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const wallet = conn.wallet?.account.address;

  async function togglePause(reason: string) {
    if (!wallet || !platform || !conn.wallet) return;
    const wasPaused = platform.paused;
    const action = wasPaused ? "Unpausing" : "Pausing";
    const pendingId = toast.showPending(`${action} platform…`, reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getSetPauseInstructionAsync({
        admin: signer,
        paused: !wasPaused,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: wasPaused ? "Platform unpaused" : "Platform paused",
      });
      void recordAudit({
        ix_name: "set_pause",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason,
        tx_signature: sig,
        target_label: wasPaused ? "unpause" : "pause",
        metadata: { paused: !wasPaused },
      });
      setConfirmPause(false);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to toggle pause", message);
      void recordAudit({
        ix_name: "set_pause",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason,
        target_label: wasPaused ? "unpause" : "pause",
        status: "failed",
        metadata: { error: message },
      });
    }
  }

  if (platform === undefined) {
    return <SkeletonCard rows={4} />;
  }

  if (platform === null) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-900">
          Platform not initialized
        </p>
        <h2 className="mt-2 text-lg font-semibold text-amber-950">
          Bootstrap required
        </h2>
        <p className="mt-2 text-sm text-amber-900/90">
          The Platform singleton must be initialized before any other
          on-chain operation can succeed. The wallet that initializes becomes
          the permanent Super Admin.
        </p>
        <Link
          href="/admin/platform"
          className="mt-4 inline-flex items-center rounded-lg bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-950"
        >
          Initialize Platform →
        </Link>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div
        className="h-0.5"
        style={{
          background: platform.paused
            ? "linear-gradient(90deg, #ef4444 0%, #b91c1c 100%)"
            : "linear-gradient(90deg, #10b981 0%, #059669 100%)",
        }}
      />
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-eyebrow">Platform</p>
            <h2 className="mt-1 text-[16px] font-semibold text-slate-900">
              On-chain singleton
            </h2>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
              platform.paused
                ? "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200"
                : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"
            }`}
          >
            <span
              className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                platform.paused
                  ? "bg-red-500"
                  : "bg-emerald-500 animate-pulse"
              }`}
            />
            {platform.paused ? "Paused" : "Active"}
          </span>
        </div>

        <dl className="mt-4 space-y-1.5 text-[13px]">
          <Row label="Super Admin" value={platform.admin.toString()} mono />
          <Row label="Treasury" value={platform.protocolTreasury.toString()} mono />
          <Row
            label="Protocol fee"
            value={`${platform.protocolFeeBps} bps — reserved on-chain field, not charged`}
          />
          <Row label="Issuers" value={String(platform.issuersCount)} />
          <Row label="Version" value={String(platform.version)} />
        </dl>

        <div className="mt-5 flex items-center gap-3">
          {isSuperAdmin ? (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirmPause(true)}
              className={`rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50 ${
                platform.paused
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
                  : "border-red-300 bg-red-50 text-red-900 hover:bg-red-100"
              }`}
            >
              {platform.paused ? "Unpause platform" : "Emergency pause"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">
              Only the Super Admin can pause the platform.
            </p>
          )}
          <Link
            href="/admin/platform"
            className="text-xs text-brand-700 underline-offset-2 hover:underline"
          >
            Open console →
          </Link>
        </div>
      </div>

      <ConfirmModal
        open={confirmPause}
        onClose={() => setConfirmPause(false)}
        onConfirm={(reason) => togglePause(reason)}
        title={platform.paused ? "Unpause platform" : "Pause platform"}
        kind={platform.paused ? "warning" : "destructive"}
        confirmLabel={platform.paused ? "Unpause" : "Pause"}
        description={
          platform.paused ? (
            <p>
              Unpausing the platform resumes <strong>all</strong> mint,
              transfer, custody, sale, OTC, governance and Rights claim
              operations. Reason will be recorded in the audit log.
            </p>
          ) : (
            <p>
              Pausing halts <strong>all platform operations</strong> across
              every issuer and share class. Use only in emergency. Reason will
              be recorded in the audit log.
            </p>
          )
        }
        busy={tx.isSending}
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-slate-700 ${mono ? "font-mono text-xs" : ""}`}
        title={mono ? value : undefined}
      >
        {mono ? `${value.slice(0, 4)}…${value.slice(-4)}` : value}
      </dd>
    </div>
  );
}
