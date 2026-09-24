"use client";

// Authority setup (Talas 3.1 K2 / K3). A dedicated bootstrap page, no longer
// the whole platform console: the program's upgrade authority initializes
// the platform and the blocklist authority on a fresh deployment ("self, then
// rotate"; devnet / testnet / localnet only) and proposes the permanent keys.
// Neither the upgrade authority nor a successor needs an Admin record here,
// so this page has no admin gate; every action verifies its own chain proof
// and the program enforces it. Successors accept at /account/roles. Mainnet
// bootstrap runs only through the 3.3 CLI.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { ACCOUNT_ROLES_PATH } from "@/components/require-role";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";
import { MAINNET_BOOTSTRAP_REFUSAL } from "@/lib/program-bootstrap";
import { AuthorityRotation } from "@/app/admin/platform/authority-rotation";
import { BlocklistBootstrap } from "@/app/admin/platform/blocklist-bootstrap";
import { PlatformInitCard } from "@/app/admin/platform/platform-init-card";

export default function AuthoritySetupPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const network = detectNetwork();
  const [platformPda, setPlatformPda] = useState("");
  /** undefined = loading, null = read failed. */
  const [platformExists, setPlatformExists] = useState<boolean | null | undefined>(undefined);
  const [platformSuccessor, setPlatformSuccessor] = useState<string | null>(null);
  const [blocklistSuccessor, setBlocklistSuccessor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pda] = await findPlatformPda();
      setPlatformPda(pda);
      const platform = await fetchMaybePlatform(client.runtime.rpc, pda, { commitment: "confirmed" });
      setPlatformExists(platform.exists && platform.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS);
    } catch {
      setPlatformExists(null);
    }
  }, [client]);

  useEffect(() => {
    // Read the live platform account after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <div>
        <p className="page-eyebrow">Deployment</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Authority setup and acceptance</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          On a fresh deployment the program&apos;s upgrade authority initializes
          the platform and the blocklist authority, becoming both roles
          itself, then proposes the permanent keys. Each permanent key accepts
          with its own signature at{" "}
          <Link href={ACCOUNT_ROLES_PATH} className="font-medium text-brand-700 underline-offset-2 hover:underline">
            {ACCOUNT_ROLES_PATH}
          </Link>
          , which proves it is controlled. The current authority proposes a
          replacement below at any time.
        </p>
        {network === "mainnet" && (
          <p className="mt-2 text-[13px] text-amber-800">
            {MAINNET_BOOTSTRAP_REFUSAL}. Rotations of the live authorities
            still work here.
          </p>
        )}
      </div>

      {!conn.isReady ? (
        <p className="text-sm text-slate-500">Loading wallet…</p>
      ) : !conn.connected || !conn.wallet ? (
        <WalletRequired />
      ) : (
        <>
          {platformExists === undefined && <p className="text-sm text-slate-500">Loading platform…</p>}
          {platformExists === null && (
            <p className="text-sm text-amber-800">
              Could not read the platform account. Retry after RPC recovery.{" "}
              <button type="button" onClick={() => void refresh()} className="underline">
                Retry
              </button>
            </p>
          )}
          {platformExists === false && (
            <PlatformInitCard
              platformPda={platformPda}
              onInitialized={async ({ permanentSuperAdmin }) => {
                setPlatformSuccessor(permanentSuperAdmin);
                await refresh();
              }}
            />
          )}
          <BlocklistBootstrap hideWhenInitialized onInitialized={setBlocklistSuccessor} />
          <AuthorityRotation
            key={`platform:${platformSuccessor ?? ""}`}
            kind="platform"
            initialNext={platformSuccessor ?? undefined}
          />
          <AuthorityRotation
            key={`blocklist:${blocklistSuccessor ?? ""}`}
            kind="blocklist"
            initialNext={blocklistSuccessor ?? undefined}
          />
          <p className="text-[12.5px] text-slate-600">
            Proposed a role to this wallet? Accept it at{" "}
            <Link href={ACCOUNT_ROLES_PATH} className="font-medium text-brand-700 underline-offset-2 hover:underline">
              {ACCOUNT_ROLES_PATH}
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}
