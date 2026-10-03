"use client";

// Mint into the ISSUER TREASURY from /admin/share-classes. The reservation,
// the transaction, the confirmation wait, the audit row and the release on
// failure are lib/treasury-mint (runTreasuryMint), the one copy "Send to
// wallets" also runs; this panel only asks for the units, the EUR value and
// the reason. The success toast and the page's refresh wait for the
// network's confirmation (tx.send returns on submission).

import { type ReactNode, useState } from "react";
import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { type ShareClass } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { runTreasuryMint, TREASURY_MINT_REASON_MIN } from "@/lib/treasury-mint";

export type TreasuryMintPanelProps = {
  sc: ShareClass;
  scPda: Address | null;
  issuerPda: Address | null;
  /** The connected wallet is this asset's issuer authority (the treasury). */
  isIssuerAuthority: boolean;
  onRefresh: () => Promise<void>;
  /** Prefills the units field (e.g. the rest of a capped supply). */
  defaultUnits?: string;
  /** Extra buttons on the same row (e.g. Lock supply); `busy` while a mint is sending. */
  children?: (busy: boolean) => ReactNode;
};

export function TreasuryMintPanel({
  sc,
  scPda,
  issuerPda,
  isIssuerAuthority,
  onRefresh,
  defaultUnits,
  children,
}: TreasuryMintPanelProps) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [mintAmount, setMintAmount] = useState(defaultUnits ?? "");
  // Declared EUR value of a treasury mint (counted against the raise limit).
  const [mintEur, setMintEur] = useState("");
  const [confirmMint, setConfirmMint] = useState(false);
  /** Between the wallet's signature and the network's answer: no second mint. */
  const [confirming, setConfirming] = useState(false);

  // Mints into the ISSUER TREASURY — the token account owned by the signing
  // issuer authority (the connected wallet). That is the only destination the
  // program accepts from this screen; see the destination-binding note on
  // /admin/share-classes.
  async function mintToTreasury(reason: string) {
    if (!wallet || !conn.wallet || !issuerPda || !scPda || !mintAmount.trim())
      return;
    if (!isIssuerAuthority || confirming) return;
    const amount = BigInt(mintAmount);
    const eurValue = Number(mintEur.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(eurValue) || eurValue <= 0) {
      toast.showError("EUR value required", "Enter the EUR value this mint counts against the raise limit.");
      return;
    }
    let pendingId = toast.showPending(`Minting ${amount} units to the issuer treasury…`);
    try {
      const result = await runTreasuryMint({
        session: conn.wallet,
        rpc: client.runtime.rpc,
        send: (request) => tx.send(request),
        sc,
        scPda,
        issuerPda,
        amount,
        amountEur: eurValue,
        reason,
        repause: false,
        onStage: (stage) => {
          if (stage !== "confirm") return;
          setConfirming(true);
          setConfirmMint(false);
          toast.dismiss(pendingId);
          pendingId = toast.showPending(`Confirming the mint of ${amount} units on the network…`);
        },
      });
      toast.dismiss(pendingId);
      // Only the network's confirmation makes it "minted"; the refresh reads it after.
      if (result.outcome === "confirmed") {
        toast.showTx(result.signature, { title: "Minted to treasury" });
        setMintAmount("");
        setMintEur("");
      } else if (result.outcome === "failed") {
        toast.show({
          kind: "error",
          title: "The mint failed on the network",
          description: "Your wallet sent it, but the network refused it. Nothing was minted; the reservation is released by the server.",
          signature: result.signature,
        });
      } else {
        toast.show({
          kind: "error",
          title: "Mint not confirmed yet",
          description: "The network has not confirmed the mint yet. Check the explorer link before minting again.",
          signature: result.signature,
        });
      }
      await onRefresh().catch(() => undefined);
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to mint", explainSendError(err instanceof Error && err.cause ? err.cause : err));
    } finally {
      setConfirming(false);
    }
  }

  const busy = tx.isSending || confirming;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={mintAmount}
          inputMode="numeric"
          onChange={(e) =>
            setMintAmount(e.target.value.replace(/\D/g, ""))
          }
          placeholder="Units to mint to treasury"
          className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
        <input
          value={mintEur}
          inputMode="decimal"
          onChange={(e) => setMintEur(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="EUR value (raise limit)"
          aria-label="Declared EUR value of the minted units"
          className="w-48 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
        <button
          type="button"
          disabled={
            busy ||
            !mintAmount.trim() ||
            !(Number(mintEur) > 0) ||
            !isIssuerAuthority
          }
          onClick={() => setConfirmMint(true)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          {confirming ? "Confirming…" : "Mint to treasury"}
        </button>
        {children?.(busy)}
      </div>

      <ConfirmModal
        open={confirmMint}
        onClose={() => setConfirmMint(false)}
        onConfirm={(reason) => mintToTreasury(reason)}
        // The raise-limit ledger needs 5-1000 characters (treasury-mint route).
        reasonMinLength={TREASURY_MINT_REASON_MIN}
        title="Mint to treasury"
        kind="info"
        confirmLabel="Mint"
        description={
          <>
            <p>
              Mint <strong>{mintAmount || "0"}</strong> units into the issuer
              treasury —{" "}
              <code className="break-all rounded bg-slate-100 px-1 font-mono text-xs">
                {wallet ? wallet.toString() : ""}
              </code>
              .
            </p>
            <p className="mt-2 text-xs text-slate-600">
              Units stay in the treasury until they are sold through an
              approved sale or transferred out under the transfer hook.
            </p>
            <p className="mt-2 text-xs text-slate-600">
              The mint counts <strong>€{mintEur || "0"}</strong> against the
              issuer&apos;s rolling 12-month raise limit: reserved before it is
              sent, booked once it finalizes.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log and the raise-limit ledger.
            </p>
          </>
        }
        busy={busy}
      />
    </>
  );
}
