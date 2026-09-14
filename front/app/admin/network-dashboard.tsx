"use client";

import { useSolanaClient } from "@solana/react-hooks";
import { useEffect, useState } from "react";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_TYPE_LABEL, fromBytes32, KYB_LABEL } from "@/lib/format";
import {
  IconBox,
  IconBuilding,
  IconChart,
  IconCoins,
  IconLayers,
  IconRepeat,
  IconRocket,
  IconStar,
} from "@/components/icons";
import { Kpi } from "@/components/kpi";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";

const ZERO = BigInt(0);

export function NetworkDashboard({ full = false }: { full?: boolean }) {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)).then(
      setData,
      () => setFailed(true),
    );
  }, [client]);

  if (failed) {
    return (
      <p className="text-sm text-red-600">Failed to load on-chain data.</p>
    );
  }
  if (!data) {
    return (
      <div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: full ? 8 : 4 }).map((_, i) => (
            <SkeletonCard key={i} rows={1} />
          ))}
        </div>
        {full && (
          <div className="mt-8 space-y-6">
            <SkeletonTable rows={4} cols={4} />
            <SkeletonTable rows={3} cols={3} />
            <SkeletonCard rows={3} />
          </div>
        )}
      </div>
    );
  }

  const circulating = data.shareClasses.reduce(
    (s, c) => s + c.circulatingSupply,
    ZERO,
  );
  const unitsSold = data.sales.reduce((s, x) => s + x.sold, ZERO);
  const vestPool = data.milestones.reduce((s, m) => s + m.amountPool, ZERO);
  const vestClaimed = data.milestones.reduce((s, m) => s + m.claimed, ZERO);

  const tiles: Array<{
    label: string;
    value: string | number;
    icon: React.ReactNode;
  }> = [
    { label: "Issuers", value: data.issuers.length, icon: <IconBuilding /> },
    { label: "Assets / RWA", value: data.assets.length, icon: <IconBox /> },
    {
      label: "Share classes",
      value: data.shareClasses.length,
      icon: <IconLayers />,
    },
    {
      label: "Tokens in circulation",
      value: String(circulating),
      icon: <IconCoins />,
    },
    { label: "Primary sales", value: data.sales.length, icon: <IconRocket /> },
    {
      label: "Units sold (primary)",
      value: String(unitsSold),
      icon: <IconChart />,
    },
    { label: "OTC offers", value: data.offers.length, icon: <IconRepeat /> },
    {
      label: "Rights issuances",
      value: data.rightsIssuances.length,
      icon: <IconStar />,
    },
  ];

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Kpi key={t.label} label={t.label} value={t.value} icon={t.icon} />
        ))}
      </div>

      {full && (
        <div className="mt-8 space-y-6">
          <Directory
            title="Issuer directory"
            cols={["Legal entity ID", "Jurisdiction", "KYB", "Assets"]}
            rows={data.issuers.map((i) => [
              fromBytes32(i.legalEntityId) || "—",
              String(i.jurisdiction),
              KYB_LABEL[i.kybStatus] ?? "?",
              String(i.assetsCount),
            ])}
          />
          <Directory
            title="Assets traded"
            cols={["Name", "Type", "Share classes"]}
            rows={data.assets.map((a) => [
              a.name || "—",
              ASSET_TYPE_LABEL[a.assetType] ?? "?",
              String(a.shareClassesCount),
            ])}
          />
          <div className="rounded-xl border border-slate-200 bg-white shadow-card p-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Vesting plan
            </h3>
            <dl className="mt-3 space-y-2 text-sm">
              <DlRow label="Vesting milestones" value={data.milestones.length} />
              <DlRow label="Underlying pooled" value={String(vestPool)} />
              <DlRow label="Underlying claimed" value={String(vestClaimed)} />
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function Directory({
  title,
  cols,
  rows,
}: {
  title: string;
  cols: string[];
  rows: string[][];
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-card p-5">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nothing on-chain yet.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
              {cols.map((c) => (
                <th key={c} className="pb-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((row, i) => (
              <tr key={i} className="text-slate-700">
                {row.map((cell, j) => (
                  <td key={j} className="break-all py-2 pr-3 font-mono">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DlRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-700">{value}</dd>
    </div>
  );
}
