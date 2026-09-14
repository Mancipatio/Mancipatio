"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export type ConfirmKind = "destructive" | "warning" | "info";

const KIND_STYLES: Record<ConfirmKind, { accent: string; button: string }> = {
  destructive: {
    accent: "border-red-200 bg-red-50 text-red-900",
    button: "bg-red-600 hover:bg-red-700 text-white",
  },
  warning: {
    accent: "border-amber-200 bg-amber-50 text-amber-900",
    button: "bg-amber-600 hover:bg-amber-700 text-white",
  },
  info: {
    accent: "border-brand-200 bg-brand-50 text-brand-900",
    button: "bg-brand-700 hover:bg-brand-800 text-white",
  },
};

export type ConfirmModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: ConfirmKind;
  requireReason?: boolean;
  reasonPlaceholder?: string;
  reasonMinLength?: number;
  busy?: boolean;
};

export function ConfirmModal(props: ConfirmModalProps) {
  if (!props.open) return null;
  return <ConfirmModalInner {...props} />;
}

function ConfirmModalInner({
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  kind = "destructive",
  requireReason = true,
  reasonPlaceholder = "Why are you doing this? (visible in audit log)",
  reasonMinLength = 4,
  busy = false,
}: ConfirmModalProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const styles = KIND_STYLES[kind];
  const reasonOk = !requireReason || reason.trim().length >= reasonMinLength;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className={`border-b px-5 py-4 ${styles.accent}`}>
          <p id="confirm-title" className="text-sm font-semibold uppercase tracking-wide">
            {title}
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="text-sm leading-relaxed text-slate-700">
            {description}
          </div>
          {requireReason && (
            <div>
              <label
                htmlFor="confirm-reason"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Reason (audit log)
              </label>
              <textarea
                id="confirm-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPlaceholder}
                rows={3}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
                disabled={busy}
                autoFocus
              />
              {!reasonOk && reason.length > 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  At least {reasonMinLength} characters.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(reason.trim())}
            disabled={busy || !reasonOk}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles.button}`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
