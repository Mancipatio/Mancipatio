"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { assetHref, withAssetAddresses, type AddressedAsset } from "@/lib/asset-links";
import { useSolanaClient } from "@solana/react-hooks";
import {
  findIssuerPda,
  type Asset,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { detectNetwork } from "@/lib/network";
import { fromBytes32, toBytes32 } from "@/lib/format";
import { SkeletonCard } from "@/components/skeleton";
import { visibleClassCount } from "@/lib/conversion-target";
import { useConversionTargets } from "@/lib/use-conversion-targets";
import { fetchArchivedSet } from "@/lib/archive-client";
import { WithdrawnNotice } from "@/components/withdrawn-notice";
import { getAssetProfiles, type PublicAssetProfile } from "@/lib/asset-profiles";
import {
  assetKindLabel,
  countryLabel,
  publicAssetName,
  publicAssetSummary,
  publicCompanyName,
  verificationLabel,
} from "@/lib/asset-presentation";
import { AssetLogo } from "@/components/asset-logo";

const KYB_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-mx-rule text-mx-ink-soft border-mx-rule-strong",
};

export default function IssuerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const legalId = decodeURIComponent(id);
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [myAssets, setMyAssets] = useState<AddressedAsset<Asset>[]>([]);
  // Published profiles of this issuer's tokens: the names a visitor reads (lib/asset-presentation.ts).
  const [profiles, setProfiles] = useState<Map<string, PublicAssetProfile>>(new Map());
  // Archived issuer (lib/archive.ts): its PDA, shown as withdrawn.
  const [withdrawn, setWithdrawn] = useState<string | null>(null);
  // Conversion targets (a class capped at 0) are not counted as share classes.
  const conversionTargets = useConversionTargets(data?.shareClasses);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        const archived = await fetchArchivedSet();
        if (cancelled) return;

        // Find this issuer + derive PDA so we can filter assets.
        const issuer = network.issuers.find(
          (i) => fromBytes32(i.legalEntityId) === legalId,
        );
        if (issuer) {
          const [pda] = await findIssuerPda({
            legalEntityId: issuer.legalEntityId,
          });
          const mine = (await withAssetAddresses(
            network.assets.filter((a) => a.issuer.toString() === pda.toString()),
          )).filter((a) => !archived.assets.has(a.address));
          // Shown under their on-chain names when the published profiles cannot be read.
          const published = mine.length
            ? await getAssetProfiles(mine.map((a) => a.address)).catch(() => new Map<string, PublicAssetProfile>())
            : new Map<string, PublicAssetProfile>();
          if (cancelled) return;
          setWithdrawn(archived.issuers.has(pda.toString()) ? pda.toString() : null);
          setMyAssets(mine);
          setProfiles(published);
        } else {
          // Re-derive PDA from the URL slug as a fallback.
          const [pda] = await findIssuerPda({
            legalEntityId: toBytes32(legalId),
          });
          const mine = (await withAssetAddresses(
            network.assets.filter((a) => a.issuer.toString() === pda.toString()),
          )).filter((a) => !archived.assets.has(a.address));
          if (!cancelled) setMyAssets(mine);
        }
        if (!cancelled) setData(network);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, legalId]);

  if (failed) {
    return (
      <section>
        <p className="text-sm text-red-600">Failed to load.</p>
      </section>
    );
  }

  if (data === null) {
    return (
      <section>
        <SkeletonCard rows={6} />
      </section>
    );
  }

  if (withdrawn) return <WithdrawnNotice kind="issuer" address={withdrawn} />;

  const issuer: Issuer | undefined = data.issuers.find(
    (i) => fromBytes32(i.legalEntityId) === legalId,
  );
  if (!issuer) {
    return (
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Issuer
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">Not found</h1>
        <p className="mt-2 text-sm text-mx-ink-soft">
          No issuer with this legal entity ID is registered on Manci
          ({detectNetwork()}).
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

  const country = countryLabel(issuer.jurisdiction);
  const names = myAssets.map(({ asset, address }) => publicAssetName(asset.name, profiles.get(address)));
  // The company's name, when the published profiles of its tokens state one and the same.
  const companies = new Set(myAssets.map(({ address }) => publicCompanyName(profiles.get(address))).filter((name): name is string => name !== null));
  const title = companies.size === 1
    ? [...companies][0]
    : names.length === 0 ? "Issuer" : names.length <= 2 ? `Issuer of ${names.join(" and ")}` : `Issuer of ${names.length} tokens`;

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
            Issuer{country ? ` · ${country}` : ""}
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-mx-ink">
            {title}
          </h1>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${KYB_BADGE[issuer.kybStatus] ?? KYB_BADGE[0]}`}
        >
          {verificationLabel(issuer.kybStatus)}
        </span>
      </div>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Tokens ({myAssets.length})
        </h2>
        {myAssets.length === 0 ? (
          <p className="mt-4 text-sm text-mx-ink-faint">
            This issuer hasn&apos;t registered any tokens yet.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {myAssets.map(({ asset: a, address }) => {
              const profile = profiles.get(address);
              const name = publicAssetName(a.name, profile);
              const summary = publicAssetSummary(profile);
              const classes = visibleClassCount(address, a.shareClassesCount, conversionTargets);
              return (
                <Link
                  key={address}
                  href={assetHref(address)}
                  className="rounded-[3px] border border-mx-rule bg-white p-5 transition-colors hover:border-mx-rule-strong"
                >
                  <div className="flex items-start gap-3">
                    <AssetLogo assetPda={address} name={name} logoPath={profile?.logo_path} size={44} />
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-mx-ink">
                        {name}
                      </p>
                      <p className="mt-0.5 text-xs text-mx-ink-faint">
                        {assetKindLabel(a.assetType)} · {classes} share class{classes === 1 ? "" : "es"}
                      </p>
                    </div>
                  </div>
                  {summary && (
                    <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-mx-ink-soft">
                      {summary}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* The registry's identifiers, in one place, for whoever checks the record on Solana. */}
      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          On-chain details
        </h2>
        <dl className="mt-4 grid gap-3 rounded-[3px] border border-mx-rule bg-white p-6 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-mx-ink-faint">Issuer ID</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-mx-ink">{legalId}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-mx-ink-faint">Issuer authority</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-mx-ink">{issuer.authority.toString()}</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
