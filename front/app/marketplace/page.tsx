"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findIssuerPda,
  SaleStatus,
  type Asset,
  type AssetType,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { withoutArchived } from "@/lib/archive-client";
import { fromBytes32 } from "@/lib/format";
import { assetHref, withAssetAddresses } from "@/lib/asset-links";
import { MANCI_MAINNET_ASSET } from "@/lib/manci-token";
import { SkeletonTable } from "@/components/skeleton";
import { assetClassOffered, navHrefVisible } from "@/lib/pilot-scope";
import { ASSET_TYPES, slugForEnum } from "@/lib/asset-types";
import { listAssetProfiles, type PublicAssetProfile } from "@/lib/asset-profiles";
import {
  assetKindLabel,
  countryLabel,
  publicAssetName,
  publicAssetSummary,
  publicCompanyName,
  unitPercent,
  verificationLabel,
} from "@/lib/asset-presentation";
import { AssetLogo } from "@/components/asset-logo";
import {
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Section,
  SectionHead,
} from "@/components/mx";

// Filter choices describe offered products; existing asset records remain readable.
const TYPE_FILTER = [
  { v: "all", label: "All types" },
  ...ASSET_TYPES.filter((type) => assetClassOffered(type.slug)).map((type) => ({ v: String(type.enumValue), label: type.title })),
];

export default function MarketplacePage() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  // Published profiles by asset PDA: the name and summary a visitor reads (lib/asset-presentation.ts).
  const [profiles, setProfiles] = useState<Map<string, PublicAssetProfile>>(new Map());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const refresh = useCallback(async () => {
    try {
      // Archived issuers and assets are not offered (lib/archive.ts).
      const [network, published] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)).then(withoutArchived),
        // The registry is still shown, under its on-chain names, when the published profiles cannot be read.
        listAssetProfiles().catch(() => [] as PublicAssetProfile[]),
      ]);
      setData(network);
      setProfiles(new Map(published.map((profile) => [profile.asset_pda, profile])));
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
    const nameOf = (a: Asset) => publicAssetName(a.name, profiles.get(assetPdaMap.get(a) ?? ""));
    return data.assets
      .filter((a) => {
        if (typeFilter !== "all" && String(a.assetType) !== typeFilter)
          return false;
        if (!q) return true;
        // The identifiers stay searchable for whoever knows them; they are not printed on the cards.
        const company = publicCompanyName(profiles.get(assetPdaMap.get(a) ?? "")) ?? "";
        return [nameOf(a), company, a.name, a.assetId, a.symbolPrefix].some((field) => field.toLowerCase().includes(q));
      })
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [data, query, typeFilter, profiles, assetPdaMap]);

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      issuers: data.issuers.length,
      verifiedIssuers: data.issuers.filter((i) => i.kybStatus === 1).length,
      assets: data.assets.length,
      activeSales: data.sales.filter((s) => s.status === SaleStatus.Open).length,
    };
  }, [data]);

  // Primary sales paused (KYC-only mode, lib/pilot-scope.ts): no sales count,
  // card or link, as on the overview.
  const salesOn = navHrefVisible("/marketplace/launchpad");
  // A count of zero says nothing about a company: once the registry is read, it is not shown.
  const statItems = [
    { k: "Companies", v: stats?.issuers },
    { k: "Verified companies", v: stats?.verifiedIssuers },
    { k: "Tokens listed", v: stats?.assets },
    ...(salesOn ? [{ k: "Open sales", v: stats?.activeSales }] : []),
  ].filter((item) => item.v === undefined || item.v > 0);
  const statColumns = ["", "sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3", "sm:grid-cols-4"][statItems.length] ?? "sm:grid-cols-4";
  const marketCards = [
    { href: "/marketplace/launchpad", title: "Primary sales", body: "Buy share-class units directly from issuers on the launchpad." },
    { href: "/marketplace/otc", title: "OTC offers", body: "Buy from existing token holders through hook-aware OTC offers." },
    { href: "/marketplace/governance", title: "Governance", body: "Track active proposals and read snapshot-based outcomes." },
  ].filter((card) => navHrefVisible(card.href));

  return (
    <>
      <PageHeader
        eyebrow="Marketplace"
        title="Discover tokenized assets"
        lede={`Browse registered assets and review issuer information and documents${salesOn ? ", and find available primary sales" : ""}${navHrefVisible("/marketplace/otc") ? " and secondary offers" : ""}.`}
      />

      {/* Live stats */}
      {statItems.length > 0 && <Section>
        <dl className={`grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-mx-rule bg-mx-rule ${statColumns}`}>
          {statItems.map((s) => (
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
      </Section>}

      {/* Assets */}
      <Section>
        <SectionHead
          eyebrow="Tokens"
          title="Listed on Manci"
        />
        <div className="mb-5 mt-6 flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="min-w-[280px] flex-1 rounded-[3px] border border-mx-rule-strong bg-mx-surface px-3 py-2 text-sm text-mx-ink outline-none placeholder:text-mx-ink-faint focus:border-mx-indigo"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-[3px] border border-mx-rule-strong bg-mx-surface px-3 py-2 text-sm text-mx-ink focus:border-mx-indigo focus:outline-none"
          >
            {/* Offered asset classes only (lib/asset-classes.ts); mapped
                through the enum, whose order differs from CATEGORY_SLUGS. */}
            {TYPE_FILTER.filter((t) => t.v === "all" || assetClassOffered(slugForEnum(Number(t.v) as AssetType))).map((t) => (
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
              const pda = assetPdaMap.get(a) ?? "";
              const profile = profiles.get(pda);
              const name = publicAssetName(a.name, profile);
              const summary = publicAssetSummary(profile);
              const isManciCaseStudy = pda === MANCI_MAINNET_ASSET && profile?.network === "mainnet";
              const company = publicCompanyName(profile);
              const issuerLegal = issuerPdaMap.get(a.issuer.toString());
              const issuer = data.issuers.find(
                (i) => fromBytes32(i.legalEntityId) === issuerLegal,
              );
              const country = countryLabel(issuer?.jurisdiction);
              const oneToken = unitPercent(profile?.token_percent_e4);
              // Tokens held outside the issuer's cap: the circulating supply of the asset's classes.
              const circulating = data.shareClasses
                .filter((sc) => pda !== "" && sc.asset.toString() === pda)
                .reduce((sum, sc) => sum + sc.circulatingSupply, BigInt(0));
              return (
                <Link
                  key={pda || `${a.issuer.toString()}:${a.assetId}`}
                  // Until PDAs resolve, the legacy assetId link still lands on
                  // the detail page, which disambiguates duplicates itself.
                  href={assetHref(pda || a.assetId)}
                  className="mx-card mx-card--link block"
                >
                  <div className="flex items-start gap-3">
                    <AssetLogo assetPda={pda} name={name} logoPath={profile?.logo_path} size={44} />
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-mx-ink">
                        {name}
                      </p>
                      <p className="mt-0.5 text-xs text-mx-ink-faint">
                        {company ?? assetKindLabel(a.assetType)}{country ? ` · ${country}` : ""}
                      </p>
                    </div>
                  </div>
                  {summary && (
                    <p className={`mt-3 text-sm leading-relaxed text-mx-ink-soft${isManciCaseStudy ? "" : " line-clamp-3"}`}>
                      {summary}
                    </p>
                  )}
                  <dl className="mt-4 space-y-1.5 text-xs">
                    {oneToken && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-mx-ink-faint">One token</dt>
                        <dd className="font-medium text-mx-ink-soft">
                          {oneToken} % of the company
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">In circulation</dt>
                      <dd className="font-medium text-mx-ink-soft">
                        {circulating.toLocaleString("en-US")} {circulating === BigInt(1) ? "token" : "tokens"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-mx-ink-faint">Verification</dt>
                      <dd
                        className={`text-right font-semibold ${
                          issuer?.kybStatus === 1
                            ? "text-emerald-700"
                            : "text-mx-amber"
                        }`}
                      >
                        {verificationLabel(issuer?.kybStatus)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-xs text-mx-indigo underline-offset-2">
                    View token →
                  </p>
                </Link>
              );
            })}
          </Grid>
        )}
      </Section>

      {/* Linked sections: only the markets in scope (lib/pilot-scope.ts). */}
      {marketCards.length > 0 && (
        <Section>
          <SectionHead eyebrow="Trade & track" title="Where the market happens" />
          <div className="mt-6">
            <Grid cols={3}>
              {marketCards.map((card) => (
                <Card key={card.href} href={card.href} title={card.title} body={card.body} />
              ))}
            </Grid>
          </div>
        </Section>
      )}
    </>
  );
}
