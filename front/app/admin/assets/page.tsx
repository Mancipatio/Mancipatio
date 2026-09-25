"use client";

import Link from "next/link";
import { address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssetStatus,
  fetchMaybeAdmin,
  findAdminRecordPda,
  findAssetPda,
  findIssuerPda,
  getActivateAssetInstructionAsync,
  KybStatus,
  type Asset,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { walletSigner } from "@/lib/wallet-signer";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL, fromBytes32 } from "@/lib/format";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { AssetCreateModal } from "@/components/asset-create-modal";
import {
  assetTypeBySlug,
  CATEGORY_SLUGS,
  slugForEnum,
  type CategorySlug,
} from "@/lib/asset-types";
import { getPrivateAssetProfiles as getAssetProfiles, type AssetProfile } from "@/lib/asset-profiles";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { assetActivationBlock, type AssetActivationBlock } from "@/lib/admin-badge-rules";

// "ready": drafts an admin can activate now — the Assets menu count.
type StatusFilter = "all" | "ready" | "draft" | "active" | "frozen" | "wound-down";

/** Why Activate is disabled for a draft (activate_asset.rs; the menu count skips these). */
const ACTIVATION_BLOCK_HINT: Record<Exclude<AssetActivationBlock, "notDraft">, string> = {
  issuerNotVerified: "The issuer's KYB is not verified yet — verify it on /admin/issuers first",
  noShareClasses: "The asset has no share class yet — the issuer adds one before it can be activated",
};

function activationBlockOf(asset: Asset, issuer: Issuer | undefined): AssetActivationBlock | null {
  return assetActivationBlock({
    status: asset.status,
    shareClassesCount: asset.shareClassesCount,
    issuerVerified: issuer?.kybStatus === KybStatus.Verified,
  });
}

const STATUS_TO_FILTER: Record<number, StatusFilter> = {
  0: "draft",
  1: "active",
  2: "frozen",
  3: "wound-down",
};

const STATUS_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-brand-100 text-brand-800 border-brand-200",
  3: "bg-slate-200 text-slate-700 border-slate-300",
};

type CategoryFilter = "all" | CategorySlug;

export default function AssetsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Assets
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Asset registry
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Every tokenized asset registered under a verified issuer — equity,
          revenue share, real estate, debt and more.
        </p>
      </div>
      <RequireRole role="admin">
        <AssetsOps />
      </RequireRole>
    </section>
  );
}

function AssetsOps() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [issuerPdaMap, setIssuerPdaMap] = useState<Map<string, Issuer>>(new Map());
  // assetId → asset PDA; asset PDA → off-chain profile.
  const [pdaMap, setPdaMap] = useState<Map<string, string>>(new Map());
  const [profileMap, setProfileMap] = useState<Map<string, AssetProfile>>(
    new Map(),
  );
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(
    async (isCancelled?: () => boolean) => {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        if (isCancelled?.()) return;
        setData(network);
        // Resolve issuer PDA → Issuer.
        const m = new Map<string, Issuer>();
        for (const issuer of network.issuers) {
          const [pda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
          m.set(pda.toString(), issuer);
        }
        if (isCancelled?.()) return;
        setIssuerPdaMap(m);
        // Derive asset PDAs (for detail links + profile join).
        const pm = new Map<string, string>();
        for (const a of network.assets) {
          const [pda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          pm.set(a.assetId, pda.toString());
        }
        if (isCancelled?.()) return;
        setPdaMap(pm);
        // Join off-chain category profiles in one round-trip.
        const profiles = await getAssetProfiles(conn.wallet, [...pm.values()]);
        if (isCancelled?.()) return;
        setProfileMap(profiles);
      } catch {
        if (!isCancelled?.()) setFailed(true);
      }
    },
    [client, conn.wallet],
  );

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // activate_asset requires an on-chain AdminRecord for the signer — the
  // Platform.admin (super admin) passes the UI role gate even without one,
  // so check the stricter on-chain requirement before offering the button.
  const [hasAdminRecord, setHasAdminRecord] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!wallet) {
        if (!cancelled) setHasAdminRecord(null);
        return;
      }
      try {
        const [adminPda] = await findAdminRecordPda({ authority: wallet });
        const admin = await fetchMaybeAdmin(client.runtime.rpc, adminPda);
        if (!cancelled) setHasAdminRecord(admin.exists);
      } catch {
        if (!cancelled) setHasAdminRecord(null); // unknown — don't block
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet, client]);

  const [activateTarget, setActivateTarget] = useState<{
    asset: Asset;
    assetPda: string;
  } | null>(null);

  async function activateAsset(reason: string) {
    if (!activateTarget || !wallet) return;
    const { asset, assetPda } = activateTarget;
    const target = `${asset.name} (${asset.assetId})`;
    const pendingId = toast.showPending(`Activating ${target}…`, reason);
    try {
      // Pre-flight the on-chain admin gate: the instruction requires an
      // AdminRecord account for the signer, which the super-admin wallet may
      // not hold. Fail with an actionable message instead of a raw
      // AccountNotInitialized error.
      const [adminPda] = await findAdminRecordPda({ authority: wallet });
      const adminRecord = await fetchMaybeAdmin(client.runtime.rpc, adminPda);
      if (!adminRecord.exists) {
        toast.dismiss(pendingId);
        toast.showError(
          "No admin record for this wallet",
          "activate_asset requires an on-chain AdminRecord. Grant this wallet an admin record on /admin/admins first.",
        );
        return;
      }
      const signer = walletSigner(conn.wallet);
      const ix = await getActivateAssetInstructionAsync({
        authority: signer,
        issuer: asset.issuer,
        asset: address(assetPda),
      });
      // tx.signature is stale render-time state inside this callback — use
      // the signature send() resolves with.
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Asset activated" });
      notifyAdminBadges({ afterIndexer: true });
      void recordAudit({
        ix_name: "activate_asset",
        category: "assets",
        actor_wallet: wallet.toString(),
        reason,
        target_label: assetPda,
        tx_signature: sig,
        metadata: { asset_id: asset.assetId, asset_name: asset.name },
      });
      setActivateTarget(null);
      await refresh();
      // The Supabase indexer can lag the chain (webhook not yet processed),
      // so refresh() may still report the asset as Draft — patch the
      // confirmed on-chain status locally so the Activate button does not
      // reappear and invite a doomed second activation (AssetNotDraft).
      setData((prev) =>
        prev
          ? {
              ...prev,
              assets: prev.assets.map((a) =>
                a.assetId === asset.assetId
                  ? { ...a, status: AssetStatus.Active }
                  : a,
              ),
            }
          : prev,
      );
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to activate", message);
      void recordAudit({
        ix_name: "activate_asset",
        category: "assets",
        actor_wallet: wallet.toString(),
        reason,
        target_label: assetPda,
        status: "failed",
        metadata: { asset_id: asset.assetId, error: message },
      });
    }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.assets
      .map((asset) => {
        const assetPda = pdaMap.get(asset.assetId) ?? null;
        const profile = assetPda ? profileMap.get(assetPda) : undefined;
        // Category = off-chain profile if present, else derived from on-chain type.
        const category = (profile?.category ??
          slugForEnum(asset.assetType)) as CategorySlug | "";
        return {
          asset,
          issuer: issuerPdaMap.get(asset.issuer.toString()),
          assetPda,
          profile,
          category,
        };
      })
      .filter(({ asset, issuer, category }) => {
        if (statusFilter === "ready") {
          if (activationBlockOf(asset, issuer) !== null) return false;
        } else if (
          statusFilter !== "all" &&
          STATUS_TO_FILTER[asset.status] !== statusFilter
        )
          return false;
        if (categoryFilter !== "all" && category !== categoryFilter)
          return false;
        if (!q) return true;
        return (
          asset.name.toLowerCase().includes(q) ||
          asset.assetId.toLowerCase().includes(q) ||
          asset.symbolPrefix.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.asset.name.localeCompare(b.asset.name));
  }, [
    data,
    issuerPdaMap,
    pdaMap,
    profileMap,
    query,
    statusFilter,
    categoryFilter,
  ]);

  // Drafts an admin can activate now (the Assets menu count).
  const readyCount = useMemo(
    () =>
      (data?.assets ?? []).filter(
        (asset) => activationBlockOf(asset, issuerPdaMap.get(asset.issuer.toString())) === null,
      ).length,
    [data, issuerPdaMap],
  );

  // Per-category counts for the chip badges (respecting only the search query).
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!data) return counts;
    const q = query.trim().toLowerCase();
    for (const asset of data.assets) {
      if (
        q &&
        !asset.name.toLowerCase().includes(q) &&
        !asset.assetId.toLowerCase().includes(q) &&
        !asset.symbolPrefix.toLowerCase().includes(q)
      )
        continue;
      const assetPda = pdaMap.get(asset.assetId);
      const profile = assetPda ? profileMap.get(assetPda) : undefined;
      const category = profile?.category ?? slugForEnum(asset.assetType);
      counts[category] = (counts[category] ?? 0) + 1;
    }
    return counts;
  }, [data, pdaMap, profileMap, query]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load asset directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, asset ID or symbol…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "ready", "draft", "active", "frozen", "wound-down"] as const).map(
            (s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  statusFilter === s
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {s === "all"
                  ? "All"
                  : s === "ready"
                    ? `Ready to activate (${readyCount})`
                    : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ),
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Create asset
        </button>
      </div>

      {/* Category segmented filter */}
      <div className="flex flex-wrap gap-1.5">
        {(["all", ...CATEGORY_SLUGS] as CategoryFilter[]).map((c) => {
          const active = categoryFilter === c;
          const label =
            c === "all" ? "All" : assetTypeBySlug(c)?.title ?? c;
          const count = c === "all" ? undefined : categoryCounts[c] ?? 0;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {label}
              {count !== undefined && (
                <span
                  className={`rounded-full px-1.5 text-[10px] ${
                    active ? "bg-white/20" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.assets.length === 0
              ? "No assets registered yet."
              : "No assets match the current filter."}
          </p>
          {data.assets.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Create the first asset
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Issuer</th>
                <th className="px-4 py-3 text-right font-medium">Classes</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ asset, issuer, assetPda, profile, category }) => {
                const title = profile?.display_name || asset.name;
                const block = activationBlockOf(asset, issuer);
                const blockHint =
                  block === "issuerNotVerified" || block === "noShareClasses"
                    ? ACTIVATION_BLOCK_HINT[block]
                    : undefined;
                const categoryLabel =
                  (category && assetTypeBySlug(category)?.title) ||
                  ASSET_TYPE_LABEL[asset.assetType] ||
                  "?";
                const href = assetPda
                  ? `/admin/assets/${assetPda}`
                  : undefined;
                return (
                  <tr
                    key={assetPda ?? `${asset.issuer}:${asset.assetId}`}
                    className="transition-colors hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {asset.assetId} · {asset.symbolPrefix}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{categoryLabel}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {issuer ? fromBytes32(issuer.legalEntityId) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {asset.shareClassesCount}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          STATUS_BADGE[asset.status] ?? STATUS_BADGE[0]
                        }`}
                      >
                        {ASSET_STATUS_LABEL[asset.status] ?? "?"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {asset.status === AssetStatus.Draft && assetPda && (
                          <button
                            type="button"
                            disabled={
                              !wallet ||
                              tx.isSending ||
                              hasAdminRecord === false ||
                              blockHint !== undefined
                            }
                            title={
                              blockHint ??
                              (hasAdminRecord === false
                                ? "activate_asset requires an on-chain AdminRecord — grant this wallet one on /admin/admins first"
                                : undefined)
                            }
                            onClick={() =>
                              setActivateTarget({ asset, assetPda })
                            }
                            className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            Activate
                          </button>
                        )}
                        {href ? (
                          <Link
                            href={href}
                            className="text-xs font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
                          >
                            Manage →
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">…</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={activateTarget !== null}
        kind="info"
        title="Activate asset"
        description={
          <>
            Activate{" "}
            <span className="font-medium">
              {activateTarget?.asset.name ?? ""}
            </span>{" "}
            ({activateTarget?.asset.assetId ?? ""})? The asset leaves Draft and
            becomes operational — share classes can be minted and traded.
          </>
        }
        confirmLabel="Activate"
        busy={tx.isSending}
        onClose={() => setActivateTarget(null)}
        onConfirm={(reason) => activateAsset(reason)}
      />

      {showCreate && (
        <AssetCreateModal
          variant="admin"
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void refresh();
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}
