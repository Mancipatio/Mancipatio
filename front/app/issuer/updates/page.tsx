"use client";

// /issuer/updates — investor relations for the connected issuer authority:
// its drafts, published and withdrawn updates (POST /api/issuer-updates/mine),
// the draft editor (draft-editor.tsx) and, per published update, the anchor
// and the withdrawal (published-actions.tsx).
//
// The issuer is the one whose on-chain authority is the connected wallet (as
// every issuer page resolves it). Composing needs issuance on (KYC-only mode
// pauses it: lib/pilot-scope KYC_ONLY_ROUTES puts the notice on this page)
// and the issuer's KYB Verified on chain; the routes enforce both. Reading,
// discarding a draft and withdrawing stay available. Opening the page never
// prompts the wallet: an existing session is used, otherwise a button asks
// for the one sign-in.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { findIssuerPda, KybStatus, type Issuer } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { withAssetAddresses, assetHref } from "@/lib/asset-links";
import { withoutArchivedAssets } from "@/lib/archive-client";
import { scopeEnabled } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { formatUpdateDate, ISSUER_UPDATE_VISIBILITY_LABELS, type IssuerUpdateRecord } from "@/lib/issuer-updates";
import { loadMyIssuerUpdates, openIssuerUpdateDocument } from "@/lib/issuer-updates-client";
import { useToast } from "@/lib/toast";
import { WalletRequired } from "@/components/wallet-required";
import { SkeletonCard } from "@/components/skeleton";
import { UpdateArticle } from "@/components/issuer-updates/update-article";
import { DraftEditor, type IssuerAsset } from "./draft-editor";
import { PublishedActions } from "./published-actions";

type Chain =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; issuer: Issuer | null; issuerPda: string | null; assets: IssuerAsset[] };

type Records =
  | { state: "loading" }
  | { state: "signin" }
  | { state: "error"; text: string }
  | { state: "ready"; updates: IssuerUpdateRecord[] };

const NO_UPDATES: IssuerUpdateRecord[] = [];

export default function IssuerUpdatesPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address.toString() ?? null;
  if (!conn.isReady) return <main className="min-w-0 flex-1"><SkeletonCard rows={4} /></main>;
  if (!conn.wallet || !wallet) return <main className="min-w-0 flex-1"><WalletRequired /></main>;
  // A new wallet gets fresh state: no list or draft of the previous one stays on screen.
  return <IssuerUpdates key={`${detectNetwork()}:${wallet}`} session={conn.wallet} wallet={wallet} />;
}

function IssuerUpdates({ session, wallet }: { session: WalletSession; wallet: string }) {
  const client = useSolanaClient();
  const toast = useToast();
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const [chain, setChain] = useState<Chain>({ state: "loading" });
  const [records, setRecords] = useState<{ key: string; value: Records } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await withoutArchivedAssets(await loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)));
      const issuer = data.issuers.find((i) => i.authority.toString() === wallet) ?? null;
      const issuerPda = issuer ? (await findIssuerPda({ legalEntityId: issuer.legalEntityId }))[0].toString() : null;
      const assets = issuerPda
        ? (await withAssetAddresses(data.assets.filter((a) => a.issuer.toString() === issuerPda)))
          .map(({ asset, address }) => ({ pda: address, name: `${asset.name} (${asset.assetId})` }))
          .sort((a, b) => a.name.localeCompare(b.name))
        : [];
      if (!cancelled) setChain({ state: "ready", issuer, issuerPda, assets });
    })().catch(() => { if (!cancelled) setChain({ state: "failed" }); });
    return () => { cancelled = true; };
  }, [client, wallet]);

  const issuerPda = chain.state === "ready" ? chain.issuerPda : null;
  const current: Records = !issuerPda ? { state: "loading" } : records?.key === issuerPda ? records.value : { state: "loading" };

  const load = useCallback((issuer: string, interactive: boolean) =>
    loadMyIssuerUpdates(sessionRef.current, issuer, interactive).then(
      (updates) => setRecords({ key: issuer, value: { state: "ready", updates } }),
      (err: unknown) => setRecords({
        key: issuer,
        value: err instanceof WalletSessionRequiredError
          ? { state: "signin" }
          : { state: "error", text: err instanceof Error ? err.message : "Your updates could not be loaded." },
      }),
    ), []);

  useEffect(() => {
    if (issuerPda) void load(issuerPda, false);
  }, [issuerPda, load]);

  const updates = current.state === "ready" ? current.updates : NO_UPDATES;
  // Functional updates: an upload or an anchor can finish long after it began,
  // and must not put back the list (or the editor) as it was then.
  const replace = (next: IssuerUpdateRecord) => {
    if (!issuerPda) return;
    setRecords((prev) => prev?.key === issuerPda && prev.value.state === "ready"
      ? { key: issuerPda, value: { state: "ready", updates: [next, ...prev.value.updates.filter((u) => u.id !== next.id)] } }
      : prev);
    setEditing((prev) => (prev && prev.id === null && next.status === "draft" ? { id: next.id } : prev));
  };
  const drop = (id: string) => {
    if (!issuerPda) return;
    setRecords((prev) => prev?.key === issuerPda && prev.value.state === "ready"
      ? { key: issuerPda, value: { state: "ready", updates: prev.value.updates.filter((u) => u.id !== id) } }
      : prev);
    setEditing((prev) => (prev?.id === id ? null : prev));
  };

  async function openDocument(documentId: string) {
    setOpening(documentId);
    try {
      await openIssuerUpdateDocument(sessionRef.current, documentId);
    } catch (err) {
      toast.showError("The document could not be opened", err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  }

  const header = (
    <>
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Investor relations</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">Updates for your holders</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Publish company updates, periodic reports and notices with their documents. Public updates appear on your assets&apos;
        pages; holders-only updates are shown to wallets that hold units, checked on chain. Every document carries the SHA-256
        the server verified, and you can anchor a published update on chain.
      </p>
    </>
  );

  if (chain.state === "loading") return <main className="min-w-0 flex-1">{header}<div className="mt-6"><SkeletonCard rows={4} /></div></main>;
  if (chain.state === "failed") {
    return <main className="min-w-0 flex-1">{header}<p role="alert" className="mt-6 text-sm text-red-600">The registry could not be read. Reload the page to try again.</p></main>;
  }
  if (!chain.issuer || !chain.issuerPda) {
    return (
      <main className="min-w-0 flex-1">
        {header}
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-card">
          This wallet is not the authority of a registered issuer. Updates are published by the issuer&apos;s authority wallet.{" "}
          <Link href="/issuer" className="text-brand-700 hover:underline">Issuer process →</Link>
        </div>
      </main>
    );
  }

  const myIssuer = chain.issuerPda;
  const verified = chain.issuer.kybStatus === KybStatus.Verified;
  const issuanceOn = scopeEnabled("issuance");
  const canCompose = verified && issuanceOn;
  const assetLabel = (pda: string | null) => (pda ? chain.assets.find((a) => a.pda === pda)?.name ?? `${pda.slice(0, 6)}…` : "Every asset of your issuer");
  const editingRecord = editing?.id ? updates.find((u) => u.id === editing.id) ?? null : null;
  // The editor is open only for a new draft or a draft still in the list (one discarded elsewhere closes it).
  const editorOpen = editing !== null && (editing.id === null || editingRecord !== null);
  const groups: Array<[string, IssuerUpdateRecord[]]> = [
    ["Drafts", updates.filter((u) => u.status === "draft")],
    ["Published", updates.filter((u) => u.status === "published")],
    ["Withdrawn", updates.filter((u) => u.status === "withdrawn")],
  ];

  return (
    <main className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>{header}</div>
        {canCompose && current.state === "ready" && !editorOpen && (
          <button type="button" className="btn-brand" onClick={() => setEditing({ id: null })}>New update</button>
        )}
      </div>

      {!verified && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your issuer is not verified (KYB) on chain, so it cannot publish updates yet. Existing updates can still be withdrawn.
        </p>
      )}

      {editing && editorOpen && (
        <div className="mt-6">
          <DraftEditor
            key={editing.id ?? "new"}
            session={session}
            issuerPda={myIssuer}
            assets={chain.assets}
            record={editingRecord}
            canCompose={canCompose}
            onChanged={replace}
            onDiscarded={drop}
            onClose={() => setEditing(null)}
          />
        </div>
      )}

      {current.state === "loading" ? (
        <div className="mt-6"><SkeletonCard rows={3} /></div>
      ) : current.state === "signin" || current.state === "error" ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-card">
          <p>{current.state === "error" ? current.text : "Sign in with your issuer wallet to see your updates."}</p>
          <button type="button" className="btn-brand mt-3" onClick={() => {
            setRecords({ key: myIssuer, value: { state: "loading" } });
            void load(myIssuer, true);
          }}>
            {current.state === "error" ? "Try again" : "Sign in"}
          </button>
        </div>
      ) : updates.length === 0 && !editorOpen ? (
        <p className="mt-6 text-sm text-slate-500">
          {canCompose ? "No updates yet. Start with “New update”." : "No updates yet."}
        </p>
      ) : (
        groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
          <section key={label} className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">{label} ({list.length})</h2>
            <div className="mt-3 space-y-3">
              {list.map((u) => (
                <UpdateArticle
                  key={u.id}
                  update={u}
                  variant="workspace"
                  context={
                    <>
                      {u.asset_pda ? <Link href={`${assetHref(u.asset_pda)}#updates`} className="text-brand-700 hover:underline">{assetLabel(u.asset_pda)}</Link> : assetLabel(null)}
                      {" · "}{ISSUER_UPDATE_VISIBILITY_LABELS[u.visibility]}
                      {u.status === "draft" && <> · Draft, last saved {formatUpdateDate(u.updated_at)}</>}
                    </>
                  }
                  onOpenDocument={(doc) => void openDocument(doc.id)}
                  openingDocument={opening}
                >
                  {u.status === "draft" && editing?.id !== u.id && (
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <button type="button" className="btn-ghost" onClick={() => setEditing({ id: u.id })}>
                        {canCompose ? "Edit draft" : "Open draft"}
                      </button>
                    </div>
                  )}
                  {u.status === "published" && (
                    <PublishedActions session={session} wallet={wallet} record={u} canAnchor={issuanceOn} onChanged={replace} />
                  )}
                  {u.status === "withdrawn" && (
                    <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      Withdrawn {formatUpdateDate(u.withdrawn_at)} by {u.withdrawn_by_role === "admin" ? "the platform (moderation)" : "your issuer"}:{" "}
                      {u.withdrawn_reason}
                    </p>
                  )}
                </UpdateArticle>
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
