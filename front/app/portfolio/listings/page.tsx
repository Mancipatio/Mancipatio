"use client";

import { WalletRequired } from "@/components/wallet-required";

// Holder resell posts — "Token holders can post about the tokens they have and
// want to sell on Mancipatio" (Flows doc, Company Ownership step 12 et al.).
// Posts are off-chain classifieds; settlement happens through the on-chain OTC
// escrow (/portfolio/offers) or directly between the parties.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { findAssetPda } from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { loadHoldings, type Holding } from "@/lib/holdings";
import { findShareClassPda } from "@/lib/pdas";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { FieldError, FieldHelp, FieldLabel } from "@/components/field";
import { useToast } from "@/lib/toast";
import {
  createResellListing,
  listMyResellListings,
  markResellListingMatched,
  withdrawResellListing,
  type ResellListing,
  type ResellStatus,
} from "@/lib/resell";
import { createOtcRequest } from "@/lib/otc";
import {
  combine,
  maxLength,
  positiveBigIntString,
  positiveNumber,
  required,
} from "@/lib/form-validation";

const CLASS_TYPE = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
];

const CURRENCIES = ["USDC", "USDT", "SOL", "EUR"];

const STATUS_BADGE: Record<ResellStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  matched: "border-brand-200 bg-brand-50 text-brand-700",
  withdrawn: "border-slate-200 bg-slate-100 text-slate-600",
  removed: "border-red-200 bg-red-50 text-red-700",
};

type EnrichedHolding = Holding & {
  label: string;
  assetPda: string;
  shareClassPda: string;
};

export default function SellListingsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [listings, setListings] = useState<ResellListing[] | null>(null);
  const [holdings, setHoldings] = useState<EnrichedHolding[] | null>(null);
  const [listingsError, setListingsError] = useState<string | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [showPost, setShowPost] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<ResellListing | null>(
    null,
  );
  const [matchTarget, setMatchTarget] = useState<ResellListing | null>(null);
  const [escrowTarget, setEscrowTarget] = useState<ResellListing | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshListings = useCallback(async () => {
    if (!wallet) return;
    try { setListings(await listMyResellListings(wallet.toString())); setListingsError(null); }
    catch (error) { setListingsError(error instanceof Error ? error.message : "Listings service unavailable"); }
  }, [wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshListings();
  }, [refreshListings]);

  // Enrich wallet holdings with share-class / asset labels (same join used on
  // the portfolio overview page: share class by mint → asset by PDA).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet) return;
      try {
        const [network, hs]: [NetworkData, Holding[]] = await Promise.all([
          loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
          loadHoldings(client.runtime.rpc, wallet),
        ]);
        const assetPdaMap = new Map<string, { name: string; assetId: string }>();
        for (const a of network.assets) {
          const [pda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          assetPdaMap.set(pda.toString(), { name: a.name, assetId: a.assetId });
        }
        const out: EnrichedHolding[] = [];
        for (const h of hs) {
          const sc = network.shareClasses.find(
            (s) => s.mint.toString() === h.mint,
          );
          if (!sc || h.balance <= BigInt(0)) continue;
          const asset = assetPdaMap.get(sc.asset.toString());
          const className = CLASS_TYPE[sc.classType] ?? "?";
          const scPda = await findShareClassPda(sc.asset, sc.classIndex);
          out.push({
            ...h,
            label: `${asset?.name ?? "(unknown)"} — ${className} #${sc.classIndex}`,
            assetPda: sc.asset.toString(),
            shareClassPda: scPda.toString(),
          });
        }
        if (!cancelled) { setHoldings(out); setHoldingsError(null); }
      } catch {
        if (!cancelled) setHoldingsError("Holdings could not be verified on this network. Reload to retry.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, wallet]);

  async function withdraw(listing: ResellListing) {
    setBusy(true);
    const ok = await withdrawResellListing(conn.wallet, listing.id);
    setBusy(false);
    setWithdrawTarget(null);
    if (ok) {
      toast.show({ kind: "success", title: "Listing withdrawn" });
      await refreshListings();
    } else {
      toast.showError("Could not withdraw listing", "Try again in a moment.");
    }
  }

  async function markMatched(listing: ResellListing, linkedOfferPda: string) {
    setBusy(true);
    const ok = await markResellListingMatched(
      conn.wallet,
      listing.id,
      linkedOfferPda.trim() || null,
    );
    setBusy(false);
    setMatchTarget(null);
    if (ok) {
      toast.show({ kind: "success", title: "Listing marked as matched" });
      await refreshListings();
    } else {
      toast.showError("Could not update listing", "Try again in a moment.");
    }
  }

  if (!conn.isReady) {
    return (
      <main className="min-w-0 flex-1">
        <SkeletonCard className="max-w-md" rows={3} />
      </main>
    );
  }

  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Portfolio
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Sell listings
          </h1>
          <p className="mt-2 max-w-xl text-sm text-slate-600">
            Post the tokens you want to sell so buyers can find you on the
            public resell board. Negotiate however you like — settlement can go
            through the on-chain OTC escrow, so neither side takes counterparty
            risk.
          </p>
        </div>
        <button
          type="button"
          disabled={!!holdingsError || holdings === null}
          onClick={() => setShowPost(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Post tokens for sale
        </button>
      </div>

      {holdingsError && <p role="alert" className="mt-4 text-sm text-rose-700">{holdingsError}</p>}
      <section className="mt-8">
        {listingsError ? <p role="alert" className="text-sm text-rose-700">{listingsError} <button type="button" onClick={() => void refreshListings()} className="underline">Retry</button></p> : listings === null ? (
          <SkeletonTable rows={3} cols={5} />
        ) : listings.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
            <p className="text-sm text-slate-600">No sell listings yet.</p>
            <p className="mt-1 text-xs text-slate-400">
              Post one and it appears on the public resell board immediately.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Asset</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-right font-medium">Ask</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Posted</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {listings.map((l) => (
                  <tr key={l.id} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {l.asset_label ||
                          `${l.mint.slice(0, 6)}…${l.mint.slice(-4)}`}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {l.mint.slice(0, 6)}…{l.mint.slice(-4)}
                      </p>
                      {l.linked_offer_pda && (
                        <p className="mt-0.5 font-mono text-[11px] text-brand-600">
                          offer {l.linked_offer_pda.slice(0, 6)}…
                          {l.linked_offer_pda.slice(-4)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {String(l.amount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {l.ask_price !== null
                        ? `${l.ask_price} ${l.ask_currency}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[l.status]}`}
                      >
                        {l.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {new Date(l.created_at).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {l.status === "active" ? (
                        <div className="flex flex-wrap justify-end gap-2 text-[12px]">
                          <Link
                            href="/portfolio/offers"
                            className="font-medium text-brand-700 hover:underline"
                            title="Settlement goes through the on-chain OTC escrow — create the offer, then share its address with your buyer."
                          >
                            Create on-chain offer
                          </Link>
                          {l.share_class_pda && (
                            <button
                              type="button"
                              onClick={() => setEscrowTarget(l)}
                              title="Found an interested buyer? Ask the platform to open the OTC escrow contract for this listing."
                              className="text-brand-700 underline-offset-2 hover:underline"
                            >
                              Request escrow
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setMatchTarget(l)}
                            className="text-slate-600 underline-offset-2 hover:underline"
                          >
                            Mark matched
                          </button>
                          <button
                            type="button"
                            onClick={() => setWithdrawTarget(l)}
                            className="text-red-600 underline-offset-2 hover:underline"
                          >
                            Withdraw
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-8 text-xs text-slate-400">
        Listings are off-chain classified posts. When you and a buyer agree on
        terms, settle through an on-chain OTC offer (escrow, no counterparty
        risk) — or transfer directly if you prefer.
      </p>

      {showPost && (
        <PostListingModal
          holdings={holdings}
          onClose={() => setShowPost(false)}
          onCreated={async () => {
            setShowPost(false);
            toast.show({ kind: "success", title: "Listing posted" });
            await refreshListings();
          }}
        />
      )}

      {escrowTarget && (
        <SellerOtcRequestModal
          listing={escrowTarget}
          sellerWallet={wallet.toString()}
          onClose={() => setEscrowTarget(null)}
          onRequested={() => {
            setEscrowTarget(null);
            toast.show({
              kind: "success",
              title: "OTC escrow requested",
              description:
                "The platform will create the escrow contract and share the deposit details with both parties.",
            });
          }}
        />
      )}

      <ConfirmModal
        open={withdrawTarget !== null}
        onClose={() => setWithdrawTarget(null)}
        onConfirm={() => (withdrawTarget ? withdraw(withdrawTarget) : undefined)}
        title="Withdraw listing"
        description={
          <>
            Remove{" "}
            <strong>
              {withdrawTarget?.asset_label ||
                `${withdrawTarget?.mint.slice(0, 6)}…`}
            </strong>{" "}
            from the public resell board? Buyers will no longer see it.
          </>
        }
        confirmLabel="Withdraw"
        kind="warning"
        requireReason={false}
        busy={busy}
      />

      {matchTarget && (
        <MarkMatchedModal
          listing={matchTarget}
          busy={busy}
          onClose={() => setMatchTarget(null)}
          onConfirm={(pda) => void markMatched(matchTarget, pda)}
        />
      )}
    </main>
  );
}

// ── Post listing modal ────────────────────────────────────────────────────────

function PostListingModal({
  holdings,
  onClose,
  onCreated,
}: {
  holdings: EnrichedHolding[] | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [mint, setMint] = useState("");
  const [amount, setAmount] = useState("");
  const [askPrice, setAskPrice] = useState("");
  const [askCurrency, setAskCurrency] = useState("USDC");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => holdings?.find((h) => h.mint === mint) ?? null,
    [holdings, mint],
  );

  const errors = useMemo(() => {
    const e: Record<string, string | null> = {
      mint: mint ? null : "Pick one of your holdings",
      amount: combine(
        required("Amount"),
        positiveBigIntString("Amount"),
      )(amount),
      askPrice: askPrice.trim()
        ? positiveNumber("Ask price")(askPrice)
        : null,
      note: maxLength(1000, "Note")(note),
      contact: combine(required("Contact"), maxLength(300, "Contact"))(contact),
    };
    if (!e.amount && selected) {
      try {
        if (BigInt(amount.trim()) > selected.balance) {
          e.amount = `You only hold ${String(selected.balance)}`;
        }
      } catch {
        e.amount = "Amount is not a valid integer";
      }
    }
    return e;
  }, [mint, amount, askPrice, note, contact, selected]);

  const isValid = Object.values(errors).every((v) => v === null);

  async function submit() {
    setTouched({ mint: true, amount: true, askPrice: true, note: true, contact: true });
    if (!isValid || !selected) return;
    setSaving(true);
    try {
      // Signed route — the server verifies the on-chain balance and the
      // share-class PDA before accepting, and stamps the seller wallet
      // from the signature.
      await createResellListing(conn.wallet, {
        mint: selected.mint,
        share_class_pda: selected.shareClassPda,
        asset_pda: selected.assetPda || undefined,
        asset_label: selected.label,
        amount: Number(amount.trim()),
        ask_price: askPrice.trim() ? Number(askPrice.trim()) : undefined,
        ask_currency: askCurrency,
        note: note.trim(),
        contact: contact.trim(),
      });
    } catch (err) {
      setSaving(false);
      toast.showError(
        "Could not post listing",
        err instanceof Error ? err.message : "The listings service is unavailable.",
      );
      return;
    }
    setSaving(false);
    await onCreated();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-listing-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="mx-4 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p
            id="post-listing-title"
            className="text-sm font-semibold uppercase tracking-wide text-slate-900"
          >
            Post tokens for sale
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Your post appears on the public resell board. Settlement is up to
            you and the buyer — the on-chain OTC escrow is the safe default.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <FieldLabel required>Holding</FieldLabel>
            <select
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, mint: true }))}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              disabled={saving}
            >
              <option value="">
                {holdings === null
                  ? "Loading holdings…"
                  : holdings.length === 0
                    ? "No Mancipatio holdings in this wallet"
                    : "Select a holding…"}
              </option>
              {(holdings ?? []).map((h) => (
                <option key={h.mint} value={h.mint}>
                  {h.label} · balance {String(h.balance)}
                </option>
              ))}
            </select>
            {touched.mint && <FieldError error={errors.mint} />}
          </label>

          <label className="block">
            <FieldLabel required>Amount</FieldLabel>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
              placeholder={selected ? `Up to ${String(selected.balance)}` : "0"}
              inputMode="numeric"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:outline-none"
              disabled={saving}
            />
            <FieldHelp>Token base units, same as shown in Holdings.</FieldHelp>
            {touched.amount && <FieldError error={errors.amount} />}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>Ask price</FieldLabel>
              <input
                value={askPrice}
                onChange={(e) => setAskPrice(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, askPrice: true }))}
                placeholder="Optional"
                inputMode="decimal"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:outline-none"
                disabled={saving}
              />
              {touched.askPrice && <FieldError error={errors.askPrice} />}
            </label>
            <label className="block">
              <FieldLabel>Currency</FieldLabel>
              <select
                value={askCurrency}
                onChange={(e) => setAskCurrency(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                disabled={saving}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <FieldLabel>Note</FieldLabel>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, note: true }))}
              rows={3}
              placeholder="Anything buyers should know — lockups, minimum size, negotiability…"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              disabled={saving}
            />
            {touched.note && <FieldError error={errors.note} />}
          </label>

          <label className="block">
            <FieldLabel required>Contact</FieldLabel>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, contact: true }))}
              placeholder="e.g. seller@example.com or @telegram_handle"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              disabled={saving}
            />
            <FieldHelp>
              How buyers reach you — email/Telegram; you can also settle
              directly through an on-chain OTC offer.
            </FieldHelp>
            {touched.contact && <FieldError error={errors.contact} />}
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !isValid}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Posting…" : "Post listing"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Mark matched modal ────────────────────────────────────────────────────────

function MarkMatchedModal({
  listing,
  busy,
  onClose,
  onConfirm,
}: {
  listing: ResellListing;
  busy: boolean;
  onClose: () => void;
  onConfirm: (linkedOfferPda: string) => void;
}) {
  const [pda, setPda] = useState(listing.linked_offer_pda ?? "");
  const pdaError =
    pda.trim() && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pda.trim())
      ? "Not a valid base58 address"
      : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mark-matched-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-brand-200 bg-brand-50 px-5 py-4 text-brand-900">
          <p
            id="mark-matched-title"
            className="text-sm font-semibold uppercase tracking-wide"
          >
            Mark listing as matched
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-slate-700">
            Found a buyer for{" "}
            <strong>
              {listing.asset_label || `${listing.mint.slice(0, 6)}…`}
            </strong>
            ? This takes the post off the public board. Optionally link the
            on-chain OTC offer you created for settlement.
          </p>
          <label className="block">
            <FieldLabel>Linked offer PDA</FieldLabel>
            <input
              value={pda}
              onChange={(e) => setPda(e.target.value)}
              placeholder="Optional — on-chain Offer address"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-400 focus:outline-none"
              disabled={busy}
            />
            <FieldHelp>
              Create the offer on the{" "}
              <Link
                href="/portfolio/offers"
                className="text-brand-700 hover:underline"
              >
                OTC offers
              </Link>{" "}
              page — the escrow settles without counterparty risk.
            </FieldHelp>
            <FieldError error={pdaError} />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(pda)}
            disabled={busy || pdaError !== null}
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Mark matched"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Seller-initiated OTC escrow request ──────────────────────────────────────

/**
 * The listing owner asks the platform to open the on-chain OTC escrow against
 * an interested buyer wallet (mirror of the buyer-initiated flow on the public
 * resell board). Amount/price are integer base units, same convention as the
 * offers UI. The signed route stamps requested_by with the seller's wallet.
 */
function SellerOtcRequestModal({
  listing,
  sellerWallet,
  onClose,
  onRequested,
}: {
  listing: ResellListing;
  sellerWallet: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [buyer, setBuyer] = useState("");
  const [amount, setAmount] = useState(String(listing.amount));
  // Do NOT prefill from ask_price: it's a HUMAN figure (e.g. "1500 USDC") while
  // this field is integer payment-mint BASE units. Prefilling would settle
  // 10^decimals too little. Leave empty; the ask is shown as a reference.
  const [price, setPrice] = useState("");
  const [paymentMint, setPaymentMint] = useState("");
  const [busy, setBusy] = useState(false);

  const base58Ok = (v: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim());
  const buyerOk = base58Ok(buyer) && buyer.trim() !== sellerWallet;
  const amountOk = /^[1-9]\d*$/.test(amount.trim());
  const priceOk = /^[1-9]\d*$/.test(price.trim());
  const mintOk = base58Ok(paymentMint);
  const valid = buyerOk && amountOk && priceOk && mintOk;

  async function submit() {
    if (!valid || busy || !listing.share_class_pda) return;
    setBusy(true);
    try {
      await createOtcRequest(conn.wallet, {
        share_class_pda: listing.share_class_pda,
        mint: listing.mint,
        asset_label: listing.asset_label,
        seller_wallet: sellerWallet,
        buyer_wallet: buyer.trim(),
        amount: Number(amount.trim()),
        price: Number(price.trim()),
        payment_mint: paymentMint.trim(),
      });
    } catch (err) {
      setBusy(false);
      toast.showError(
        "Could not submit the request",
        err instanceof Error ? err.message : "The request queue is unavailable.",
      );
      return;
    }
    setBusy(false);
    onRequested();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Request OTC escrow
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {listing.asset_label || "Share-class tokens"} — found a buyer? The
            platform opens a smart-contract escrow; you and the buyer each
            deposit your side, and the swap settles automatically once both
            legs are funded.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <FieldLabel required>Buyer wallet</FieldLabel>
            <input
              value={buyer}
              onChange={(e) => setBuyer(e.target.value)}
              placeholder="Interested buyer's wallet address"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              disabled={busy}
            />
            {buyer.trim().length > 0 && !buyerOk && (
              <FieldError
                error={
                  buyer.trim() === sellerWallet
                    ? "Buyer must be a different wallet than yours"
                    : "Not a valid base58 address"
                }
              />
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <FieldLabel required>Amount (share units)</FieldLabel>
              <input
                value={amount}
                inputMode="numeric"
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                disabled={busy}
              />
            </label>
            <label className="block">
              <FieldLabel required>Total price (payment units)</FieldLabel>
              <input
                value={price}
                inputMode="numeric"
                onChange={(e) => setPrice(e.target.value)}
                placeholder="e.g. 1000000"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                disabled={busy}
              />
              {listing.ask_price !== null && (
                <span className="mt-1 block text-[11px] text-amber-700">
                  Listing asks {listing.ask_price} {listing.ask_currency}. Enter
                  this in the payment mint&apos;s base units (e.g. ×10⁶ for
                  USDC/USDT), not the plain number.
                </span>
              )}
            </label>
          </div>
          <label className="block">
            <FieldLabel required>Payment mint</FieldLabel>
            <input
              value={paymentMint}
              onChange={(e) => setPaymentMint(e.target.value)}
              placeholder="USDC mint address"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              disabled={busy}
            />
            <FieldHelp>
              The token the buyer pays in (plain SPL or Token-2022).
            </FieldHelp>
            {paymentMint.trim().length > 0 && !mintOk && (
              <FieldError error="Not a valid mint address" />
            )}
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || busy}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}
