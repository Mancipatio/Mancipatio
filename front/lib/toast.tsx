"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { detectNetwork, explorerTxUrl } from "@/lib/network";

export type ToastKind = "success" | "error" | "info" | "pending";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  signature?: string;
  duration?: number;
};

type ToastInput = Omit<Toast, "id">;

type Ctx = {
  toasts: Toast[];
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
  showTx: (
    signature: string,
    opts?: { title?: string; description?: string },
  ) => number;
  showError: (title: string, description?: string) => number;
  showPending: (title: string, description?: string) => number;
};

const ToastContext = createContext<Ctx | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      counter += 1;
      const id = counter;
      const duration = toast.duration ?? (toast.kind === "error" ? 8000 : 5000);
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (toast.kind !== "pending" && duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const showTx = useCallback<Ctx["showTx"]>(
    (signature, opts) =>
      show({
        kind: "success",
        title: opts?.title ?? "Transaction confirmed",
        description: opts?.description,
        signature,
      }),
    [show],
  );

  const showError = useCallback<Ctx["showError"]>(
    (title, description) => show({ kind: "error", title, description }),
    [show],
  );

  const showPending = useCallback<Ctx["showPending"]>(
    (title, description) =>
      show({ kind: "pending", title, description, duration: 0 }),
    [show],
  );

  return (
    <ToastContext.Provider
      value={{ toasts, show, dismiss, showTx, showError, showPending }}
    >
      {children}
      <ToastViewport />
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-red-200 bg-red-50 text-red-900",
  info: "border-brand-200 bg-brand-50 text-brand-900",
  pending: "border-slate-200 bg-white text-slate-900",
};

const KIND_ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
  pending: "…",
};

function ToastViewport() {
  const ctx = useContext(ToastContext);
  const [network] = useState(() => detectNetwork());
  if (!ctx) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {ctx.toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg border px-4 py-3 shadow-card ${KIND_STYLES[t.kind]}`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                t.kind === "pending" ? "animate-pulse" : ""
              }`}
              aria-hidden="true"
            >
              {KIND_ICONS[t.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-xs opacity-80">{t.description}</p>
              )}
              {t.signature && (
                <a
                  href={explorerTxUrl(t.signature, network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block break-all font-mono text-xs underline decoration-dotted underline-offset-2 hover:opacity-100 opacity-80"
                >
                  {t.signature.slice(0, 12)}…{t.signature.slice(-8)} ↗
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => ctx.dismiss(t.id)}
              className="shrink-0 text-xs opacity-50 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function useTxToast() {
  const { show, showError, showPending, dismiss } = useToast();
  return useCallback(
    async <T,>(
      promise: Promise<T>,
      opts: {
        pendingTitle: string;
        successTitle: string;
        getSignature?: (result: T) => string | undefined;
      },
    ): Promise<T> => {
      const pendingId = showPending(opts.pendingTitle);
      try {
        const result = await promise;
        dismiss(pendingId);
        const signature = opts.getSignature?.(result);
        show({
          kind: "success",
          title: opts.successTitle,
          signature,
        });
        return result;
      } catch (err) {
        dismiss(pendingId);
        const message = err instanceof Error ? err.message : String(err);
        showError("Transaction failed", message);
        throw err;
      }
    },
    [show, showError, showPending, dismiss],
  );
}

