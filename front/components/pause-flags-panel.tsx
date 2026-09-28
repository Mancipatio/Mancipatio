"use client";

import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useState } from "react";
import {
  fetchMaybePlatform,
  findPlatformPda,
  getSetPauseFlagsInstructionAsync,
  type Platform,
} from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { useMaintenance } from "@/lib/maintenance-client";
import {
  CLOSE_BOOTSTRAP_MASKS,
  describePausedAreas,
  formatPauseFlags,
  isBootstrapOpen,
  PAUSE_EXITS_OPEN,
  PAUSE_FLAGS,
  PAUSE_FLAGS_ALL,
  PAUSE_PAYOUT_MODULES,
  PLATFORM_BOOTSTRAP_OPEN,
  RESUME_EVERYTHING_MASK,
  pauseAuditMetadata,
  pauseControls,
  pauseMasks,
  pauseRole,
} from "@/lib/pause-flags";
import { detectNetwork } from "@/lib/network";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { useToast } from "@/lib/toast";

type Pending = {
  /** "bootstrap": `set_pause_flags(0, 0x80)`, closing the one-way window. */
  action: "pause" | "resume" | "bootstrap";
  /** Bits the action targets. */
  bits: number;
  title: string;
};

/**
 * Emergency pause: one row per `Platform.pause_flags` pause bit. Any Admin
 * can pause an area (or everything); only the Super Admin can resume. The
 * program combines concurrent pauses (`new = (old | set) & !clear`), so a
 * pause never wipes a bit another Admin set in the meantime.
 *
 * v1.0.0-rc: "Resume everything" never switches the payout modules (0x40)
 * on — the program clears that bit only in a call of its own (6154), and the
 * panel offers it only off mainnet, as its own confirmed action. Bit 7 is the
 * one-way bootstrap window: any resume closes it; the Super Admin can also
 * close it explicitly.
 */
export function PauseFlagsPanel({
  platform,
  onChanged,
}: {
  platform: Platform;
  onChanged: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const role = useRole();
  const toast = useToast();
  const maintenance = useMaintenance();
  const [pending, setPending] = useState<Pending | null>(null);

  const wallet = conn.wallet?.account.address;
  const flags = platform.pauseFlags;
  const { isAdmin, isSuperAdmin } = pauseRole(
    wallet,
    platform.admin,
    role.isAdmin,
  );
  // D2: the payout / Merkle modules stay off on mainnet; elsewhere the Super
  // Admin may switch them on, in a call of its own.
  const allowPayoutModules = detectNetwork() !== "mainnet";
  const controls = pauseControls(flags, { isAdmin, isSuperAdmin }, { allowPayoutModules });
  const areas = describePausedAreas(flags);
  const bootstrapOpen = isBootstrapOpen(flags);

  /** The flags on chain right after this transaction confirmed (null when
   *  the read fails; the tx's PauseFlagsChanged event stays authoritative). */
  async function observedFlags(): Promise<number | null> {
    try {
      const [pda] = await findPlatformPda();
      const maybe = await fetchMaybePlatform(client.runtime.rpc, pda, {
        commitment: "confirmed",
      });
      return maybe.exists ? maybe.data.pauseFlags : null;
    } catch {
      return null;
    }
  }

  async function apply(reason: string) {
    if (!pending || !wallet || !conn.wallet) return;
    const { setMask, clearMask } =
      pending.action === "bootstrap"
        ? CLOSE_BOOTSTRAP_MASKS
        : pauseMasks(pending.action, pending.bits);
    // The panel's cached view: another Admin may have moved the flags since.
    const metadata = pauseAuditMetadata(setMask, clearMask, flags);
    const pendingId = toast.showPending(`${pending.title}…`, reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getSetPauseFlagsInstructionAsync({
        authority: signer,
        setMask,
        clearMask,
      });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      // The pre-sign pause gate (lib/pause-gate.ts) re-reads on the next send.
      clearPauseFlagsCache();
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: pending.title });
      const title = pending.title;
      // Recorded in the background: the confirmed re-read must not hold the
      // modal open.
      void observedFlags().then((observed) =>
        recordAudit({
          ix_name: "set_pause_flags",
          category: "platform",
          actor_wallet: wallet.toString(),
          reason,
          target_label: title,
          tx_signature: sig || undefined,
          status: "success",
          metadata: pauseAuditMetadata(setMask, clearMask, flags, observed),
        }),
      );
      setPending(null);
      await onChanged();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError(`${pending.title} failed`, detail);
      void recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason,
        target_label: pending.title,
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-slate-900">
            Emergency pause
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {areas ? `Paused: ${areas}.` : "Nothing is paused."}{" "}
            <span className="font-mono">{formatPauseFlags(flags)}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Bootstrap window ({formatPauseFlags(PLATFORM_BOOTSTRAP_OPEN)}):{" "}
            {bootstrapOpen
              ? "open — Admin grants and a Super Admin rotation skip their 48-hour wait. Any resume closes it for good."
              : "closed for good."}
          </p>
        </div>
        <div className="flex gap-2">
          {controls.pauseEverything && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() =>
                setPending({
                  action: "pause",
                  bits: PAUSE_FLAGS_ALL,
                  title: "Pause every area",
                })
              }
              className="rounded-md border border-red-300 bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
            >
              Pause everything
            </button>
          )}
          {controls.resumeEverything && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() =>
                setPending({
                  action: "resume",
                  // Every emergency area and bit 7, never the payout modules.
                  bits: RESUME_EVERYTHING_MASK,
                  title: "Resume every area",
                })
              }
              className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              Resume everything
            </button>
          )}
          {controls.closeBootstrap && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() =>
                setPending({
                  action: "bootstrap",
                  bits: PLATFORM_BOOTSTRAP_OPEN,
                  title: "Close the bootstrap window",
                })
              }
              className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              Close bootstrap window
            </button>
          )}
        </div>
      </div>

      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {PAUSE_FLAGS.map((flag, i) => {
          const { paused, action } = controls.rows[i];
          return (
            <li
              key={flag.bit}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-slate-800">
                  {flag.label}
                  <span className="ml-2 font-mono text-[11px] text-slate-400">
                    {formatPauseFlags(flag.bit)}
                  </span>
                </p>
                <p className="text-xs text-slate-500">{flag.stops}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                    paused
                      ? "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200"
                      : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200"
                  }`}
                >
                  {paused ? "Paused" : "Active"}
                </span>
                {action === "resume" && (
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() =>
                      setPending({
                        action: "resume",
                        bits: flag.bit,
                        title:
                          flag.bit === PAUSE_PAYOUT_MODULES
                            ? "Enable the payout modules (clear 0x40)"
                            : `Resume ${flag.label.toLowerCase()}`,
                      })
                    }
                    className="rounded-md border border-slate-300 px-2 py-0.5 text-[11.5px] font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
                  >
                    {flag.bit === PAUSE_PAYOUT_MODULES ? "Enable" : "Resume"}
                  </button>
                )}
                {paused && flag.bit === PAUSE_PAYOUT_MODULES && !allowPayoutModules && (
                  <span className="text-[11px] text-slate-500">Stays off on mainnet</span>
                )}
                {action === "pause" && (
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() =>
                      setPending({
                        action: "pause",
                        bits: flag.bit,
                        title: `Pause ${flag.label.toLowerCase()}`,
                      })
                    }
                    className="rounded-md border border-red-200 px-2 py-0.5 text-[11.5px] font-medium text-red-800 hover:border-red-300 disabled:opacity-50"
                  >
                    Pause
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {maintenance?.enabled && isAdmin && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
          Maintenance mode is on, so this site refuses every wallet
          transaction, a pause included. To pause now, sign{" "}
          <span className="font-mono">set_pause_flags</span> outside the site
          (Solana CLI or the multisig) with an Admin key: the area bits shown
          next to each area as the set mask and a clear mask of 0x00.
        </p>
      )}

      <p className="mt-2 text-xs text-slate-500">
        {PAUSE_EXITS_OPEN} The transfer hook never reads the pause.{" "}
        {isSuperAdmin
          ? "You can pause and resume."
          : isAdmin
            ? "As an Admin you can pause; only the Super Admin can resume."
            : "Admins can pause; only the Super Admin can resume."}
      </p>

      {pending && (
        <ConfirmModal
          open
          onClose={() => setPending(null)}
          onConfirm={(reason) => apply(reason)}
          title={pending.title}
          kind={pending.action === "pause" ? "destructive" : "warning"}
          confirmLabel={
            pending.action === "pause"
              ? "Pause"
              : pending.action === "bootstrap"
                ? "Close window"
                : pending.bits === PAUSE_PAYOUT_MODULES
                  ? "Enable payout modules"
                  : "Resume"
          }
          description={
            pending.action === "bootstrap" ? (
              <p>
                Closes the one-way bootstrap window for good: from now on
                every Admin grant and Super Admin rotation waits its 48 hours.
                No area is resumed. The reason is recorded in the audit log.
              </p>
            ) : pending.action === "resume" && pending.bits === PAUSE_PAYOUT_MODULES ? (
              <p>
                This switches the payout and Merkle modules <strong>on</strong>:
                Startup raises, yield routing, Rights-Token issuances and
                milestones. They are off on mainnet by decision (D2); do this
                only on a test network, on purpose. The reason is recorded in
                the audit log.
              </p>
            ) : pending.action === "pause" ? (
              <p>
                This stops:{" "}
                <strong>
                  {describePausedAreas(pending.bits & ~flags) ||
                    "nothing new (already paused)"}
                </strong>
                . {PAUSE_EXITS_OPEN} Only the Super Admin can resume. The
                reason is recorded in the audit log.
              </p>
            ) : (
              <p>
                This resumes:{" "}
                <strong>
                  {describePausedAreas(pending.bits & flags) ||
                    "nothing paused (it only closes the bootstrap window)"}
                </strong>
                . The payout modules stay as they are, and the bootstrap
                window closes for good. Resume only once the cause of the
                pause is resolved. The reason is recorded in the audit log.
              </p>
            )
          }
          busy={tx.isSending}
        />
      )}
    </div>
  );
}
