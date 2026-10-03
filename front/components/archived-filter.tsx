"use client";

// The "Show archived" switch and the "Archived" tag of the admin lists that
// hide archived assets (lib/archive.ts) unless asked: share classes, primary
// sales, rights issuances. /admin/assets and /admin/issuers keep their own.

export function ShowArchivedToggle({
  checked,
  onChange,
  count,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  count: number;
}) {
  return (
    <label
      className="inline-flex items-center gap-1.5 text-xs text-slate-600"
      title="Rows of archived assets (and of assets of an archived issuer) are hidden until shown here"
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Show archived{count ? ` (${count})` : ""}
    </label>
  );
}

export function ArchivedPill() {
  return (
    <span className="ml-2 inline-flex rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 align-middle text-[10px] font-semibold uppercase text-slate-600">
      Archived
    </span>
  );
}
