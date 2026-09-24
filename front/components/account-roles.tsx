"use client";

// /account/roles (Talas 3.1 §4): the connected wallet's on-chain roles, the
// operational authorities it can hand over, what waits for its acceptance and
// the proposals it made. Every action is gated on on-chain state only and the
// program enforces the same rules.

import Link from "next/link";
import { useWalletConnection } from "@solana/react-hooks";
import { AuthorityRotation } from "@/app/admin/platform/authority-rotation";
import { OpenProposalsPanel, PendingRolesPanel } from "@/components/pending-roles-panel";
import { RoleReadError } from "@/components/require-role";
import { SkeletonCard } from "@/components/skeleton";
import { WalletRequired } from "@/components/wallet-required";
import { useRole } from "@/lib/auth";
import { maintenanceText } from "@/lib/maintenance";
import { useMaintenance } from "@/lib/maintenance-client";
import { CAPABILITY_LABEL, type Capability } from "@/lib/role-resolution";

const ROLE_ORDER: Capability[] = ["superAdmin", "admin", "kycProvider", "blocklistAuthority", "issuer"];

export function AccountRoles() {
  const conn = useWalletConnection();
  const role = useRole({ kyc: true });
  const maintenance = useMaintenance();
  const inMaintenance = maintenance?.enabled === true;

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <div>
        <p className="page-eyebrow">Account</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">On-chain roles</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Roles are read from the chain for the connected wallet. A proposed
          role becomes yours only when this wallet accepts it with its own
          signature. Operator keys must be the primary wallet of their account.
        </p>
      </div>

      {inMaintenance && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="status">
          <p className="font-semibold">Role changes are unavailable during maintenance</p>
          <p className="mt-1 text-xs">
            {maintenanceText(maintenance?.message)} Accepting, proposing and
            cancelling are browser transactions, which maintenance refuses.
            Blocklist and hook changes that cannot wait go through the 3.3 CLI.
          </p>
        </div>
      )}

      {!conn.isReady ? (
        <SkeletonCard rows={3} className="max-w-md" />
      ) : !conn.connected || !conn.wallet ? (
        <WalletRequired />
      ) : role.loading ? (
        <SkeletonCard rows={3} className="max-w-md" />
      ) : role.error ? (
        <RoleReadError message={role.error} onRetry={role.refresh} />
      ) : (
        <>
          <div className="panel panel-pad">
            <p className="page-eyebrow">Your on-chain roles</p>
            {role.capabilities.size > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {ROLE_ORDER.filter((c) => role.capabilities.has(c)).map((c) => (
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
                This wallet holds no on-chain role on this network.
              </p>
            )}
            {role.kycUnavailable && (
              <p className="mt-2 text-xs text-amber-800">{role.kycUnavailable}</p>
            )}
          </div>

          <div className="panel panel-pad">
            <p className="page-eyebrow">Your operational authorities</p>
            {!role.isSuperAdmin && !role.isBlocklistAuthority && !role.isKycProvider ? (
              <p className="mt-2 text-sm text-slate-600">
                This wallet holds no operational authority to hand over.
              </p>
            ) : (
              <p className="mt-2 text-[12.5px] text-slate-600">
                Propose a successor. The current authority stays active until
                the successor accepts with its own signature.
              </p>
            )}
            {role.isKycProvider && (
              <p className="mt-2 text-[12.5px] text-slate-600">
                KYC provider: propose, replace or cancel a successor for the
                registry authority on{" "}
                <Link href="/admin/kyc" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                  /admin/kyc
                </Link>
                .
              </p>
            )}
          </div>
          {role.isSuperAdmin && <AuthorityRotation kind="platform" />}
          {role.isBlocklistAuthority && <AuthorityRotation kind="blocklist" />}

          <PendingRolesPanel maintenance={inMaintenance} />
          <OpenProposalsPanel maintenance={inMaintenance} />
        </>
      )}
    </section>
  );
}
