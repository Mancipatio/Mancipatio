"use client";
import { useState } from "react";
import { address, isAddress, type Address } from "@solana/kit";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  getSetConvertibleToInstruction,
  fetchMaybeShareClass,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  ISSUER_CAPABILITIES,
  resolveIssuerPermission,
} from "@/lib/issuer-permissions";
import { buildUpdateMintMetadataInstruction } from "@/lib/transaction-builders";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
export function IssuerOperatingActions({
  issuer,
  shareClass,
  sc,
  capabilities,
  onRefresh,
}: {
  issuer: Address;
  shareClass: Address;
  sc: ShareClass;
  capabilities: number;
  onRefresh: () => Promise<void>;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const [uri, setUri] = useState(""),
    [target, setTarget] = useState(""),
    [confirm, setConfirm] = useState<
      "metadata" | "conversion" | "clear" | null
    >(null);
  async function submit() {
    if (!conn.wallet || !confirm) return;
    try {
      const signer = walletSigner(conn.wallet),
        capability =
          confirm === "metadata"
            ? ISSUER_CAPABILITIES.Metadata
            : ISSUER_CAPABILITIES.Conversion;
      const adminRecord = await resolveIssuerPermission(
        client.runtime.rpc,
        issuer,
        signer.address,
        capability,
      );
      let ix;
      if (confirm === "metadata") {
        if (!/^(https:\/\/|ipfs:\/\/|ar:\/\/)/i.test(uri.trim()))
          throw new Error("Use an HTTPS, IPFS or Arweave metadata URI");
        ix = buildUpdateMintMetadataInstruction({
          authority: signer,
          adminRecord,
          issuer,
          asset: sc.asset,
          shareClass,
          mint: sc.mint,
          field: "uri",
          value: uri.trim(),
        });
      } else {
        const targetShareClass =
          confirm === "clear" ? undefined : address(target.trim());
        if (targetShareClass) {
          const info = await fetchMaybeShareClass(
            client.runtime.rpc,
            targetShareClass,
            { commitment: "finalized" },
          );
          if (
            !info.exists ||
            info.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
            info.data.asset !== sc.asset ||
            targetShareClass === shareClass
          )
            throw new Error(
              "Choose a different share class belonging to the same asset",
            );
        }
        ix = getSetConvertibleToInstruction({
          authority: signer,
          adminRecord,
          issuer,
          asset: sc.asset,
          shareClass,
          ...(targetShareClass ? { targetShareClass } : {}),
        });
      }
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, { title: "Issuer update submitted" });
      setConfirm(null);
      await onRefresh();
    } catch (error) {
      toast.showError(
        "Issuer update failed",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  return (
    <div className="mt-5 space-y-4 border-t border-slate-200 pt-4">
      {(capabilities & ISSUER_CAPABILITIES.Metadata) !== 0 &&
        sc.mintInitialized && (
          <div>
            <h3 className="text-sm font-semibold">Metadata URI</h3>
            <p className="mt-1 text-xs text-slate-500">
              Only the URI changes; token name and symbol remain fixed.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="Metadata URI"
                value={uri}
                maxLength={200}
                onChange={(e) => setUri(e.target.value)}
                placeholder="https://… or ipfs://…"
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
              />
              <button
                type="button"
                disabled={tx.isSending || !uri.trim()}
                onClick={() => setConfirm("metadata")}
                className="rounded-lg border border-brand-200 px-3 py-2 text-sm text-brand-900 disabled:opacity-50"
              >
                Update URI
              </button>
            </div>
          </div>
        )}
      {(capabilities & ISSUER_CAPABILITIES.Conversion) !== 0 && (
        <div>
          <h3 className="text-sm font-semibold">Conversion target</h3>
          <p className="mt-1 text-xs text-slate-500">
            Use the address of another share class of this asset. This sets the
            allowed target; holder conversion remains a separate process.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              aria-label="Conversion target share class"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Target share-class address"
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs"
            />
            <button
              type="button"
              disabled={tx.isSending || !isAddress(target.trim())}
              onClick={() => setConfirm("conversion")}
              className="rounded-lg border border-brand-200 px-3 py-2 text-sm text-brand-900 disabled:opacity-50"
            >
              Set target
            </button>
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirm("clear")}
              className="text-xs text-slate-500 underline"
            >
              Clear target
            </button>
          </div>
        </div>
      )}
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "metadata"
            ? "Update metadata URI?"
            : confirm === "clear"
              ? "Clear conversion target?"
              : "Set conversion target?"
        }
        description={
          confirm === "metadata"
            ? uri.trim()
            : confirm === "clear"
              ? "Remove this class's configured conversion target."
              : target.trim()
        }
        requireReason={false}
        kind="warning"
        confirmLabel="Submit update"
        busy={tx.isSending}
        onConfirm={() => void submit()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
