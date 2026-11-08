"use client";

// "Updates from the issuer" on the public asset page (/marketplace/assets/[id]):
// the published public updates of the asset and its issuer's issuer-wide
// ones (GET /api/issuer-updates/public, no wallet), and, when the issuer has
// published holders-only updates, the way for a holder to read them: the
// signed holder read, which checks the wallet's balance of the asset's
// classes on chain. Opening the page never prompts the wallet: an existing
// session is used, otherwise a button asks for the one sign-in.
// Self-contained: the page passes the asset and issuer addresses only.

import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import {
  loadHolderIssuerUpdates,
  loadPublicIssuerUpdates,
  openIssuerUpdateDocument,
  publicDocumentHref,
  type PublicUpdatesAnswer,
} from "@/lib/issuer-updates-client";
import { byPublicationDesc, type HolderIssuerUpdate, type PublicIssuerUpdate } from "@/lib/issuer-updates";
import { useToast } from "@/lib/toast";
import { UpdateArticle } from "@/components/issuer-updates/update-article";

type HolderState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "signin" }
  | { state: "not-holder" }
  | { state: "error"; text: string }
  | { state: "ready"; updates: HolderIssuerUpdate[] };

type Keyed<T> = { key: string; value: T } | null;
type ShownUpdate = PublicIssuerUpdate & { via_asset?: string };

const SHOWN = 5;

export function AssetUpdatesBlock({ assetPda, issuerPda }: { assetPda: string; issuerPda: string }) {
  const { wallet: session } = useWalletConnection();
  const wallet = session?.account.address.toString() ?? null;
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  // Results are kept with the key they answer, so a change of asset or wallet never shows another's.
  const publicKey = `${issuerPda}:${assetPda}`;
  const [publicResult, setPublicResult] = useState<Keyed<PublicUpdatesAnswer | "error">>(null);
  const published = publicResult?.key === publicKey ? publicResult.value : null;
  useEffect(() => {
    let cancelled = false;
    loadPublicIssuerUpdates(issuerPda, assetPda).then(
      (answer) => { if (!cancelled) setPublicResult({ key: publicKey, value: answer }); },
      () => { if (!cancelled) setPublicResult({ key: publicKey, value: "error" }); },
    );
    return () => { cancelled = true; };
  }, [issuerPda, assetPda, publicKey]);

  const holdersOnly = published && published !== "error" ? published.holders_only : 0;
  const holderKey = wallet && holdersOnly > 0 ? `${wallet}:${assetPda}` : null;
  const [holderResult, setHolderResult] = useState<Keyed<HolderState>>(null);
  // No answer yet for this wallet: the background read below is on its way.
  const holder: HolderState = !holderKey ? { state: "idle" } : holderResult?.key === holderKey ? holderResult.value : { state: "loading" };

  const readHolder = useCallback((key: string, interactive: boolean) =>
    loadHolderIssuerUpdates(sessionRef.current, [assetPda], interactive).then(
      (answer) => setHolderResult({
        key,
        value: answer.holder_assets.includes(assetPda)
          ? { state: "ready", updates: answer.updates.filter((u) => u.via_asset === assetPda) }
          : { state: "not-holder" },
      }),
      (err: unknown) => setHolderResult({
        key,
        value: err instanceof WalletSessionRequiredError
          ? { state: "signin" }
          : { state: "error", text: err instanceof Error ? err.message : "Holder updates could not be loaded." },
      }),
    ), [assetPda]);

  // A wallet with a live session reads the holder updates without a prompt.
  useEffect(() => {
    if (holderKey) void readHolder(holderKey, false);
  }, [holderKey, readHolder]);

  // Public and holder updates, each once (a few dozen at most: no memo needed).
  const merged = new Map<string, ShownUpdate>((published && published !== "error" ? published.updates : []).map((u) => [u.id, u]));
  if (holder.state === "ready") for (const u of holder.updates) merged.set(u.id, u);
  const updates = [...merged.values()].sort(byPublicationDesc);

  async function open(update: ShownUpdate, documentId: string) {
    setOpening(documentId);
    try {
      await openIssuerUpdateDocument(sessionRef.current, documentId, update.via_asset ?? assetPda);
    } catch (err) {
      toast.showError("The document could not be opened", err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  }

  function signInAndRead() {
    if (!holderKey) return;
    setHolderResult({ key: holderKey, value: { state: "loading" } });
    void readHolder(holderKey, true);
  }

  const visible = showAll ? updates : updates.slice(0, SHOWN);

  return (
    <section className="mt-10" id="updates">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        Updates from the issuer
      </h2>
      {published === null ? (
        <p className="mt-4 text-sm text-mx-ink-faint" role="status">Loading updates…</p>
      ) : published === "error" ? (
        <p className="mt-4 text-sm text-mx-ink-faint">Updates could not be loaded. Reload the page to try again.</p>
      ) : (
        <>
          {updates.length === 0 ? (
            <p className="mt-4 text-sm text-mx-ink-faint">The issuer has not published updates for this asset yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {visible.map((update) => (
                <UpdateArticle
                  key={update.id}
                  update={update}
                  variant="public"
                  context={update.asset_pda === null ? "For every asset of this issuer" : undefined}
                  documentHref={update.visibility === "public" ? (doc) => publicDocumentHref(doc.id) : undefined}
                  onOpenDocument={update.visibility === "holders" ? (doc) => void open(update, doc.id) : undefined}
                  openingDocument={opening}
                />
              ))}
              {updates.length > SHOWN && (
                <button
                  type="button"
                  onClick={() => setShowAll((all) => !all)}
                  className="text-xs font-medium text-mx-ink-soft underline-offset-2 hover:underline"
                >
                  {showAll ? "Show fewer updates" : `Show all ${updates.length} updates`}
                </button>
              )}
            </div>
          )}
          {holdersOnly > 0 && holder.state !== "ready" && (
            <HolderNotice count={holdersOnly} state={holder} connected={!!session} onRead={signInAndRead} />
          )}
        </>
      )}
    </section>
  );
}

function HolderNotice({ count, state, connected, onRead }: {
  count: number;
  state: HolderState;
  connected: boolean;
  onRead: () => void;
}) {
  const what = count === 1 ? "1 update is" : `${count} updates are`;
  return (
    <div className="mt-4 rounded-[3px] border border-mx-rule bg-mx-paper p-4 text-sm text-mx-ink-soft">
      <p>{what} visible only to holders of this asset.</p>
      {!connected ? (
        <p className="mt-1 text-xs text-mx-ink-faint">Connect a wallet that holds units of this asset to read them.</p>
      ) : state.state === "not-holder" ? (
        <p className="mt-1 text-xs text-mx-ink-faint">This wallet holds no units of this asset&apos;s share classes, so they stay hidden.</p>
      ) : (
        <>
          {state.state === "error" && <p className="mt-1 text-xs text-red-600">{state.text}</p>}
          <button
            type="button"
            onClick={onRead}
            disabled={state.state === "loading"}
            className="mt-2 rounded-[3px] bg-mx-ink px-3 py-1.5 text-xs font-medium text-mx-paper hover:opacity-90 disabled:opacity-50"
          >
            {state.state === "loading" ? "Checking your holding…" : state.state === "error" ? "Try again" : "Show holder updates"}
          </button>
          <p className="mt-2 text-[11px] text-mx-ink-faint">Your wallet signs in once; the server checks its balance on chain.</p>
        </>
      )}
    </div>
  );
}
