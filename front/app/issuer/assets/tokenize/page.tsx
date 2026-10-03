"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { TokenizeSharesFlow } from "@/components/tokenize-shares-flow";

// /issuer/assets/tokenize — the one-screen "Tokenize company shares" flow.
// ?asset=<asset PDA> continues a token that stopped half-way (and shows its
// checklist once it is created). This static segment wins over [id].
export default function TokenizeSharesPage() {
  return (
    <Suspense fallback={null}>
      <TokenizeSharesInner />
    </Suspense>
  );
}

function TokenizeSharesInner() {
  const searchParams = useSearchParams();
  const asset = searchParams.get("asset");
  return (
    <main className="min-w-0 flex-1">
      <Link href="/issuer/assets" className="text-xs text-slate-500 underline-offset-2 hover:underline">
        ← My assets
      </Link>
      <TokenizeSharesFlow key={asset ?? "new"} resumeAssetPda={asset} />
    </main>
  );
}
