"use client";

// The issuer journey (lib/issuer-journey.ts) in the admin issuer detail:
// read-only. It shows where this issuer stands in the engagement and who acts
// next, from the chain and the admin's existing session reads (the
// application queue matched to the issuer, its classes' public-sale requests,
// the conversion queue); every link goes to the admin page where that step is
// handled. It changes nothing: decisions stay on their own pages and their
// own signed routes.
import { useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import type { Issuer } from "@/lib/generated/asset_registry";
import type { NetworkData } from "@/lib/enumerate";
import { useIssuerJourney } from "@/lib/use-issuer-journey";
import { IssuerJourneyTracker } from "@/components/issuer-journey";

export function IssuerJourneyPanel({
  issuer,
  data,
  companyName,
}: {
  issuer: Issuer;
  /** The directory's on-chain snapshot (assets, share classes, sales). */
  data: NetworkData | null;
  companyName?: string | null;
}) {
  const conn = useWalletConnection();
  const [revision, setRevision] = useState(0);
  const read = useIssuerJourney({ audience: "admin", data, issuer, session: conn.wallet, refreshKey: revision });
  return (
    <IssuerJourneyTracker
      journey={read.journey}
      audience="admin"
      companyName={companyName}
      loading={read.loading}
      unavailable={read.unavailable}
      onRetry={() => setRevision((r) => r + 1)}
    />
  );
}
