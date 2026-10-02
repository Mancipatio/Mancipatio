"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { MIN_OFFCHAIN_APP_VERSION, type LedgerAccountChoiceRequest, type LedgerAccountOption, type LedgerConfirmInfo } from "@/lib/ledger-usb";
import { ledgerUsbPromptSnapshot, subscribeLedgerUsbPrompt, type LedgerUsbPromptState } from "@/lib/ledger-usb-prompts";

/** The "Ledger (USB)" wallet's dialogs (mounted once in app/providers.tsx):
 * the account picker, "connect your Ledger" and "confirm on your Ledger". */
export function LedgerUsbDialogs() {
  const prompt = useSyncExternalStore(subscribeLedgerUsbPrompt, ledgerUsbPromptSnapshot, () => null);
  if (!prompt) return null;
  if (prompt.kind === "choose") return <AccountPicker key={prompt.request.accounts.map((a) => a.address).join()} prompt={prompt} />;
  if (prompt.kind === "access") return <AccessDialog prompt={prompt} />;
  return <ConfirmNotice info={prompt.info} />;
}

function Modal({ title, children, onCancel, footer }: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  footer: React.ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; }, [onCancel]);
  useEffect(() => {
    (panel.current?.querySelector<HTMLElement>("input, button") ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancel.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm" role="dialog"
      aria-modal="true" aria-labelledby={titleId}>
      <div ref={panel} tabIndex={-1} className="mx-4 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <p id={titleId} className="text-sm font-semibold text-slate-900">{title}</p>
        </div>
        <div className="space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-slate-700">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

const BUTTON = "rounded-md px-3 py-1.5 text-sm disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-slate-900 font-medium text-white hover:bg-slate-800`;
const SECONDARY = `${BUTTON} text-slate-700 hover:bg-slate-200`;

type Shown = "pending" | "confirmed" | "not-confirmed";

function AccountPicker({ prompt }: { prompt: Extract<LedgerUsbPromptState, { kind: "choose" }> }) {
  const { request } = prompt;
  const [selected, setSelected] = useState<LedgerAccountOption | null>(request.remembered ?? null);
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const showing = Object.values(shown).includes("pending");
  const accounts = orderAccounts(request);

  async function showOnDevice(path: string) {
    setShown((s) => ({ ...s, [path]: "pending" }));
    let confirmed = false;
    try {
      confirmed = await request.showOnDevice(path);
    } catch {
      confirmed = false;
    }
    setShown((s) => ({ ...s, [path]: confirmed ? "confirmed" : "not-confirmed" }));
  }

  return (
    <Modal
      title="Choose your Ledger account"
      onCancel={() => { if (!showing) prompt.cancel(); }}
      footer={<>
        <button type="button" className={SECONDARY} disabled={showing} onClick={() => prompt.cancel()}>Cancel</button>
        <button type="button" className={PRIMARY} disabled={!selected || showing} onClick={() => selected && prompt.choose(selected)}>
          Connect
        </button>
      </>}
    >
      <p>
        These are the Solana accounts on this Ledger. Pick the address your wallet app (Phantom, Solflare, Ledger Live)
        shows for this Ledger account. To be sure, click <em>Show on Ledger</em> and compare the address on the device.
      </p>
      <AppStatus request={request} />
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Ledger accounts</legend>
        {accounts.map((option) => {
          const checked = selected?.path === option.path && selected.address === option.address;
          const state = shown[option.path];
          return (
            <div key={option.path}
              className={`flex items-start gap-2 rounded-md border px-3 py-1.5 ${checked ? "border-slate-900 bg-slate-50" : "border-slate-200"}`}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                <input type="radio" name="ledger-account" className="mt-1" checked={checked} disabled={showing}
                  onChange={() => setSelected(option)} />
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-xs text-slate-900">{option.address}</span>
                  <span className="block text-[11px] text-slate-500">
                    {option.path}
                    {option === request.remembered && " · last used"}
                    {state === "pending" && <span className="text-slate-700"> · approve on the Ledger if it shows this address…</span>}
                    {state === "confirmed" && <span className="text-emerald-700"> · confirmed on the Ledger</span>}
                    {state === "not-confirmed" && <span className="text-amber-700"> · not confirmed on the Ledger</span>}
                  </span>
                </span>
              </label>
              <button type="button" className="shrink-0 pt-0.5 text-[11px] underline decoration-dotted hover:text-slate-900 disabled:opacity-50"
                disabled={showing} onClick={() => void showOnDevice(option.path)}>
                Show on Ledger
              </button>
            </div>
          );
        })}
      </fieldset>
      <p className="text-xs text-slate-500">
        Not listed? The list covers the first five accounts as Phantom, Solflare and Ledger Live derive them; an
        address from another account number or a passphrase needs that setup on the Ledger.
      </p>
    </Modal>
  );
}

/** The remembered account first, then the others in path order. */
function orderAccounts(request: LedgerAccountChoiceRequest): LedgerAccountOption[] {
  const seen = new Set<string>();
  const ordered = request.remembered ? [request.remembered, ...request.accounts] : [...request.accounts];
  return ordered.filter((option) => {
    if (seen.has(option.path)) return false;
    seen.add(option.path);
    return true;
  });
}

function AppStatus({ request }: { request: LedgerAccountChoiceRequest }) {
  const { app } = request;
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-slate-500">
        Solana app {app.version} · Blind signing {app.blindSigningEnabled ? "on" : "off"}
      </p>
      {!app.signsMessages && (
        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          This Solana app is too old to sign Manci requests. Update it to the latest version
          ({MIN_OFFCHAIN_APP_VERSION} at the very least) in Ledger Live (My Ledger), then connect again.
        </p>
      )}
      {!app.blindSigningEnabled && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
          Manci transactions need <strong>Blind signing</strong>: on the Ledger, Solana app → Settings → Blind signing →
          Enabled. Signing in works without it.
        </p>
      )}
    </div>
  );
}

function AccessDialog({ prompt }: { prompt: Extract<LedgerUsbPromptState, { kind: "access" }> }) {
  return (
    <Modal
      title="Connect your Ledger"
      onCancel={() => { if (!prompt.pending) prompt.cancel(); }}
      footer={<>
        <button type="button" className={SECONDARY} disabled={prompt.pending} onClick={() => prompt.cancel()}>Cancel</button>
        <button type="button" className={PRIMARY} disabled={prompt.pending} onClick={() => prompt.grant()}>
          {prompt.pending ? "Waiting for the browser…" : "Continue"}
        </button>
      </>}
    >
      <p>
        Plug in the Ledger, unlock it and open the Solana app. Then click <em>Continue</em> and select the Ledger in the
        browser&apos;s list.
      </p>
    </Modal>
  );
}

const MESSAGE_PREVIEW = 220;

function ConfirmNotice({ info }: { info: LedgerConfirmInfo }) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2" role="status" aria-live="polite">
      <div className="pointer-events-auto rounded-lg border border-slate-200 bg-white px-4 py-3 text-slate-900 shadow-card-lg">
        {info.kind === "message" ? (
          <>
            <p className="text-sm font-semibold">Confirm on your Ledger</p>
            <p className="mt-0.5 text-xs text-slate-600">
              The Ledger shows this request as text. Approve only if it starts with mancipatio:v2 and names this site and
              the action you started.
            </p>
            <code className="mt-2 block max-h-28 overflow-hidden break-all rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
              {info.text.length > MESSAGE_PREVIEW ? `${info.text.slice(0, MESSAGE_PREVIEW)}…` : info.text}
            </code>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold">Confirm the transaction on your Ledger</p>
            {info.hash ? (
              <>
                <p className="mt-0.5 text-xs text-slate-600">
                  With blind signing the Ledger shows a message hash. This page sent it this transaction, whose hash is:
                </p>
                <code className="mt-2 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-900">{info.hash}</code>
              </>
            ) : (
              <p className="mt-0.5 text-xs text-slate-600">Review the transaction on the Ledger before you approve it.</p>
            )}
            <p className="mt-2 text-xs text-slate-600">
              A matching hash proves only that this page and the Ledger agree, not what the transaction does. For a role
              or admin step, copy the transaction and check it with <code>npm run ops:inspect-tx</code> from the reviewed
              release on your own computer; approve only if the Ledger shows the hash printed there. Otherwise reject it
              on the Ledger.
            </p>
            <CopyMessage key={info.message} message={info.message} />
          </>
        )}
      </div>
    </div>
  );
}

/** Copies the transaction message (base64) for `npm run ops:inspect-tx`. */
function CopyMessage({ message }: { message: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center gap-2">
        <button type="button" className={SECONDARY} onClick={() => void copy()}>Copy transaction (base64)</button>
        {copied === "copied" && <span className="text-emerald-700">Copied</span>}
        {copied === "failed" && <span className="text-amber-700">The browser refused: copy it from the box below.</span>}
      </div>
      {copied === "failed" && (
        <textarea readOnly rows={3} aria-label="Transaction message (base64)" value={message}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 block w-full resize-none rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-700" />
      )}
    </div>
  );
}
