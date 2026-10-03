"use client";

// Mint into the ISSUER TREASURY — moved unchanged from /admin/share-classes so
// the issuer's "Tokenize company shares" checklist mints through the same code
// (one copy of the raise-limit reservation, the destination binding and the
// release on failure).

import { type ReactNode, useState } from "react";
import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  getMintToTreasuryInstructionAsync,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  resolveIssuerPermission,
  ISSUER_CAPABILITIES,
} from "@/lib/issuer-permissions";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import {
  releaseWhenExpired,
  reserveTreasuryMint,
} from "@/lib/sale-approvals";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

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

  // Mints into the ISSUER TREASURY — the token account owned by the signing
  // issuer authority (the connected wallet). That is the only destination the
  // program accepts from this screen; see the destination-binding note on
  // /admin/share-classes.
  //
  // Program package 2B: only an Admin issuer key reaches the treasury, and the
  // mint counts against the issuer's (SPV's) rolling 12-month raise limit:
  // its declared EUR value is reserved first (/api/sale-approvals/treasury-mint)
  // and booked once the transaction finalizes. A failed send releases it.
  async function mintToTreasury(reason: string) {
    if (!wallet || !conn.wallet || !issuerPda || !scPda || !mintAmount.trim())
      return;
    if (!isIssuerAuthority) return;
    const destination = wallet;
    const amount = BigInt(mintAmount);
    const eurValue = Number(mintEur.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(eurValue) || eurValue <= 0) {
      toast.showError("EUR value required", "Enter the EUR value this mint counts against the raise limit.");
      return;
    }
    const pendingId = toast.showPending(
      `Minting ${amount} units to the issuer treasury…`,
    );
    let reservationId: string | null = null;
    let lastValidBlockHeight: bigint | null = null;
    let sent = false;
    try {
      const reserved = await reserveTreasuryMint(conn.wallet, {
        share_class: scPda,
        amount_units: amount.toString(),
        amount_eur: eurValue,
        reason,
      });
      reservationId = reserved.reservation_id;
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const mint = sc.mint;
      const [ata] = await findAssociatedTokenPda({
        owner: destination,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: destination,
          mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      const mintIx = await getMintToTreasuryInstructionAsync({
        authority: signer,
        adminRecord: await resolveIssuerPermission(
          client.runtime.rpc,
          issuerPda,
          signer.address,
          ISSUER_CAPABILITIES.Mint,
        ),
        issuer: issuerPda,
        asset: sc.asset,
        shareClass: scPda,
        destination: ata,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount,
      });
      // A known lifetime: after a failed send the reservation is released
      // only once this blockhash can no longer land (server-proven).
      const lifetime = (await client.runtime.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      lastValidBlockHeight = lifetime.lastValidBlockHeight;
      const sig = await tx.send({
        lifetime,
        prepareTransaction: { blockhashReset: false },
        instructions: [createAtaIx, mintIx],
        feePayer: signer,
      });
      sent = true;
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Minted to treasury" });
      void recordAudit({
        ix_name: "mint_to_treasury",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
        metadata: {
          destination: "issuer_treasury",
          destination_wallet: destination.toString(),
          destination_token_account: ata.toString(),
          amount: amount.toString(),
          amount_eur: eurValue,
          reservation_id: reservationId,
        },
      });
      // The server books it: the alarm worker sees the finalized mint and the
      // retry worker's ledger stage books the reservation at the block date
      // (Talas 5.1). Until then it stays counted at the reserved value.
      setConfirmMint(false);
      setMintAmount("");
      setMintEur("");
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to mint",
        explainSendError(err),
      );
      if (reservationId && !sent && lastValidBlockHeight !== null) {
        // The mint may still land until its blockhash expires; the server
        // releases the reservation only after that (the worker otherwise).
        void releaseWhenExpired(conn.wallet, reservationId, lastValidBlockHeight);
      }
    }
  }

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
            tx.isSending ||
            !mintAmount.trim() ||
            !(Number(mintEur) > 0) ||
            !isIssuerAuthority
          }
          onClick={() => setConfirmMint(true)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          Mint to treasury
        </button>
        {children?.(tx.isSending)}
      </div>

      <ConfirmModal
        open={confirmMint}
        onClose={() => setConfirmMint(false)}
        onConfirm={(reason) => mintToTreasury(reason)}
        // The raise-limit ledger needs 5-1000 characters (treasury-mint route).
        reasonMinLength={5}
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
        busy={tx.isSending}
      />
    </>
  );
}
