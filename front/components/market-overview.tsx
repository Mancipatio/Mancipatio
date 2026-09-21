"use client";

import Link from "next/link";
import { AccountMenu } from "@/components/account-menu";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { IconArrowUpRight, IconLayers, IconRocket, IconRepeat, IconLock, IconWallet, IconShield, IconFile, IconCoins, IconBox, IconGavel } from "@/components/icons";
import { ASSET_TYPES } from "@/lib/asset-types";
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL } from "@/lib/format";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { buildMarketOverview, type MarketAssetRow, type MarketOverview as OverviewData } from "@/lib/market-overview";
import { loadPositionsForWallet, loadSeriesByPda, positionClaimable, VestingSeriesStatus } from "@/lib/vesting-series";

const categoryCopy: Record<string, { label: string; right: string; action: string }> = {
  equity: { label: "Equity", right: "Company & shareholder rights", action: "Explore ownership" },
  debt: { label: "Debt", right: "Principal & interest", action: "Explore debt" },
  real_estate: { label: "Real estate", right: "Property & rental rights", action: "Explore property" },
  royalty: { label: "Royalties", right: "Intellectual property income", action: "Explore royalties" },
  revenue_share: { label: "Revenue share", right: "A share of business revenue", action: "Explore revenue" },
  commodity: { label: "Commodities", right: "Fungible goods & redemption", action: "Explore goods" },
  physical: { label: "Physical assets", right: "Unique goods & delivery", action: "Explore assets" },
  other: { label: "Other assets", right: "Rights defined by the issuer", action: "Explore instruments" },
};

function withDeadline<T>(task: Promise<T>, milliseconds = 18000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The network did not respond in time.")), milliseconds);
    task.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function marketAction(row: MarketAssetRow, market: string) {
  if (market === "otc") return row.offers.length === 1
    ? { href: row.offers[0].href, label: "View offer" }
    : { href: "/marketplace/otc", label: "View offers" };
  if (row.sales.length === 1) return { href: row.sales[0].href, label: "View sale" };
  if (row.offers.length === 1 && !row.sales.length) return { href: row.offers[0].href, label: "View offer" };
  return { href: row.href, label: "View asset" };
}

function VestingSummary({ wallet, revision }: { wallet: string; revision: number }) {
  const client = useSolanaClient();
  const [state, setState] = useState<{ positions: number; ready: number; next: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const positions = await withDeadline(loadPositionsForWallet(client.runtime.rpc, wallet));
        const seriesIds = [...new Set(positions.map((p) => p.account.series.toString()))];
        const series = await withDeadline(Promise.all(seriesIds.map(async (id) => [id, await loadSeriesByPda(client.runtime.rpc, id)] as const)));
        if (series.some(([, value]) => value === null)) throw new Error("Some vesting schedules could not be loaded.");
        const seriesMap = new Map(series);
        const now = Math.floor(Date.now() / 1000);
        let ready = 0;
        const future: number[] = [];
        for (const position of positions) {
          const schedule = seriesMap.get(position.account.series.toString());
          if (!schedule) continue;
          if (positionClaimable(schedule, position.account, now) > BigInt(0)) ready += 1;
          if (schedule.status !== VestingSeriesStatus.Cancelled && position.account.allocation > position.account.released) {
            for (const tranche of schedule.tranches) {
              if (Number(tranche.unlockTs) > now) future.push(Number(tranche.unlockTs));
            }
          }
        }
        if (!cancelled) { setState({ positions: positions.length, ready, next: future.length ? Math.min(...future) : null }); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
    }
    void load();
    return () => { cancelled = true; };
  }, [client, wallet, attempt, revision]);
  if (failed) return <div className="overview-inline-error" role="status">Vesting data is unavailable. <button onClick={() => { setFailed(false); setAttempt((v) => v + 1); }}>Try again</button></div>;
  if (!state) return <p className="overview-muted" role="status">Loading your vesting positions…</p>;
  return <>
    <div className="overview-vesting-numbers"><div><strong>{state.positions}</strong><span>Positions</span></div><div><strong className={state.ready ? "overview-green" : ""}>{state.ready}</strong><span>Ready to release</span></div></div>
    <div className="overview-next-unlock"><span>Next scheduled unlock</span><strong>{state.next ? new Date(state.next * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "No upcoming unlock"}</strong></div>
    {state.next && <p className="overview-fineprint">Schedule date in UTC. Release depends on funding and series terms.</p>}
  </>;
}

export function MarketOverview() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const wallet = conn.connected ? conn.wallet?.account.address.toString() : undefined;
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [vestingRevision, setVestingRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [market, setMarket] = useState("all");
  const [sort, setSort] = useState("availability");
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    setVestingRevision((value) => value + 1);
    try {
      const result = await withDeadline(loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)));
      const model = await buildMarketOverview(result, Math.floor(Date.now() / 1000));
      if (request !== generation.current) return;
      setOverview(model);
      setUpdatedAt(new Date());
    } catch { if (request === generation.current) setFailed(true); }
    finally { if (request === generation.current) setLoading(false); }
  }, [client]);
  useEffect(() => {
    // Refresh owns the loading state for both the initial request and retries.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  const rows = (overview?.rows ?? []).filter((row) => {
    const term = query.trim().toLowerCase();
    return (category === "all" || String(row.asset.assetType) === category)
      && (market === "all" || (market === "primary" ? row.sales.length > 0 : row.offers.length > 0))
      && (!term || [row.asset.name, row.asset.assetId, row.asset.symbolPrefix, row.issuerLegalId ?? ""].some((field) => field.toLowerCase().includes(term)));
  }).sort((a, b) => sort === "name" ? a.asset.name.localeCompare(b.asset.name) : (b.sales.length + b.offers.length) - (a.sales.length + a.offers.length) || a.asset.name.localeCompare(b.asset.name));
  const pageCount = Math.ceil(rows.length / 8);
  const visiblePage = Math.min(page, Math.max(0, pageCount - 1));
  const displayedRows = rows.slice(visiblePage * 8, visiblePage * 8 + 8);
  const counts = overview?.counts;
  const setCategoryFilter = (value: string) => { setCategory(value); setPage(0); };
  const statItems = [
    { label: "Registered assets", value: counts?.assets, detail: counts ? `${counts.activeAssets} active in the registry` : "Across all asset categories", icon: IconLayers, href: "/marketplace" },
    { label: "Open primary sales", value: counts?.availableSales, detail: "Current sale windows", icon: IconRocket, href: "/marketplace/launchpad" },
    { label: "Funded OTC offers", value: counts?.fundedOffers, detail: "Escrow funded · not expired", icon: IconRepeat, href: "/marketplace/otc" },
    { label: "Verified issuers", value: counts?.verifiedIssuers, detail: counts ? `Of ${counts.issuers} registered issuers` : "Issuer verification status", icon: IconShield, href: "/marketplace" },
  ];
  const filtered = category !== "all" || market !== "all" || !!query;
  return (
    <div className="overview">
      <div className="overview-heading"><div><div className="overview-eyebrow"><span /> THE REAL-WORLD ASSET WORKSPACE</div><h1>Market overview<span>.</span></h1><p>Explore assets. Find your next opportunity. Manage what you own.</p></div><div className="overview-heading-actions"><button className="overview-button" onClick={() => void refresh()} disabled={loading}><span className={loading ? "overview-refresh-spin" : ""} aria-hidden="true">↻</span>{loading ? "Refreshing" : "Refresh"}</button><Link href="/portfolio" className="overview-button overview-button-dark"><IconWallet size={16} />My portfolio <span aria-hidden="true">↗</span></Link><div className="overview-account"><AccountMenu /></div></div></div>
      <div className="overview-stats">{statItems.map(({ label, value, detail, icon: Icon, href }) => <Link className="overview-stat" href={href} key={label}><div className="overview-stat-label">{label}<Icon size={18} /></div><div className="overview-stat-number">{value === undefined ? <span className="overview-value-placeholder">{failed ? "Unavailable" : "…"}</span> : value.toLocaleString("en")}</div><div className="overview-stat-detail">{detail}<span aria-hidden="true">↗</span></div></Link>)}</div>
      <div className="overview-section-heading"><h2>Explore by asset class</h2><Link href="/markets/types">Compare rights & structures <span aria-hidden="true">↗</span></Link></div>
      <div className="overview-categories" aria-label="Filter assets by category">{ASSET_TYPES.map((type) => <button key={type.slug} className={`overview-category ${category === String(type.enumValue) ? "is-selected" : ""}`} aria-pressed={category === String(type.enumValue)} onClick={() => setCategoryFilter(category === String(type.enumValue) ? "all" : String(type.enumValue))}><span className={`overview-category-icon category-${type.slug}`}>{type.icon}</span><strong>{categoryCopy[type.slug].label}</strong><span>{overview ? `${overview.rows.filter((row) => row.asset.assetType === type.enumValue).length} assets` : "Explore"}</span></button>)}</div>
      <div className="overview-main-grid">
        <div className="overview-market-column">
          <section className="overview-panel overview-market-panel" aria-labelledby="market-heading">
            <div className="overview-panel-heading"><div><h2 id="market-heading">The marketplace <span className="overview-count">{overview ? rows.length : "…"}</span></h2><p>Assets, availability and the next step.</p></div><Link href="/marketplace" className="overview-icon-link" aria-label="Open full asset directory"><IconArrowUpRight size={20} /></Link></div>
            <div className="overview-market-tabs" aria-label="Market filter">{[{ value: "all", label: "All assets" }, { value: "primary", label: "Primary sales" }, { value: "otc", label: "OTC offers" }].map((tab) => <button key={tab.value} aria-pressed={market === tab.value} className={market === tab.value ? "is-active" : ""} onClick={() => { setMarket(tab.value); setPage(0); }}>{tab.label}{overview && tab.value !== "all" && <span>{tab.value === "primary" ? counts?.availableSales : counts?.fundedOffers}</span>}</button>)}</div>
            <div className="overview-filters"><label className="overview-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg><input aria-label="Search assets" placeholder="Search assets, symbols or issuers…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label><select aria-label="Asset category" value={category} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{ASSET_TYPES.map((type) => <option value={String(type.enumValue)} key={type.slug}>{categoryCopy[type.slug].label}</option>)}</select><select aria-label="Sort assets" value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}><option value="availability">Availability</option><option value="name">Name A–Z</option></select></div>
            {failed && <div className="overview-error" role="alert"><IconShield size={20} /><div><strong>{overview ? "Refresh failed. Showing the previous snapshot." : "Market data is temporarily unavailable."}</strong><p>{overview ? "Open an asset to verify its current availability." : "The network could not be reached. Retry to load the registry."}</p></div><button onClick={() => void refresh()} disabled={loading}>Retry</button></div>}
            {overview ? displayedRows.length ? <div className="overview-table-scroll"><table className="overview-table"><caption className="sr-only">Registered assets with primary sales and funded OTC offers</caption><thead><tr><th>Asset / issuer</th><th>Category</th><th>Availability</th><th>Action</th></tr></thead><tbody>{displayedRows.map((row) => <tr key={row.address}><td><Link href={row.href} className="overview-asset"><span className={`overview-asset-avatar category-${ASSET_TYPES.find((t) => t.enumValue === row.asset.assetType)?.slug ?? "other"}`}>{row.asset.symbolPrefix.slice(0, 2) || row.asset.name.slice(0, 2)}</span><span><strong>{row.asset.name}</strong><small>{row.asset.symbolPrefix}{row.issuerLegalId ? ` · ${row.issuerLegalId}` : ""}{row.issuerKybStatus === 1 && <span className="overview-verified" title="Issuer KYB verified" aria-label="Issuer KYB verified">✓</span>}</small></span></Link></td><td><span className="overview-type-label">{ASSET_TYPE_LABEL[row.asset.assetType]}</span><small>{row.shareClasses.length} share {row.shareClasses.length === 1 ? "class" : "classes"}</small></td><td>{row.sales.length > 0 && <span className="overview-status overview-status-green"><i />{row.sales.length} primary {row.sales.length === 1 ? "sale" : "sales"}</span>}{row.offers.length > 0 && <span className="overview-status overview-status-otc">{row.offers.length} OTC {row.offers.length === 1 ? "offer" : "offers"}</span>}{!row.sales.length && !row.offers.length && <span className="overview-status">{row.asset.status === 1 ? "No open market" : ASSET_STATUS_LABEL[row.asset.status]}</span>}</td><td><Link className="overview-row-action" href={marketAction(row, market).href}>{marketAction(row, market).label}<span aria-hidden="true">↗</span></Link></td></tr>)}</tbody></table></div> : <div className="overview-empty"><span className="overview-empty-icon"><IconLayers size={26} /></span><h3>{filtered ? "No assets match your filters" : "The next market starts here"}</h3><p>{filtered ? "Try another asset class or clear your filters to see the full registry." : "No assets are available in this registry snapshot. Explore the supported asset classes or start an equity raise."}</p>{filtered ? <button className="overview-button" onClick={() => { setQuery(""); setCategory("all"); setMarket("all"); setPage(0); }}>Clear filters</button> : <Link className="overview-button" href="/apply">Create a raise ↗</Link>}</div> : !failed && <div className="overview-table-loading" role="status" aria-label="Loading market data">{[0, 1, 2, 3].map((item) => <div key={item}><span /><span /><span /></div>)}</div>}
            <div className="overview-table-footer"><span>{updatedAt ? `Snapshot loaded ${updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · Verify terms before buying` : "Registry data · No wallet needed to explore"}</span>{pageCount > 1 && <div><button disabled={visiblePage === 0} aria-label="Previous page" onClick={() => setPage(visiblePage - 1)}>←</button><span>{visiblePage + 1} / {pageCount}</span><button disabled={visiblePage + 1 >= pageCount} aria-label="Next page" onClick={() => setPage(visiblePage + 1)}>→</button></div>}</div>
          </section>
          <section className="overview-journey" aria-labelledby="rights-heading"><div className="overview-section-heading"><h2 id="rights-heading">More than holding a token</h2><Link href="/how-it-works">How it works ↗</Link></div><div className="overview-journey-grid">{[{ href: "/portfolio/rights", icon: IconCoins, title: "Income & rights", text: "Review distributions and claim rights attached to your holdings." }, { href: "/portfolio/delivery", icon: IconBox, title: "Redeem & receive", text: "Request physical delivery and follow its escrow status." }, { href: "/portfolio/governance", icon: IconGavel, title: "Have your say", text: "Review proposals and exercise your voting rights." }].map(({ href, icon: Icon, title, text }) => <Link href={href} key={title}><Icon size={20} /><h3>{title}<span aria-hidden="true">↗</span></h3><p>{text}</p></Link>)}</div></section>
        </div>
        <aside className="overview-right-column" aria-label="Your workspace and asset guidance">
          {wallet ? <section className="overview-wallet-card"><span className="overview-card-eyebrow"><IconWallet size={17} /> YOUR WORKSPACE</span><h2>Your assets. Your next move.</h2><p>Open your portfolio to review holdings, income, active deals and pending actions.</p><Link href="/portfolio" className="overview-wallet-cta">Open portfolio <span>↗</span></Link><div className="overview-wallet-note"><IconShield size={14} />Transactions require your wallet approval</div></section> : <WalletRequired />}
          <section className="overview-panel overview-vesting-card"><div className="overview-panel-heading"><h2><IconLock size={18} />Vesting & unlocks</h2><span className="overview-mini-label">SCHEDULES</span></div><div className="overview-vesting-body">{wallet ? <VestingSummary key={wallet} wallet={wallet} revision={vestingRevision} /> : <><div className="overview-vesting-track" aria-hidden="true"><span /><span /><span /><span /></div><h3>A clear view of what unlocks next.</h3><p>See scheduled releases, available claims and the terms of each vesting position after connecting.</p></>}<Link className="overview-full-link" href="/portfolio/vesting">View my vesting <span aria-hidden="true">↗</span></Link><Link className="overview-secondary-link" href="/issuer/vesting-series">Create a vesting series <span aria-hidden="true">↗</span></Link></div></section>
          <section className="overview-panel overview-guide-card"><span className="overview-card-eyebrow"><IconFile size={16} /> KNOW WHAT YOU OWN</span><h3>{category === "all" ? "Every asset has a different set of rights." : categoryCopy[ASSET_TYPES.find((t) => String(t.enumValue) === category)!.slug].right}</h3><p>Check the issuer, legal documents, transfer rules and exit conditions before you participate.</p><Link href={category === "all" ? "/markets/types" : `/markets/types/${ASSET_TYPES.find((t) => String(t.enumValue) === category)!.slug}`}>Read the asset guide <span aria-hidden="true">↗</span></Link></section>
        </aside>
      </div>
    </div>
  );
}
