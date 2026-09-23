"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconArrowUpRight, IconFile } from "@/components/icons";
import { getSupabase } from "@/lib/supabase";
import { listAssetProfiles, type AssetProfile } from "@/lib/asset-profiles";
import { assetTypeBySlug, CATEGORY_SLUGS } from "@/lib/asset-types";
import { safeHttpUrl } from "@/lib/format";
import { assetHref as marketplaceAssetHref } from "@/lib/asset-links";
import { detectNetwork, networkLabel } from "@/lib/network";
import { SSC_NOT_APPROVED_LABEL, sscDecisionRef } from "@/lib/whitepaper-approval";

type PublishedProfile = Pick<
  AssetProfile,
  | "asset_pda"
  | "category"
  | "display_name"
  | "summary"
  | "whitepaper_path"
  | "whitepaper_url"
  | "whitepaper_status"
  | "whitepaper_published_at"
  | "whitepaper_sha256"
  | "whitepaper_version_id"
  | "ssc_decision_ref"
  | "updated_at"
>;

type Item = {
  profile: PublishedProfile;
  linkId: string | null;
  whitepaper: boolean;
  documentUrl: string | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: Item[]; linksUnavailable: boolean };

type DocumentFilter = "all" | "whitepaper" | "basic";

const ROWS_PER_PAGE = 10;
const LOAD_TIMEOUT_MS = 25_000;
const FILTERS: { value: DocumentFilter; label: string }[] = [
  { value: "all", label: "All documents" },
  { value: "whitepaper", label: "Whitepapers" },
  { value: "basic", label: "Basic information" },
];

/** Migration 0031 keeps whitepapers/ in the public documents bucket.
 * Only link files inside this asset's whitepaper directory; encode each
 * segment so a stored filename cannot change the URL's path or query. */
function whitepaperFileUrl(profile: PublishedProfile): string | null {
  const path = profile.whitepaper_path;
  const base = safeHttpUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!path || !base || !path.startsWith(`whitepapers/${profile.asset_pda}/`)) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const url = new URL(base);
  url.pathname = `/storage/v1/object/public/documents/${segments.map(encodeURIComponent).join("/")}`;
  url.search = "";
  url.hash = "";
  return safeHttpUrl(url.href);
}

async function loadPublishedDocuments(signal: AbortSignal): Promise<Extract<LoadState, { status: "ready" }>> {
  const sb = getSupabase();
  if (!sb) throw new Error("Document service is not configured.");
  const network = detectNetwork();
  const profiles: PublishedProfile[] = await listAssetProfiles({ signal });

  const uniqueProfiles = [...new Map(profiles.map((profile) => [profile.asset_pda, profile])).values()];
  const linkIds = new Map<string, string>();
  let linksUnavailable = false;

  // Keep small IN batches, and never drop a published profile if the indexer
  // has not resolved its marketplace route yet or the join request fails.
  for (let offset = 0; offset < uniqueProfiles.length; offset += 100) {
    signal.throwIfAborted();
    try {
      const { data, error } = await sb
        .from("assets")
        .select("pda, asset_id")
        .eq("network", network)
        .in("pda", uniqueProfiles.slice(offset, offset + 100).map((profile) => profile.asset_pda))
        .abortSignal(signal);
      if (error) {
        signal.throwIfAborted();
        linksUnavailable = true;
        continue;
      }
      for (const row of (data ?? []) as { pda: string; asset_id: string | null }[]) {
        if (row.pda && row.asset_id) linkIds.set(row.pda, row.asset_id);
      }
    } catch {
      signal.throwIfAborted();
      linksUnavailable = true;
    }
  }

  signal.throwIfAborted();
  return {
    status: "ready",
    linksUnavailable,
    items: uniqueProfiles
      .sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? ""))
      .map((profile) => ({
        profile,
        linkId: linkIds.get(profile.asset_pda) ?? null,
        whitepaper:
          profile.whitepaper_status === "published" ||
          profile.whitepaper_status === "ssc_approved",
        documentUrl: whitepaperFileUrl(profile) ?? safeHttpUrl(profile.whitepaper_url),
      })),
  };
}

function displayDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function DocumentRow({ item }: { item: Item }) {
  const { profile, linkId, whitepaper, documentUrl } = item;
  // The asset PDA is the public identity (e2e §6); a bare asset_id can be
  // shared by two issuers and would land on the chooser. The indexer join is
  // still consulted so a profile whose asset is not indexed yet gets no link.
  const assetHref = linkId ? marketplaceAssetHref(profile.asset_pda) : null;
  const date = displayDate(whitepaper ? profile.whitepaper_published_at : profile.updated_at);
  const decisionRef = whitepaper ? sscDecisionRef(profile) : null;
  const fingerprint = whitepaper ? profile.whitepaper_sha256?.trim() : null;

  return (
    <li className="docs-library-row">
      <div className="docs-library-document">
        <span className="docs-library-file-icon"><IconFile size={20} /></span>
        <div className="docs-library-document-copy">
          <h3>{profile.display_name || "Untitled asset"}</h3>
          <span className="docs-library-category">{assetTypeBySlug(profile.category)?.title ?? profile.category}</span>
          {profile.summary && <p>{profile.summary}</p>}
          <span className="docs-library-date-compact">
            {date ? `${whitepaper ? "Published" : "Updated"} ${date}` : "Date not provided"}
          </span>
          {(fingerprint || decisionRef) && (
            <details className="docs-library-verification">
              <summary>Document verification</summary>
              {decisionRef && (
                <div>
                  <span>SSC decision reference</span>
                  <p>{decisionRef}</p>
                </div>
              )}
              {fingerprint && (
                <div>
                  <span>{profile.whitepaper_version_id ? "Server-verified SHA-256" : "Uploader-declared SHA-256"}</span>
                  <code>{fingerprint}</code>
                  <p>{profile.whitepaper_version_id ? "The server verified these bytes in an immutable document version." : "This historical file has not passed server verification."}</p>
                </div>
              )}
            </details>
          )}
        </div>
      </div>
      <div className="docs-library-row-type">
        <span>{whitepaper ? "Whitepaper" : "Basic information"}</span>
        {/* A whitepaper without a recorded decision reference is not
            approved — "Published" alone would read like an endorsement. */}
        <span className={`docs-library-status${decisionRef ? " docs-library-status-approved" : whitepaper ? " docs-library-status-unapproved" : ""}`}>
          <i />{decisionRef ? "SSC approved" : whitepaper ? SSC_NOT_APPROVED_LABEL : "Published"}
        </span>
      </div>
      <div className="docs-library-date">
        <span>{date ?? "Date not provided"}</span>
        {date && <small>{whitepaper ? "Published" : "Updated"}</small>}
      </div>
      <div className="docs-library-actions">
        {whitepaper ? (
          <>
            {documentUrl ? (
              <a href={documentUrl} target="_blank" rel="noopener noreferrer" className="docs-library-read">
                Read document <IconArrowUpRight size={13} />
              </a>
            ) : <span className="docs-library-unavailable">Document unavailable</span>}
            {assetHref ? (
              <Link href={assetHref}>Asset details <span aria-hidden="true">→</span></Link>
            ) : <span className="docs-library-unavailable">Asset details unavailable</span>}
          </>
        ) : assetHref ? (
          <Link href={assetHref} className="docs-library-read">Read information <span aria-hidden="true">→</span></Link>
        ) : <span className="docs-library-unavailable">Asset details unavailable</span>}
      </div>
    </li>
  );
}

export function WhitepapersBoard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [filter, setFilter] = useState<DocumentFilter>("all");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
      if (!cancelled) setState({ status: "error" });
    }, LOAD_TIMEOUT_MS);
    void loadPublishedDocuments(controller.signal)
      .then((result) => {
        if (!cancelled && !controller.signal.aborted) setState(result);
      })
      .catch(() => { if (!cancelled) setState({ status: "error" }); })
      .finally(() => { clearTimeout(deadline); });
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [attempt]);

  function retry() {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  function clearFilters() {
    setQuery("");
    setCategory("all");
    setFilter("all");
    setPage(0);
  }

  const items = state.status === "ready" ? state.items : [];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = items.filter(({ profile, whitepaper }) =>
    (category === "all" || profile.category === category) &&
    (filter === "all" || (filter === "whitepaper" ? whitepaper : !whitepaper)) &&
    (!normalizedQuery || (profile.display_name ?? "Untitled asset").toLowerCase().includes(normalizedQuery)),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / ROWS_PER_PAGE) - 1));
  const pageStart = currentPage * ROWS_PER_PAGE;
  const visibleItems = filtered.slice(pageStart, pageStart + ROWS_PER_PAGE);

  return (
    <div className="docs-library">
      <div className="docs-library-heading">
        <div>
          <h2>Document library</h2>
        </div>
        <span className="docs-library-network">{networkLabel(detectNetwork())}</span>
      </div>
      <div className="docs-library-tabs" role="group" aria-label="Document type">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            className={filter === option.value ? "is-active" : ""}
            onClick={() => { setFilter(option.value); setPage(0); }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="docs-library-filters">
        <label className="docs-library-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input
            type="search"
            aria-label="Search documents by asset name"
            placeholder="Search by asset name…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}
          />
        </label>
        <select
          aria-label="Filter by asset category"
          value={category}
          onChange={(event) => { setCategory(event.target.value); setPage(0); }}
        >
          <option value="all">All asset categories</option>
          {CATEGORY_SLUGS.map((slug) => <option key={slug} value={slug}>{assetTypeBySlug(slug)?.title ?? slug}</option>)}
        </select>
      </div>

      {state.status === "loading" ? (
        <div className="docs-library-loading" role="status" aria-label="Loading published documents">
          {[0, 1, 2].map((row) => <div key={row}><span /><span /><span /></div>)}
          <p>Loading published documents…</p>
        </div>
      ) : state.status === "error" ? (
        <div className="docs-library-empty" role="alert">
          <span className="docs-library-empty-icon"><IconFile size={24} /></span>
          <h3>The document library is unavailable</h3>
          <p>Published documents could not be loaded. Please try again.</p>
          <button type="button" className="overview-button" onClick={retry}>Try again <span aria-hidden="true">↻</span></button>
        </div>
      ) : items.length === 0 ? (
        <div className="docs-library-empty">
          <span className="docs-library-empty-icon"><IconFile size={24} /></span>
          <h3>No issuer documents published yet</h3>
          <p>Whitepapers and basic asset information will appear here as issuers publish assets on {networkLabel(detectNetwork())}.</p>
          <Link href="/marketplace" className="overview-button">Explore the market <span aria-hidden="true">→</span></Link>
        </div>
      ) : (
        <>
          {state.linksUnavailable && (
            <div className="docs-library-notice" role="status">
              <p>Some asset detail links could not be loaded. Published documents remain available.</p>
              <button type="button" onClick={retry}>Retry</button>
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="docs-library-empty">
              <span className="docs-library-empty-icon"><IconFile size={24} /></span>
              <h3>No documents match these filters</h3>
              <p>Try a different asset name, category or document type.</p>
              <button type="button" className="overview-button" onClick={clearFilters}>Clear filters</button>
            </div>
          ) : (
            <>
              <div className="docs-library-columns" aria-hidden="true"><span>Asset / document</span><span>Type / status</span><span>Date</span><span>Open</span></div>
              <ul className="docs-library-list" aria-label="Published issuer documents">
                {visibleItems.map((item) => <DocumentRow key={item.profile.asset_pda} item={item} />)}
              </ul>
              <div className="docs-library-footer">
                <span role="status">{pageStart + 1}–{Math.min(pageStart + ROWS_PER_PAGE, filtered.length)} of {filtered.length} {filtered.length === 1 ? "document" : "documents"}</span>
                {filtered.length > ROWS_PER_PAGE && (
                  <div>
                    <button type="button" aria-label="Previous page of documents" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button>
                    <span>Page {currentPage + 1} of {Math.ceil(filtered.length / ROWS_PER_PAGE)}</span>
                    <button type="button" aria-label="Next page of documents" disabled={pageStart + ROWS_PER_PAGE >= filtered.length} onClick={() => setPage(currentPage + 1)}>→</button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
