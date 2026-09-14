type SkeletonProps = {
  className?: string;
};

// Loading placeholders shared by every surface. Defaults are the app's
// brand-* language (admin, portfolio, issuer, onboarding); under a
// `[data-mx]` wrapper the globals.css overrides on the skeleton-* hook
// classes retokenise them to the mx paper language, so each skeleton
// matches the card it resolves into without call-site changes.
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <span
      className={`skeleton inline-block animate-pulse rounded-md bg-slate-200/80 ${className}`}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`block h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({
  rows = 4,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={`skeleton-card rounded-xl border border-slate-200 bg-white p-6 shadow-card ${className}`}
    >
      <Skeleton className="block h-5 w-1/3" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex justify-between gap-4">
            <Skeleton className="block h-3 w-1/4" />
            <Skeleton className="block h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({
  rows = 5,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="skeleton-card overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
      <div className="skeleton-head grid border-b border-slate-100 bg-slate-50 px-4 py-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="block h-3 w-2/3" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="skeleton-row grid border-b border-slate-100 px-4 py-3 last:border-0"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={`block h-3 ${c === 0 ? "w-3/4" : "w-1/2"}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
