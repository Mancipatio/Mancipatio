"use client";

import { WalletRequired } from "@/components/wallet-required";

import type { ReactNode } from "react";
import { useRole, type Role } from "@/lib/auth";
import { SkeletonCard } from "@/components/skeleton";

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

export function RequireRole({
  role: required,
  children,
  fallback,
  allowBootstrap = false,
}: {
  role: RequiredRole;
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * Allow access (with a banner) when the Platform PDA is not initialized yet —
   * needed so the program upgrade authority can call `initialize_platform`.
   */
  allowBootstrap?: boolean;
}) {
  const { loading, role, platformInitialized } = useRole();

  if (loading) {
    return <SkeletonCard rows={3} className="max-w-md" />;
  }

  // Bootstrap escape hatch: Platform not initialized AND wallet is connected →
  // the user must be allowed through so they can hit Initialize.
  if (
    allowBootstrap &&
    !platformInitialized &&
    role !== "disconnected"
  ) {
    return (
      <>
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-semibold text-amber-900">
            Bootstrap mode — Platform not initialized
          </p>
          <p className="mt-1 text-xs text-amber-800/90">
            The program upgrade authority can call <code className="rounded bg-amber-100 px-1">initialize_platform</code>{" "}
            to establish the initial Super Admin. Later changes require an explicit
            proposal and acceptance by the new authority. This page remains available
            during setup; the program verifies who can initialize it.
          </p>
        </div>
        {children}
      </>
    );
  }

  if (RANK[role] < REQUIRED[required]) {
    return fallback ?? <NotAuthorized required={required} current={role} />;
  }

  return <>{children}</>;
}

function NotAuthorized({
  required,
  current,
}: {
  required: RequiredRole;
  current: Role;
}) {
  if (current === "disconnected") return <WalletRequired />;

  const label: Record<RequiredRole, string> = {
    superAdmin: "Super Admin",
    admin: "Admin",
    issuer: "verified Issuer",
  };
  const currentLabel: Record<Role, string> = {
    disconnected: "no wallet connected",
    public: "Public",
    issuer: "Issuer (unverified)",
    admin: "Admin",
    superAdmin: "Super Admin",
  };
  return (
    <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
      <p className="text-sm font-semibold uppercase tracking-wider text-amber-900">
        Access denied
      </p>
      <p className="mt-2 text-sm text-amber-900">
        This page requires the <strong>{label[required]}</strong> role.
      </p>
      <p className="mt-1 text-xs text-amber-800/80">
        Connected as: {currentLabel[current]}
      </p>
    </div>
  );
}
