"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useBalance, useWalletConnection } from "@solana/react-hooks";
import { useRole } from "@/lib/auth";
import { WalletButton } from "@/app/wallet-button";

const PILL = "rounded-full border px-3 py-1.5 text-xs font-mono transition-colors";

function truncate(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function AccountMenu() {
  const conn = useWalletConnection();
  const balance = useBalance(conn.wallet?.account.address);
  const { isAdmin, isIssuer } = useRole();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // All disconnected states use the shared wallet control.
  if (!conn.isReady || !conn.connected || !conn.wallet) {
    return <WalletButton />;
  }

  const address = conn.wallet.account.address.toString();
  const sol =
    balance.lamports != null ? (Number(balance.lamports) / 1e9).toFixed(3) : "…";

  const links: { label: string; href: string }[] = [
    { label: "Your account", href: "/account" },
    { label: "Portfolio", href: "/portfolio" },
  ];
  if (isIssuer) links.push({ label: "Issuer dashboard", href: "/issuer" });
  if (isAdmin) links.push({ label: "Admin", href: "/admin" });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${PILL} border-slate-300 text-slate-700 hover:border-slate-400`}
      >
        {truncate(address)} · {sol} SOL
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="font-mono text-[11px] text-slate-400">Connected</p>
            <p className="font-mono text-xs text-slate-700">{truncate(address)}</p>
          </div>
          <nav className="py-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void conn.disconnect();
            }}
            className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
