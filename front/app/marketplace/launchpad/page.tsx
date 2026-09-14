"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RaiseType } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { SkeletonCard } from "@/components/skeleton";
import { findSalePda } from "@/lib/pdas";
import {
  listPublishedListings,
  getPublicApplications,
  commitmentAggregate,
  type LaunchListing,
  type PublicApplication,
  type CommitAggregate,
} from "@/lib/launchpad";
import { daysLeft, progressPct } from "@/lib/launch-math";
import { fmtMoney } from "@/lib/format";
import { formatPaymentTotal } from "@/lib/commitment-totals";
import { Badge, EmptyState, Grid, PageHeader, Section } from "@/components/mx";

// ── derived card shape ─────────────────────────────────────────────────────
type DealCard = {
  sale_pubkey: string;
  company: string;
  category: string;
  oneLiner: string;
  target: number;
  raised: number;
  settled: string;
  totalsAvailable: boolean;
  soldPercent: number;
  backers: number;
  equity: number | null;
  isStartup: boolean;
  vestingMonths: number;
  dLeft: number;
  logoLetter: string;
  logoGradient: string | null;
};

export default function PublicLaunchpadPage() {
  const client = useSolanaClient();
  const [cards, setCards] = useState<DealCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeCategory, setActiveCategory] = useState("All");

  const load = useCallback(async () => {
    setFailed(false);
    setCards(null);
    try {
      // 1. On-chain sales + off-chain published listings, in parallel
      const [network, listings] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
        listPublishedListings(),
      ]);

      // 2. Build sale-PDA → Sale map
      const salePdaEntries = await Promise.all(
        network.sales.map(async (sale) => {
          const pda = await findSalePda(sale.shareClass, sale.saleId);
          return [pda.toString(), sale] as const;
        }),
      );
      const saleByPda = new Map(salePdaEntries);

      // 3. Only published listings backed by an on-chain sale.
      const matched = listings.filter((l) => saleByPda.has(l.sale_pubkey));

      // 4. Fetch ONLY the applications referenced by matched listings (avoid
      //    pulling the whole applicant table — it carries PII).
      const appIds = Array.from(
        new Set(
          matched
            .map((l) => l.application_id)
            .filter((id): id is string => !!id),
        ),
      );
      // Public read — approved applications only, non-PII columns (the table
      // has no anon SELECT).
      const apps = await getPublicApplications(appIds);
      const appById = new Map<string, PublicApplication>(
        apps.map((a) => [a.id, a]),
      );

      // 5. Commitment aggregates for each matched listing.
      const aggregates = await Promise.all(
        matched.map((l) => commitmentAggregate(l.sale_pubkey)),
      );

      // 5. Derive card data
      const now = Math.floor(Date.now() / 1000);
      const derived: DealCard[] = matched.map(
        (listing: LaunchListing, i: number) => {
          const sale = saleByPda.get(listing.sale_pubkey)!;
          const app: PublicApplication | undefined = listing.application_id
            ? (appById.get(listing.application_id) ?? undefined)
            : undefined;
          const agg: CommitAggregate = aggregates[i];

          const company =
            app?.company_name ??
            `Sale ${listing.sale_pubkey.slice(0, 4)}…${listing.sale_pubkey.slice(-4)}`;
          const category = app?.category ?? "—";
          const oneLiner = app?.one_liner ?? "";
          const target = app?.raise_amount ?? 0;
          const raised = agg.pledged + agg.confirmed;
          const backers =
            sale.raiseType === RaiseType.Startup ? agg.pledgers : agg.backers;
          const equity = app?.equity_offered ?? null;
          const isStartup = sale.raiseType === RaiseType.Startup;
          const vestingMonths = sale.vestingMonths;
          const dLeft = daysLeft(sale.endTs, now);
          const logoLetter = listing.logo_letter ?? company[0] ?? "?";
          const logoGradient = listing.logo_gradient ?? null;

          return {
            sale_pubkey: listing.sale_pubkey,
            company,
            category,
            oneLiner,
            target,
            raised,
            settled: agg.settled,
            totalsAvailable: agg.available,
            soldPercent: progressPct(
              Number(sale.sold),
              Number(sale.totalForSale),
            ),
            backers,
            equity,
            isStartup,
            vestingMonths,
            dLeft,
            logoLetter,
            logoGradient,
          };
        },
      );

      setCards(derived);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Unique non-"—" categories for the filter row
  const categories = useMemo(() => {
    if (!cards) return [];
    const seen = new Set<string>();
    for (const c of cards) {
      if (c.category !== "—") seen.add(c.category);
    }
    return Array.from(seen).sort();
  }, [cards]);

  const filtered = useMemo(() => {
    if (!cards) return [];
    if (activeCategory === "All") return cards;
    return cards.filter((c) => c.category === activeCategory);
  }, [cards, activeCategory]);

  // Reset active category to "All" when cards change and the current category
  // no longer exists.
  useEffect(() => {
    if (
      cards &&
      activeCategory !== "All" &&
      !categories.includes(activeCategory)
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveCategory("All");
    }
  }, [cards, categories, activeCategory]);

  return (
    <>
      <PageHeader
        eyebrow="Equity Launch"
        title="Explore primary offers."
        lede="Review the issuer, sale terms and verified documents. Each asset defines its own ownership, income, transfer and exit rights."
      >
        {cards !== null && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-mx-ink-faint">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {cards.length} live raise{cards.length !== 1 ? "s" : ""}
            </span>
            {/* Category filter pills */}
            {categories.length > 0 &&
              ["All", ...categories].map((cat) => {
                const active = cat === activeCategory;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveCategory(cat)}
                    className={`rounded-[3px] border px-3 py-1 text-[13px] font-medium transition-colors ${
                      active
                        ? "border-mx-indigo bg-mx-indigo-soft text-mx-indigo"
                        : "border-mx-rule-strong text-mx-ink-soft hover:border-mx-indigo"
                    }`}
                  >
                    {cat === "All" ? "All raises" : cat}
                  </button>
                );
              })}
          </div>
        )}
      </PageHeader>

      <Section>
        {failed ? (
          <div className="text-sm text-mx-amber">
            Primary offers are temporarily unavailable.{" "}
            <button
              type="button"
              onClick={() => void load()}
              className="underline underline-offset-2"
            >
              Retry loading
            </button>
          </div>
        ) : cards === null ? (
          <Grid cols={3}>
            {[0, 1, 2].map((i) => (
              <SkeletonCard key={i} rows={4} />
            ))}
          </Grid>
        ) : filtered.length === 0 ? (
          <Empty hasCards={cards.length > 0} category={activeCategory} />
        ) : (
          <Grid cols={3}>
            {filtered.map((card) => (
              <DealCard key={card.sale_pubkey} card={card} />
            ))}
          </Grid>
        )}
      </Section>
    </>
  );
}

// ── DealCard ────────────────────────────────────────────────────────────────
function DealCard({ card }: { card: DealCard }) {
  const {
    sale_pubkey,
    company,
    category,
    oneLiner,
    target,
    raised,
    settled,
    totalsAvailable,
    soldPercent,
    backers,
    equity,
    isStartup,
    vestingMonths,
    dLeft,
    logoLetter,
    logoGradient,
  } = card;

  const pct = isStartup ? progressPct(raised, target) : soldPercent;
  const isClosingSoon = dLeft > 0 && dLeft <= 7;

  return (
    <Link
      href={`/marketplace/launchpad/${sale_pubkey}`}
      className="mx-card mx-card--link group flex flex-col"
    >
      {/* Top row: logo + name + badges */}
      <div className="mb-4 flex items-start gap-3">
        {/* Logo square */}
        <div
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[3px] text-lg font-bold text-white"
          style={
            logoGradient
              ? { background: logoGradient }
              : { background: "var(--mx-indigo)" }
          }
        >
          {logoLetter}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight text-mx-ink">
            {company}
          </p>

          {/* Badges row */}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {category !== "—" && <Badge>{category}</Badge>}
            {isClosingSoon && (
              <span className="inline-flex rounded-[3px] border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                Closing soon
              </span>
            )}
            {isStartup && vestingMonths > 0 && (
              <span className="inline-flex rounded-[3px] border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                Vested {vestingMonths}mo
              </span>
            )}
            {!isStartup && <Badge>Instant payout</Badge>}
          </div>
        </div>
      </div>

      {/* One-liner */}
      {oneLiner && (
        <p className="mb-4 line-clamp-2 text-[13px] leading-relaxed text-mx-ink-soft">
          {oneLiner}
        </p>
      )}

      {/* Progress bar */}
      <div className="mb-4 flex flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-mx-indigo-soft">
          <div
            className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-emerald-600" : "bg-mx-indigo"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-mx-ink-faint">
          {totalsAvailable
            ? `${pct}% ${isStartup ? "pledged" : "of share units sold"}`
            : "Payment totals unavailable"}
          {isStartup && target > 0 && ` · target ${fmtMoney(target)}`}
        </p>
      </div>

      {/* Stats row */}
      <div className="mt-auto flex items-end justify-between border-t border-mx-rule pt-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mx-ink-faint">
            {isStartup ? "Pledged (not paid)" : "Verified payments"}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-semibold text-mx-indigo">
            {!totalsAvailable
              ? "Unavailable"
              : isStartup
                ? fmtMoney(raised)
                : `${formatPaymentTotal(settled)} tokens`}
            {isStartup && target > 0 && (
              <span className="ml-1 text-[11px] font-normal text-mx-ink-faint">
                / {fmtMoney(target)}
              </span>
            )}
          </p>
        </div>

        {equity !== null && (
          <div className="text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mx-ink-faint">
              Equity
            </p>
            <p className="mt-0.5 font-mono text-[14px] font-semibold text-mx-ink">
              {equity}%
            </p>
          </div>
        )}

        <div className="text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mx-ink-faint">
            {isStartup ? "Pledgers" : "Buyers"}
          </p>
          <p className="mt-0.5 font-mono text-[14px] font-semibold text-mx-ink">
            {totalsAvailable ? backers : "—"}
          </p>
        </div>

        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mx-ink-faint">
            Time left
          </p>
          <p
            className={`mt-0.5 font-mono text-[14px] font-semibold ${
              isClosingSoon
                ? "text-rose-600"
                : dLeft === 0
                  ? "text-mx-ink-faint"
                  : "text-mx-ink"
            }`}
          >
            {dLeft === 0 ? "—" : `${dLeft}d`}
          </p>
        </div>
      </div>
    </Link>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────
function Empty({
  hasCards,
  category,
}: {
  hasCards: boolean;
  category: string;
}) {
  if (hasCards && category !== "All") {
    return (
      <EmptyState
        title={
          <>
            No raises in <span className="font-medium">{category}</span> right
            now.
          </>
        }
        hint="Try a different category or check back soon."
      />
    );
  }
  return (
    <EmptyState
      title="No live raises yet."
      hint="Issuers open equity raises from their dashboards — check back soon."
    />
  );
}
