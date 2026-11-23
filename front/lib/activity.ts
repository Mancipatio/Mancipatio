// The public activity feed of the overview (components/activity-feed.tsx,
// GET /api/activity/public): what happened to the tokens listed here, newest
// first, in words.
//
// Two kinds of event, both already public one asset at a time:
//   registered  a conversion entered in the company register: the recorded
//               register entry's date, units, stake and registry
//               (/api/cap-table/public shows the same per asset)
//   update      an issuer published a public update for holders
//               (/api/issuer-updates/public): its kind and date only. The
//               title and body are the issuer's words and stay on the asset
//               page, under the note that Manci does not verify them.
// No wallet, holder, case number, request id or document name is part of an
// item: the route selects only the columns below.

import { ISSUER_UPDATE_KIND_LABELS, type IssuerUpdateKind } from "@/lib/issuer-updates";

export type RegisteredActivity = {
  kind: "registered";
  /** The registry decision's date, YYYY-MM-DD. */
  at: string;
  asset_pda: string;
  /** Share-class units (whole tokens: mint decimals are 0). */
  units: string;
  /** The stake as the decision states it, in percent ("2.5"). */
  percent: string;
  registry: string;
};

export type UpdateActivity = {
  kind: "update";
  /** Publication time, ISO 8601. */
  at: string;
  asset_pda: string;
  update_kind: IssuerUpdateKind;
};

export type PublicActivity = RegisteredActivity | UpdateActivity;

/** Items the route returns and the overview shows. */
export const ACTIVITY_LIMIT = 8;

/** Registers the feed names in full; any other is shown as recorded. */
const REGISTRY_NAMES: Record<string, string> = {
  APR: "the Serbian Business Registers Agency (APR)",
};

export function registryName(registry: string): string {
  return REGISTRY_NAMES[registry.trim().toUpperCase()] ?? registry.trim();
}

function timeOf(at: string): number {
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
  return Number.isNaN(time) ? 0 : time;
}

/** Newest first; a stable order for items of the same moment. */
export function byActivityDesc(a: PublicActivity, b: PublicActivity): number {
  return timeOf(b.at) - timeOf(a.at) || a.kind.localeCompare(b.kind) || a.asset_pda.localeCompare(b.asset_pda);
}

/** "9 Oct 2026" (UTC), or "" for an unreadable date. */
export function activityDate(at: string): string {
  const time = timeOf(at);
  if (!time) return "";
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function count(units: string): string {
  return /^\d+$/.test(units) ? BigInt(units).toLocaleString("en-US") : units;
}

/** What happened, for a token called `name`. */
export function activityText(item: PublicActivity, name: string): { title: string; detail: string } {
  if (item.kind === "registered") {
    const tokens = `${count(item.units)} ${item.units === "1" ? "token" : "tokens"}`;
    return {
      title: `${tokens} of ${name} converted into registered ownership`,
      detail: `${item.percent} % of the company, entered in ${registryName(item.registry)}.`,
    };
  }
  return {
    title: `${ISSUER_UPDATE_KIND_LABELS[item.update_kind]} published for ${name}`,
    detail: "Published by the issuer for token holders.",
  };
}
