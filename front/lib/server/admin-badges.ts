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
// * Memo: 10 s per network|role|wallet, concurrent callers share one run.
//   `fresh` (sent right after an admin action) never takes a value or a run
//   that started before it arrived — those may have read before the action's
//   write committed. It waits for the run in flight and reads once more after
//   it; every fresh caller meanwhile shares that one queued run, so a key has
//   at most one run in flight and one queued. Per instance and best effort —
//   it absorbs several tabs of one admin, it does not protect the database.
// * passport_requests and payout_schedules have no network column; their
//   pages read them unscoped too (one Supabase project serves one network).

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork, type Network } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import type { AdminOrKycRole } from "@/lib/server/kyc-provider-gate";
import { readClientReviewQueue } from "@/lib/server/client-review-queue";
import { withTimeout } from "@/lib/server/with-timeout";
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
    // Expired sales still open that the caller can close: close_sale is
    // has_one = authority, and sale.authority is the issuer key that opened
    // it. Other issuers' expired sales (the rest of the page's "Expired
    // (open)" filter) wait on that issuer: named, not counted — Overview's
    // AlertsCard warns about them.
    href: "/admin/launchpad",
    roles: ADMIN,
    indexer: true,
    read: async ({ sb, network, wallet, nowSec, signal }) => {
      const expiredOpen = () => sb.from("sales").select("pda", HEAD)
        .eq("network", network).eq("status", SaleStatus.Open).gt("end_ts", 0).lte("end_ts", nowSec);
      const [all, yours] = await Promise.all([
        headCount(expiredOpen().abortSignal(signal)),
        headCount(expiredOpen().eq("authority", wallet).abortSignal(signal)),
      ]);
      return { count: yours, parts: { yours }, aside: { issuers: Math.max(0, all - yours) } };
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
    // Passport requests not yet decided — the tabs "New" and "In review".
    // "Mark in review" is triage, not a decision: an in-review request still
    // gets Issue passport (KYC provider) and Reject, and only approved or
    // rejected is handled. No network column (see the header).
    href: "/admin/kyc",
    roles: ADMIN_OR_PROVIDER,
    read: async ({ sb, signal }) => {
      const status = (value: string) => headCount(sb.from("passport_requests").select("id", HEAD)
        .eq("status", value).abortSignal(signal));
      const [fresh, inReview, latest] = await Promise.all([
        status("new"),
        status("in_review"),
        newest(sb.from("passport_requests").select("created_at").in("status", ["new", "in_review"])
          .order("created_at", { ascending: false }).limit(1).abortSignal(signal), "created_at"),
      ]);
      const count = fresh + inReview;
      return { count, parts: { new: fresh, inReview }, ...(count > 0 && latest ? { latest } : {}) };
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

type MemoEntry = {
  /** When the reads behind `value` started: it holds writes committed before then. */
  at: number;
  value?: AdminBadges;
  /** The one computation in flight for this key. */
  running?: Promise<AdminBadges>;
  /** A `fresh` run queued behind `running`, shared by every fresh caller until it starts. */
  queued?: Promise<AdminBadges>;
};
const memo = new Map<string, MemoEntry>();

/** Starts a computation for `key` and records it as the one in flight. */
function begin(key: string, compute: () => Promise<AdminBadges>): Promise<AdminBadges> {
  const at = Date.now();
  const running = compute();
  const prev = memo.get(key);
  // Re-insert: the Map's order is the eviction order (oldest first).
  memo.delete(key);
  memo.set(key, { at: prev?.at ?? 0, value: prev?.value, running });
  while (memo.size > MEMO_MAX_KEYS) memo.delete(memo.keys().next().value as string);
  const settle = (value: AdminBadges | null) => {
    const entry = memo.get(key);
    if (entry?.running !== running) return;
    const queued = entry.queued ? { queued: entry.queued } : {};
    if (value) memo.set(key, { at, value, ...queued });
    else if (entry.queued) memo.set(key, { at: 0, ...queued });
    else memo.delete(key);
  };
  running.then(settle, () => settle(null));
  return running;
}

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
  // The wallet is part of the key: the Launchpad count is per wallet.
  const key = `${network}|${opts.role}|${opts.wallet}`;
  const hit = memo.get(key);
  if (!opts.fresh) {
    if (hit?.running) return hit.running;
    if (hit?.value && Date.now() - hit.at < BADGE_MEMO_MS) return hit.value;
  }

  let sb: SupabaseClient;
  try {
    sb = getSupabaseAdmin();
  } catch (err) {
    console.error("[api/admin/badges] database client unavailable:", err instanceof Error ? err.message : err);
    throw new SiwsError(503, "Admin badges unavailable — try again");
  }
  const compute = () => computeBadges(sb, network, opts.wallet, opts.role);
  // fresh: join the queued run (it has not started yet, so its reads start
  // after this request arrived) …
  if (opts.fresh && hit?.queued) return hit.queued;
  if (!opts.fresh || !hit?.running) return begin(key, compute);
  // … or queue one behind the run in flight, which may have read before the
  // admin's write committed.
  const queued = hit.running.then(() => undefined, () => undefined).then(() => begin(key, compute));
  hit.queued = queued;
  return queued;
}
