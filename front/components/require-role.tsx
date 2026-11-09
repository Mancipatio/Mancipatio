"use client";

import Link from "next/link";
import { type Address } from "@solana/kit";
import { useSolanaClient } from "@solana/react-hooks";
import { useEffect, useState, type ReactNode } from "react";
import { WalletRequired } from "@/components/wallet-required";
import { loadPendingAdmin, type PendingAdminRecord } from "@/lib/admin-grants";
import { describeProposalWindow, proposalWindowState } from "@/lib/proposal-window";
import { useChainClock } from "@/lib/use-chain-clock";
import { SkeletonCard } from "@/components/skeleton";
import { useRole, type Role, type RoleState } from "@/lib/auth";
import { CAPABILITY_LABEL } from "@/lib/role-resolution";
import {
  gateOutcome,
  holdsOperatorRole,
  requirementKey,
  type GateDecision,
  type RequiredRole,
  type RoleRequirement as Requirement,
} from "@/lib/role-state";

/** Where a wallet accepts a proposed role or proposes a successor (Talas 3.1 §4). */
export const ACCOUNT_ROLES_PATH = "/account/roles";

/** The bootstrap page of a fresh deployment (platform / blocklist init, K2/K3). */
export const AUTHORITY_SETUP_PATH = "/issuer/authority";

/**
 * Client-side gate. A hint only: every privileged builder and server route
 * re-checks on-chain state. Stays closed while loading and on a role-read
 * error (never falls back to "public"). Right after a role change
 * (invalidateRoles) it keeps its previous decision until the re-read lands,
 * so the gated page is not unmounted and keeps its local state; the stale
 * roles never make a new decision (lib/role-state gateOutcome).
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
  const [last, setLast] = useState<GateDecision | null>(null);

  const outcome = gateOutcome(state, requirement, last);
  // Remember each decision made on a fresh read (adjusting state while
  // rendering: React re-renders this component before committing).
  if ((outcome === "allowed" || outcome === "denied") && !state.stale && state.walletAddress) {
    const req = requirementKey(requirement);
    if (last?.wallet !== state.walletAddress || last.requirement !== req || last.outcome !== outcome) {
      setLast({ wallet: state.walletAddress, requirement: req, outcome });
    }
  }

  switch (outcome) {
    case "loading":
      return <SkeletonCard rows={3} className="max-w-md" />;
    case "disconnected":
      return fallback ?? <WalletRequired />;
    case "error":
      return fallback ?? <RoleReadError message={state.error ?? ""} onRetry={state.refresh} />;
    case "denied":
      return fallback ?? <NotAuthorized requirement={requirement} state={state} />;
    case "allowed":
      return <>{children}</>;
  }
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

/** The gate opens for an Admin (an Admin grant would open it). */
function wantsAdmin(requirement: Requirement): boolean {
  return requirement.anyOf ? requirement.anyOf.includes("admin") : requirement.role === "admin";
}

/**
 * A wallet proposed as Admin that is still inside the 48 h wait is not in
 * `state.pending` (counted only once executable), so without this it would
 * see a bare "Access denied": it says when the grant can be accepted.
 */
function ProposedAdminNotice({ wallet }: { wallet: string }) {
  const client = useSolanaClient();
  const now = useChainClock();
  const [grant, setGrant] = useState<PendingAdminRecord | null>(null);
  useEffect(() => {
    let live = true;
    loadPendingAdmin(client.runtime.rpc, wallet as Address)
      .then((g) => {
        if (live) setGrant(g);
      })
      .catch(() => {
        // A hint only: the gate's answer stands either way.
      });
    return () => {
      live = false;
    };
  }, [client, wallet]);
  if (!grant || grant.stale) return null;
  const windowState = proposalWindowState(grant, now, { pauseFlags: grant.platformPauseFlags, bootstrapWaived: true });
  if (windowState.kind !== "waiting") return null;
  return (
    <p className="mt-3 text-xs text-amber-900">
      The Admin role is proposed for this wallet and is not active yet. {describeProposalWindow(windowState)} Accept
      it then on{" "}
      <Link href={ACCOUNT_ROLES_PATH} className="font-semibold underline">
        {ACCOUNT_ROLES_PATH}
      </Link>{" "}
      with this wallet; until then this page stays closed.
    </p>
  );
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
      {state.pending.length === 0 && state.walletAddress && wantsAdmin(requirement) && (
        <ProposedAdminNotice wallet={state.walletAddress} />
      )}
      {state.pending.length > 0 ? (
        <p className="mt-3 text-xs text-amber-900">
          A role is waiting for this wallet to accept it:{" "}
          <Link href={ACCOUNT_ROLES_PATH} className="font-semibold underline">
            review pending roles
          </Link>
          .
        </p>
      ) : (
        holdsOperatorRole(state) && (
          <p className="mt-3 text-xs text-amber-900">
            This wallet&apos;s on-chain roles, and the successor proposals it
            can make, are on{" "}
            <Link href={ACCOUNT_ROLES_PATH} className="font-semibold underline">
              {ACCOUNT_ROLES_PATH}
            </Link>
            .
          </p>
        )
      )}
      {!state.platformInitialized && (
        <p className="mt-2 text-xs text-amber-900">
          The platform is not initialized on this network. Its program upgrade
          authority sets it up on{" "}
          <Link href={AUTHORITY_SETUP_PATH} className="font-semibold underline">
            {AUTHORITY_SETUP_PATH}
          </Link>
          .
        </p>
      )}
    </div>
  );
}
