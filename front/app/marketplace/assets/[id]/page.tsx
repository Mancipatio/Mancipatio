"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useSolanaClient } from "@solana/react-hooks";
import {
  findIssuerPda,
  type Asset,
  SaleStatus,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findSalePda } from "@/lib/pdas";
import {
  assetHref,
  resolveAssetParam,
  saleHref,
  saleKey,
  shareClassKey,
  withAssetAddresses,
  type AssetLookup,
} from "@/lib/asset-links";
import {
  ASSET_STATUS_LABEL,
  ASSET_TYPE_LABEL,
  fromBytes32,
  safeHttpUrl,
} from "@/lib/format";
import { SkeletonCard } from "@/components/skeleton";
import { detectNetwork } from "@/lib/network";
import {
  assetTypeBySlug,
  fieldsForCategory,
} from "@/lib/asset-types";
import {
  displayFieldValue,
  getAssetProfile,
  type PublicAssetProfile,
} from "@/lib/asset-profiles";

export default function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [issuerLegalId, setIssuerLegalId] = useState<string>("—");
  const [profile, setProfile] = useState<PublicAssetProfile | null>(null);
  // The route param is the asset PDA (public identity). A bare assetId is
  // honoured only when unique — the program allows the same id per issuer.
  const [lookup, setLookup] = useState<AssetLookup<Asset> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        if (cancelled) return;
        setData(network);
        const found = resolveAssetParam(
          await withAssetAddresses(network.assets),
          id,
        );
        if (cancelled) return;
        setLookup(found);
        if (found.kind === "found") {
          const asset = found.asset;
          for (const i of network.issuers) {
            const [pda] = await findIssuerPda({
              legalEntityId: i.legalEntityId,
            });
            if (pda.toString() === asset.issuer.toString()) {
              if (!cancelled) setIssuerLegalId(fromBytes32(i.legalEntityId));
              break;
            }
          }
          // Off-chain category profile (degrade gracefully when absent).
          // Only published profiles are public; drafts stay private to admin/issuer.
          const row = await getAssetProfile(found.address);
          if (!cancelled) setProfile(row && row.is_published ? row : null);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, id]);

  if (failed) {
    return (
      <section>
        <p className="text-sm text-red-600">Failed to load.</p>
      </section>
    );
  }

  if (data === null || lookup === null) {
    return (
      <section>
        <SkeletonCard rows={6} />
      </section>
    );
  }

  if (lookup.kind === "ambiguous") {
    return (
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Asset
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Several assets share this ID
        </h1>
        <p className="mt-2 text-sm text-mx-ink-soft">
          Different issuers registered &ldquo;{id}&rdquo;. Pick the one you
          meant — each link below is the asset&apos;s unique on-chain address.
        </p>
        <ul className="mt-4 space-y-2">
          {lookup.candidates.map((c) => (
            <li key={c.address}>
              <Link
                href={assetHref(c.address)}
                className="text-sm text-mx-ink underline-offset-2 hover:underline"
              >
                {c.asset.name} · issuer {c.asset.issuer.toString().slice(0, 8)}… ·{" "}
                <span className="font-mono text-xs">{c.address}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const asset: Asset | undefined =
    lookup.kind === "found" ? lookup.asset : undefined;
  if (!asset) {
    return (
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Asset
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Not found
        </h1>
        <p className="mt-2 text-sm text-mx-ink-soft">
          No asset with this ID is registered on Manci ({detectNetwork()}).
        </p>
        <Link
          href="/marketplace"
          className="mt-4 inline-block text-sm text-mx-ink-soft underline-offset-2 hover:underline"
        >
          ← Back to marketplace
        </Link>
      </section>
    );
  }

  return (
    <section>
      <Link
        href="/marketplace"
        className="text-xs text-mx-ink-faint underline-offset-2 hover:underline"
      >
        ← Marketplace
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
            Asset
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-mx-ink">
            {profile?.display_name || asset.name}
          </h1>
          <p className="mt-1 text-sm text-mx-ink-faint">
            {asset.assetId} · {asset.symbolPrefix} ·{" "}
            <Link
              href={`/marketplace/issuers/${encodeURIComponent(issuerLegalId)}`}
              className="text-mx-ink-soft underline-offset-2 hover:underline"
            >
              {issuerLegalId}
            </Link>
          </p>
          {profile?.summary && (
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-mx-ink-soft">
              {profile.summary}
            </p>
          )}
        </div>
        <span className="rounded-full bg-mx-indigo-soft px-3 py-1 text-xs font-semibold uppercase tracking-wider text-mx-ink-soft">
          {ASSET_TYPE_LABEL[asset.assetType] ?? "?"}
        </span>
      </div>

      <TokenInformationBlock profile={profile} />

      <AssetProfileBlock profile={profile} />

      <ShareClassesBlock asset={asset} data={data} />

      {/* Asset metadata */}
      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Asset metadata
        </h2>
        <dl className="mt-4 grid gap-3 rounded-[3px] border border-mx-rule bg-white p-6 text-sm sm:grid-cols-2">
          <Field label="Status" value={ASSET_STATUS_LABEL[asset.status] ?? "?"} />
          <Field label="Share classes" value={String(asset.shareClassesCount)} />
          <Field
            label="Allow P2P"
            value={asset.jurisdictionRules.allowP2p ? "Yes" : "No"}
          />
          <Field
            label="Max holders"
            value={
              asset.jurisdictionRules.maxHolders === 0
                ? "unlimited"
                : String(asset.jurisdictionRules.maxHolders)
            }
          />
          <Field label="Issuer PDA" value={asset.issuer.toString()} mono />
        </dl>
      </section>
    </section>
  );
}

/** Public URL for a whitepaper file stored in the public `documents` bucket. */
function whitepaperFileUrl(path: string | null): string | null {
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base
    ? `${base}/storage/v1/object/public/documents/${path}`
    : null;
}

/** Token information (Flows doc section 10): the token's whitepaper when one
 *  is published — or the note that this page IS the token's official basic
 *  information — plus the Serbian SPV the issuance runs through. */
function TokenInformationBlock({ profile }: { profile: PublicAssetProfile | null }) {
  if (!profile) return null;

  const isLive =
    profile.whitepaper_status === "published" ||
    profile.whitepaper_status === "ssc_approved";
  const href =
    whitepaperFileUrl(profile.whitepaper_path) ??
    safeHttpUrl(profile.whitepaper_url);
  const hasWhitepaper = isLive && Boolean(href);
  const publishedAt = profile.whitepaper_published_at
    ? new Date(profile.whitepaper_published_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <section className="mt-10">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        Token information
      </h2>
      <div className="mt-4 rounded-[3px] border border-mx-rule bg-white p-6">
        {hasWhitepaper ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={href!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-[3px] bg-mx-ink px-4 py-2 text-sm font-medium text-mx-paper hover:opacity-90"
              >
                Whitepaper ↗
              </a>
              {/* The approval badge requires the decision evidence
                  (ssc_decision_ref) recorded by the platform. */}
              {profile.whitepaper_status === "ssc_approved" &&
                profile.ssc_decision_ref && (
                  <span
                    title={profile.ssc_decision_ref}
                    className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
                  >
                    Approved by the Serbian Securities Commission
                  </span>
                )}
            </div>
            {profile.whitepaper_status === "ssc_approved" &&
              profile.ssc_decision_ref && (
                <p className="mt-3 text-xs text-mx-ink-faint">
                  {profile.ssc_decision_ref}
                  {whitepaperFileUrl(profile.ssc_decision_doc_path) && (
                    <>
                      {" · "}
                      <a
                        href={whitepaperFileUrl(profile.ssc_decision_doc_path)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        Decision document ↗
                      </a>
                    </>
                  )}
                </p>
              )}
            {publishedAt && (
              <p className="mt-3 text-xs text-mx-ink-faint">
                Published {publishedAt}
              </p>
            )}
            <p className="mt-3 text-xs text-mx-ink-faint">{profile.whitepaper_version_id ? "Immutable document version · file bytes verified by the server" : "Historical document · file bytes have not been verified by the server"}</p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-mx-ink-soft">
            This token has no separate whitepaper. The information on this page
            is the token&apos;s official basic information published by
            Manci.
          </p>
        )}
        {profile.spv_name && (
          <p className="mt-4 border-t border-mx-rule pt-4 text-sm text-mx-ink-soft">
            Issued through SPV: <span className="font-medium text-mx-ink">{profile.spv_name}</span>
          </p>
        )}
      </div>
    </section>
  );
}

/** Public-facing off-chain product profile: description, website, and the
 *  category-specific facts. Renders nothing when there's no profile so the
 *  page degrades gracefully for assets created without one. */
function AssetProfileBlock({ profile }: { profile: PublicAssetProfile | null }) {
  if (!profile) return null;

  const typeRecord = assetTypeBySlug(profile.category);
  const fields = fieldsForCategory(profile.category);
  const facts = fields
    .map((f) => ({
      key: f.key,
      label: f.label,
      value: displayFieldValue(f, (profile as Record<string, unknown>)[f.key]),
    }))
    .filter((f) => f.value !== "—");

  const hasAbout = Boolean(profile.description || profile.website);
  if (!hasAbout && facts.length === 0) return null;

  return (
    <>
      {hasAbout && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
            About
          </h2>
          <div className="mt-4 rounded-[3px] border border-mx-rule bg-white p-6">
            {profile.description && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-mx-ink-soft">
                {profile.description}
              </p>
            )}
            {safeHttpUrl(profile.website) && (
              <a
                href={safeHttpUrl(profile.website)!}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex text-sm text-mx-ink-soft underline-offset-2 hover:underline ${
                  profile.description ? "mt-4" : ""
                }`}
              >
                {profile.website} ↗
              </a>
            )}
          </div>
        </section>
      )}

      {facts.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
            {typeRecord?.title ?? "Category"} facts
          </h2>
          <dl className="mt-4 grid gap-3 rounded-[3px] border border-mx-rule bg-white p-6 text-sm sm:grid-cols-2">
            {facts.map((f) => (
              <Field key={f.key} label={f.label} value={f.value} />
            ))}
          </dl>
        </section>
      )}
    </>
  );
}

function ShareClassesBlock({
  asset,
  data,
}: {
  asset: Asset;
  data: NetworkData;
}) {
  // Derive this asset's PDA so we can match share classes by sc.asset.
  const [assetPda, setAssetPda] = useState<string>("");
  // shareClass:saleId → on-chain Sale PDA, so the Buy CTA can deep-link to the
  // concrete deal page (/marketplace/launchpad/[salePda]). Keyed by the full
  // pair: two classes of one asset can both have a sale #1.
  const [salePdaById, setSalePdaById] = useState<Map<string, string>>(
    new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { findAssetPda } = await import("@/lib/generated/asset_registry");
      const [pda] = await findAssetPda({
        issuer: asset.issuer,
        assetId: asset.assetId,
      });
      if (!cancelled) setAssetPda(pda.toString());
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [asset]);

  const shareClasses = data.shareClasses.filter(
    (sc) => sc.asset.toString() === assetPda,
  );
  const activeSales = data.sales.filter(
    (s) =>
      s.status === SaleStatus.Open &&
      shareClasses.some((sc) => sc.mint.toString() === s.mint.toString()),
  );
  // Stable key for the open-sale set so the resolver effect re-runs only when it
  // actually changes (activeSales is a fresh array every render).
  const activeSalesKey = activeSales
    .map((s) => saleKey(s.shareClass, s.saleId))
    .join(",");

  // Resolve each open sale's PDA once the share classes for this asset are known.
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (activeSales.length === 0) return;
      const next = new Map<string, string>();
      for (const s of activeSales) {
        const pda = await findSalePda(s.shareClass, s.saleId);
        next.set(saleKey(s.shareClass, s.saleId), pda.toString());
      }
       
      if (!cancelled) setSalePdaById(next);
    }
    void resolve();
    return () => {
      cancelled = true;
    };
    // Re-resolve whenever the matched open-sale set changes (keyed by ids+pdas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSalesKey]);

  return (
    <>
      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Share classes ({shareClasses.length})
        </h2>
        {shareClasses.length === 0 ? (
          <p className="mt-4 text-sm text-mx-ink-faint">No share classes yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-[3px] border border-mx-rule bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-mx-rule bg-mx-paper text-left text-xs uppercase tracking-wider text-mx-ink-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Class</th>
                  <th className="px-4 py-3 text-right font-medium">Circulating</th>
                  <th className="px-4 py-3 font-medium">Mint</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mx-rule">
                {shareClasses.map((sc) => {
                  const status = sc.supplyLocked
                    ? "Locked"
                    : sc.mintInitialized
                      ? "Active"
                      : "Pending mint";
                  return (
                    <tr key={shareClassKey(sc.asset, sc.classIndex)} className="text-mx-ink-soft">
                      <td className="px-4 py-3 font-mono">#{sc.classIndex}</td>
                      <td className="px-4 py-3">
                        {[
                          "Common",
                          "Pref A",
                          "Pref B",
                          "Sr debt",
                          "Jr debt",
                          "Rev",
                          "Royalty",
                        ][sc.classType] ?? "?"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {String(sc.circulatingSupply)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-mx-ink-faint">
                        {sc.mintInitialized
                          ? `${sc.mint.toString().slice(0, 6)}…${sc.mint.toString().slice(-4)}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">{status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {activeSales.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
            Open sales ({activeSales.length})
          </h2>
          <ul className="mt-4 space-y-3">
            {activeSales.map((s) => (
              <li
                key={saleKey(s.shareClass, s.saleId)}
                className="rounded-[3px] border border-emerald-200 bg-emerald-50 p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-900">
                    Sale #{String(s.saleId)} — {String(s.sold)} /{" "}
                    {String(s.totalForSale)} sold
                  </p>
                  <Link
                    href={saleHref(
                      salePdaById.get(saleKey(s.shareClass, s.saleId)),
                    )}
                    className="text-xs font-medium text-emerald-800 underline-offset-2 hover:underline"
                  >
                    Buy →
                  </Link>
                </div>
                <p className="mt-1 text-xs text-emerald-800/80">
                  Price: {String(s.pricePerUnit)} payment-token base units per
                  share unit
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-mx-ink-faint">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-mx-ink ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}
