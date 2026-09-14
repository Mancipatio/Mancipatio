// Horizontal strip of 3-4 stat blocks with a subtle brand top-line.
// Tabular numerals so values don't jitter when they update.

export type StatItem = { value: string; label: string };

export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-card">
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-0.5"
        style={{
          background:
            "linear-gradient(90deg, var(--brand-400) 0%, var(--brand-600) 100%)",
          opacity: 0.7,
        }}
      />
      <dl className="grid grid-cols-2 divide-x divide-slate-100 sm:grid-cols-4">
        {items.map((s) => (
          <div key={s.label} className="px-5 py-4">
            <dt className="page-eyebrow">{s.label}</dt>
            <dd
              className="mt-1 text-[28px] font-semibold leading-none text-slate-900"
              style={{
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.015em",
              }}
            >
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
