"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconArrowUpRight } from "@/components/icons";
import { AssetLogo } from "@/components/asset-logo";
import { listAssetProfiles, type PublicAssetProfile } from "@/lib/asset-profiles";
import { activityDate, activityText, type PublicActivity } from "@/lib/activity";
import { assetHref } from "@/lib/asset-links";
import { publicAssetSummary, unitPercent } from "@/lib/asset-presentation";
import styles from "./landing.module.css";

/** Cards shown on the landing page; the marketplace lists every token. */
const MAX_COMPANIES = 4;
/** Lines of the public record shown next to them. */
const MAX_RECORD = 4;

/**
 * "On Manci now" on the landing page: the tokens whose profile is published,
 * each under its company's mark, next to the latest entries of the public
 * record (conversions entered in a company register, issuer updates).
 *
 * Both reads are the open ones the app already uses (/api/profiles/public,
 * /api/activity/public): published profiles and non-personal register
 * columns. The section appears only when a profile is published; a page
 * without it, or a failed read, is the landing page as it was.
 */
export function LandingCompanies() {
  const [profiles, setProfiles] = useState<PublicAssetProfile[]>([]);
  const [record, setRecord] = useState<PublicActivity[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listAssetProfiles({ signal: controller.signal })
      .then((rows) => setProfiles(rows))
      .catch(() => { /* optional section */ });
    fetch("/api/activity/public", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (body?.ok && Array.isArray(body.data?.items)) setRecord(body.data.items as PublicActivity[]); })
      .catch(() => { /* optional section */ });
    return () => controller.abort();
  }, []);

  const named = profiles
    .filter((profile) => profile.display_name?.trim())
    .sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? ""));
  if (named.length === 0) return null;
  const nameOf = new Map(named.map((profile) => [profile.asset_pda, profile.display_name!.trim()]));
  const lines = record.flatMap((item) => {
    const name = nameOf.get(item.asset_pda);
    return name ? [{ item, ...activityText(item, name) }] : [];
  }).slice(0, MAX_RECORD);

  return (
    <section className={styles.listed} aria-labelledby="listed-title">
      <div className={styles.container}>
        <div className={styles.listedHeading}>
          <div><p className={styles.eyebrow}>ON MANCI NOW</p><h2 id="listed-title">Companies and their tokens.</h2></div>
          <Link href="/marketplace" className={styles.textLink}>All tokens <IconArrowUpRight size={17} /></Link>
        </div>
        <div className={lines.length > 0 ? styles.listedBody : undefined}>
          <div className={`${styles.listedGrid} ${lines.length > 0 ? styles.listedGridNarrow : ""}`}>
            {named.slice(0, MAX_COMPANIES).map((profile) => {
              const name = nameOf.get(profile.asset_pda)!;
              const summary = publicAssetSummary(profile);
              const oneToken = unitPercent(profile.token_percent_e4);
              return (
                <Link key={profile.asset_pda} href={assetHref(profile.asset_pda)} className={styles.listedCard}>
                  <div className={styles.listedCardTop}><AssetLogo assetPda={profile.asset_pda} name={name} size={52} /><h3>{name}</h3></div>
                  {summary && <p>{summary}</p>}
                  {oneToken && <span className={styles.listedFact}>1 token = {oneToken} % of the company</span>}
                  <span className={styles.listedMore}>View token <IconArrowUpRight size={15} /></span>
                </Link>
              );
            })}
          </div>
          {lines.length > 0 && (
            <div className={styles.listedRecord}>
              <p className={styles.eyebrow}>FROM THE PUBLIC RECORD</p>
              <ol>
                {lines.map(({ item, title, detail }) => (
                  <li key={`${item.kind}:${item.asset_pda}:${item.at}`}>
                    <time dateTime={item.at}>{activityDate(item.at)}</time>
                    <Link href={assetHref(item.asset_pda)}>{title}</Link>
                    <p>{detail}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
