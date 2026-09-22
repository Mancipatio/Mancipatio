"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useBalance, useWalletConnection } from "@solana/react-hooks";
import { useRole } from "@/lib/auth";
import { WalletButton } from "@/app/wallet-button";
import { IconUsers as IconUser, IconWallet } from "@/components/icons";
import { clearWalletSession } from "@/lib/siws-client";
import { signOutAccount, useSignedInAccount } from "@/lib/account-login";

function truncate(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function AccountMenu() {
  const conn = useWalletConnection();
  const signedIn = useSignedInAccount();
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

  // No wallet: the email/Google account (if signed in), else "Sign in".
  if (!conn.isReady || !conn.connected || !conn.wallet) {
    if (signedIn.status === "signed_in" && signedIn.account) {
      const label = signedIn.account.display_name || signedIn.account.email || "Your account";
      return (
        <div ref={ref} className="relative">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
            className="overview-button overview-button-dark app-wallet-menu">
            <IconUser size={16} />{label.length > 28 ? `${label.slice(0, 26)}…` : label}
            <svg className="app-wallet-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {open && (
            <div role="menu" className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="font-mono text-[11px] text-slate-400">Signed in</p>
                <p className="truncate text-xs text-slate-700">{signedIn.account.email ?? "Manci account"}</p>
              </div>
              <nav className="py-1">
                {[{ label: "Your account", href: "/account" }, { label: "Verification", href: "/verify" }, { label: "Portfolio", href: "/portfolio" }].map((l) => (
                  <Link key={l.href} href={l.href} role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">{l.label}</Link>
                ))}
              </nav>
              <div className="border-t border-slate-100 px-3 py-2"><WalletButton /></div>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); void signOutAccount(); }}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50">Sign out</button>
            </div>
          )}
        </div>
      );
    }
    if (signedIn.status === "signed_out") {
      return <Link href="/login" className="overview-button overview-button-dark app-wallet-menu"><IconUser size={16} />Sign in</Link>;
    }
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
        className="overview-button overview-button-dark app-wallet-menu"
      >
        <IconWallet size={16} />{truncate(address)} · {sol} SOL<svg className="app-wallet-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
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
          {signedIn.status === "signed_in" && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); void signOutAccount(); }}
              className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50">
              Sign out of {signedIn.account?.email ?? "account"}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              clearWalletSession();
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
