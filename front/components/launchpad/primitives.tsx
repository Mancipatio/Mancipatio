"use client";

import type { ReactNode } from "react";

export function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-0.5 mb-10">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className={`h-[3px] flex-1 rounded-full transition-colors ${i <= current ? "bg-brand-500" : "bg-slate-200"}`} />
      ))}
    </div>
  );
}

export function StepIndicator({ steps, current }: { steps: { id: string; label: string }[]; current: number }) {
  return (
    <div className="flex flex-wrap gap-6 mb-3">
      {steps.map((s, i) => (
        <span key={s.id} className={`font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${i === current ? "text-brand-600" : "text-slate-300"}`}>
          {String(i + 1).padStart(2, "0")} {s.label}
        </span>
      ))}
    </div>
  );
}

export function ChipSelect({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o === value;
        return (
          <button key={o} type="button" onClick={() => onChange(o)}
            className={`rounded-full border px-4 py-1.5 text-[13px] transition-colors ${active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function RangeSlider({ value, min, max, step, onChange, format }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="mb-2 text-2xl font-semibold text-foreground">{format(value)}</div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
        style={{ background: `linear-gradient(90deg, var(--brand-300) ${pct}%, var(--color-slate-200) ${pct}%)` }} />
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>{format(min)}</span><span>{format(max)}</span>
      </div>
    </div>
  );
}

export function PayoutBars({ vestingMonths, cliffMonths }: { vestingMonths: number; cliffMonths: number }) {
  const months = Array.from({ length: vestingMonths });
  return (
    <div className="flex items-end gap-0.5">
      {months.map((_, i) => {
        const isCliff = i < cliffMonths;
        return <div key={i} className={`flex-1 rounded-sm ${isCliff ? "h-2 bg-rose-300" : "h-10 bg-gradient-to-t from-brand-400 to-brand-500"}`} title={isCliff ? "cliff" : `M${i + 1}`} />;
      })}
    </div>
  );
}

export function YieldSplit({ labels = ["You (founder)", "Investors", "Platform"] }: { labels?: [string, string, string] | string[] }) {
  const colors = ["bg-brand-800", "bg-brand-500", "bg-brand-200"];
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full">
        {colors.map((c, i) => <div key={i} className={`${c} flex-1`} />)}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-500">
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

export function InfoBox({ tone = "brand", children }: { tone?: "brand" | "good" | "warn"; children: ReactNode }) {
  const cls = tone === "good" ? "border-emerald-200 bg-emerald-50" : tone === "warn" ? "border-amber-200 bg-amber-50" : "border-brand-200 bg-brand-50";
  return <div className={`rounded-xl border ${cls} p-4 text-[13px] leading-relaxed text-slate-600`}>{children}</div>;
}
