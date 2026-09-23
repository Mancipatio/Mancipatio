"use client";

import { useMemo, useState } from "react";
import { COUNTRIES, type Country } from "@/lib/countries";
import { isJurisdictionRepresentable } from "@/lib/passport";

/**
 * Approved / blocked checkbox table over every ISO country, used by the KYC
 * registry create form and by the jurisdiction editor. Toggle semantics
 * (a code is never both) live in lib/kyc-registry-rotation#toggleJurisdiction.
 */
export function JurisdictionSelector({
  approved,
  blocked,
  onToggle,
  disabled = false,
}: {
  approved: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  onToggle: (code: string, target: "approved" | "blocked") => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const countries: Country[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.alpha2.toLowerCase().includes(q) ||
        c.code.includes(q),
    );
  }, [filter]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter countries…"
        aria-label="Filter countries"
        className="mb-3 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
      />
      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="pb-1 pr-3 font-medium">Country</th>
              <th className="pb-1 pr-3 font-medium">Code</th>
              <th className="pb-1 pr-3 font-medium text-center">Approved</th>
              <th className="pb-1 font-medium text-center">Blocked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {countries.map((c) => (
              <tr key={c.code} className="text-slate-700">
                <td className="py-1 pr-3">
                  {c.alpha2} {c.name}
                </td>
                <td className="py-1 pr-3 font-mono">
                  {c.code}
                  {!isJurisdictionRepresentable(parseInt(c.code, 10)) && (
                    <span
                      className="ml-1 text-[10px] font-semibold text-amber-600"
                      title="Code ≥ 1024 — cannot be encoded in the 128-byte on-chain bitmap; the program silently drops it"
                    >
                      ≥1024
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Approve ${c.name}`}
                    disabled={disabled}
                    checked={approved.has(c.code)}
                    onChange={() => onToggle(c.code, "approved")}
                  />
                </td>
                <td className="py-1 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Block ${c.name}`}
                    disabled={disabled}
                    checked={blocked.has(c.code)}
                    onChange={() => onToggle(c.code, "blocked")}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
