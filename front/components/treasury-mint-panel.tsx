"use client";

// Mint into the ISSUER TREASURY from /admin/share-classes. The reservation,
// the transaction, the confirmation wait, the audit row and the release on
// failure are lib/treasury-mint (runTreasuryMint), the one copy "Send to
// wallets" also runs; this panel asks for the units, the EUR value and the
// reason, and says before anything is signed what would refuse the mint:
//   - the room left, counted from lifetime_minted (a conversion burn never
//     reopens it: lib/distribution-supply); the exact room, Open sales and
//     reserved mints included, is the server's check (409 at reservation);
//   - KYC-only mode (lib/features scopeEnabled) and Primary issuance (0x02)
//     paused — read fresh right before the reservation, and the mint closes
//     0x02 again in its own transaction unless a sale still needs it open
//     (lib/public-sale mintRepausesPrimary, the rule Send to wallets uses).
// One mint at a time, from the click — the reservation prompt included; a
// mint the network has not confirmed keeps the form disabled until the
// operator checked the explorer. The success toast and the page's refresh
// wait for the network's confirmation (tx.send returns on submission).

import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { type ShareClass } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { PrimaryReopenLink } from "@/components/primary-reopen-link";
import { readPlatformPause } from "@/lib/distribution-chain";
import { remainingFromLifetime } from "@/lib/distribution-supply";
import { KYC_ONLY_MESSAGE, scopeEnabled } from "@/lib/features";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { listOpenSalesWithFreezes } from "@/lib/open-sales-chain";
import { PAUSE_PRIMARY, isPaused } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { mintRepausesPrimary } from "@/lib/public-sale";
import { isApprovalLive, listShareClassSaleApprovals } from "@/lib/sale-approvals";
import { nowSeconds } from "@/lib/sale-liveness";
import { formatTokens, readSignatureOutcome, shortAddress } from "@/lib/share-transfer";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { usePauseFlags } from "@/lib/use-pause-flags";
import {
  formatDeclaredEur,
  parseDeclaredEur,
  runTreasuryMint,
  TREASURY_MINT_REASON_MIN,
} from "@/lib/treasury-mint";

export type TreasuryMintPanelProps = {
  sc: ShareClass;
  scPda: Address | null;
  issuerPda: Address | null;
  /** The connected wallet is this asset's issuer authority (the treasury). */
  isIssuerAuthority: boolean;
  onRefresh: () => Promise<void>;
  /** Extra buttons on the same row (e.g. Lock supply); `busy` while a mint is sending. */
  children?: (busy: boolean) => ReactNode;
};

/** From the click to the network's answer: what the panel is waiting for. */
type Stage = "check" | "reserve" | "sign" | "confirm";

/** A mint the network has not confirmed in time (for one wallet and mint, `key`). */
type Unsettled = { key: string; signature: string; amount: bigint };

const ZERO = BigInt(0);

/** The panel's own 0x02 note (Send to wallets has its own, about sends). */
function pausedNote(superAdmin: string | null): string {
  const who = superAdmin ? `the super admin (${shortAddress(superAdmin)})` : "the super admin";
  return `Minting is paused platform-wide (Primary issuance, bit 0x02). Only ${who} can reopen it; the mint then closes it again in the same transaction unless a sale still needs it open.`;
}

export function TreasuryMintPanel({
  sc,
  scPda,
  issuerPda,
  isIssuerAuthority,
  onRefresh,
  children,
}: TreasuryMintPanelProps) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const wallet = conn.wallet?.account.address;
  const [network] = useState(() => detectNetwork());
  // For the panel's own note (refreshed every 30 s); the mint reads the flags fresh before reserving anything.
  const flags = usePauseFlags();
  /** Who may reopen Primary issuance (the Platform's super admin), for the 0x02 note; null until read. */
  const [superAdmin, setSuperAdmin] = useState<string | null>(null);
  const [mintAmount, setMintAmount] = useState("");
  // Declared EUR value of a treasury mint (counted against the raise limit), as typed.
  const [mintEur, setMintEur] = useState("");
  const [confirmMint, setConfirmMint] = useState(false);
  /** What the wallet or the network is being waited for; null when idle. */
  const [stage, setStage] = useState<Stage | null>(null);
  // One mint at a time, from the click — the reservation prompt included.
  const mintLock = useRef(false);
  const [unsettled, setUnsettled] = useState<Unsettled | null>(null);
  const [checking, setChecking] = useState(false);

  // The super admin named in the 0x02 note (one read; the mint reads the Platform again).
  useEffect(() => {
    let cancelled = false;
    void readPlatformPause(rpc)
      .then((p) => {
        if (!cancelled && p) setSuperAdmin(p.superAdmin.toString());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const issuanceOn = scopeEnabled("issuance");
  const primaryPaused = flags !== null && isPaused(flags, PAUSE_PRIMARY);
  const cap = sc.maxSupply.__option === "Some" ? sc.maxSupply.value : null;
  // The checklist's own figure: the cap minus everything ever created (converted tokens included).
  const notCreated = remainingFromLifetime(cap, sc.lifetimeMinted);
  const units = /^\d+$/.test(mintAmount) ? BigInt(mintAmount) : null;
  const overRoom = notCreated !== null && units !== null && units > notCreated;
  const eur = parseDeclaredEur(mintEur);
  const unsettledKey = `${wallet ?? ""}|${sc.mint}`;
  const pending = unsettled !== null && unsettled.key === unsettledKey;
  const busy = tx.isSending || stage !== null || checking;

  // Mints into the ISSUER TREASURY — the token account owned by the signing
  // issuer authority (the connected wallet). That is the only destination the
  // program accepts from this screen; see the destination-binding note on
  // /admin/share-classes.
  async function mintToTreasury(reason: string) {
    if (!wallet || !conn.wallet || !issuerPda || !scPda || units === null || units === ZERO) return;
    if (!isIssuerAuthority || !issuanceOn || overRoom || pending || mintLock.current) return;
    // Re-parsed here (never a stale closure): what the ledger reserves is what the field says.
    const parsed = parseDeclaredEur(mintEur);
    if (!parsed.ok) {
      toast.showError("EUR value required", parsed.error);
      return;
    }
    const amount = units;
    mintLock.current = true;
    setStage("check");
    let pendingId = toast.showPending(`Minting ${formatTokens(amount)} units to the issuer treasury…`);
    try {
      // Primary issuance (0x02) read fresh (never the 10 s cache) before anything is reserved: the
      // mint needs it open, and closes it again in its own transaction unless an Open sale of any
      // issuer can still take a buy or this class has an approved sale waiting to be opened
      // (lib/public-sale mintRepausesPrimary). A flag that cannot be read refuses; never a guess.
      const [platform, sales, approvals] = await Promise.all([
        readPlatformPause(rpc),
        listOpenSalesWithFreezes(rpc),
        listShareClassSaleApprovals(rpc, scPda),
      ]);
      if (!platform) throw new Error("Could not read the platform's pause flags; nothing was reserved or sent. Try again.");
      if (isPaused(platform.flags, PAUSE_PRIMARY)) throw new Error(pausedNote(platform.superAdmin.toString()));
      const repause = mintRepausesPrimary({
        sales,
        nowSec: nowSeconds(),
        classLiveApprovals: approvals.filter((a) => isApprovalLive(a)).length,
      });
      // The gates on the way to the wallet read the flags again, not the 10 s cache.
      clearPauseFlagsCache();
      toast.dismiss(pendingId);
      pendingId = toast.showPending(
        `Minting ${formatTokens(amount)} units to the issuer treasury${repause ? " and closing Primary issuance (0x02) again" : ""}…`,
      );
      const result = await runTreasuryMint({
        session: conn.wallet,
        rpc,
        send: (request) => tx.send(request),
        sc,
        scPda,
        issuerPda,
        amount,
        amountEur: parsed.eur,
        reason,
        repause,
        onStage: (next) => {
          setStage(next);
          if (next !== "confirm") return;
          setConfirmMint(false);
          toast.dismiss(pendingId);
          pendingId = toast.showPending(`Confirming the mint of ${formatTokens(amount)} units on the network…`);
        },
      });
      toast.dismiss(pendingId);
      // Only the network's confirmation makes it "minted"; the refresh reads it after.
      if (result.outcome === "confirmed") {
        toast.showTx(result.signature, { title: "Minted to treasury" });
        setMintAmount("");
        setMintEur("");
        setUnsettled(null);
        if (!repause) {
          toast.show({
            kind: "info",
            title: "Primary issuance (0x02) stays open",
            description:
              "An Open sale can still take buys or this class's approved sale is waiting to be opened. Close it on Admin → Launchpad when it is no longer needed.",
            duration: 12_000,
          });
        }
      } else if (result.outcome === "failed") {
        toast.show({
          kind: "error",
          title: "The mint failed on the network",
          description: "Your wallet sent it, but the network refused it. Nothing was minted; the reservation is released by the server.",
          signature: result.signature,
        });
      } else {
        // Not confirmed in time, or its status could not be read: it may still land. The form is
        // cleared and stays disabled until the operator checked the explorer (no second mint by accident).
        setMintAmount("");
        setMintEur("");
        setUnsettled({ key: unsettledKey, signature: result.signature, amount });
        toast.show({
          kind: "error",
          title: "Mint not confirmed yet",
          description:
            "Outcome unknown — check the explorer before minting again. The form was cleared so the units are not minted twice by accident.",
          signature: result.signature,
        });
      }
      await onRefresh().catch(() => undefined);
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to mint", explainSendError(err instanceof Error && err.cause ? err.cause : err));
    } finally {
      mintLock.current = false;
      setStage(null);
    }
  }

  /** One status read (retried, the history searched) of the unconfirmed mint: confirmed or failed settles it. */
  async function checkAgain() {
    if (!unsettled || checking) return;
    const { signature } = unsettled;
    setChecking(true);
    try {
      const outcome = await readSignatureOutcome(rpc, signature);
      if (outcome === "confirmed") {
        toast.showTx(signature, { title: "Minted to treasury" });
        setUnsettled(null);
        await onRefresh().catch(() => undefined);
      } else if (outcome === "failed") {
        toast.show({
          kind: "error",
          title: "The mint failed on the network",
          description: "The network refused it. Nothing was minted; the reservation is released by the server.",
          signature,
        });
        setUnsettled(null);
      } else {
        toast.show({
          kind: "info",
          title: "Still not confirmed",
          description: "The network has no answer for this mint yet. Check the explorer, or try again in a minute.",
          signature,
        });
      }
    } catch (err) {
      toast.showError("Could not read the mint's status", explainSendError(err));
    } finally {
      setChecking(false);
    }
  }

  const roomLine =
    cap !== null && notCreated !== null ? (
      <p className={`text-[12px] ${overRoom ? "font-medium text-red-700" : "text-slate-500"}`}>
        Cap {formatTokens(cap)} · created so far {formatTokens(sc.lifetimeMinted)} (converted tokens included) · at most{" "}
        {formatTokens(notCreated)} more
        {overRoom && units !== null ? ` — ${formatTokens(units)} is more than that.` : "."}
      </p>
    ) : null;

  const stageLine =
    stage === "check"
      ? "Checking the room and Primary issuance on the network…"
      : stage === "reserve"
        ? "Confirm in your wallet: reserve the value of the new tokens (a message)"
        : stage === "sign"
          ? `Confirm in your wallet: mint ${mintAmount} units to the treasury`
          : null;

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
          onChange={(e) => setMintEur(e.target.value)}
          placeholder="EUR value, e.g. 1000.50"
          aria-label="Declared EUR value of the minted units"
          className="w-48 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
        <button
          type="button"
          disabled={
            busy ||
            units === null ||
            units === ZERO ||
            !eur.ok ||
            !isIssuerAuthority ||
            !issuanceOn ||
            overRoom ||
            primaryPaused ||
            pending
          }
          onClick={() => setConfirmMint(true)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          {stage === "confirm" ? "Confirming…" : stage === "check" ? "Checking…" : stage ? "Waiting for your wallet…" : "Mint to treasury"}
        </button>
        {children?.(busy)}
      </div>
      {mintEur.trim() !== "" && !eur.ok ? (
        <p className="text-[12px] text-red-700">{eur.error}</p>
      ) : eur.ok ? (
        <p className="text-[12px] text-slate-500">= {formatDeclaredEur(eur.eur)} against the raise limit</p>
      ) : null}
      {roomLine}
      {!issuanceOn && <p className="text-xs text-slate-500">{KYC_ONLY_MESSAGE}</p>}
      {primaryPaused && (
        <p className="text-[12px] text-amber-800">
          {pausedNote(superAdmin)} <PrimaryReopenLink publicSale={false} className="mt-1" />
        </p>
      )}
      {pending && unsettled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <p>
            A mint of {formatTokens(unsettled.amount)} units was sent but is not confirmed yet. Outcome unknown — check the{" "}
            <a href={explorerTxUrl(unsettled.signature, network)} target="_blank" rel="noreferrer" className="font-medium underline">
              explorer
            </a>{" "}
            before minting again: minting again may create the units twice.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" onClick={() => void checkAgain()} disabled={checking} className="font-medium underline disabled:opacity-50">
              {checking ? "Checking…" : "Check again"}
            </button>
            <button type="button" onClick={() => setUnsettled(null)} disabled={checking} className="font-medium underline disabled:opacity-50">
              I checked the explorer — allow minting again
            </button>
          </div>
        </div>
      )}

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
              Mint <strong>{units !== null ? formatTokens(units) : "0"}</strong> units into the issuer
              treasury —{" "}
              <code className="break-all rounded bg-slate-100 px-1 font-mono text-xs">
                {wallet ? wallet.toString() : ""}
              </code>
              .
            </p>
            {roomLine}
            <p className="mt-2 text-xs text-slate-600">
              Units stay in the treasury until they are sold through an
              approved sale or transferred out under the transfer hook.
            </p>
            <p className="mt-2 text-xs text-slate-600">
              The mint counts <strong>{eur.ok ? formatDeclaredEur(eur.eur) : "—"}</strong> against the
              issuer&apos;s rolling 12-month raise limit: reserved before it is
              sent, booked once it finalizes.
            </p>
            <p className="mt-2 text-xs text-slate-600">
              The same transaction closes Primary issuance (0x02) again, unless an Open sale can still
              take buys or this class has an approved sale waiting to be opened.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log and the raise-limit ledger.
            </p>
            {stageLine && (
              <p className="mt-2 text-xs font-medium text-slate-700" aria-live="polite">
                {stageLine}
              </p>
            )}
          </>
        }
        busy={busy}
      />
    </>
  );
}
