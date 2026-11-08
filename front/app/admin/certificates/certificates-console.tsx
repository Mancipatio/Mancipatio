"use client";

// /admin/certificates: the certificates of this network (newest first), the
// selected one with its next step (./certificate-detail.tsx), and the form
// for a new one (./new-certificate-form.tsx). The list carries no personal
// data; the detail of the selected certificate is read on its own (a signed
// session read). Opening the page never prompts: the first load uses an
// existing wallet session, and signing in starts from its button.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { listCertificates, readCertificate } from "@/lib/certificates-client";
import type { CertificateDetail, CertificateListItem } from "@/lib/certificates/payload";
import { WalletSessionRequiredError, type SignedFetchInteractive } from "@/lib/siws-client";
import { detectNetwork } from "@/lib/network";
import { CertificateDetailPanel, CertificateStatusBadge } from "./certificate-detail";
import { NewCertificateForm } from "./new-certificate-form";

type ListState = { state: "loading" } | { state: "signin" } | { state: "error"; text: string } | { state: "ready"; items: CertificateListItem[] };

export function CertificatesConsole() {
  const { wallet } = useWalletConnection();
  if (!wallet) return null;
  // What was loaded belongs to the wallet that loaded it.
  return <WalletCertificatesConsole key={`${detectNetwork()}:${wallet.account.address}`} session={wallet} />;
}

function shortWallet(wallet: string | null): string {
  return wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : "—";
}

function WalletCertificatesConsole({ session }: { session: WalletSession }) {
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [selected, setSelected] = useState<CertificateDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  // The latest detail asked for: an earlier answer arriving late must not
  // replace a newer selection or close the new-certificate form.
  const detailRequest = useRef(0);

  const load = useCallback(
    async (interactive: SignedFetchInteractive) => {
      const request = ++generation.current;
      try {
        const items = await listCertificates(session, interactive);
        if (request === generation.current) setList({ state: "ready", items });
      } catch (err) {
        if (request !== generation.current) return;
        setList(err instanceof WalletSessionRequiredError ? { state: "signin" } : { state: "error", text: err instanceof Error ? err.message : String(err) });
      }
    },
    [session],
  );

  useEffect(() => {
    const request = ++generation.current;
    void listCertificates(session, false).then(
      (items) => {
        if (request === generation.current) setList({ state: "ready", items });
      },
      (err) => {
        if (request !== generation.current) return;
        setList(err instanceof WalletSessionRequiredError ? { state: "signin" } : { state: "error", text: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [session]);

  async function open(item: CertificateListItem) {
    const request = ++detailRequest.current;
    setDetailError(null);
    try {
      const detail = await readCertificate(session, item.id);
      if (request !== detailRequest.current) return;
      setSelected(detail);
      setCreating(false);
    } catch (err) {
      if (request === detailRequest.current) setDetailError(err instanceof Error ? err.message : String(err));
    }
  }

  function changed(detail: CertificateDetail) {
    detailRequest.current += 1;
    setSelected(detail);
    setCreating(false);
    void load(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Certificates of this network, newest first.</p>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={() => void load(true)}>
            Reload
          </button>
          <button
            type="button"
            className="btn-brand"
            onClick={() => {
              detailRequest.current += 1;
              setDetailError(null);
              setCreating(true);
              setSelected(null);
            }}
          >
            New certificate
          </button>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.6fr)]">
        <section aria-label="Certificates" className="panel min-w-0 overflow-hidden">
          {list.state === "loading" && <p role="status" className="p-5 text-sm text-slate-500">Loading certificates…</p>}
          {list.state === "signin" && (
            <div className="p-5 text-sm text-slate-600">
              <p>The list needs a wallet sign-in (one message, no transaction).</p>
              <button type="button" className="btn-brand mt-3" onClick={() => void load("session-only")}>
                Show certificates
              </button>
            </div>
          )}
          {list.state === "error" && (
            <div role="alert" className="p-5 text-sm text-red-800">
              <p>{list.text}</p>
              <button type="button" className="btn-ghost mt-3" onClick={() => void load(true)}>
                Try again
              </button>
            </div>
          )}
          {list.state === "ready" && list.items.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-500">No certificate on this network yet.</p>
          )}
          {list.state === "ready" && list.items.length > 0 && (
            <ul className="max-h-[40rem] divide-y divide-slate-100 overflow-y-auto">
              {list.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={selected?.id === item.id ? "true" : undefined}
                    onClick={() => void open(item)}
                    className={`w-full px-4 py-3 text-left transition-colors ${selected?.id === item.id ? "bg-brand-50" : "hover:bg-slate-50"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-medium text-slate-900">{item.number}</span>
                      <CertificateStatusBadge status={item.status} />
                    </span>
                    <span className="mt-1 block text-xs text-slate-600">{item.asset_label}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {item.kind === "holding" ? `Holding · ${shortWallet(item.holder_wallet)}` : "Issuance"} · {item.issued_at.slice(0, 10)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="min-w-0 space-y-4">
          {detailError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {detailError}
            </p>
          )}
          {creating ? (
            <NewCertificateForm session={session} onCreated={changed} />
          ) : selected ? (
            <CertificateDetailPanel key={selected.id} session={session} detail={selected} onChange={changed} />
          ) : (
            <div className="panel panel-pad text-sm text-slate-500">Select a certificate, or create a new one.</div>
          )}
        </div>
      </div>
    </div>
  );
}
