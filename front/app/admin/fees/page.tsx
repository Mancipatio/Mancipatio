"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import {
  fetchMaybePlatform,
  findPlatformPda,
  type Platform,
} from "@/lib/generated/asset_registry";
import { RequireRole } from "@/components/require-role";
import { describePausedAreas, formatPauseFlags } from "@/lib/pause-flags";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import {
  bpsToPercent,
  deleteFeeConfig,
  deleteFeeWaiver,
  FEE_TYPE_LABEL,
  FEE_TYPES,
  listFees,
  upsertFeeConfig,
  upsertFeeWaiver,
  type FeeConfig,
  type FeeType,
  type FeeWaiver,
} from "@/lib/fees";
import { listClients, type ClientRow } from "@/lib/clients";
import { useToast } from "@/lib/toast";

export default function FeesPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Fees
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Commercial terms register
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Internal register of per-client commercial terms — pricing is agreed
          per engagement; nothing is charged on-chain. Records here document
          the agreed terms and per-client waivers.
        </p>
      </div>
      <RequireRole role="admin">
        <FeesOps />
      </RequireRole>
    </section>
  );
}

function FeesOps() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const [platform, setPlatform] = useState<Platform | null | undefined>(undefined);
  const [feeConfig, setFeeConfig] = useState<FeeConfig[] | null>(null);
  const [waivers, setWaivers] = useState<FeeWaiver[] | null>(null);
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [showAddFee, setShowAddFee] = useState(false);
  const [showAddWaiver, setShowAddWaiver] = useState(false);
  const [confirmDeleteFee, setConfirmDeleteFee] = useState<FeeConfig | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const [pda] = await findPlatformPda();
      const maybe = await fetchMaybePlatform(client.runtime.rpc, pda);
      setPlatform(maybe.exists ? maybe.data : null);
      // ONE signed request loads both fee tables (single wallet signature).
      const [fees, cs] = await Promise.all([
        listFees(conn.wallet),
        listClients(conn.wallet),
      ]);
      setFeeConfig(fees.config);
      setWaivers(fees.waivers);
      setClients(cs);
    } catch {
      setFeeConfig([]);
      setWaivers([]);
      setClients([]);
    }
  }, [client, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const clientById = useMemo(() => {
    const m = new Map<string, ClientRow>();
    for (const c of clients ?? []) m.set(c.id, c);
    return m;
  }, [clients]);

  const groupedFees = useMemo(() => {
    if (!feeConfig) return null;
    const out: Partial<Record<FeeType, FeeConfig[]>> = {};
    for (const f of feeConfig) {
      if (!out[f.fee_type]) out[f.fee_type] = [];
      out[f.fee_type]!.push(f);
    }
    return out;
  }, [feeConfig]);

  return (
    <div className="mt-8 space-y-8">
      {/* Platform fee — on-chain ground truth */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">
            Platform account (on-chain)
          </h2>
          <span className="text-[10px] uppercase tracking-wider text-slate-400">
            on-chain
          </span>
        </div>
        {platform === undefined ? (
          <SkeletonCard rows={2} className="mt-4" />
        ) : platform === null ? (
          <p className="mt-4 text-sm text-amber-700">
            Platform not initialized on this network.{" "}
            <Link href="/admin/platform" className="underline">
              Bootstrap now
            </Link>
            .
          </p>
        ) : (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Super admin"
              value={platform.admin.toString()}
              mono
            />
            <Field
              label="protocol_fee_bps"
              value={bpsToPercent(platform.protocolFeeBps)}
              hint={`${platform.protocolFeeBps} bps — reserved on-chain field, not charged`}
            />
            <Field
              label="Treasury"
              value={platform.protocolTreasury.toString()}
              mono
            />
            <Field
              label="Emergency pause"
              value={
                platform.pauseFlags === 0
                  ? "None"
                  : describePausedAreas(platform.pauseFlags) ||
                    formatPauseFlags(platform.pauseFlags)
              }
              hint={`pause_flags ${formatPauseFlags(platform.pauseFlags)}`}
            />
          </dl>
        )}
        <p className="mt-3 text-xs text-slate-500">
          The <code>protocol_fee_bps</code> value is a reserved field on the
          on-chain Platform account — no instruction charges or collects it.
          Pricing is agreed per engagement and settled off-chain; the register
          below documents those agreed terms per client.
        </p>
      </section>

      {/* Fee schedule */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Agreed terms per flow
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Internal record of agreed rates per flow + recipient splits —
              nothing here is charged on-chain. Multiple rows for the same
              flow split the amount by share_bps.
            </p>
          </div>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setShowAddFee(true)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              + Add fee
            </button>
          )}
        </div>

        {feeConfig === null ? (
          <div className="mt-4">
            <SkeletonTable rows={3} cols={5} />
          </div>
        ) : feeConfig.length === 0 ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
            <p className="text-sm text-slate-600">
              No terms recorded yet. Add a row to document an agreed rate.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {FEE_TYPES.map((t) => {
              const rows = groupedFees?.[t];
              if (!rows || rows.length === 0) return null;
              const totalShare = rows.reduce(
                (acc, r) => acc + r.share_bps,
                0,
              );
              return (
                <div
                  key={t}
                  className="overflow-hidden rounded-lg border border-slate-200"
                >
                  <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                    {FEE_TYPE_LABEL[t]}
                    {totalShare !== 10000 && (
                      <span className="ml-2 text-[11px] font-normal text-amber-700">
                        ⚠ recipient shares total {totalShare} bps (expected 10000)
                      </span>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Label</th>
                        <th className="px-4 py-2 text-right font-medium">Rate</th>
                        <th className="px-4 py-2 text-right font-medium">Share</th>
                        <th className="px-4 py-2 font-medium">Recipient</th>
                        <th className="px-4 py-2 font-medium">Enabled</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((r) => (
                        <tr key={r.id} className="text-slate-700">
                          <td className="px-4 py-2">
                            {r.label || (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {bpsToPercent(r.rate_bps)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {bpsToPercent(r.share_bps)}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-slate-500">
                            {r.recipient.slice(0, 6)}…{r.recipient.slice(-4)}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {r.enabled ? (
                              <span className="text-emerald-700">Enabled</span>
                            ) : (
                              <span className="text-slate-400">Disabled</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right text-xs">
                            {isSuperAdmin && (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteFee(r)}
                                className="text-red-700 underline-offset-2 hover:underline"
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Waivers */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Per-client waivers
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Record an agreed override of the default terms for one client /
              fee combination. Useful for design partners, free tiers and
              promotional discounts.
            </p>
          </div>
          {isSuperAdmin && (clients?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setShowAddWaiver(true)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              + Add waiver
            </button>
          )}
        </div>

        {waivers === null ? (
          <div className="mt-4">
            <SkeletonTable rows={3} cols={5} />
          </div>
        ) : waivers.length === 0 ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
            <p className="text-sm text-slate-600">No waivers yet.</p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Fee</th>
                  <th className="px-4 py-2 text-right font-medium">Override</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {waivers.map((w) => {
                  const c = clientById.get(w.client_id);
                  return (
                    <tr key={w.id} className="text-slate-700">
                      <td className="px-4 py-2">
                        {c ? (
                          <Link
                            href={`/admin/clients/${c.id}`}
                            className="text-slate-700 underline-offset-2 hover:underline"
                          >
                            {c.display_name}
                          </Link>
                        ) : (
                          <span className="text-slate-400">
                            {w.client_id.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {FEE_TYPE_LABEL[w.fee_type]}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {bpsToPercent(w.override_bps)}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">
                        {w.expires_at
                          ? new Date(w.expires_at).toISOString().slice(0, 10)
                          : "never"}
                      </td>
                      <td className="max-w-[240px] px-4 py-2 truncate text-xs text-slate-600">
                        {w.reason || "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-xs">
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              void deleteFeeWaiver(conn.wallet, w.id).then(
                                refresh,
                                () => {},
                              );
                            }}
                            className="text-red-700 underline-offset-2 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Revenue — tracked off-chain */}
      <section className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6">
        <h2 className="text-base font-semibold text-slate-900">
          Fee revenue — tracked off-chain
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Nothing is charged on-chain: the <code>protocol_fee_bps</code> value
          on the Platform account is a reserved field no instruction collects,
          so there are no on-chain fee transfers to sum. Engagements are
          priced by agreement and invoiced off-platform; this register only
          documents the agreed terms per client.
        </p>
      </section>

      {showAddFee && (
        <FeeConfigModal
          onClose={() => setShowAddFee(false)}
          onSuccess={() => {
            void refresh();
            setShowAddFee(false);
          }}
        />
      )}
      {showAddWaiver && (clients?.length ?? 0) > 0 && (
        <WaiverModal
          clients={clients!}
          onClose={() => setShowAddWaiver(false)}
          onSuccess={() => {
            void refresh();
            setShowAddWaiver(false);
          }}
        />
      )}

      {confirmDeleteFee && (
        <ConfirmModal
          open
          onClose={() => setConfirmDeleteFee(null)}
          onConfirm={async () => {
            try {
              await deleteFeeConfig(conn.wallet, confirmDeleteFee.id);
              toast.show({ kind: "success", title: "Fee removed" });
              setConfirmDeleteFee(null);
              await refresh();
            } catch (err) {
              toast.showError(
                "Delete failed",
                err instanceof Error ? err.message : String(err),
              );
            }
          }}
          title={`Remove ${FEE_TYPE_LABEL[confirmDeleteFee.fee_type]} fee`}
          kind="destructive"
          confirmLabel="Remove"
          requireReason={false}
          description={
            <p>
              The recorded terms are removed from the register — nothing is
              charged on-chain either way. You can recreate the row later if
              needed.
            </p>
          }
        />
      )}
    </div>
  );
}

function FeeConfigModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;

  const [feeType, setFeeType] = useState<FeeType>("issuance");
  // No default rate — pricing is agreed per engagement, so the agreed bps
  // must be entered explicitly.
  const [rateBps, setRateBps] = useState("0");
  const [recipient, setRecipient] = useState(wallet?.toString() ?? "");
  const [shareBps, setShareBps] = useState("10000");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!recipient.trim()) return;
    setSubmitting(true);
    try {
      await upsertFeeConfig(conn.wallet, {
        fee_type: feeType,
        rate_bps: Number(rateBps) || 0,
        recipient: recipient.trim(),
        share_bps: Number(shareBps) || 0,
        label,
        enabled,
      });
      toast.show({ kind: "success", title: "Fee saved" });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Failed to save fee",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Add / edit fee
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Flow
              </span>
              <select
                value={feeType}
                onChange={(e) => setFeeType(e.target.value as FeeType)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {FEE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FEE_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Rate (bps; 100 = 1%)
              </span>
              <input
                value={rateBps}
                inputMode="numeric"
                onChange={(e) => setRateBps(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Recipient wallet
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Solana address"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Share (bps of fee; 10000 = whole)
              </span>
              <input
                value={shareBps}
                inputMode="numeric"
                onChange={(e) =>
                  setShareBps(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Label
              </span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Platform treasury"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !recipient.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WaiverModal({
  clients,
  onClose,
  onSuccess,
}: {
  clients: ClientRow[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [feeType, setFeeType] = useState<FeeType>("issuance");
  const [overrideBps, setOverrideBps] = useState("0");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!clientId || !wallet) return;
    setSubmitting(true);
    try {
      // granted_by is stamped server-side from the verified signer.
      await upsertFeeWaiver(conn.wallet, {
        client_id: clientId,
        fee_type: feeType,
        override_bps: Number(overrideBps) || 0,
        expires_at: expiresAt
          ? new Date(`${expiresAt}T23:59:59Z`).toISOString()
          : null,
        reason,
      });
      toast.show({ kind: "success", title: "Waiver saved" });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Failed to save waiver",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Add fee waiver
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Client
              </span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name} ({c.type})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Fee type
              </span>
              <select
                value={feeType}
                onChange={(e) => setFeeType(e.target.value as FeeType)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {FEE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FEE_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Override (bps; 0 = full waiver)
              </span>
              <input
                value={overrideBps}
                inputMode="numeric"
                onChange={(e) =>
                  setOverrideBps(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Expires (optional)
              </span>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Reason
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Design partner / promotional / partner agreement…"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !clientId}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
      {hint && (
        <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
      )}
    </div>
  );
}
