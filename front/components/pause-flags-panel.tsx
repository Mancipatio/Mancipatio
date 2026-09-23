"use client";

import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useWalletConnection,
} from "@solana/react-hooks";
import { useState } from "react";
import {
  getSetPauseFlagsInstructionAsync,
  type Platform,
} from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import {
  describePausedAreas,
  formatPauseFlags,
  isPaused,
  nextPauseFlags,
  PAUSE_EXITS_OPEN,
  PAUSE_FLAGS,
  PAUSE_FLAGS_ALL,
  pauseMasks,
  unknownPauseBits,
} from "@/lib/pause-flags";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";

type Pending = {
  action: "pause" | "resume";
  /** Bits the action targets. */
  bits: number;
  title: string;
};

/**
 * Emergency pause: one row per `Platform.pause_flags` bit. Any Admin can
 * pause an area (or everything); only the Super Admin can resume. The program
 * combines concurrent pauses (`new = (old | set) & !clear`), so a pause never
 * wipes a bit another Admin set in the meantime.
 */
export function PauseFlagsPanel({
  platform,
  onChanged,
}: {
  platform: Platform;
  onChanged: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const role = useRole();
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const wallet = conn.wallet?.account.address;
  const flags = platform.pauseFlags;
  const isSuperAdmin = !!wallet && platform.admin === wallet;
  const isAdmin = isSuperAdmin || role.isAdmin;
  const unknown = unknownPauseBits(flags);
  const allPaused = (flags & PAUSE_FLAGS_ALL) === PAUSE_FLAGS_ALL;
  const areas = describePausedAreas(flags);

  async function apply(reason: string) {
    if (!pending || !wallet || !conn.wallet) return;
    const { setMask, clearMask } = pauseMasks(pending.action, pending.bits);
    const old = flags;
    const next = nextPauseFlags(old, setMask, clearMask);
    const metadata = {
      set: formatPauseFlags(setMask),
      clear: formatPauseFlags(clearMask),
      old: formatPauseFlags(old),
      new: formatPauseFlags(next),
    };
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
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: pending.title });
      void recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason,
        target_label: pending.title,
        tx_signature: sig || undefined,
        status: "success",
        metadata,
      });
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
        </div>
        <div className="flex gap-2">
          {isAdmin && !allPaused && (
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
          {isSuperAdmin && flags !== 0 && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() =>
                setPending({
                  action: "resume",
                  // Clears undefined bits too (rollback normalization).
                  bits: flags,
                  title: "Resume every area",
                })
              }
              className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              Resume everything
            </button>
          )}
        </div>
      </div>

      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {PAUSE_FLAGS.map((flag) => {
          const paused = isPaused(flags, flag.bit);
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
                {paused
                  ? isSuperAdmin && (
                      <button
                        type="button"
                        disabled={tx.isSending}
                        onClick={() =>
                          setPending({
                            action: "resume",
                            bits: flag.bit,
                            title: `Resume ${flag.label.toLowerCase()}`,
                          })
                        }
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-[11.5px] font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
                      >
                        Resume
                      </button>
                    )
                  : isAdmin && (
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

      {unknown !== 0 && (
        <p className="mt-2 text-xs text-amber-700">
          Undefined bits {formatPauseFlags(unknown)} are set. They pause
          nothing; the Super Admin can clear them with Resume everything.
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
          confirmLabel={pending.action === "pause" ? "Pause" : "Resume"}
          description={
            pending.action === "pause" ? (
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
                    "undefined bits only"}
                </strong>
                . Resume only once the cause of the pause is resolved. The
                reason is recorded in the audit log.
              </p>
            )
          }
          busy={tx.isSending}
        />
      )}
    </div>
  );
}
