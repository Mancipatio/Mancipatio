"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { WalletRequired } from "@/components/wallet-required";
import { SkeletonCard } from "@/components/skeleton";
import { useRole, type Role, type RoleState } from "@/lib/auth";
import { CAPABILITY_LABEL, type Capability } from "@/lib/role-resolution";

type RequiredRole = "superAdmin" | "admin" | "issuer";

const RANK: Record<Role, number> = {
  disconnected: -1,
  public: 0,
  issuer: 1,
  admin: 2,
  superAdmin: 3,
};

const REQUIRED: Record<RequiredRole, number> = {
  issuer: 1,
  admin: 2,
  superAdmin: 3,
};

/** Where a wallet accepts a proposed role or proposes a successor (Talas 3.1 §4). */
export const ACCOUNT_ROLES_PATH = "/account/roles";

type Requirement =
  /** Ranking semantics: the role or any higher one. */
  | { role: RequiredRole; anyOf?: never }
  /** Any one of these capabilities (operator roles do not rank). */
  | { role?: never; anyOf: readonly Capability[] };

/**
 * Client-side gate. A hint only: every privileged builder and server route
 * re-checks on-chain state. Stays closed while loading and on a role-read
 * error (never falls back to "public").
 */
export function RequireRole({
  children,
  fallback,
  ...requirement
}: Requirement & {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const anyOf = requirement.anyOf;
  const state = useRole({ kyc: anyOf?.includes("kycProvider") ?? false });

  if (state.loading) {
    return <SkeletonCard rows={3} className="max-w-md" />;
  }
  if (state.role === "disconnected") {
    return fallback ?? <WalletRequired />;
  }
  if (state.error) {
    return fallback ?? <RoleReadError message={state.error} onRetry={state.refresh} />;
  }
  const allowed = anyOf
    ? anyOf.some((c) => state.capabilities.has(c))
    : RANK[state.role] >= REQUIRED[requirement.role];
  if (!allowed) {
    return fallback ?? <NotAuthorized requirement={requirement} state={state} />;
  }
  return <>{children}</>;
}

export function RoleReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-6" role="alert">
      <p className="text-sm font-semibold uppercase tracking-wider text-red-900">
        Could not verify your on-chain roles
      </p>
      <p className="mt-2 text-xs text-red-800/90">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-900 hover:bg-red-100"
      >
        Retry
      </button>
    </div>
  );
}

const ROLE_LABEL: Record<RequiredRole, string> = {
  superAdmin: "Super Admin",
  admin: "Admin",
  issuer: "verified Issuer",
};

const CURRENT_LABEL: Record<Role, string> = {
  disconnected: "no wallet connected",
  public: "Public",
  issuer: "Issuer (unverified)",
  admin: "Admin",
  superAdmin: "Super Admin",
};

/** "Admin", plus any operator roles the wallet holds. */
export function connectedAsLabel(state: RoleState): string {
  const side = [
    state.isKycProvider ? CAPABILITY_LABEL.kycProvider : null,
    state.isBlocklistAuthority ? CAPABILITY_LABEL.blocklistAuthority : null,
  ].filter(Boolean);
  const main = state.role === "issuer" && state.isVerifiedIssuer ? "Issuer" : CURRENT_LABEL[state.role];
  return side.length > 0 && state.role === "public" ? side.join(" · ") : [main, ...side].join(" · ");
}

function NotAuthorized({ requirement, state }: { requirement: Requirement; state: RoleState }) {
  const required = requirement.anyOf
    ? requirement.anyOf.map((c) => CAPABILITY_LABEL[c])
    : [ROLE_LABEL[requirement.role]];
  const kycMatters = requirement.anyOf?.includes("kycProvider") ?? false;
  return (
    <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
      <p className="text-sm font-semibold uppercase tracking-wider text-amber-900">
        Access denied
      </p>
      <p className="mt-2 text-sm text-amber-900">
        {required.length === 1 ? (
          <>
            This page requires the <strong>{required[0]}</strong> role.
          </>
        ) : (
          <>
            This page requires one of these roles:{" "}
            <strong>{required.join(", ")}</strong>.
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-amber-800/80">Connected as: {connectedAsLabel(state)}</p>
      {kycMatters && state.kycUnavailable && (
        <p className="mt-2 text-xs text-amber-800">{state.kycUnavailable}</p>
      )}
      {state.pending.length > 0 && (
        <p className="mt-3 text-xs text-amber-900">
          A role is waiting for this wallet to accept it:{" "}
          <Link href={ACCOUNT_ROLES_PATH} className="font-semibold underline">
            review pending roles
          </Link>
          .
        </p>
      )}
    </div>
  );
}
