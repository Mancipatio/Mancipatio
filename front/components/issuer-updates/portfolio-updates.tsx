"use client";

// "Updates from your companies" on /portfolio: the published updates, public
// and holders-only, of the assets this wallet holds, through the signed
// holder read (the server re-reads every balance on chain; the list the page
// sends is only what it believes the wallet holds). An existing wallet session
// is used without a prompt; otherwise a button asks for the one sign-in.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { assetHref } from "@/lib/asset-links";
import { ISSUER_CONTENT_NOTE, ISSUER_UPDATE_LIMITS, type HolderIssuerUpdate } from "@/lib/issuer-updates";
import { loadHolderIssuerUpdates, openIssuerUpdateDocument, publicDocumentHref } from "@/lib/issuer-updates-client";
import { useToast } from "@/lib/toast";
import { UpdateArticle } from "@/components/issuer-updates/update-article";

type State =
  | { state: "loading" }
  | { state: "signin" }
  | { state: "error"; text: string }
  | { state: "ready"; updates: HolderIssuerUpdate[] };

const SHOWN = 10;

export function PortfolioUpdates({ session, holdings }: {
  session: WalletSession;
  /** The assets the page found in the wallet: address and display name. */
  holdings: ReadonlyArray<{ assetPda: string; assetName: string }>;
}) {
  const toast = useToast();
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const names = new Map(holdings.map((h) => [h.assetPda, h.assetName]));
  // The holder read names at most ISSUER_UPDATE_LIMITS.holderAssets assets (by name, stable).
  const assets = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .slice(0, ISSUER_UPDATE_LIMITS.holderAssets).map(([pda]) => pda);
  const key = assets.join(",");
  // One answer per asset list: a late answer for a previous list never overwrites the current one's.
  const [results, setResults] = useState<ReadonlyMap<string, State>>(new Map());
  const answer = (forKey: string, value: State) => setResults((prev) => new Map(prev).set(forKey, value));
  const current: State = results.get(key) ?? { state: "loading" };
  const [showAll, setShowAll] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const read = useCallback((forKey: string, interactive: boolean) => {
    const list = forKey.split(",");
    return loadHolderIssuerUpdates(sessionRef.current, list, interactive).then(
      (data) => setResults((prev) => new Map(prev).set(forKey, { state: "ready", updates: data.updates })),
      (err: unknown) => setResults((prev) => new Map(prev).set(forKey, err instanceof WalletSessionRequiredError
        ? { state: "signin" }
        : { state: "error", text: err instanceof Error ? err.message : "Updates could not be loaded." })),
    );
  }, []);

  useEffect(() => {
    if (key) void read(key, false);
  }, [key, read]);

  if (!key) return null;

  async function open(update: HolderIssuerUpdate, documentId: string) {
    setOpening(documentId);
    try {
      await openIssuerUpdateDocument(sessionRef.current, documentId, update.via_asset);
    } catch (err) {
      toast.showError("The document could not be opened", err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  }

  function signIn() {
    answer(key, { state: "loading" });
    void read(key, true);
  }

  const updates = current.state === "ready" ? current.updates : [];
  const visible = showAll ? updates : updates.slice(0, SHOWN);

  return (
    <section className="mt-10">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Updates from your companies</h2>
      <p className="mt-2 text-xs text-slate-500">{ISSUER_CONTENT_NOTE}</p>
      {current.state === "loading" ? (
        <p className="mt-4 text-sm text-slate-500" role="status">Checking your holdings for updates…</p>
      ) : current.state === "signin" || current.state === "error" ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-card">
          <p>Issuers publish company updates, reports and documents for their holders; some are visible to holders only.</p>
          {current.state === "error" && <p className="mt-2 text-xs text-red-600">{current.text}</p>}
          <button type="button" onClick={signIn} className="btn-brand mt-3">
            {current.state === "error" ? "Try again" : "Show updates"}
          </button>
          <p className="mt-2 text-xs text-slate-500">Your wallet signs in once; the server checks your balances on chain.</p>
        </div>
      ) : updates.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No updates from the companies you hold yet.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {visible.map((update) => {
            const asset = names.get(update.via_asset) ?? `${update.via_asset.slice(0, 6)}…`;
            return (
              <UpdateArticle
                key={update.id}
                update={update}
                variant="workspace"
                context={
                  <Link href={`${assetHref(update.via_asset)}#updates`} className="text-brand-700 underline-offset-2 hover:underline">
                    {update.asset_pda === null ? `${asset} · for every asset of its issuer` : asset}
                  </Link>
                }
                documentHref={update.visibility === "public" ? (doc) => publicDocumentHref(doc.id) : undefined}
                onOpenDocument={update.visibility === "holders" ? (doc) => void open(update, doc.id) : undefined}
                openingDocument={opening}
              />
            );
          })}
          {updates.length > SHOWN && (
            <button type="button" onClick={() => setShowAll((all) => !all)} className="text-xs font-medium text-brand-700 hover:underline">
              {showAll ? "Show fewer updates" : `Show all ${updates.length} updates`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
