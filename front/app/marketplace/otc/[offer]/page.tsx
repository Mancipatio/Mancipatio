"use client";

import { WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type Address } from "@solana/kit";
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
  findAssetPda,
  getExpireOfferInstructionAsync,
  getTakeOfferInstructionAsync,
  OfferStatus,
  type Asset,
  type Offer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { isOfferFunded } from "@/lib/escrow-ledger";
import { detectTokenProgram } from "@/lib/otc";
import {
  checkReceiverEligibility,
  type ReceiverEligibility,
} from "@/lib/passport";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findOfferPda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard } from "@/components/skeleton";
import { useToast } from "@/lib/toast";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

type LoadedOffer = {
  offer: Offer;
  offerPda: Address;
  assetName: string;
  assetId: string;
  classIndex: number | null;
};

export default function TakeOfferPage({
  params,
}: {
  params: Promise<{ offer: string }>;
}) {
  const { offer: offerPubkey } = use(params);
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const router = useRouter();
  const wallet = conn.wallet?.account.address;

  const [loaded, setLoaded] = useState<LoadedOffer | null | "not_found">(null);
  const [failed, setFailed] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Taker's available payment-token balance (base units), or null while unknown.
  const [payBalance, setPayBalance] = useState<bigint | null>(null);
  // The payment mint may be classic SPL or Token-2022 — detect it so ATAs and
  // paymentTokenProgram are correct (hard-coding classic makes Token-2022
  // payment offers untakeable). Defaults to classic until detection resolves.
  const [payTokenProgram, setPayTokenProgram] =
    useState<Address>(TOKEN_CLASSIC_ADDRESS);
  // Investor-passport pre-check for KYC-gated mints (the program re-checks the
  // taker's passport on-chain; surface it before the wallet prompt). null =
  // unknown/not-gated.
  const [passportGate, setPassportGate] = useState<ReceiverEligibility | null>(
    null,
  );
  // "now" captured at load time (render must stay pure) — expiry checks.
  const [nowSec, setNowSec] = useState<bigint>(BigInt(0));

  // ── load the offer + enrich with asset metadata ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        if (cancelled) return;

        // Map asset PDA → Asset, and share-class mint → { asset, classIndex }.
        const assetByPda = new Map<string, Asset>();
        for (const a of network.assets) {
          const [pda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          assetByPda.set(pda.toString(), a);
        }
        const scByMint = new Map<string, ShareClass>();
        for (const sc of network.shareClasses) {
          scByMint.set(sc.mint.toString(), sc);
        }

        // Match the on-chain Offer by deriving its PDA for every offer.
        let matched: Offer | null = null;
        for (const o of network.offers) {
          const pda = await findOfferPda(o.shareClass, o.offerId);
          if (pda.toString() === offerPubkey) {
            matched = o;
            break;
          }
        }
        if (cancelled) return;
        if (!matched) {
          setLoaded("not_found");
          return;
        }

        const sc = scByMint.get(matched.mint.toString());
        const asset = sc ? assetByPda.get(sc.asset.toString()) : undefined;
        setNowSec(BigInt(Math.floor(Date.now() / 1000)));
        setLoaded({
          offer: matched,
          offerPda: offerPubkey as Address,
          assetName: asset?.name ?? "Unknown share class",
          assetId: asset?.assetId ?? "—",
          classIndex: sc?.classIndex ?? null,
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, offerPubkey]);

  // ── detect the payment token program (classic vs Token-2022) ──────────────
  useEffect(() => {
    let cancelled = false;
    async function detect() {
      if (loaded === null || loaded === "not_found") return;
      const prog = await detectTokenProgram(
        client.runtime.rpc,
        loaded.offer.paymentMint,
      );
      if (!cancelled && prog) setPayTokenProgram(prog);
    }
    void detect();
    return () => {
      cancelled = true;
    };
  }, [client, loaded]);

  // ── read the taker's payment-token balance (best-effort) ──────────────────
  useEffect(() => {
    let cancelled = false;
    async function readBalance() {
      if (!wallet || loaded === null || loaded === "not_found") return;
      try {
        const [takerPaymentAta] = await findAssociatedTokenPda({
          owner: wallet,
          tokenProgram: payTokenProgram,
          mint: loaded.offer.paymentMint,
        });
        const res = await client.runtime.rpc
          .getTokenAccountBalance(takerPaymentAta)
          .send();
        if (!cancelled) setPayBalance(BigInt(res.value.amount));
      } catch {
        // No payment ATA yet (or RPC hiccup) → treat as zero balance.
        if (!cancelled) setPayBalance(BigInt(0));
      }
    }
    void readBalance();
    return () => {
      cancelled = true;
    };
  }, [client, wallet, loaded, payTokenProgram]);

  // ── investor-passport pre-check for KYC-gated mints ───────────────────────
  // Delegated to lib/passport's checkReceiverEligibility, the single mirror of
  // the program's `receiver_kyc_outcome`. It checks all FOUR things the chain
  // does — hook config mode, entry Approved, `expiry > now` (so expiry == 0 is
  // ALWAYS expired, never "no expiry") and the registry's jurisdiction
  // bitmaps — and fails closed on any RPC error.
  useEffect(() => {
    let cancelled = false;
    async function checkPassport() {
      if (loaded === null || loaded === "not_found") return;
      if (!wallet) {
        // Nothing to check yet — the "connect a wallet" reason takes priority
        // over the passport reason in `blockedReason` anyway.
        if (!cancelled) setPassportGate(null);
        return;
      }
      const gate = await checkReceiverEligibility(
        client.runtime.rpc,
        loaded.offer.mint,
        wallet,
      );
      if (!cancelled) setPassportGate(gate);
    }
    void checkPassport();
    return () => {
      cancelled = true;
    };
  }, [client, wallet, loaded]);

  // ── error / loading states ────────────────────────────────────────────────
  if (failed) {
    return (
      <section>
        <p className="text-sm text-red-600">Failed to load offer.</p>
      </section>
    );
  }

  if (loaded === null) {
    return (
      <section>
        <SkeletonCard rows={6} />
      </section>
    );
  }

  if (loaded === "not_found") {
    return (
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          OTC
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Offer not found
        </h1>
        <p className="mt-2 text-sm text-mx-ink-soft">
          No on-chain OTC offer with this address is registered on Manci
          (devnet).
        </p>
        <Link
          href="/marketplace/otc"
          className="mt-4 inline-block text-sm text-mx-ink-soft underline-offset-2 hover:underline"
        >
          ← All open offers
        </Link>
      </section>
    );
  }

  const { offer, offerPda, assetName, assetId, classIndex } = loaded;
  const isOpen = offer.status === OfferStatus.Open;
  // Open on-chain but past its expiry — take_offer rejects it on-chain, and
  // anyone can permissionlessly expire it to refund the maker.
  const expiredOpen =
    isOpen && offer.expiresAt > BigInt(0) && nowSec > offer.expiresAt;
  const isSelf =
    !!wallet && offer.maker.toString() === wallet.toString();
  const insufficient =
    payBalance !== null && payBalance < offer.price;

  // A taker can only fill an open offer they did not create, with enough
  // payment-token balance. The button is convenience — every guard is
  // re-asserted at send time.
  //
  // Funded-ness comes from the offer's own DEPOSIT LEDGER, not from the
  // escrow's token balance. `take_offer` requires
  // `offer.deposited >= offer.amount` and the escrow is an ordinary token
  // account anyone can raw-transfer into, so a balance read is both a wrong
  // answer (a raw-funded escrow looks takeable but is not) and an extra RPC
  // round-trip. The ledger travels with the Offer account we already loaded.
  const unfunded = !isOfferFunded(offer.amount, offer.deposited);
  // KYC-gated mint + no valid taker passport → the program's on-chain
  // receiver-KYC check would reject the take; block it here with a pointer.
  const passportBlocked =
    passportGate?.gated === true && passportGate.ok === false;
  const canTake =
    isOpen &&
    !expiredOpen &&
    !!wallet &&
    !isSelf &&
    !insufficient &&
    !unfunded &&
    !passportBlocked &&
    !tx.isSending;

  const blockedReason = expiredOpen
    ? "This offer has expired and can no longer be taken. The escrowed share units can be returned to the maker."
    : !isOpen
      ? offer.status === OfferStatus.Filled
        ? "This offer has already been filled."
        : offer.status === OfferStatus.Expired
          ? "This offer expired and the escrow was returned to the maker."
          : "This offer was cancelled by the maker."
      : unfunded
        ? `This offer's escrow is not fully funded yet — the maker has deposited ${offer.deposited} of ${offer.amount} share unit(s) on the record, so it cannot be taken.`
        : !wallet
          ? WALLET_CONNECT_DESCRIPTION
          : isSelf
            ? "You can't take your own offer — cancel it from My offers instead."
            : passportBlocked
              ? `This token is KYC-gated — you need a valid investor passport to take it. ${passportGate?.reason ?? ""} Request one from your portfolio, then retry.`
              : insufficient
                ? "Your payment-token balance is below the offer price."
                : "";

  async function take() {
    if (!wallet || !conn.wallet) {
      toast.showError(WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION);
      return;
    }
    // Re-assert guards at send time — the button is not the source of truth.
    if (!isOpen) {
      toast.showError("Offer unavailable", blockedReason);
      return;
    }
    if (isSelf) {
      toast.showError("Can't take your own offer", blockedReason);
      return;
    }
    if (unfunded) {
      toast.showError("Offer not funded", blockedReason);
      return;
    }
    if (insufficient) {
      toast.showError("Insufficient balance", blockedReason);
      return;
    }

    const pendingId = toast.showPending(`Taking offer #${offer.offerId}…`);
    try {
      const signer = walletSigner(conn.wallet);

      // Taker receives share units here (Token-2022, share mint).
      const [takerShareAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: offer.mint,
      });
      const createTakerShareAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: offer.mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });

      // Taker pays from here (classic SPL, payment mint).
      const [takerPaymentAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: payTokenProgram,
        mint: offer.paymentMint,
      });
      const createTakerPaymentAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: offer.paymentMint,
          tokenProgram: payTokenProgram,
        });

      // Maker receives the payment here (classic SPL, payment mint). The
      // on-chain constraint requires owner == offer.maker, which the maker's
      // ATA satisfies; create it idempotently so settlement can't fail on a
      // missing destination.
      const [makerPaymentAta] = await findAssociatedTokenPda({
        owner: offer.maker,
        tokenProgram: payTokenProgram,
        mint: offer.paymentMint,
      });
      const createMakerPaymentAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: offer.maker,
          mint: offer.paymentMint,
          tokenProgram: payTokenProgram,
        });

      // escrowMarker (["escrow_marker", offer PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path.
      const baseIx = await getTakeOfferInstructionAsync({
        taker: signer,
        offer: offerPda,
        mint: offer.mint,
        escrow: offer.escrow,
        takerShareAccount: takerShareAta,
        paymentMint: offer.paymentMint,
        takerPaymentAccount: takerPaymentAta,
        makerPaymentAccount: makerPaymentAta,
        shareTokenProgram: TOKEN_2022_ADDRESS,
        paymentTokenProgram: payTokenProgram,
      });
      // Append the mode-aware hook tail for the escrow→taker release. The
      // release is signed by the Offer PDA, so the source-authority blocklist
      // entry is keyed on the Offer PDA (mirrors cancel_offer).
      const takeIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, offer.mint, {
            sourceTokenAccount: offer.escrow,
            destTokenAccount: takerShareAta,
            transferAuthority: offerPda,
            sourceOwner: offerPda,
            destOwner: wallet,
          })),
        ],
      };

      const sig = await tx.send({
        instructions: [
          createTakerShareAtaIx,
          createTakerPaymentAtaIx,
          createMakerPaymentAtaIx,
          takeIx,
        ],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Offer taken" });
      setShowConfirm(false);
      router.push("/portfolio");
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to take offer", explainSendError(err));
      console.error("[take_offer]", err);
    }
  }

  /**
   * Permissionless expire & refund (expire_offer): the escrowed share units
   * return to the maker via a hook-aware transfer signed by the Offer PDA, so
   * the hook metas are keyed on the Offer PDA (mirrors cancel_offer). The
   * maker's share ATA is created idempotently — the Rust account constraints
   * require it to exist.
   */
  async function expireOffer() {
    if (!wallet || !conn.wallet) {
      toast.showError(WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION);
      return;
    }
    const pendingId = toast.showPending(`Expiring offer #${offer.offerId}…`);
    try {
      const signer = walletSigner(conn.wallet);
      const [makerShareAta] = await findAssociatedTokenPda({
        owner: offer.maker,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: offer.mint,
      });
      const createMakerShareAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: offer.maker,
          mint: offer.mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      // escrowMarker (["escrow_marker", offer PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path.
      const baseIx = await getExpireOfferInstructionAsync({
        payer: signer,
        offer: offerPda,
        mint: offer.mint,
        escrow: offer.escrow,
        makerShareAccount: makerShareAta,
        shareTokenProgram: TOKEN_2022_ADDRESS,
      });
      const expireIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          // Refund leg: offer escrow (offer PDA) → maker's share account.
          ...(await hookTransferMetas(client.runtime.rpc, offer.mint, {
            sourceTokenAccount: offer.escrow,
            destTokenAccount: makerShareAta,
            transferAuthority: offerPda,
            sourceOwner: offerPda,
            destOwner: offer.maker,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createMakerShareAtaIx, expireIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig ?? "", { title: "Offer expired — maker refunded" });
      setLoaded({
        offer: { ...offer, status: OfferStatus.Expired },
        offerPda,
        assetName,
        assetId,
        classIndex,
      });
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to expire offer", explainSendError(err));
      console.error("[expire_offer]", err);
    }
  }

  const statusBadge = expiredOpen
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : isOpen
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : offer.status === OfferStatus.Filled
        ? "border-mx-rule bg-mx-paper text-mx-ink-soft"
        : offer.status === OfferStatus.Expired
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-red-200 bg-red-50 text-red-700";
  const statusLabel = expiredOpen
    ? "Open — past expiry"
    : isOpen
      ? "Open"
      : offer.status === OfferStatus.Filled
        ? "Filled"
        : offer.status === OfferStatus.Expired
          ? "Expired"
          : "Cancelled";

  const makerShort = `${offer.maker.toString().slice(0, 6)}…${offer.maker
    .toString()
    .slice(-4)}`;
  const payMintShort = `${offer.paymentMint.toString().slice(0, 6)}…${offer.paymentMint
    .toString()
    .slice(-4)}`;

  const terms: { label: string; value: string; mono?: boolean }[] = [
    { label: "Share class", value: assetName },
    { label: "Asset ID", value: assetId, mono: true },
    ...(classIndex !== null
      ? [{ label: "Class index", value: `#${classIndex}` }]
      : []),
    { label: "Amount", value: `${offer.amount} units`, mono: true },
    {
      label: "Escrow deposited",
      value: `${offer.deposited} / ${offer.amount} units`,
      mono: true,
    },
    { label: "Total price", value: `${offer.price} base units`, mono: true },
    { label: "Payment mint", value: payMintShort, mono: true },
    { label: "Maker", value: makerShort, mono: true },
  ];

  return (
    <section>
      <Link
        href="/marketplace/otc"
        className="text-xs text-mx-ink-faint underline-offset-2 hover:underline"
      >
        ← All open offers
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* ═══ LEFT: offer terms ═══ */}
        <div>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
                OTC offer
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
                {assetName}
              </h1>
              <p className="mt-1 font-mono text-[12px] text-mx-ink-faint">
                offer #{String(offer.offerId)} · {assetId}
              </p>
            </div>
            <span
              className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${statusBadge}`}
            >
              {statusLabel}
            </span>
          </div>

          <p className="mb-6 max-w-2xl text-sm leading-relaxed text-mx-ink-soft">
            Filling this offer pays the maker the full price and releases the
            escrowed share units to your wallet. Settlement runs through the
            Manci transfer hook, so the issuer-set eligibility whitelist is
            still enforced at the moment of transfer.
          </p>

          {/* Terms table */}
          <div className="overflow-hidden rounded-[3px] border border-mx-rule bg-white">
            {terms.map((row, i) => (
              <div
                key={row.label}
                className={`flex items-center justify-between px-5 py-4 ${
                  i < terms.length - 1 ? "border-b border-mx-rule" : ""
                }`}
              >
                <p className="text-sm text-mx-ink-faint">{row.label}</p>
                <p
                  className={`text-[15px] font-semibold text-mx-ink ${
                    row.mono ? "font-mono text-[13px]" : ""
                  }`}
                >
                  {row.value}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ═══ RIGHT: take panel ═══ */}
        <aside className="lg:sticky lg:top-20 space-y-4 self-start">
          <div className="rounded-[3px] border border-mx-rule bg-white p-6">
            <p className="mb-1 text-[15px] font-semibold text-mx-ink">
              {expiredOpen ? "Offer expired" : "Take this offer"}
            </p>
            <p className="mb-5 text-[12px] leading-relaxed text-mx-ink-faint">
              {expiredOpen
                ? "The expiry passed without a taker. Trigger the on-chain expiry to return the escrowed share units to the maker."
                : `You pay ${String(offer.price)} and receive ${String(offer.amount)} share units.`}
            </p>

            {/* Price summary */}
            {!expiredOpen && (
              <div className="mb-4 space-y-2">
                <div className="flex items-center justify-between rounded-[3px] border border-mx-rule bg-mx-paper px-4 py-3">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mx-ink-faint">
                    You pay
                  </span>
                  <span className="font-mono text-[15px] font-bold text-mx-ink">
                    {String(offer.price)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-[3px] border border-mx-indigo bg-mx-indigo-soft px-4 py-3">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mx-indigo">
                    You receive
                  </span>
                  <span className="font-mono text-[15px] font-bold text-mx-indigo">
                    {String(offer.amount)} units
                  </span>
                </div>
              </div>
            )}

            {/* Blocked / not-available notice */}
            {!canTake && blockedReason && !expiredOpen && (wallet || !isOpen || unfunded) && (
              <div className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-[13px] font-semibold text-amber-800">
                  Can&apos;t take this offer
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-amber-700">
                  {blockedReason}
                </p>
                {isSelf && (
                  <Link
                    href="/portfolio/offers"
                    className="mt-2 inline-flex items-center gap-1 rounded-[3px] border border-amber-300 bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-50"
                  >
                    Go to My offers →
                  </Link>
                )}
              </div>
            )}

            {/* Take / expire button */}
            {!wallet ? <WalletRequired /> : expiredOpen ? (
              <>
                <button
                  type="button"
                  disabled={!wallet || tx.isSending}
                  onClick={() => void expireOffer()}
                  className={`w-full rounded-[3px] py-3.5 text-[14px] font-semibold transition-all ${
                    wallet && !tx.isSending
                      ? "bg-amber-600 text-mx-paper shadow-sm hover:bg-amber-700 active:scale-[0.98]"
                      : "cursor-default bg-mx-indigo-soft text-mx-ink-faint"
                  }`}
                >
                  {tx.isSending
                    ? "Sending…"
                    : "Expire & refund maker"}
                </button>
                <p className="mt-3 text-center text-[11px] leading-relaxed text-mx-ink-faint">
                  Permissionless — anyone can send this. The escrowed share
                  units return to the maker and the offer closes.
                </p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!canTake}
                  onClick={() => setShowConfirm(true)}
                  className={`w-full rounded-[3px] py-3.5 text-[14px] font-semibold transition-all ${
                    canTake
                      ? "bg-mx-ink text-mx-paper hover:opacity-90 active:scale-[0.98]"
                      : "cursor-default bg-mx-indigo-soft text-mx-ink-faint"
                  }`}
                >
                  {tx.isSending
                    ? "Sending…"
                    : !isOpen
                      ? statusLabel
                      : isSelf
                          ? "Your own offer"
                          : insufficient
                            ? "Insufficient balance"
                            : `Pay ${String(offer.price)} & take`}
                </button>
                <p className="mt-3 text-center text-[11px] leading-relaxed text-mx-ink-faint">
                  Atomic settlement: payment to maker and share release to you
                  happen in a single transaction.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* ── Confirm modal ── */}
      <ConfirmModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={async () => {
          await take();
        }}
        title={`Take offer #${offer.offerId}`}
        kind="info"
        requireReason={false}
        confirmLabel="Confirm & take →"
        cancelLabel="Cancel"
        busy={tx.isSending}
        description={
          <div className="space-y-3">
            <p className="text-sm text-mx-ink-soft">
              You&apos;re about to fill this OTC offer. Payment is sent to the
              maker and the escrowed share units are released to your wallet —
              atomically.
            </p>
            <div className="overflow-hidden rounded-[3px] border border-mx-rule">
              {[
                { label: "Share class", value: assetName },
                { label: "Amount", value: `${offer.amount} units` },
                { label: "You pay", value: `${offer.price} base units` },
                { label: "Maker", value: makerShort },
              ].map((row, i, arr) => (
                <div
                  key={row.label}
                  className={`flex items-center justify-between px-4 py-3 ${
                    i < arr.length - 1 ? "border-b border-mx-rule" : ""
                  }`}
                >
                  <span className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mx-ink-faint">
                    {row.label}
                  </span>
                  <span className="text-sm font-semibold text-mx-ink">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        }
      />
    </section>
  );
}
