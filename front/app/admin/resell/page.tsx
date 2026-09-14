"use client";

// Admin moderation for holder resell posts (off-chain classifieds).
// Doc basis: "Token holders can post about the tokens they have and want to
// sell on Mancipatio" — the platform moderates the public board.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { Kpi } from "@/components/kpi";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import {
  listResellListings,
  moderateResellListing,
  type ResellListing,
  type ResellStatus,
} from "@/lib/resell";

const STATUS_BADGE: Record<ResellStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  matched: "border-brand-200 bg-brand-50 text-brand-700",
  withdrawn: "border-slate-200 bg-slate-100 text-slate-600",
  removed: "border-red-200 bg-red-50 text-red-700",
};

type StatusFilter = "all" | ResellStatus;

export default function AdminResellPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Markets
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Resell board moderation
        </h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-600">
          Holder posts on the public resell board. Remove anything that looks
          like a scam or violates the terms; restore if removed in error. Posts
          are off-chain — removal never touches the holder&apos;s tokens.
        </p>
      </div>
      <RequireRole role="admin">
        <ResellModeration />
      </RequireRole>
    </section>
  );
}

function ResellModeration() {
  const conn = useWalletConnection();
  const toast = useToast();
  const adminWallet = conn.wallet?.account.address?.toString() ?? "";

  const [rows, setRows] = useState<ResellListing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ResellListing | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ResellListing | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setRows(await listResellListings()); setLoadError(null); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Listings service unavailable"); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      total: all.length,
      active: all.filter((r) => r.status === "active").length,
      matched: all.filter((r) => r.status === "matched").length,
      removed: all.filter((r) => r.status === "removed").length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => statusFilter === "all" || r.status === statusFilter)
      .filter(
        (r) =>
          !q ||
          r.seller_wallet.toLowerCase().includes(q) ||
          r.mint.toLowerCase().includes(q) ||
          r.asset_label.toLowerCase().includes(q),
      );
  }, [rows, query, statusFilter]);

  async function moderate(
    listing: ResellListing,
    action: "remove" | "restore",
    reason: string,
  ) {
    setBusy(true);
    // Signed + admin-gated route; moderated_by/at are stamped server-side.
    const ok = await moderateResellListing(conn.wallet, listing.id, action);
    if (ok) {
      await recordAudit({
        ix_name:
          action === "remove"
            ? "resell_listing_remove"
            : "resell_listing_restore",
        category: "other",
        actor_wallet: adminWallet,
        reason,
        target_label:
          listing.asset_label ||
          `${listing.mint.slice(0, 6)}…${listing.mint.slice(-4)}`,
        metadata: {
          listing_id: listing.id,
          seller_wallet: listing.seller_wallet,
          mint: listing.mint,
        },
      });
      toast.show({
        kind: "success",
        title:
          action === "remove"
            ? "Listing removed from the board"
            : "Listing restored to the board",
      });
      await refresh();
    } else {
      toast.showError("Update failed", "Listings service unavailable.");
    }
    setBusy(false);
    setRemoveTarget(null);
    setRestoreTarget(null);
  }

  return (
    <div className="mt-8 space-y-6">
      {loadError && <p role="alert" className="text-sm text-rose-700">{loadError} <button type="button" className="underline" onClick={() => void refresh()}>Retry</button></p>}
      {/* KPIs */}
      <section className="grid gap-3 sm:grid-cols-4">
        <Kpi label="Total posts" value={loadError || rows === null ? "—" : String(counts.total)} />
        <Kpi label="Active" value={loadError || rows === null ? "—" : String(counts.active)} />
        <Kpi label="Matched" value={loadError || rows === null ? "—" : String(counts.matched)} />
        <Kpi
          label="Removed"
          value={loadError || rows === null ? "—" : String(counts.removed)}
          tone={counts.removed > 0 ? "warn" : "default"}
        />
      </section>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search wallet, mint or asset label…"
          className="w-72 max-w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
        />
        <label className="text-[12px] text-slate-500">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="ml-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="matched">Matched</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="removed">Removed</option>
          </select>
        </label>
      </div>

      {/* Table */}
      {loadError ? null : rows === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">No listings match.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 font-medium">Seller</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Ask</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Posted</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <Row
                  key={r.id}
                  listing={r}
                  expanded={expanded === r.id}
                  onToggle={() =>
                    setExpanded((cur) => (cur === r.id ? null : r.id))
                  }
                  onRemove={() => setRemoveTarget(r)}
                  onRestore={() => setRestoreTarget(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={(reason) =>
          removeTarget ? moderate(removeTarget, "remove", reason) : undefined
        }
        title="Remove listing"
        description={
          <>
            Take{" "}
            <strong>
              {removeTarget?.asset_label ||
                `${removeTarget?.mint.slice(0, 6)}…`}
            </strong>{" "}
            by{" "}
            <code className="font-mono text-xs">
              {removeTarget?.seller_wallet.slice(0, 6)}…
              {removeTarget?.seller_wallet.slice(-4)}
            </code>{" "}
            off the public resell board? The holder keeps their tokens; only the
            post is hidden.
          </>
        }
        confirmLabel="Remove listing"
        kind="destructive"
        requireReason
        reasonPlaceholder="Why is this post being removed? (visible in audit log)"
        busy={busy}
      />

      <ConfirmModal
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={(reason) =>
          restoreTarget ? moderate(restoreTarget, "restore", reason) : undefined
        }
        title="Restore listing"
        description={
          <>
            Put{" "}
            <strong>
              {restoreTarget?.asset_label ||
                `${restoreTarget?.mint.slice(0, 6)}…`}
            </strong>{" "}
            back on the public resell board as <strong>active</strong>?
          </>
        }
        confirmLabel="Restore"
        kind="info"
        requireReason
        reasonPlaceholder="Why is this post being restored? (visible in audit log)"
        busy={busy}
      />
    </div>
  );
}

function Row({
  listing: r,
  expanded,
  onToggle,
  onRemove,
  onRestore,
}: {
  listing: ResellListing;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onRestore: () => void;
}) {
  return (
    <>
      <tr className="text-slate-700 hover:bg-slate-50">
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={onToggle}
            className="text-left"
            title="Toggle detail"
          >
            <p className="font-medium text-slate-900">
              {r.asset_label || `${r.mint.slice(0, 6)}…${r.mint.slice(-4)}`}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-slate-500">
              {r.mint.slice(0, 6)}…{r.mint.slice(-4)}{" "}
              <span className="text-slate-400">
                {expanded ? "▴ hide" : "▾ detail"}
              </span>
            </p>
          </button>
        </td>
        <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
          {r.seller_wallet.slice(0, 6)}…{r.seller_wallet.slice(-4)}
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums">
          {String(r.amount)}
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums">
          {r.ask_price !== null ? `${r.ask_price} ${r.ask_currency}` : "—"}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
          >
            {r.status}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-slate-500">
          {new Date(r.created_at).toISOString().slice(0, 10)}
        </td>
        <td className="px-4 py-3 text-right text-[12px]">
          {r.status === "removed" ? (
            <button
              type="button"
              onClick={onRestore}
              className="font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              onClick={onRemove}
              className="font-medium text-red-600 underline-offset-2 hover:underline"
            >
              Remove
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/60">
          <td colSpan={7} className="px-4 py-3">
            <dl className="grid gap-3 text-[12.5px] sm:grid-cols-2">
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                  Note
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-slate-700">
                  {r.note || "—"}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                  Contact
                </dt>
                <dd className="mt-0.5 break-all text-slate-700">
                  {r.contact || "—"}
                </dd>
              </div>
              {r.linked_offer_pda && (
                <div>
                  <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    Linked offer PDA
                  </dt>
                  <dd className="mt-0.5 break-all font-mono text-slate-700">
                    {r.linked_offer_pda}
                  </dd>
                </div>
              )}
              {r.moderated_at && (
                <div>
                  <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    Last moderated
                  </dt>
                  <dd className="mt-0.5 text-slate-700">
                    {new Date(r.moderated_at).toISOString().slice(0, 16).replace("T", " ")}{" "}
                    by{" "}
                    <span className="font-mono">
                      {r.moderated_by
                        ? `${r.moderated_by.slice(0, 6)}…${r.moderated_by.slice(-4)}`
                        : "—"}
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
