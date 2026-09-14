"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useBalance, useWalletConnection } from "@solana/react-hooks";
import { WALLET_CONNECT_LABEL } from "@/lib/wallet-copy";

const PILL =
  "rounded-full border px-3 py-1.5 text-xs font-mono transition-colors";

function truncate(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const conn = useWalletConnection();
  const balance = useBalance(conn.wallet?.account.address);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!pickerOpen) return;
    const firstOption = panelRef.current?.querySelector<HTMLButtonElement>("button");
    (firstOption ?? panelRef.current)?.focus();
    function onOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setPickerOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPickerOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  if (conn.connected && conn.wallet) {
    const address = conn.wallet.account.address.toString();
    const sol = balance.lamports != null ? (Number(balance.lamports) / 1e9).toFixed(3) : "…";
    return (
      <span className="flex items-center gap-2">
        <span className={`${PILL} border-slate-300 text-slate-700`}>
          {truncate(address)} · {sol} SOL
        </span>
        <button type="button" onClick={() => void conn.disconnect()}
          className={`${PILL} border-slate-300 text-slate-600 hover:border-slate-400 hover:text-slate-800`}>
          Disconnect
        </button>
      </span>
    );
  }

  const connect = (id: string) => {
    setPickerOpen(false);
    setConnectionError(false);
    buttonRef.current?.focus();
    conn.connect(id).catch(() => {
      setConnectionError(true);
      setPickerOpen(true);
    });
  };

  return (
    <div ref={ref} className="wallet-control relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        disabled={!conn.isReady || conn.connecting}
        aria-busy={!conn.isReady || conn.connecting}
        aria-expanded={pickerOpen}
        aria-controls={pickerOpen ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => {
          if (conn.connectors.length === 1) connect(conn.connectors[0].id);
          else {
            setConnectionError(false);
            setPickerOpen((open) => !open);
          }
        }}
        className={`wallet-control-button ${PILL} border-slate-300/60 text-slate-900 hover:border-slate-400 disabled:opacity-50`}
      >
        {conn.connecting ? "Connecting…" : WALLET_CONNECT_LABEL}
      </button>
      {pickerOpen && (
        <div id={panelId} ref={panelRef} role="dialog" aria-label={WALLET_CONNECT_LABEL}
          tabIndex={-1} className="wallet-control-panel">
          {connectionError && (
            <p role="alert" className="wallet-control-message">
              Connection was cancelled or could not be completed. Try again in your wallet.
            </p>
          )}
          {conn.connectors.length === 0 ? (
            <p className="wallet-control-message">
              No Solana wallet detected. Enable a Solana wallet extension or open this app in your wallet&apos;s browser, then reload.
            </p>
          ) : conn.connectors.map((connector) => (
            <button key={connector.id} type="button" className="wallet-control-option"
              disabled={conn.connecting} onClick={() => connect(connector.id)}>
              {connector.name}
            </button>
          ))}
          <button type="button" className="wallet-control-option" onClick={() => {
            setPickerOpen(false);
            buttonRef.current?.focus();
          }}>Close</button>
        </div>
      )}
    </div>
  );
}
