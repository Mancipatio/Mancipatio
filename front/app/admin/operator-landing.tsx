"use client";

import Link from "next/link";
import { useRole } from "@/lib/auth";
import { ACCOUNT_ROLES_PATH, RoleReadError } from "@/components/require-role";
import { SkeletonCard } from "@/components/skeleton";
import { WalletRequired } from "@/components/wallet-required";
import { adminRouteAllows, CAPABILITY_LABEL, type PendingRoleKind } from "@/lib/role-resolution";

/** Operator pages, each shown only when the admin table opens it for this wallet. */
const OPERATOR_PAGES: { href: string; title: string; body: string }[] = [
  {
    href: "/admin/kyc",
    title: "KYC operations",
    body: "Triage passport requests and issue or revoke on-chain passports.",
  },
  {
    href: "/admin/clients",
    title: "Clients",
    body: "Review client dossiers, documents and KYC verdicts.",
  },
  {
    href: "/admin/blocklist",
    title: "Blocklist",
    body: "Add and remove sanctions blocklist entries.",
  },
  {
    href: "/admin/share-classes",
    title: "Share classes",
    body: "Switch the transfer-hook mode of KYC-gated share classes.",
  },
];

const PENDING_LABEL: Record<PendingRoleKind, string> = {
  platform: "Super Admin",
  blocklist: "Blocklist authority",
  kyc: "KYC provider (registry authority)",
};

/**
 * /admin for a wallet that holds an operator role but no Admin record: what
 * it can do here, its pending roles, and where to hand a role over.
 */
export function OperatorLanding() {
  const state = useRole({ kyc: true });
  if (state.loading) return <SkeletonCard rows={3} className="mt-6 max-w-md" />;
  if (state.role === "disconnected") return <WalletRequired />;
  if (state.error) return <RoleReadError message={state.error} onRetry={state.refresh} />;

  const operatorCaps = (["kycProvider", "blocklistAuthority"] as const).filter((c) =>
    state.capabilities.has(c),
  );
  const pages = OPERATOR_PAGES.filter((p) => adminRouteAllows(p.href, state.capabilities));

  return (
    <div className="mt-6 max-w-2xl space-y-4">
      <div className="panel panel-pad">
        <p className="page-eyebrow">Your on-chain roles</p>
        {operatorCaps.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {operatorCaps.map((c) => (
              <li
                key={c}
                className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-700"
              >
                {CAPABILITY_LABEL[c]}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            This wallet holds no operator role on this network.
          </p>
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed text-slate-600">
          Operator roles open only their own pages. Platform administration
          needs an Admin record.
        </p>
      </div>

      {pages.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {pages.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className="panel panel-pad transition-all hover:-translate-y-0.5 hover:border-brand-200"
            >
              <h3 className="text-[14px] font-semibold text-slate-900">{p.title}</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{p.body}</p>
            </Link>
          ))}
        </div>
      )}

      <div className="panel panel-pad">
        <p className="page-eyebrow">Pending roles</p>
        {state.pending.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {state.pending.map((p) => (
              <li key={`${p.kind}:${p.target}`}>
                {PENDING_LABEL[p.kind]} — proposed by{" "}
                <span className="font-mono text-xs">{p.currentAuthority}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No role is waiting for this wallet.</p>
        )}
        <p className="mt-3 text-[12.5px] text-slate-600">
          <Link href={ACCOUNT_ROLES_PATH} className="font-medium text-brand-700 underline-offset-2 hover:underline">
            Propose a successor or accept a role
          </Link>
        </p>
      </div>
    </div>
  );
}
