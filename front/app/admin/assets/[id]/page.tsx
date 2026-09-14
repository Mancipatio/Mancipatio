"use client";

import Link from "next/link";
import { use } from "react";
import { RequireRole } from "@/components/require-role";
import { AssetDetail } from "@/components/asset-detail";

export default function AdminAssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <section className="min-w-0 flex-1">
      <Link
        href="/admin/assets"
        className="text-xs text-slate-500 underline-offset-2 hover:underline"
      >
        ← Assets
      </Link>
      <RequireRole role="admin">
        <AssetDetail id={id} variant="admin" />
      </RequireRole>
    </section>
  );
}
