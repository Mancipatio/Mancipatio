"use client";

import Link from "next/link";
import { use } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { AssetDetail } from "@/components/asset-detail";

export default function IssuerAssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address?.toString() ?? null;

  return (
    <main className="min-w-0 flex-1">
      <Link
        href="/issuer/assets"
        className="text-xs text-slate-500 underline-offset-2 hover:underline"
      >
        ← My assets
      </Link>
      <AssetDetail id={id} variant="issuer" gateWallet={wallet} />
    </main>
  );
}
