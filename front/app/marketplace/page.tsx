"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findIssuerPda,
  SaleStatus,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_TYPE_LABEL, fromBytes32, KYB_LABEL } from "@/lib/format";
import { assetHref, withAssetAddresses } from "@/lib/asset-links";
import type { Asset } from "@/lib/generated/asset_registry";
import { SkeletonTable } from "@/components/skeleton";
import {
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Section,
  SectionHead,
} from "@/components/mx";

// Derived from ASSET_TYPE_LABEL so the filter always mirrors the on-chain
// AssetType enum order and covers all 8 categories.
const TYPE_FILTER = [
  { v: "all", label: "All types" },
  ...ASSET_TYPE_LABEL.map((label, i) => ({ v: String(i), label })),
];

export default function MarketplacePage() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Issuer PDA → legal-entity-id label.
  const [issuerPdaMap, setIssuerPdaMap] = useState<Map<string, string>>(
    new Map(),
  );
  // Asset PDA per (issuer, assetId) — the public identity used in links/keys.
  const [assetPdaMap, setAssetPdaMap] = useState<Map<Asset, string>>(
    new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!data) return;
      const am = new Map<Asset, string>();
      for (const { asset, address } of await withAssetAddresses(data.assets)) {
        am.set(asset, address);
      }
      if (!cancelled) setAssetPdaMap(am);
      const im = new Map<string, string>();
      for (const issuer of data.issuers) {
        const [pda] = await findIssuerPda({
          legalEntityId: issuer.legalEntityId,
        });
        im.set(pda.toString(), fromBytes32(issuer.legalEntityId));
      }
      if (!cancelled) setIssuerPdaMap(im);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const filteredAssets = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.assets
      .filter((a) => {
        if (typeFilter !== "all" && String(a.assetType) !== typeFilter)
          return false;
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          a.assetId.toLowerCase().includes(q) ||
          a.symbolPrefix.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, query, typeFilter]);

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      issuers: data.issuers.length,
      verifiedIssuers: data.issuers.filter((i) => i.kybStatus === 1).length,
      assets: data.assets.length,
      shareClasses: data.shareClasses.length,
      activeSales: data.sales.filter((s) => s.status === SaleStatus.Open).length,
    };
  }, [data]);

  return (
    <>
      <PageHeader
        eyebrow="Marketplace"
        title="Discover tokenized assets"
        lede="Every asset registered on Manci — equity, debt, revenue share, real estate and more — backed by an on-chain custodial flow and a verified issuer."
      />

      {/* Live stats */}
      <Section>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-mx-rule bg-mx-rule sm:grid-cols-5">
          {[
            { k: "Issuers", v: stats?.issuers },
            { k: "Verified issuers", v: stats?.verifiedIssuers },
            { k: "Assets", v: stats?.assets },
            { k: "Share classes", v: stats?.shareClasses },
            { k: "Active sales", v: stats?.activeSales },
          ].map((s) => (
            <div key={s.k} className="bg-mx-surface px-4 py-3.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                {s.k}
              </dt>
              <dd className="mt-1 font-mono text-xl text-mx-ink">
                {stats ? String(s.v) : "…"}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* Assets */}
      <Section>
        <SectionHead
          eyebrow="Assets"
          title="Registered assets"
        />
        <div className="mb-5 mt-6 flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by asset name, ID or symbol…"
            className="min-w-[280px] flex-1 rounded-[3px] border border-mx-rule-strong bg-mx-surface px-3 py-2 text-sm text-mx-ink outline-none placeholder:text-mx-ink-faint focus:border-mx-indigo"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-[3px] border border-mx-rule-strong bg-mx-surface px-3 py-2 text-sm text-mx-ink focus:border-mx-indigo focus:outline-none"
          >
            {TYPE_FILTER.map((t) => (
              <option key={t.v} value={t.v}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {failed ? (
          <p className="text-sm text-mx-amber">Failed to load.</p>
        ) : data === null ? (
          <SkeletonTable rows={4} cols={4} />
        ) : filteredAssets.length === 0 ? (
          <EmptyState
            title={
              data.assets.length === 0
                ? "No assets registered yet on the platform."
                : "No assets match the current filter."
            }
          />
        ) : (
          <Grid cols={3}>
            {filteredAssets.map((a) => {
              const issuerLegal = issuerPdaMap.get(a.issuer.toString());
              const issuer = data.issuers.find(
                (i) => fromBytes32(i.legalEntityId) === issuerLegal,
              );
              return (
                <Link
                  key={assetPdaMap.get(a) ?? `${a.issuer.toString()}:${a.assetId}`}
                  // Until PDAs resolve, the legacy assetId link still lands on
                  // the detail page, which disambiguates duplicates itself.
                  href={assetHref(assetPdaMap.get(a) ?? a.assetId)}
                  className="mx-card mx-card--link block"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold text-mx-ink">
                        {a.name}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-mx-ink-faint">
                        {a.assetId} · {a.symbolPrefix}
                      </p>
                    </div>
                    <Badge>{ASSET_TYPE_LABEL[a.assetType] ?? "?"}</Badge>
                  </div>
                  <dl className="mt-4 space-y-1.5 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">Issuer</dt>
                      <dd className="font-medium text-mx-ink-soft">
                        {issuerLegal ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">Share classes</dt>
                      <dd className="font-mono text-mx-ink-soft">
                        {a.shareClassesCount}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">Jurisdiction</dt>
                      <dd className="font-mono text-mx-ink-soft">
                        {issuer?.jurisdiction ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">KYB</dt>
                      <dd
                        className={`text-xs font-semibold ${
                          issuer?.kybStatus === 1
                            ? "text-emerald-700"
                            : "text-mx-amber"
                        }`}
                      >
                        {issuer ? KYB_LABEL[issuer.kybStatus] : "—"}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-xs text-mx-indigo underline-offset-2">
                    Open profile →
                  </p>
                </Link>
              );
            })}
          </Grid>
        )}
      </Section>

      {/* Linked sections */}
      <Section>
        <SectionHead eyebrow="Trade & track" title="Where the market happens" />
        <div className="mt-6">
          <Grid cols={3}>
            <Card
              href="/marketplace/launchpad"
              title="Primary sales"
              body="Buy share-class units directly from issuers on the launchpad."
            />
            <Card
              href="/marketplace/otc"
              title="OTC offers"
              body="Buy from existing token holders through hook-aware OTC offers."
            />
            <Card
              href="/marketplace/governance"
              title="Governance"
              body="Track active proposals and read snapshot-based outcomes."
            />
          </Grid>
        </div>
      </Section>
    </>
  );
}
