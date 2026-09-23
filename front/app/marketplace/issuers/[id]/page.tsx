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
import { ASSET_TYPE_LABEL, fromBytes32, KYB_LABEL, toBytes32 } from "@/lib/format";
import { SkeletonCard } from "@/components/skeleton";

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        if (cancelled) return;
        setData(network);

        // Find this issuer + derive PDA so we can filter assets.
        const issuer = network.issuers.find(
          (i) => fromBytes32(i.legalEntityId) === legalId,
        );
        if (issuer) {
          const [pda] = await findIssuerPda({
            legalEntityId: issuer.legalEntityId,
          });
          const mine = await withAssetAddresses(
            network.assets.filter((a) => a.issuer.toString() === pda.toString()),
          );
          if (cancelled) return;
          setMyAssets(mine);
        } else {
          // Re-derive PDA from the URL slug as a fallback.
          const [pda] = await findIssuerPda({
            legalEntityId: toBytes32(legalId),
          });
          const mine = await withAssetAddresses(
            network.assets.filter((a) => a.issuer.toString() === pda.toString()),
          );
          if (!cancelled) setMyAssets(mine);
        }
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
            Issuer
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-mx-ink">
            {legalId}
          </h1>
          <p className="mt-1 text-sm text-mx-ink-faint">
            Jurisdiction (ISO-3166): <span className="font-mono">{issuer.jurisdiction}</span> ·
            Authority:{" "}
            <code className="font-mono text-xs">
              {issuer.authority.toString().slice(0, 6)}…
              {issuer.authority.toString().slice(-4)}
            </code>
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${KYB_BADGE[issuer.kybStatus] ?? KYB_BADGE[0]}`}
        >
          KYB: {KYB_LABEL[issuer.kybStatus] ?? "Unknown"}
        </span>
      </div>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Assets ({myAssets.length})
        </h2>
        {myAssets.length === 0 ? (
          <p className="mt-4 text-sm text-mx-ink-faint">
            This issuer hasn&apos;t registered any assets yet.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {myAssets.map(({ asset: a, address }) => (
              <Link
                key={address}
                href={assetHref(address)}
                className="rounded-[3px] border border-mx-rule bg-white p-5 transition-colors hover:border-mx-rule-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-mx-ink">
                      {a.name}
                    </p>
                    <p className="mt-0.5 text-xs text-mx-ink-faint">
                      {a.assetId} · {a.symbolPrefix}
                    </p>
                  </div>
                  <span className="rounded-full bg-mx-indigo-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-mx-ink-soft">
                    {ASSET_TYPE_LABEL[a.assetType] ?? "?"}
                  </span>
                </div>
                <p className="mt-3 text-xs text-mx-ink-faint">
                  {a.shareClassesCount} share class
                  {a.shareClassesCount === 1 ? "" : "es"}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
