"use client";

// Data protection (GDPR) actions on /admin/clients/[id]:
//   * Export data — any admin; JSON bundle of what is stored about the client
//     (/api/clients/export, fresh wallet signature, logged server-side).
//   * Anonymize   — Super Admin only; typed confirmation + reason
//     (/api/clients/anonymize). Not reversible.

import { useState } from "react";
import type { WalletSession } from "@solana/client";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { adminAnonymizeClient, adminExportClient } from "@/lib/clients";
import { anonymizeConfirmationPhrase, type ErasurePassportCheck } from "@/lib/client-privacy";

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ClientPrivacyPanel({
  session,
  clientId,
  anonymizedAt,
  passportCheck,
  onChanged,
}: {
  session: WalletSession | null | undefined;
  clientId: string;
  anonymizedAt: string | null | undefined;
  /**
   * On-chain passport state of the client's wallet (erasurePassportCheck).
   * Anonymize is offered only on "none"; the server checks again.
   */
  passportCheck: ErasurePassportCheck;
  onChanged: () => Promise<void> | void;
}) {
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    try {
      const bundle = await adminExportClient(session, clientId);
      const day = new Date().toISOString().slice(0, 10);
      downloadJson(`client-${clientId.slice(0, 8)}-data-export-${day}.json`, bundle);
      const minutes = Math.round(Number(bundle.document_links_expire_in_seconds ?? 600) / 60);
      toast.show({
        kind: "success",
        title: "Data export downloaded",
        description: `Document links in the file stop working after ${minutes} minutes — download the files now. The export is recorded in the audit log.`,
      });
      await onChanged();
    } catch (err) {
      toast.showError("Export failed", err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Data protection (GDPR)
      </p>
      {anonymizedAt && (
        <p className="mt-3 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Personal data erased on {new Date(anonymizedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.
          Ledger records (Terms acceptances, requests, audit log) were kept.
        </p>
      )}
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        Export gives the client a copy of what is stored about them (access /
        portability). Anonymize erases their personal data: identity documents
        and their files, verification details, note texts and contact fields.
        Every export and erasure is recorded in the audit log.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void exportData()}
          disabled={exporting}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {exporting ? "Preparing export…" : "Export data"}
        </button>
        {isSuperAdmin && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={passportCheck !== "none"}
            title={passportCheck === "live" ? "Revoke the on-chain passport first" : undefined}
            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
          >
            {anonymizedAt ? "Erase again" : "Anonymize"}
          </button>
        )}
      </div>
      {isSuperAdmin && passportCheck === "live" && (
        <p className="mt-2 text-xs text-amber-700">
          This client holds a live on-chain passport. Revoke it before erasing
          the dossier — the passport cannot be erased from the chain and would
          keep vouching for an identity the platform no longer holds.
        </p>
      )}
      {isSuperAdmin && passportCheck === "loading" && (
        <p className="mt-2 text-xs text-slate-500">Checking the on-chain passport…</p>
      )}
      {isSuperAdmin && passportCheck === "unknown" && (
        <p className="mt-2 text-xs text-amber-700">
          The on-chain passport could not be checked (network error, or several
          KYC registries exist). Anonymize stays off until the check succeeds —
          reload the page.
        </p>
      )}
      {!isSuperAdmin && (
        <p className="mt-2 text-xs text-slate-500">Only the Super Admin can anonymize a client.</p>
      )}
      {open && (
        <AnonymizeModal
          clientId={clientId}
          onClose={() => setOpen(false)}
          onConfirm={async (confirm, reason) => {
            const result = await adminAnonymizeClient(session, clientId, confirm, reason);
            setOpen(false);
            const issues: string[] = [];
            const notes: string[] = [];
            if (result.legacy_files_deleted > 0) {
              notes.push(`${result.legacy_files_deleted} of the files were in the old public bucket.`);
            }
            if (result.files_missing > 0) {
              notes.push(`${result.files_missing} document file(s) were already gone from storage.`);
            }
            if (result.files_shared > 0) {
              notes.push(`${result.files_shared} file(s) were kept because another dossier uses them.`);
            }
            if (result.files_for_review.length > 0) {
              issues.push(
                `Not deleted, check by hand (public document-repository folders): ${result.files_for_review.join(", ")}.`,
              );
            }
            if (result.files_left > 0 || !result.late_sweep_complete) {
              issues.push("Files uploaded during the erasure could not all be checked or deleted — run it again.");
            }
            if (!result.audit_complete) {
              issues.push("The completion audit row could not be written (the start row exists).");
            }
            toast.show({
              kind: issues.length > 0 ? "error" : "success",
              title: "Client anonymized",
              description: [
                `${result.counts.documents} document(s), ${result.files_deleted} file(s), ${result.counts.verification_details} verification record(s) erased.`,
                ...notes,
                ...issues,
              ].join(" "),
              duration: issues.length > 0 ? 0 : undefined,
            });
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

function AnonymizeModal({
  clientId,
  onClose,
  onConfirm,
}: {
  clientId: string;
  onClose: () => void;
  onConfirm: (confirm: string, reason: string) => Promise<void>;
}) {
  const toast = useToast();
  const phrase = anonymizeConfirmationPhrase(clientId);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = typed.trim() === phrase && reason.trim().length >= 4 && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    try {
      await onConfirm(typed.trim(), reason.trim());
    } catch (err) {
      toast.showError("Anonymization failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="anonymize-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-red-200 bg-red-50 px-5 py-4">
          <p id="anonymize-title" className="text-sm font-semibold uppercase tracking-wide text-red-900">
            Anonymize client — cannot be undone
          </p>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm leading-relaxed text-slate-700">
          <p>
            <strong>Erased:</strong> identity documents and their stored files
            (also old copies in the public bucket), KYC/KYB verification
            details, the text of all notes, requirement notes and custom
            requirement labels, passport-request notes, and the name, email,
            company, country, tags and provider reference on the dossier. The
            KYC verdict ends (a suspension or rejection is kept).
          </p>
          <p>
            <strong>Kept:</strong> the dossier row and its dates, the wallet,
            Terms acceptances (detached from the dossier), conversion and
            delivery requests, SPVs and vesting series, compliance alerts, the
            audit log and everything on-chain. The on-chain passport must be
            revoked before this runs.
          </p>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            Anti-money-laundering and other record-keeping rules can require
            keeping identity documents for years after the relationship ends.
            Erase only when that period is over or compliance has confirmed no
            retention duty applies. Export the data first if the client asked
            for a copy.
          </p>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Type <span className="font-mono normal-case text-slate-800">{phrase}</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Reason (audit log)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={busy}
              placeholder="e.g. Erasure request received 2026-09-20; retention period ended."
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </label>
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
            disabled={!ready}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Erasing…" : "Anonymize"}
          </button>
        </div>
      </div>
    </div>
  );
}
