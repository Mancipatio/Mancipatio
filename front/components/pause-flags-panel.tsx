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
import { kycOnly, moduleEnabled } from "@/lib/features";
import { useMaintenance } from "@/lib/maintenance-client";
import {
  CLOSE_BOOTSTRAP_MASKS,
  describePausedAreas,
  formatPauseFlags,
  isBootstrapOpen,
  PAUSE_CUSTODY_ENTRY,
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
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { confirmThenReport } from "@/lib/send-outcome";
import { waitForSignature, type SignatureOutcome } from "@/lib/simulation-gate";
import { recordAudit, type AuditStatus } from "@/lib/supabase";
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

// ── The send's outcome (pure, node-safe: tests/pause-panel-send.test.ts) ────

/**
 * How long the panel waits for the network to confirm a `set_pause_flags`
 * (status reads retried on a refused RPC). `tx.send` returns at submission,
 * so nothing below is reported before this wait answers.
 */
export const PAUSE_CONFIRM_TIMEOUT_MS = 30_000;

export type PauseSendHandlers = {
  /** Polls the signature until it is confirmed, failed, or the wait runs out (lib/simulation-gate waitForSignature). */
  wait: () => Promise<SignatureOutcome>;
  /** Reads `Platform.pause_flags`; called only after the confirmation (null when the read fails). */
  observe: () => Promise<number | null>;
  /** Writes the audit row of the outcome; `observed` is given only for a confirmed send. */
  audit: (
    status: AuditStatus,
    detail: { observed?: number | null; error?: string; confirmation?: SignatureOutcome },
  ) => Promise<unknown>;
  /** The network confirmed it: the success toast. */
  confirmed: () => void;
  /** The network refused it: the flags are unchanged. */
  failed: () => void;
  /** Not confirmed within the wait, or the status could not be read: it may still land. */
  unconfirmed: (outcome: Exclude<SignatureOutcome, "confirmed" | "failed">) => void;
  /** After the report, whatever the outcome: forget the pre-sign gate's cached flags. */
  clearCache: () => void;
  /** Then re-read the host page (its Platform read). */
  refresh: () => void | Promise<void>;
  /** The host page could not be re-read: the send's own outcome stands (an info, never a failed send). */
  refreshFailed: () => void;
};

/**
 * A pause or resume is "done" only when the network says so: the success
 * toast, the audit row (its `observed_after` read AFTER the confirmation) and
 * the host page's refresh wait for the outcome (lib/send-outcome
 * confirmThenReport). A refused send is a "failed" row with the signature; an
 * unconfirmed one a "pending" row. A failed re-read afterwards is not a failed
 * pause: the outcome already reported stands and the host is told to refresh.
 */
export async function settlePauseFlagsSend(h: PauseSendHandlers): Promise<SignatureOutcome> {
  return confirmThenReport(h.wait, {
    confirmed: () => {
      h.confirmed();
      // Recorded in the background (it never holds the refresh), but read
      // only now, so observed_after is the state the transaction left.
      void h
        .observe()
        .catch(() => null)
        .then((observed) => h.audit("success", { observed }))
        .catch(() => undefined);
    },
    failed: () => {
      h.failed();
      void h.audit("failed", { error: "refused by the network" }).catch(() => undefined);
    },
    unconfirmed: (outcome) => {
      h.unconfirmed(outcome);
      void h.audit("pending", { confirmation: outcome }).catch(() => undefined);
    },
    settled: async () => {
      h.clearCache();
      try {
        await h.refresh();
      } catch {
        h.refreshFailed();
      }
    },
  });
}

// ── The resume confirmation's copy (pure) ───────────────────────────────────

/** What clearing 0x08 opens on-chain, and when to set it again (ops/runbook-mainnet.md, the conversion window). */
export const CUSTODY_ENTRY_OPENS =
  "Opens custody entry: any Admin can open custody vaults (delivery escrows included) and holders can deposit into them. Open it only for a specific conversion request, and close it (Pause custody entry) as soon as the deposit has landed.";
/** KYC-only mode refuses the vault open and the deposit on this site (lib/pause-gate KYC_ONLY_FLOWS). */
export const CUSTODY_ENTRY_KYC_ONLY =
  "KYC-only mode is on: this site refuses the conversion vault open and the holder's deposit, so this only opens the chain to transactions signed outside the site.";
/** The conversion module is off: this site opens no conversion vault (lib/pause-gate MODULE_FLOWS). */
export const CUSTODY_ENTRY_CONVERSION_OFF =
  "Conversion is switched off here: this site will not open a conversion vault (a holder can still deposit into one already open).";

export type ResumeScope = { kycOnly: boolean; conversionOn: boolean };

export type ResumeNotice = {
  /** The areas this clears, or "nothing paused (it only closes the bootstrap window)". */
  resumes: string;
  /** The custody-entry window's sentences; empty unless Custody entry is among the areas. */
  custody: string[];
  /** Bit 7 is still open: any clear closes it for good. */
  bootstrapCloses: boolean;
  /** More than the one custody window is being lifted: an emergency pause. */
  incident: boolean;
  /** The closing sentence(s): the payout modules, the bootstrap window, the incident reminder, the audit log. */
  closing: string;
};

/**
 * The copy of a resume confirmation. A single Custody entry (0x08) resume is
 * the per-conversion window (runbook steps 5 and 8), not incident recovery:
 * it says what the bit opens platform-wide and when to close it, and drops
 * "once the cause of the pause is resolved". The bootstrap sentence appears
 * only while bit 7 is open.
 */
export function resumeNotice(bits: number, flags: number, scope: ResumeScope): ResumeNotice {
  const resumed = bits & flags & PAUSE_FLAGS_ALL;
  const custody: string[] = [];
  if ((resumed & PAUSE_CUSTODY_ENTRY) !== 0) {
    custody.push(CUSTODY_ENTRY_OPENS);
    if (scope.kycOnly) custody.push(CUSTODY_ENTRY_KYC_ONLY);
    else if (!scope.conversionOn) custody.push(CUSTODY_ENTRY_CONVERSION_OFF);
  }
  const bootstrapCloses = isBootstrapOpen(flags);
  const incident = resumed !== PAUSE_CUSTODY_ENTRY;
  const closing = [
    "The payout modules stay as they are.",
    bootstrapCloses ? "The bootstrap window closes for good." : null,
    incident ? "Resume only once the cause of the pause is resolved." : null,
    "The reason is recorded in the audit log.",
  ]
    .filter((s): s is string => s !== null)
    .join(" ");
  return {
    resumes: describePausedAreas(resumed) || "nothing paused (it only closes the bootstrap window)",
    custody,
    bootstrapCloses,
    incident,
    closing,
  };
}

function ResumeDescription({ bits, flags }: { bits: number; flags: number }) {
  const notice = resumeNotice(bits, flags, {
    kycOnly: kycOnly(),
    conversionOn: moduleEnabled("custodyConversion"),
  });
  return (
    <div className="space-y-2">
      <p>
        This resumes: <strong>{notice.resumes}</strong>.
      </p>
      {notice.custody.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[13px] text-amber-900">
          {notice.custody.join(" ")}
        </p>
      )}
      <p>{notice.closing}</p>
    </div>
  );
}

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
 *
 * A change is reported only once the network confirms it (`tx.send` returns
 * at submission): the buttons stay held until then, so a second click cannot
 * send the same change twice.
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
  const rpc = client.runtime.rpc;
  const tx = useSendTransaction();
  const role = useRole();
  const toast = useToast();
  const maintenance = useMaintenance();
  const [pending, setPending] = useState<Pending | null>(null);
  /** Between the submission and the network's answer: the buttons stay held. */
  const [confirming, setConfirming] = useState(false);
  const busy = tx.isSending || confirming;

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
   *  the read fails; the tx's PauseFlagsChanged event stays authoritative).
   *  A refused read right after a send (HTTP 429) is retried. */
  async function observedFlags(): Promise<number | null> {
    try {
      const [pda] = await findPlatformPda();
      const maybe = await withRpcReadRetry((signal) =>
        fetchMaybePlatform(rpc, pda, { commitment: "confirmed", abortSignal: signal }),
      );
      return maybe.exists ? maybe.data.pauseFlags : null;
    } catch {
      return null;
    }
  }

  async function apply(reason: string) {
    if (!pending || !wallet || !conn.wallet || confirming) return;
    const { title } = pending;
    const { setMask, clearMask } =
      pending.action === "bootstrap"
        ? CLOSE_BOOTSTRAP_MASKS
        : pauseMasks(pending.action, pending.bits);
    const actor = wallet.toString();
    // The panel's cached view: another Admin may have moved the flags since.
    const audit = (
      status: AuditStatus,
      sig: string | null,
      detail: { observed?: number | null; error?: string; confirmation?: SignatureOutcome } = {},
    ) =>
      recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: actor,
        reason,
        target_label: title,
        tx_signature: sig || undefined,
        status,
        metadata: {
          ...pauseAuditMetadata(setMask, clearMask, flags, detail.observed),
          ...(detail.error === undefined ? {} : { error: detail.error }),
          ...(detail.confirmation === undefined ? {} : { confirmation: detail.confirmation }),
        },
      });

    // 1. The wallet signs and the network takes the transaction. A refusal
    //    here (the wallet, the pre-sign gate, the preflight) has no signature.
    let pendingId = toast.showPending(`${title}…`, reason);
    let sig: string;
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getSetPauseFlagsInstructionAsync({
        authority: signer,
        setMask,
        clearMask,
      });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      sig = typeof result === "string" ? result : "";
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError(`${title} failed`, detail);
      void audit("failed", null, { error: detail });
      return;
    }

    // 2. Only the network's confirmation makes it done: the success toast,
    //    the audit row's observed_after and the page's refresh wait for it
    //    (settlePauseFlagsSend above). The modal closes at submission; the
    //    buttons stay held until the outcome.
    setConfirming(true);
    setPending(null);
    toast.dismiss(pendingId);
    pendingId = toast.showPending(`${title}: waiting for the network to confirm…`, reason);
    try {
      await settlePauseFlagsSend({
        wait: () =>
          sig
            ? waitForSignature(rpc, sig, { timeoutMs: PAUSE_CONFIRM_TIMEOUT_MS, retryReads: true })
            : Promise.resolve<SignatureOutcome>("unknown"),
        observe: observedFlags,
        audit: (status, detail) => audit(status, sig, detail),
        confirmed: () => {
          toast.dismiss(pendingId);
          toast.showTx(sig, { title, description: "Confirmed on the network." });
        },
        failed: () => {
          toast.dismiss(pendingId);
          toast.show({
            kind: "error",
            title: `${title} failed on the network`,
            description:
              "Your wallet signed it, but the network refused it. The pause flags are unchanged; open the explorer link for details.",
            signature: sig,
          });
        },
        unconfirmed: () => {
          toast.dismiss(pendingId);
          toast.show({
            kind: "error",
            title: "Not confirmed yet",
            description: `${title} was sent, but the network has not confirmed it. Check the explorer link and the flags below (read again now) before acting again.`,
            signature: sig || undefined,
          });
        },
        // The pre-sign pause gate (lib/pause-gate.ts) re-reads on the next send.
        clearCache: clearPauseFlagsCache,
        refresh: onChanged,
        refreshFailed: () =>
          void toast.show({
            kind: "info",
            title: "Sent; could not re-read the flags",
            description: `${title} stands as reported. The flags shown may be out of date: refresh the page.`,
          }),
      });
    } finally {
      setConfirming(false);
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
                    disabled={busy}
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
                    disabled={busy}
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

      {confirming && (
        <p className="mt-2 text-xs text-slate-500" role="status">
          Waiting for the network to confirm the last change; the flags above are read again once it has.
        </p>
      )}

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
              <ResumeDescription bits={pending.bits} flags={flags} />
            )
          }
          busy={busy}
        />
      )}
    </div>
  );
}
