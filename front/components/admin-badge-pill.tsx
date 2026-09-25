import type { BadgeView } from "@/lib/admin-badges";

/**
 * The count pill of an admin menu item (and of the collapsed menu toggle).
 * The visible number is aria-hidden; screen readers get the sr-only text
 * inside the link instead ("Clients, 65 waiting") — an aria-label on a plain
 * span is not reliably announced. Amber like the custody "to act" pills;
 * on the active (brand-600) row a solid white pill. Every tone keeps the
 * 10px number at WCAG AA (4.5:1) or better: amber-800 on amber-100, brand-700
 * on white, slate-600 on slate-100 and on brand-100 for the muted ones.
 */
export function AdminBadgePill({ view, active = false }: { view: BadgeView; active?: boolean }) {
  const tone = view.muted
    ? active ? "bg-brand-100 text-slate-600" : "bg-slate-100 text-slate-600"
    : active ? "bg-white text-brand-700" : "bg-amber-100 text-amber-800";
  return (
    <span
      title={view.title}
      data-admin-badge=""
      className={`ml-auto inline-flex min-w-[1.25rem] shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums ${tone}`}
    >
      {view.fresh && (
        <span
          aria-hidden="true"
          data-admin-badge-new=""
          className="h-1.5 w-1.5 rounded-full bg-red-500"
        />
      )}
      <span aria-hidden="true">{view.text}</span>
      <span className="sr-only">, {view.srText}</span>
    </span>
  );
}
