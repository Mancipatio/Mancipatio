"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconArrowUpRight } from "@/components/icons";
import { SkeletonCard } from "@/components/skeleton";
import { getSupabase } from "@/lib/supabase";
import {
  listAssetProfiles,
  displayFieldValue,
  type PublicAssetProfile,
} from "@/lib/asset-profiles";
import { fieldsForCategory, type CategorySlug } from "@/lib/asset-types";
import { assetHref } from "@/lib/asset-links";
import { detectNetwork, networkLabel } from "@/lib/network";

type Item = {
  profile: PublicAssetProfile;
  /** marketplace detail route keys on the on-chain asset id; falls back to the pda */
  linkId: string;
};

/** Resolve each profile's `asset_pda` to the on-chain `asset_id` the
 *  marketplace detail route expects (one cheap select on the indexer table). */
async function resolveLinkIds(
  profiles: PublicAssetProfile[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const sb = getSupabase();
  if (!sb || profiles.length === 0) return out;
  try {
    const { data, error } = await sb
      .from("assets")
      .select("pda, asset_id")
      .in(
        "pda",
        profiles.map((p) => p.asset_pda),
      );
    if (error) return out;
    for (const row of (data ?? []) as Array<{
      pda: string;
      asset_id: string;
    }>) {
      if (row.pda && row.asset_id) out.set(row.pda, row.asset_id);
    }
    return out;
  } catch {
    return out;
  }
}

export function CategoryOffers({
  slug,
  title,
}: {
  slug: CategorySlug;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);

  const allFields = fieldsForCategory(slug);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const profiles = await listAssetProfiles({
          category: slug,
          publishedOnly: true,
        });
        const linkMap = await resolveLinkIds(profiles);
        if (cancelled) return;
        // Only show cards whose asset resolves to an on-chain asset_id the
        // marketplace detail route can open — otherwise the card would 404.
        const next = profiles
          .map((profile) => {
            const linkId = linkMap.get(profile.asset_pda);
            return linkId ? { profile, linkId } : null;
          })
          .filter((x): x is Item => x !== null);
        setItems(next);
        setFailed(false);
      } catch { if (!cancelled) setFailed(true); }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (failed) return <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Published listings are temporarily unavailable. Please try again shortly.</p>;

  if (items === null) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-[14px] font-medium text-slate-900">
          No {title.toLowerCase()} listed yet.
        </p>
        <p className="mt-2 text-[12.5px] text-slate-500">
          {networkLabel(detectNetwork())} is early. No issuer has published a{" "}
          {title.toLowerCase()}{" "}
          listing in this category yet — check the live OTC board for secondary
          offers, or open the platform to be the first.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href={`/markets/resell?type=${slug}`} className="btn-brand">
            Live OTC board
          </Link>
          <Link href="/marketplace" className="btn-ghost">
            Open the platform
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(({ profile }) => {
        // Show up to three POPULATED category facts (skip empty columns).
        const facts = allFields
          .map((field) => ({
            field,
            value: displayFieldValue(
              field,
              (profile as Record<string, unknown>)[field.key],
            ),
          }))
          .filter((f) => f.value !== "—")
          .slice(0, 3);
        return (
          <Link
            key={profile.asset_pda}
            href={assetHref(profile.asset_pda)}
            className="group panel panel-pad flex flex-col transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-brand"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[16px] font-semibold text-slate-900">
                {profile.display_name ?? "Untitled listing"}
              </h3>
              {profile.jurisdiction && (
                <span className="page-eyebrow shrink-0">
                  {profile.jurisdiction}
                </span>
              )}
            </div>

            {profile.summary && (
              <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-slate-600">
                {profile.summary}
              </p>
            )}

            {facts.length > 0 && (
              <dl className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-[12.5px]">
                {facts.map(({ field, value }) => (
                  <div
                    key={field.key}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <dt className="text-slate-500">{field.label}</dt>
                    <dd className="text-right font-medium tabular-nums text-slate-800">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <span className="mt-4 inline-flex items-center gap-1 pt-1 text-[12.5px] font-medium text-brand-700 transition-colors group-hover:text-brand-800">
              View listing
              <IconArrowUpRight size={14} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}
