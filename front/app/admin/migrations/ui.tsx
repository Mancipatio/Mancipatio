"use client";

// Small presentational pieces the token migration admin screens share.
import type { ReactNode } from "react";
import { detectNetwork, explorerAddressUrl, explorerTxUrl } from "@/lib/network";

export const inputClass = "mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-400 focus:outline-none";
export const primaryButton = "min-h-9 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
export const secondaryButton = "min-h-9 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50";
export const dangerButton = "min-h-9 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50";

export function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium text-slate-700">
      {label}
      {children}
      {hint && <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">{hint}</span>}
    </label>
  );
}

export function Notes({ tone, items }: { tone: "warn" | "bad" | "info"; items: readonly string[] }) {
  if (items.length === 0) return null;
  const style = tone === "bad" ? "border-red-200 bg-red-50 text-red-800" : tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <ul role={tone === "bad" ? "alert" : "status"} className={`mt-3 space-y-1 rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${style}`}>
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  );
}

export function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function TxLink({ signature, label }: { signature: string; label?: string }) {
  return (
    <a href={explorerTxUrl(signature, detectNetwork())} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 underline underline-offset-2">
      {label ?? short(signature)}
    </a>
  );
}

export function AddressLink({ address }: { address: string }) {
  return (
    <a href={explorerAddressUrl(address, detectNetwork())} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 underline underline-offset-2">
      {short(address)}
    </a>
  );
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function utcText(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}
