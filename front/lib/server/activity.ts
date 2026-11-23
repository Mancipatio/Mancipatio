// SERVER-ONLY — the rows behind GET /api/activity/public (lib/activity.ts).
//
// Reads, for this deployment's network only:
//   register_entries  recorded entries: asset, units, stake, registry, date
//   issuer_updates    published, public, asset-scoped updates: asset, kind,
//                     publication time
// and leaves out everything of an archived asset or issuer (lib/archive.ts).
// The SELECT names only those columns, so a case number, a holder's dossier,
// a wallet or an update's text cannot reach the response. A database error
// answers 503: an incomplete feed is not shown as the whole of it.

import "server-only";

import { detectNetwork } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";
import { readArchivedSet } from "@/lib/server/archive";
import { bpsToPercent } from "@/lib/cap-table";
import { ISSUER_UPDATE_KINDS, type IssuerUpdateKind } from "@/lib/issuer-updates";
import { ACTIVITY_LIMIT, byActivityDesc, type PublicActivity } from "@/lib/activity";

const ENTRY_COLUMNS = "asset_pda,units::text,percent_bps::text,registry,decision_date,status";
const UPDATE_COLUMNS = "asset_pda,issuer_pda,kind,visibility,status,published_at";
/** Rows read per source: enough to fill the feed after the archived ones are dropped. */
const SCAN = ACTIVITY_LIMIT * 4;

type Row = Record<string, unknown>;

function unavailable(): never {
  throw new SiwsError(503, "Activity unavailable — try again");
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export async function readPublicActivity(): Promise<PublicActivity[]> {
  const network = detectNetwork();
  const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
  const [entries, updates, archived] = await Promise.all([
    sb.from("register_entries").select(ENTRY_COLUMNS)
      .eq("network", network).eq("status", "recorded")
      .order("decision_date", { ascending: false }).limit(SCAN),
    sb.from("issuer_updates").select(UPDATE_COLUMNS)
      .eq("network", network).eq("status", "published").eq("visibility", "public")
      .not("asset_pda", "is", null).not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(SCAN),
    readArchivedSet(sb),
  ]);
  if (entries.error || updates.error) unavailable();

  // An archived issuer's assets are withdrawn with it: their issuer comes from the profile rows.
  const assets = [...new Set([...(entries.data ?? []), ...(updates.data ?? [])]
    .map((row) => text((row as unknown as Row).asset_pda)).filter((pda): pda is string => pda !== null))];
  const issuerOf = new Map<string, string>();
  if (assets.length && archived.issuers.length) {
    const profiles = await sb.from("asset_profiles").select("asset_pda,issuer_pda").eq("network", network).in("asset_pda", assets);
    if (profiles.error) unavailable();
    for (const row of profiles.data ?? []) {
      const { asset_pda, issuer_pda } = row as unknown as Row;
      if (typeof asset_pda === "string" && typeof issuer_pda === "string") issuerOf.set(asset_pda, issuer_pda);
    }
  }
  const archivedAssets = new Set(archived.assets);
  const archivedIssuers = new Set(archived.issuers);
  const hidden = (assetPda: string, issuerPda?: string | null) =>
    archivedAssets.has(assetPda) || archivedIssuers.has(issuerPda ?? issuerOf.get(assetPda) ?? "");

  const items: PublicActivity[] = [];
  for (const value of entries.data ?? []) {
    const row = value as unknown as Row;
    const asset = text(row.asset_pda);
    const units = text(row.units);
    const registry = text(row.registry);
    const date = text(row.decision_date);
    const percent = bpsToPercent(typeof row.percent_bps === "number" ? String(row.percent_bps) : text(row.percent_bps) ?? "");
    if (row.status !== "recorded" || !asset || !units || !/^\d{1,20}$/.test(units) || !registry || !date || !percent) continue;
    if (hidden(asset)) continue;
    items.push({ kind: "registered", at: date.slice(0, 10), asset_pda: asset, units, percent, registry });
  }
  for (const value of updates.data ?? []) {
    const row = value as unknown as Row;
    const asset = text(row.asset_pda);
    const at = text(row.published_at);
    const kind = text(row.kind) as IssuerUpdateKind | null;
    if (row.status !== "published" || row.visibility !== "public" || !asset || !at || !kind) continue;
    if (!ISSUER_UPDATE_KINDS.includes(kind) || hidden(asset, text(row.issuer_pda))) continue;
    items.push({ kind: "update", at, asset_pda: asset, update_kind: kind });
  }
  return items.sort(byActivityDesc).slice(0, ACTIVITY_LIMIT);
}
