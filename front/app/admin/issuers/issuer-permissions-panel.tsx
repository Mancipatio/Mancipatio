"use client";
import { useCallback, useEffect, useState } from "react";
import { type Address } from "@solana/kit";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  fetchMaybeIssuerPermissions,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
} from "@/lib/generated/asset_registry";
import {
  findIssuerPermissionsAddress,
  buildSetIssuerPermissions,
  ISSUER_CAPABILITIES,
} from "@/lib/issuer-permissions";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
export function IssuerPermissionsPanel({
  issuer,
  authority,
  canEdit,
}: {
  issuer: Address;
  authority: Address;
  canEdit: boolean;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const [caps, setCaps] = useState<number | null>(null),
    [next, setNext] = useState(0),
    [error, setError] = useState<string | null>(null),
    [confirm, setConfirm] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const pda = await findIssuerPermissionsAddress(issuer, authority);
      const info = await fetchMaybeIssuerPermissions(client.runtime.rpc, pda, {
        commitment: "finalized",
      });
      if (
        info.exists &&
        (info.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
          info.data.issuer !== issuer ||
          info.data.authority !== authority)
      )
        throw new Error("Invalid permission account");
      const value = info.exists ? info.data.capabilities : 0;
      setCaps(value);
      setNext(value);
      setError(null);
    } catch {
      setError("Could not read issuer permissions");
    }
  }, [client, issuer, authority]);
  useEffect(() => {
    // Read finalized permission state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function save() {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet),
        ix = await buildSetIssuerPermissions(
          client.runtime.rpc,
          issuer,
          signer,
          next,
        );
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, {
        title: next
          ? "Issuer permission update submitted"
          : "Issuer scoped permissions revoked",
      });
      setConfirm(false);
      void refresh();
    } catch (error) {
      toast.showError(
        "Permission update failed",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  return (
    <section className="mt-5 rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <h3 className="text-sm font-semibold text-slate-900">
        Issuer operating permissions
      </h3>
      <p className="mt-2 text-xs text-slate-600">
        Grant only the actions this issuer needs. Each permission applies to
        this issuer and its current authority. A global Admin record still
        grants all three capabilities and must be removed separately to fully
        revoke access.
      </p>
      {error ? (
        <p className="mt-2 text-xs text-amber-800">{error}</p>
      ) : caps === null ? (
        <p className="mt-2 text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-4">
          {Object.entries(ISSUER_CAPABILITIES).map(([label, bit]) => (
            <label
              key={bit}
              className="flex items-center gap-2 text-xs text-slate-700"
            >
              <input
                type="checkbox"
                checked={(next & bit) !== 0}
                disabled={!canEdit || tx.isSending}
                onChange={(e) =>
                  setNext((value) =>
                    e.target.checked ? value | bit : value & ~bit,
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      )}
      {canEdit && (
        <button
          type="button"
          disabled={tx.isSending || caps === null || next === caps}
          onClick={() => setConfirm(true)}
          className="mt-3 rounded-lg border border-brand-300 bg-white px-3 py-2 text-xs font-semibold text-brand-900 disabled:opacity-50"
        >
          Save scoped permissions
        </button>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="ml-3 mt-3 text-xs text-slate-500 underline"
      >
        Refresh
      </button>
      <ConfirmModal
        open={confirm}
        title="Change issuer permissions?"
        description={`Set this issuer's scoped capabilities to ${
          Object.entries(ISSUER_CAPABILITIES)
            .filter(([, bit]) => (next & bit) !== 0)
            .map(([label]) => label)
            .join(", ") || "none"
        }. The issuer's current wallet must still sign every operation.`}
        kind="warning"
        confirmLabel="Save permissions"
        requireReason={false}
        busy={tx.isSending}
        onConfirm={() => void save()}
        onClose={() => setConfirm(false)}
      />
    </section>
  );
}
