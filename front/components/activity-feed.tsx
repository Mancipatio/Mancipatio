"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { activityDate, activityText, type PublicActivity } from "@/lib/activity";

/**
 * "Latest activity" on the overview: conversions entered in a company
 * register and public issuer updates (GET /api/activity/public), each named
 * after its token and linked to the token's page. Shown only when there is
 * something to show: without items, or when the feed cannot be read, the
 * overview is complete without it.
 */
export function ActivityFeed({
  nameOf,
}: {
  /** The listed token an item belongs to, or null (not listed here: the item is skipped). */
  nameOf: (assetPda: string) => { name: string; href: string } | null;
}) {
  const [items, setItems] = useState<PublicActivity[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/activity/public", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (body?.ok && Array.isArray(body.data?.items)) setItems(body.data.items as PublicActivity[]); })
      .catch(() => { /* optional panel */ });
    return () => controller.abort();
  }, []);

  const shown = items.flatMap((item) => {
    const token = nameOf(item.asset_pda);
    return token ? [{ item, token, ...activityText(item, token.name) }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <section className="overview-panel overview-activity" aria-labelledby="activity-heading">
      <div className="overview-panel-heading"><div><h2 id="activity-heading">Latest activity</h2><p>Register entries and issuer updates, from the public record.</p></div></div>
      <ol>
        {shown.map(({ item, token, title, detail }) => (
          <li key={`${item.kind}:${item.asset_pda}:${item.at}`}>
            <time dateTime={item.at}>{activityDate(item.at)}</time>
            <div><Link href={token.href}>{title}</Link><p>{detail}</p></div>
          </li>
        ))}
      </ol>
    </section>
  );
}
