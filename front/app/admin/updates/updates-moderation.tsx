"use client";

// /admin/updates: the published and withdrawn issuer updates of every issuer
// (POST /api/issuer-updates/admin-list), with their documents, and the
// moderation withdrawal (POST /api/issuer-updates/withdraw as an admin; the
// reason is kept on the update and shown to its issuer, and an audit row is
// written). Opening the page never prompts: an existing wallet session is
// used, otherwise "Sign in" asks once. ops/runbook-mainnet.md "Investor
// relations" describes when to withdraw.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { UpdateArticle } from "@/components/issuer-updates/update-article";
import { assetHref } from "@/lib/asset-links";
import { detectNetwork } from "@/lib/network";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import {
  formatUpdateDate,
  ISSUER_UPDATE_LIMITS,
  ISSUER_UPDATE_VISIBILITY_LABELS,
  type AdminIssuerUpdate,
} from "@/lib/issuer-updates";
import { loadAdminIssuerUpdates, openIssuerUpdateDocument, withdrawIssuerUpdate } from "@/lib/issuer-updates-client";
import { useToast } from "@/lib/toast";

type Filter = "all" | "published" | "withdrawn";
type List =
  | { state: "loading" }
  | { state: "signin" }
  | { state: "error"; text: string }
  | { state: "ready"; updates: AdminIssuerUpdate[] };

const FILTERS: Array<[Filter, string]> = [["all", "All"], ["published", "Published"], ["withdrawn", "Withdrawn"]];

export function UpdatesModeration() {
  const { wallet } = useWalletConnection();
  if (!wallet) return null;
  return <Moderation key={`${detectNetwork()}:${wallet.account.address}`} session={wallet} />;
}

function Moderation({ session }: { session: WalletSession }) {
  const toast = useToast();
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const [filter, setFilter] = useState<Filter>("published");
  const [list, setList] = useState<{ key: Filter; value: List } | null>(null);
  const current: List = list?.key === filter ? list.value : { state: "loading" };
  const [target, setTarget] = useState<AdminIssuerUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback((key: Filter, interactive: boolean) =>
    loadAdminIssuerUpdates(sessionRef.current, key, interactive).then(
      (updates) => setList({ key, value: { state: "ready", updates } }),
      (err: unknown) => setList({
        key,
        value: err instanceof WalletSessionRequiredError
          ? { state: "signin" }
          : { state: "error", text: err instanceof Error ? err.message : "The updates could not be loaded." },
      }),
    ), []);

  useEffect(() => { void load(filter, false); }, [filter, load]);

  async function withdraw(reason: string) {
    if (!target || busy) return;
    setBusy(true);
    try {
      await withdrawIssuerUpdate(sessionRef.current, target.id, reason);
      setTarget(null);
      toast.show({ kind: "success", title: "Update withdrawn", description: "Readers no longer see it; its issuer sees your reason." });
      setList({ key: filter, value: { state: "loading" } });
      void load(filter, false);
    } catch (err) {
      toast.showError("The update was not withdrawn", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Status">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
            className={filter === key ? "btn-brand" : "btn-ghost"}>
            {label}
          </button>
        ))}
      </div>

      {current.state === "loading" ? (
        <p className="mt-6 text-sm text-slate-500" role="status">Loading updates…</p>
      ) : current.state === "signin" || current.state === "error" ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-card">
          <p>{current.state === "error" ? current.text : "Sign in with your admin wallet to load the updates."}</p>
          <button type="button" className="btn-brand mt-3" onClick={() => { setList({ key: filter, value: { state: "loading" } }); void load(filter, true); }}>
            {current.state === "error" ? "Try again" : "Sign in"}
          </button>
        </div>
      ) : current.updates.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No updates.</p>
      ) : (
        <div className="mt-6 space-y-3">
          {current.updates.map((u) => (
            <UpdateArticle
              key={u.id}
              update={u}
              variant="workspace"
              context={
                <>
                  {u.company_name ?? `Issuer ${u.issuer_pda.slice(0, 6)}…`}
                  {" · "}
                  {u.asset_pda ? <Link href={`${assetHref(u.asset_pda)}#updates`} className="text-brand-700 hover:underline">asset {u.asset_pda.slice(0, 6)}…</Link> : "every asset"}
                  {" · "}{ISSUER_UPDATE_VISIBILITY_LABELS[u.visibility]}
                  {" · published by "}<code className="font-mono">{(u.published_by ?? "").slice(0, 6)}…</code>
                </>
              }
              onOpenDocument={(doc) => void openDocument(doc.id)}
              openingDocument={opening}
            >
              {u.status === "withdrawn" ? (
                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Withdrawn {formatUpdateDate(u.withdrawn_at)} by {u.withdrawn_by_role === "admin" ? "an admin" : "the issuer"}{" "}
                  (<code className="font-mono">{(u.withdrawn_by ?? "").slice(0, 6)}…</code>): {u.withdrawn_reason}
                </p>
              ) : (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <button type="button" className="btn-ghost text-red-700" onClick={() => setTarget(u)}>Withdraw (moderation)</button>
                </div>
              )}
            </UpdateArticle>
          ))}
        </div>
      )}

      <ConfirmModal
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={(reason) => withdraw(reason)}
        title="Withdraw this issuer update"
        requireReason
        reasonMinLength={ISSUER_UPDATE_LIMITS.withdrawReasonMin}
        reasonPlaceholder="Why is it withdrawn? Shown to the issuer and kept in the audit log."
        confirmLabel="Withdraw"
        busy={busy}
        busyLabel="Withdrawing…"
        description={target ? (
          <p>
            &ldquo;{target.title}&rdquo; will no longer be shown to readers and its documents will no longer open for them. The
            update stays on record with your reason; a withdrawal cannot be undone.
          </p>
        ) : null}
      />
    </div>
  );
}
