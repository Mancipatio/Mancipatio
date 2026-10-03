"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssetStatus,
  findAssetPda,
  findIssuerPda,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL, fromBytes32 } from "@/lib/format";
import { SkeletonTable } from "@/components/skeleton";
import { AssetCreateModal } from "@/components/asset-create-modal";
import {
  assetTypeBySlug,
  CATEGORY_SLUGS,
  slugForEnum,
  type CategorySlug,
} from "@/lib/asset-types";
import { getPrivateAssetProfiles as getAssetProfiles, type AssetProfile } from "@/lib/asset-profiles";
import { ArchiveDialog } from "@/components/archive-dialog";
import { useArchivedSet } from "@/lib/archive-client";

const STATUS_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-brand-100 text-brand-800 border-brand-200",
  3: "bg-slate-200 text-slate-700 border-slate-300",
};

export default function MyAssetsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<Issuer | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
      if (wallet) {
        const found = network.issuers.find(
          (i) => i.authority.toString() === wallet.toString(),
        );
        setMe(found ?? null);
      } else {
        setMe(null);
      }
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const [myIssuerPda, setMyIssuerPda] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function derive() {
      if (!me) {
        setMyIssuerPda(null);
        return;
      }
      const [pda] = await findIssuerPda({ legalEntityId: me.legalEntityId });
      if (!cancelled) setMyIssuerPda(pda.toString());
    }
    void derive();
    return () => {
      cancelled = true;
    };
  }, [me]);

  const [categoryFilter, setCategoryFilter] = useState<"all" | CategorySlug>(
    "all",
  );

  const myAssets = useMemo(() => {
    if (!data || !myIssuerPda) return [];
    return data.assets
      .filter((a) => a.issuer.toString() === myIssuerPda)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, myIssuerPda]);

  const [pdaMap, setPdaMap] = useState<Map<string, string>>(new Map());
  const [profileMap, setProfileMap] = useState<Map<string, AssetProfile>>(
    new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const m = new Map<string, string>();
      for (const a of myAssets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        m.set(a.assetId, pda.toString());
      }
      if (cancelled) return;
      setPdaMap(m);
      setProfileMap(new Map());
      if (!conn.wallet) return;
      try {
        const profiles = await getAssetProfiles(conn.wallet, [...m.values()]);
        if (!cancelled) setProfileMap(profiles);
      } catch { if (!cancelled) setFailed(true); }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [myAssets, conn.wallet]);

  const categoryOf = useCallback(
    (a: (typeof myAssets)[number]): CategorySlug | "" => {
      const pda = pdaMap.get(a.assetId);
      const profile = pda ? profileMap.get(pda) : undefined;
      return (profile?.category ?? slugForEnum(a.assetType)) as
        | CategorySlug
        | "";
    },
    [pdaMap, profileMap],
  );

  // Archived assets (lib/archive.ts) are hidden unless "Show archived".
  const archivedSet = useArchivedSet();
  const [showArchived, setShowArchived] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ pda: string; label: string; mode: "archive" | "unarchive" } | null>(null);
  const isArchived = useCallback(
    (a: (typeof myAssets)[number]) => {
      const pda = pdaMap.get(a.assetId);
      if (!pda) return false;
      return profileMap.get(pda)?.status === "archived" || !!archivedSet?.assets.has(pda);
    },
    [pdaMap, profileMap, archivedSet],
  );
  const archivedCount = useMemo(() => myAssets.filter(isArchived).length, [myAssets, isArchived]);
  /** The issuer may archive its own asset while it is a Draft or was never minted (the server decides). */
  const issuerMayArchive = useCallback(
    (a: (typeof myAssets)[number], pda: string) => {
      const classes = (data?.shareClasses ?? []).filter((sc) => sc.asset.toString() === pda);
      if (classes.some((sc) => BigInt(sc.circulatingSupply) > BigInt(0))) return false;
      return a.status === AssetStatus.Draft || classes.every((sc) => BigInt(sc.lifetimeMinted) === BigInt(0));
    },
    [data],
  );

  const rows = useMemo(() => {
    const visible = showArchived ? myAssets : myAssets.filter((a) => !isArchived(a));
    if (categoryFilter === "all") return visible;
    return visible.filter((a) => categoryOf(a) === categoryFilter);
  }, [myAssets, categoryFilter, categoryOf, showArchived, isArchived]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of myAssets) {
      const c = categoryOf(a);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [myAssets, categoryOf]);

  const verified = me?.kybStatus === 1;
  const legalId = me ? fromBytes32(me.legalEntityId) : null;

  if (!wallet) return <main><WalletRequired /></main>;

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            My assets
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Tokenized assets
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Every asset registered under your issuer authority.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {verified ? (
            <Link
              href="/issuer/assets/tokenize"
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Tokenize company shares
            </Link>
          ) : (
            <span
              aria-disabled="true"
              title="Verify KYB first to create assets."
              className="cursor-not-allowed rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white opacity-50"
            >
              Tokenize company shares
            </span>
          )}
          <button
            type="button"
            disabled={!verified}
            onClick={() => setShowCreate(true)}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
            title={verified ? undefined : "Verify KYB first to create assets."}
          >
            Other asset types
          </button>
        </div>
      </div>

      {!verified && me && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          KYB pending — asset creation is locked until Super Admin verifies
          your entity.
        </div>
      )}

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : !myIssuerPda ? (
        <NotIssuer />
      ) : myAssets.length === 0 ? (
        <Empty onClick={() => setShowCreate(true)} canCreate={verified} />
      ) : (
        <>
          {/* Category segmented filter */}
          <div className="mt-8 flex flex-wrap gap-1.5">
            {(["all", ...CATEGORY_SLUGS] as ("all" | CategorySlug)[]).map((c) => {
              const active = categoryFilter === c;
              const label = c === "all" ? "All" : assetTypeBySlug(c)?.title ?? c;
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

          {archivedCount > 0 && (
            <label className="mt-3 inline-flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived ({archivedCount})
            </label>
          )}

          {rows.length === 0 ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
              <p className="text-sm text-slate-600">
                No assets in this category.
              </p>
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Asset</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Share classes
                    </th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Manage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((a) => {
                    const pda = pdaMap.get(a.assetId);
                    const profile = pda ? profileMap.get(pda) : undefined;
                    const title = profile?.display_name || a.name;
                    const category = categoryOf(a);
                    const categoryLabel =
                      (category && assetTypeBySlug(category)?.title) ||
                      ASSET_TYPE_LABEL[a.assetType] ||
                      "?";
                    const archived = isArchived(a);
                    return (
                      <tr key={`${a.issuer.toString()}:${a.assetId}`} className={`text-slate-700 ${archived ? "opacity-60" : ""}`}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">
                            {title}
                            {archived && (
                              <span className="ml-2 inline-flex rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                                Archived
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {a.assetId} · {a.symbolPrefix}
                          </p>
                        </td>
                        <td className="px-4 py-3">{categoryLabel}</td>
                        <td className="px-4 py-3 text-right font-mono">
                          {a.shareClassesCount}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[a.status] ?? STATUS_BADGE[0]}`}
                          >
                            {ASSET_STATUS_LABEL[a.status] ?? "?"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-3">
                            {pda && (archived || issuerMayArchive(a, pda)) && (
                              <button
                                type="button"
                                onClick={() => setArchiveTarget({ pda, label: title, mode: archived ? "unarchive" : "archive" })}
                                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                                title={archived ? undefined : "Hide this unused asset from every list (the on-chain record stays)"}
                              >
                                {archived ? "Unarchive" : "Archive"}
                              </button>
                            )}
                            {pda ? (
                              <Link
                                href={`/issuer/assets/${pda}`}
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
        </>
      )}

      {archiveTarget && (
        <ArchiveDialog
          open
          kind="asset"
          pda={archiveTarget.pda}
          label={archiveTarget.label}
          mode={archiveTarget.mode}
          onClose={() => setArchiveTarget(null)}
          onDone={() => refresh()}
        />
      )}

      {showCreate && legalId && (
        <AssetCreateModal
          variant="issuer"
          issuerLegalId={legalId}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void refresh();
            setShowCreate(false);
          }}
        />
      )}
    </main>
  );
}

function NotIssuer() {
  return (
    <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-6">
      <p className="text-sm font-semibold text-amber-900">
        No issuer found for this wallet
      </p>
      <p className="mt-1 text-xs text-amber-900/80">
        Register an issuer first to see your assets here.
      </p>
      <Link
        href="/issuer/onboarding"
        className="mt-3 inline-block rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-950"
      >
        Start onboarding →
      </Link>
    </div>
  );
}

function Empty({
  onClick,
  canCreate,
}: {
  onClick: () => void;
  canCreate: boolean;
}) {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        You haven&apos;t created any assets yet.
      </p>
      {canCreate ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/issuer/assets/tokenize"
            className="inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Tokenize company shares →
          </Link>
          <button
            type="button"
            onClick={onClick}
            className="inline-block rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:border-slate-400"
          >
            Other asset types
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-700">
          Verify KYB to unlock asset creation.
        </p>
      )}
    </div>
  );
}
