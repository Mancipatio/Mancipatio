// SERVER-ONLY — the counts behind the admin menu badges (POST
// /api/admin/badges). Each source counts the rows of one admin page whose
// next step belongs to the caller; the shared rules are in
// lib/admin-badge-rules.ts, which the pages use for the same numbers.
//
// * Role first: only the sources of the gate's role run — a KYC provider gets
//   /admin/clients (without the KYB reason) and /admin/kyc, the two pages
//   ADMIN_ROUTE_ACCESS opens for it. Sources for other pages never run.
// * Counts only: head counts, or id/status reads that stay in this process.
//   The result holds integers, fixed reason keys and one timestamp per queue.
// * Isolation: every source has its own 4 s budget (abort + race); a failing
//   or slow source is `null` ("unavailable") and the others still answer.
// * Indexer sources (issuers, assets, sales, proposals) share one
//   indexer_sync_state read and run only while the mirror is fresh
//   (lib/indexer-freshness.ts); otherwise they are `null` ("indexer").
// * Memo: 10 s per network|role|wallet, concurrent callers share one run;
//   `fresh` (sent right after an admin action) reads again. Per instance and
//   best effort — it absorbs several tabs of one admin, it does not protect
//   the database.
// * passport_requests and payout_schedules have no network column; their
//   pages read them unscoped too (one Supabase project serves one network).

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork, type Network } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import type { AdminOrKycRole } from "@/lib/server/kyc-provider-gate";
import { readClientReviewQueue } from "@/lib/server/client-review-queue";
import { isIndexerStateFresh } from "@/lib/indexer-freshness";
import { AssetStatus } from "@/lib/generated/asset_registry/types/assetStatus";
import { KybStatus } from "@/lib/generated/asset_registry/types/kybStatus";
import { ProposalStatus } from "@/lib/generated/asset_registry/types/proposalStatus";
import { SaleStatus } from "@/lib/generated/asset_registry/types/saleStatus";
import {
  assetActivationBlock,
  CONVERSION_ADMIN_STATUSES,
  DELIVERY_ADMIN_STATUSES,
  VESTING_REVIEW_FILTER,
  type AdminBadge,
  type AdminBadgeHref,
  type AdminBadges,
  type BadgePart,
} from "@/lib/admin-badge-rules";

export const BADGE_SOURCE_TIMEOUT_MS = 4_000;
export const BADGE_MEMO_MS = 10_000;
/** A `fresh` burst still re-reads at most this often per key. */
const FRESH_MIN_GAP_MS = 1_000;
const MEMO_MAX_KEYS = 64;
/** Bounded row reads (PostgREST caps an un-ranged select at 1000 rows). */
const ROW_CAP = 1000;
/** Issuer pdas per `.in()` read. */
const PDA_CHUNK = 100;
const HEAD = { count: "exact", head: true } as const;

type DbError = { message: string; code?: string };

class BadgeReadError extends Error {
  readonly code: string | undefined;
  constructor(error: DbError) {
    super(error.message);
    this.code = error.code;
  }
}

async function headCount(query: PromiseLike<{ count: number | null; error: DbError | null }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw new BadgeReadError(error);
  if (typeof count !== "number") throw new Error("count missing");
  return count;
}

async function rows<T>(query: PromiseLike<{ data: T[] | null; error: DbError | null }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new BadgeReadError(error);
  return data ?? [];
}

/** The newest `column` value of a narrowed query, or undefined. */
async function newest(
  query: PromiseLike<{ data: Record<string, unknown>[] | null; error: DbError | null }>,
  column: string,
): Promise<string | undefined> {
  const [row] = await rows(query);
  const value = row?.[column];
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

type BadgeContext = {
  sb: SupabaseClient;
  network: Network;
  wallet: string;
  role: AdminOrKycRole;
  nowSec: number;
  /** UTC YYYY-MM-DD, the same day as todayIso() in lib/payout-schedules.ts. */
  today: string;
  signal: AbortSignal;
};

type Source = {
  href: AdminBadgeHref;
  /** Gate roles that may see this page's count (ADMIN_ROUTE_ACCESS). */
  roles: readonly AdminOrKycRole[];
  /** Reads the indexer mirror: skipped (null, "indexer") unless it is fresh. */
  indexer?: true;
  read(ctx: BadgeContext): Promise<AdminBadge>;
};

const ADMIN: readonly AdminOrKycRole[] = ["admin"];
const ADMIN_OR_PROVIDER: readonly AdminOrKycRole[] = ["admin", "kycProvider"];

function withParts(count: number, parts: Partial<Record<BadgePart, number>>): AdminBadge {
  return { count, parts };
}

/** The 13 queues of the admin menu, in menu order (the badge table of the design). */
export const BADGE_SOURCES: readonly Source[] = [
  {
    // KYB decisions are verify_issuer_kyb, which only Platform.admin can sign:
    // the menu shows this one to the super admin only (lib/admin-badges.ts).
    href: "/admin/issuers",
    roles: ADMIN,
    indexer: true,
    read: async ({ sb, network, signal }) => ({
      count: await headCount(sb.from("issuers").select("pda", HEAD)
        .eq("network", network).eq("kyb_status", KybStatus.Pending).abortSignal(signal)),
    }),
  },
  {
    // New submissions and resubmissions (resubmit sets `pending` again).
    href: "/admin/applications",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => {
      const [count, latest] = await Promise.all([
        headCount(sb.from("launch_applications").select("id", HEAD)
          .eq("network", network).eq("status", "pending").abortSignal(signal)),
        newest(sb.from("launch_applications").select("submitted_at").eq("network", network).eq("status", "pending")
          .order("submitted_at", { ascending: false }).limit(1).abortSignal(signal), "submitted_at"),
      ]);
      return { count, ...(count > 0 && latest ? { latest } : {}) };
    },
  },
  {
    // Drafts an admin can activate now: issuer KYB Verified and at least one
    // share class (activate_asset.rs). The others wait on the issuer.
    href: "/admin/assets",
    roles: ADMIN,
    indexer: true,
    read: async ({ sb, network, signal }) => {
      const drafts = await rows<{ issuer_pda: string; share_classes_count: number | null }>(
        sb.from("assets").select("issuer_pda,share_classes_count")
          .eq("network", network).eq("status", AssetStatus.Draft).limit(ROW_CAP).abortSignal(signal),
      );
      const issuerPdas = [...new Set(drafts.map((d) => d.issuer_pda))];
      const verified = new Set<string>();
      for (let i = 0; i < issuerPdas.length; i += PDA_CHUNK) {
        const found = await rows<{ pda: string }>(sb.from("issuers").select("pda")
          .eq("network", network).eq("kyb_status", KybStatus.Verified)
          .in("pda", issuerPdas.slice(i, i + PDA_CHUNK)).abortSignal(signal));
        for (const r of found) verified.add(r.pda);
      }
      const tally = { ready: 0, issuerNotVerified: 0, noShareClasses: 0 };
      for (const d of drafts) {
        const block = assetActivationBlock({
          status: AssetStatus.Draft,
          shareClassesCount: Number(d.share_classes_count ?? 0),
          issuerVerified: verified.has(d.issuer_pda),
        });
        if (block === null) tally.ready += 1;
        else if (block === "issuerNotVerified") tally.issuerNotVerified += 1;
        else if (block === "noShareClasses") tally.noShareClasses += 1;
      }
      return {
        count: tally.ready,
        parts: { ready: tally.ready },
        aside: { issuerNotVerified: tally.issuerNotVerified, noShareClasses: tally.noShareClasses },
        ...(drafts.length >= ROW_CAP ? { atLeast: true as const } : {}),
      };
    },
  },
  {
    // Every expired sale that is still open — the page's "Expired (open)"
    // filter. close_sale needs the sale's issuer key, so the parts say how
    // many the caller can close itself.
    href: "/admin/launchpad",
    roles: ADMIN,
    indexer: true,
    read: async ({ sb, network, wallet, nowSec, signal }) => {
      const expiredOpen = () => sb.from("sales").select("pda", HEAD)
        .eq("network", network).eq("status", SaleStatus.Open).gt("end_ts", 0).lte("end_ts", nowSec);
      const [count, yours] = await Promise.all([
        headCount(expiredOpen().abortSignal(signal)),
        headCount(expiredOpen().eq("authority", wallet).abortSignal(signal)),
      ]);
      return withParts(count, { yours, issuers: Math.max(0, count - yours) });
    },
  },
  {
    // The "N to act" pills of the two request lists (vault_opened waits on the holder).
    href: "/admin/custody",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => {
      const [delivery, conversion] = await Promise.all([
        headCount(sb.from("delivery_requests").select("id", HEAD)
          .eq("network", network).in("status", [...DELIVERY_ADMIN_STATUSES]).abortSignal(signal)),
        headCount(sb.from("conversion_requests").select("id", HEAD)
          .eq("network", network).in("status", [...CONVERSION_ADMIN_STATUSES]).abortSignal(signal)),
      ]);
      return withParts(delivery + conversion, { delivery, conversion });
    },
  },
  {
    // Requests waiting for an escrow deal (the page loads exactly these).
    href: "/admin/otc",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => ({
      count: await headCount(sb.from("otc_requests").select("id", HEAD)
        .eq("network", network).eq("status", "requested").abortSignal(signal)),
    }),
  },
  {
    // Active proposals past their end time — the page's "Ended" filter.
    // finalize_proposal is permissionless once the window is over.
    href: "/admin/governance",
    roles: ADMIN,
    indexer: true,
    read: async ({ sb, network, nowSec, signal }) => ({
      count: await headCount(sb.from("proposals").select("pda", HEAD)
        .eq("network", network).eq("status", ProposalStatus.Active).gt("end_ts", 0).lte("end_ts", nowSec)
        .abortSignal(signal)),
    }),
  },
  {
    // The page's "Awaiting review" KPI (vestingSeriesNeedsReview).
    href: "/admin/vesting",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => ({
      count: await headCount(sb.from("vesting_series").select("id", HEAD)
        .eq("network", network).or(VESTING_REVIEW_FILTER).abortSignal(signal)),
    }),
  },
  {
    // Distinct dossiers with a reviewer step (the "Needs review" tab).
    href: "/admin/clients",
    roles: ADMIN_OR_PROVIDER,
    read: async ({ sb, network, role, signal }) => {
      const queue = await readClientReviewQueue(sb, network, role, signal);
      const parts: Partial<Record<BadgePart, number>> = { final: 0, documents: 0, ...(role === "admin" ? { kyb: 0 } : {}) };
      for (const reasons of queue.reasons.values()) {
        for (const reason of reasons) parts[reason] = (parts[reason] ?? 0) + 1;
      }
      const count = queue.reasons.size;
      return {
        count,
        parts,
        ...(queue.capped ? { atLeast: true as const } : {}),
        ...(count > 0 && queue.latest ? { latest: queue.latest } : {}),
      };
    },
  },
  {
    // KPIs "New" and "In review"; `proposed` and later wait on the client.
    href: "/admin/inquiries",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => {
      const status = (value: string) => headCount(sb.from("custom_inquiries").select("id", HEAD)
        .eq("network", network).eq("status", value).abortSignal(signal));
      const [fresh, inReview] = await Promise.all([status("new"), status("in_review")]);
      return withParts(fresh + inReview, { new: fresh, inReview });
    },
  },
  {
    // New passport requests — the queue's default "New" tab. "Mark in review"
    // is triage, not a decision, and an in-review request often waits on the
    // KYC provider or on the dossier (Clients), so it is named, not counted.
    // No network column (see the header).
    href: "/admin/kyc",
    roles: ADMIN_OR_PROVIDER,
    read: async ({ sb, signal }) => {
      const status = (value: string) => headCount(sb.from("passport_requests").select("id", HEAD)
        .eq("status", value).abortSignal(signal));
      const [fresh, inReview, latest] = await Promise.all([
        status("new"),
        status("in_review"),
        newest(sb.from("passport_requests").select("created_at").eq("status", "new")
          .order("created_at", { ascending: false }).limit(1).abortSignal(signal), "created_at"),
      ]);
      return { count: fresh, parts: { new: fresh }, aside: { inReview }, ...(fresh > 0 && latest ? { latest } : {}) };
    },
  },
  {
    // Open and escalated alerts, system alarms (0072) included.
    href: "/admin/compliance",
    roles: ADMIN,
    read: async ({ sb, network, signal }) => {
      const status = (value: string) => headCount(sb.from("compliance_alerts").select("id", HEAD)
        .eq("network", network).eq("status", value).abortSignal(signal));
      const [open, escalated] = await Promise.all([status("open"), status("escalated")]);
      return withParts(open + escalated, { open, escalated });
    },
  },
  {
    // Active schedules whose next_due is in the past: the red "overdue" rows.
    // Overdue or freezable payout vaults are RPC-only and not counted. No
    // network column (see the header).
    href: "/admin/payouts",
    roles: ADMIN,
    read: async ({ sb, today, signal }) => ({
      count: await headCount(sb.from("payout_schedules").select("id", HEAD)
        .eq("active", true).lt("next_due", today).abortSignal(signal)),
    }),
  },
];

const UNAVAILABLE: AdminBadge = Object.freeze({ count: null, reason: "unavailable" as const });
const INDEXER_BEHIND: AdminBadge = Object.freeze({ count: null, reason: "indexer" as const });

/** Runs `read` with its own abort signal; rejects after `ms` even if the query ignores it. */
async function withTimeout<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function indexerIsFresh(sb: SupabaseClient, network: Network): Promise<boolean> {
  try {
    return await withTimeout(BADGE_SOURCE_TIMEOUT_MS, async (signal) => {
      const { data, error } = await sb.from("indexer_sync_state").select("status,checked_at,completed_at")
        .eq("network", network).abortSignal(signal).maybeSingle();
      return !error && isIndexerStateFresh(data);
    });
  } catch {
    return false;
  }
}

async function computeBadges(
  sb: SupabaseClient,
  network: Network,
  wallet: string,
  role: AdminOrKycRole,
): Promise<AdminBadges> {
  // R3: pick the role's sources BEFORE anything runs.
  const sources = BADGE_SOURCES.filter((s) => s.roles.includes(role));
  const fresh = sources.some((s) => s.indexer) ? indexerIsFresh(sb, network) : Promise.resolve(false);
  const now = new Date();
  const base = {
    sb, network, wallet, role,
    nowSec: Math.floor(now.getTime() / 1000),
    today: now.toISOString().slice(0, 10),
  };
  const settled = await Promise.allSettled(sources.map(async (source) => {
    if (source.indexer && !(await fresh)) return INDEXER_BEHIND;
    return withTimeout(BADGE_SOURCE_TIMEOUT_MS, (signal) => source.read({ ...base, signal }));
  }));
  const badges: Partial<Record<AdminBadgeHref, AdminBadge>> = {};
  settled.forEach((result, i) => {
    const { href } = sources[i];
    if (result.status === "fulfilled") {
      badges[href] = result.value;
    } else {
      const err = result.reason as { code?: unknown; message?: unknown } | undefined;
      // Never params, ids or rows — the error code or message only.
      console.warn(`[api/admin/badges] ${href} failed:`, err?.code ?? err?.message ?? "unknown error");
      badges[href] = UNAVAILABLE;
    }
  });
  return { network, checkedAt: now.toISOString(), badges };
}

type MemoEntry = { at: number; value?: AdminBadges; running?: Promise<AdminBadges> };
const memo = new Map<string, MemoEntry>();

/**
 * The badges of `wallet` in `role` on this deployment's network. Never
 * rejects over a single source; throws SiwsError(503) when the database
 * client cannot be built at all (env unset).
 */
export async function readAdminBadges(opts: {
  wallet: string;
  role: AdminOrKycRole;
  fresh?: boolean;
}): Promise<AdminBadges> {
  const network = detectNetwork();
  // The wallet is part of the key: the Launchpad parts are per wallet.
  const key = `${network}|${opts.role}|${opts.wallet}`;
  const hit = memo.get(key);
  const now = Date.now();
  if (hit?.running && !opts.fresh) return hit.running;
  if (hit?.value && now - hit.at < (opts.fresh ? FRESH_MIN_GAP_MS : BADGE_MEMO_MS)) return hit.value;

  let sb: SupabaseClient;
  try {
    sb = getSupabaseAdmin();
  } catch (err) {
    console.error("[api/admin/badges] database client unavailable:", err instanceof Error ? err.message : err);
    throw new SiwsError(503, "Admin badges unavailable — try again");
  }
  const running = computeBadges(sb, network, opts.wallet, opts.role);
  memo.delete(key);
  memo.set(key, { at: hit?.at ?? 0, value: hit?.value, running });
  while (memo.size > MEMO_MAX_KEYS) memo.delete(memo.keys().next().value as string);
  try {
    const value = await running;
    if (memo.get(key)?.running === running) memo.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (memo.get(key)?.running === running) memo.delete(key);
    throw err;
  }
}
