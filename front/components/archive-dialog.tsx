"use client";

// Archive / Unarchive an asset or issuer (lib/archive.ts) — the admin lists'
// and the issuer workspace's dialog. It reads the fresh facts first
// (/api/archive/check: Open sales, live approvals, circulating supply, who
// may act), asks for the reason, makes the super admin tick an explicit
// override when something stands in the way (and says what), and — for an
// asset, super admin only — offers the one-way "lock supply at 0" on every
// class with nothing in circulation (A2: lock_supply, admin-signed, each
// transaction simulated before the wallet sees it).

import { useEffect, useState } from "react";
import { address } from "@solana/kit";
import { useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { useLockSupply } from "@/components/lock-supply-button";
import { checkArchive, setArchived, type ArchiveCheck } from "@/lib/archive-client";
import { ARCHIVE_PERMANENCE_NOTE, ARCHIVE_REASON_MIN, type ArchiveKind } from "@/lib/archive";
import { useToast } from "@/lib/toast";

export function ArchiveDialog({
  open,
  onClose,
  kind,
  pda,
  label,
  mode,
  hasAdminRecord = null,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  kind: ArchiveKind;
  pda: string;
  /** What the person sees it as ("Mancipatio 5%", the issuer's legal ID). */
  label: string;
  mode: "archive" | "unarchive";
  /** Whether the connected key holds an Admin record (lock_supply needs one); null = unknown. */
  hasAdminRecord?: boolean | null;
  onDone: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const { lock, busy: locking } = useLockSupply();
  const [check, setCheck] = useState<ArchiveCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [lockAtZero, setLockAtZero] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    // Callers mount the dialog per target (fresh state each time).
    if (!open) return;
    let cancelled = false;
    void checkArchive(conn.wallet, kind, pda)
      .then((value) => { if (!cancelled) setCheck(value); })
      .catch((err) => { if (!cancelled) setCheckError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open, kind, pda, conn.wallet]);

  const blockers = check?.blockers ?? [];
  const needsOverride = mode === "archive" && check?.actor === "super" && kind === "asset" && blockers.length > 0;
  const lockable = mode === "archive" && kind === "asset" && check?.actor === "super" ? check.lockableAtZero ?? [] : [];
  const allowed = mode === "archive" ? !!check?.canArchive : !!check?.canUnarchive;
  const refusal = mode === "archive" ? check?.refusal : check?.unarchiveRefusal ?? check?.refusal;

  async function confirm(reason: string) {
    if (!check || !allowed) return;
    setWorking(true);
    try {
      await setArchived(conn.wallet, { kind, pda, archive: mode === "archive", reason, confirm: needsOverride ? override : undefined });
      toast.show({
        kind: "success",
        title: mode === "archive" ? "Archived" : "Unarchived",
        description: mode === "archive"
          ? `${label} is hidden from the lists. The on-chain record stays.`
          : `${label} is shown again.`,
      });
      if (lockAtZero && lockable.length) {
        let locked = 0;
        for (const c of lockable) {
          const sig = await lock(address(c.address), reason, { atZero: true, context: "archive" });
          if (!sig) break;
          locked += 1;
        }
        if (locked < lockable.length) {
          toast.showError(
            "Archived, but not every class was locked",
            `${locked} of ${lockable.length} class${lockable.length === 1 ? "" : "es"} locked at 0. Lock the rest on Admin → Share classes.`,
          );
        }
      }
      await onDone();
      onClose();
    } catch (err) {
      toast.showError(mode === "archive" ? "Not archived" : "Not unarchived", err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  const noun = kind === "asset" ? "asset" : "issuer";
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      onConfirm={confirm}
      title={`${mode === "archive" ? "Archive" : "Unarchive"} ${noun}`}
      kind={mode === "archive" ? "warning" : "info"}
      confirmLabel={mode === "archive" ? (lockAtZero ? "Archive and lock at 0" : "Archive") : "Unarchive"}
      reasonMinLength={ARCHIVE_REASON_MIN}
      reasonPlaceholder={mode === "archive" ? "Why is it withdrawn? e.g. test asset created with a test legal document" : "Why is it shown again?"}
      busy={working || locking}
      confirmDisabled={!check || !allowed || (needsOverride && !override)}
      description={
        <div className="space-y-3">
          <p>
            <strong>{label}</strong>
            <span className="ml-1 break-all font-mono text-[11px] text-slate-500">{pda}</span>
          </p>
          {mode === "archive" ? (
            <p>
              {kind === "asset"
                ? "Hides the asset from the marketplace, the primary sales list, the issuer workspace, the tokenize flow's Continue list and the admin lists (unless “Show archived”). A direct link shows “This asset was withdrawn”. Holders still see what they hold."
                : "Hides the issuer and every asset of it from the public lists and the admin lists (unless “Show archived”)."}
            </p>
          ) : (
            <p>Shows the {noun} again where it was listed before it was archived.</p>
          )}
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700">{ARCHIVE_PERMANENCE_NOTE}</p>

          {!check && !checkError && <p className="text-xs text-slate-500">Checking the chain…</p>}
          {checkError && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">{checkError}</p>}

          {check?.record && (
            <p className="text-[13px] text-slate-600">
              Archived {new Date(check.record.archived_at).toLocaleString()} by{" "}
              <span className="font-mono text-[11px]">{check.record.archived_by.slice(0, 4)}…{check.record.archived_by.slice(-4)}</span>: “{check.record.reason}”
            </p>
          )}

          {check && !allowed && refusal && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">{refusal}</p>
          )}

          {check && mode === "archive" && blockers.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              <p className="font-medium">Still live on chain:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {blockers.map((b) => <li key={b.code}>{b.message}</li>)}
              </ul>
              {needsOverride && allowed && (
                <label className="mt-2 flex items-start gap-2">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5" />
                  <span>I understand the above and want to archive it anyway (recorded with the archive).</span>
                </label>
              )}
            </div>
          )}

          {check && lockable.length > 0 && allowed && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={lockAtZero}
                  disabled={hasAdminRecord === false}
                  onChange={(e) => setLockAtZero(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>Also lock supply at 0 (one-way)</strong> on class{lockable.length === 1 ? "" : "es"}{" "}
                  {lockable.map((c) => c.classIndex).join(", ")} (nothing in circulation). After it no token of
                  {lockable.length === 1 ? " this class" : " these classes"} can ever be created — not even by the super admin —
                  and Unarchive does not undo it. Your wallet signs one lock_supply per class; each is simulated first.
                </span>
              </label>
              {hasAdminRecord === false && (
                <p className="mt-1 text-xs">This key has no Admin record, and lock_supply needs one.</p>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
