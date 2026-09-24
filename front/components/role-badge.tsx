"use client";

import { useRole, type Role } from "@/lib/auth";

const STYLES: Record<Role, { label: string; classes: string }> = {
  superAdmin: {
    label: "Super Admin",
    classes: "bg-brand-50 text-brand-700 border-brand-200",
  },
  admin: {
    label: "Admin",
    classes: "bg-brand-50 text-brand-700 border-brand-200",
  },
  issuer: {
    label: "Issuer",
    classes: "bg-brand-50 text-brand-700 border-brand-200",
  },
  public: {
    label: "Public",
    classes: "bg-slate-50 text-slate-600 border-slate-200",
  },
  disconnected: {
    label: "Disconnected",
    classes: "bg-slate-50 text-slate-400 border-slate-200",
  },
};

/** Operator roles are not ranked; they are appended to the ranking label. */
function sideRoles(state: { isKycProvider: boolean; isBlocklistAuthority: boolean }): string[] {
  return [
    state.isKycProvider ? "KYC provider" : null,
    state.isBlocklistAuthority ? "Blocklist authority" : null,
  ].filter((s): s is string => s !== null);
}

export function RoleBadge() {
  const state = useRole();
  const { role, loading, isVerifiedIssuer } = state;
  if (loading) {
    return (
      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        …
      </span>
    );
  }
  const s = STYLES[role];
  const side = sideRoles(state);
  // Distinguish a KYB-verified issuer with an emerald variant.
  const main = role === "issuer" && isVerifiedIssuer ? "Issuer · Verified" : s.label;
  const label =
    side.length === 0 ? main : role === "public" ? side.join(" · ") : [main, ...side].join(" · ");
  const classes =
    role === "issuer" && isVerifiedIssuer
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : role === "public" && side.length > 0
        ? STYLES.admin.classes
        : s.classes;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${classes}`}
      title={`Detected role: ${label}`}
    >
      {label}
    </span>
  );
}
