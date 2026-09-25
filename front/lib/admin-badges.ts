// Admin menu badges — client half. Plain TypeScript, no React: the menu
// (components/admin-badges.tsx) subscribes through useSyncExternalStore and
// the node tests drive the store and the view helpers directly (the model is
// lib/role-store.ts).
//
// * fetchAdminBadges() reads POST /api/admin/badges over the wallet session
//   only — it never signs a request itself (lib/siws-client.ts
//   `interactive`).
// * The store polls while the tab is visible, refreshes on focus, navigation
//   and the "admin:badges-refresh" event (lib/admin-badges-events.ts), and
//   asks the wallet at most once per page load: the first mount with no
//   session may start one (one prompt, shared with the page's own first
//   read). Opening /admin without a live session therefore prompts once per
//   12 h session; a declined prompt is never repeated by the poll.
// * Rules and the response shape: lib/admin-badge-rules.ts.

import type { WalletSession } from "@solana/client";
import { signedFetch, WalletSessionRequiredError } from "@/lib/siws-client";
import { adminRouteAllows, isRoleRefusal, type Capability } from "@/lib/role-resolution";
import {
  ADMIN_BADGE_HREFS,
  isAdminBadgeHref,
  type AdminBadge,
  type AdminBadgeHref,
  type AdminBadges,
  type BadgePart,
} from "@/lib/admin-badge-rules";

export { ADMIN_BADGES_EVENT, notifyAdminBadges } from "@/lib/admin-badges-events";
export type { AdminBadge, AdminBadgeHref, AdminBadges, BadgePart } from "@/lib/admin-badge-rules";

export const ADMIN_BADGES_ACTION = "admin.badges";
/** Poll period of an admin's visible tab. */
export const BADGE_POLL_MS = 45_000;
/**
 * Poll period of a KYC provider without an Admin record: its gate costs more
 * RPC reads per request (admin check first, then the registry).
 */
export const BADGE_PROVIDER_POLL_MS = 90_000;
/** Least time between two non-event refreshes (measured from the last attempt). */
export const BADGE_MIN_GAP_MS = 10_000;
/** Numbers older than this many poll periods are shown muted as out of date. */
export const BADGE_STALE_POLLS = 2;

export type BadgeReadMode = false | "session-only";

/** One read of the menu counts over the wallet session (never a per-request signature). */
export async function fetchAdminBadges(
  session: WalletSession | null | undefined,
  opts: { fresh?: boolean; interactive?: BadgeReadMode } = {},
): Promise<AdminBadges> {
  return signedFetch<AdminBadges>(
    session,
    "/api/admin/badges",
    ADMIN_BADGES_ACTION,
    opts.fresh ? { fresh: true } : {},
    { interactive: opts.interactive ?? false },
  );
}

// ── View helpers (pure) ─────────────────────────────────────────────────────

/**
 * Who may act on a page's queue beyond opening it. Display only (the count is
 * not sensitive): verify_issuer_kyb is Platform.admin only, so a plain admin
 * sees no Issuers number it could not work off.
 */
export const BADGE_ACTOR: Partial<Record<AdminBadgeHref, Capability>> = {
  "/admin/issuers": "superAdmin",
};

/** The menu shows `href`'s badge to these capabilities (the page gate plus BADGE_ACTOR). */
export function badgeVisible(href: string, caps: ReadonlySet<Capability>): href is AdminBadgeHref {
  if (!isAdminBadgeHref(href) || !adminRouteAllows(href, caps)) return false;
  const actor = BADGE_ACTOR[href];
  return !actor || caps.has(actor);
}

/** "12", "99+", "7+" (a capped read), or null when there is nothing to show. */
export function badgeText(count: number | null | undefined, atLeast?: boolean): string | null {
  if (count === null || count === undefined || !Number.isFinite(count) || count <= 0) return null;
  if (count > 99) return "99+";
  return atLeast ? `${count}+` : String(count);
}

const NOUN: Record<AdminBadgeHref, [one: string, many: string]> = {
  "/admin/issuers": ["issuer waiting for a KYB decision", "issuers waiting for a KYB decision"],
  "/admin/applications": ["launch application to review", "launch applications to review"],
  "/admin/assets": ["draft asset ready to activate", "draft assets ready to activate"],
  "/admin/launchpad": ["expired sale you can close", "expired sales you can close"],
  "/admin/custody": ["custody request to act on", "custody requests to act on"],
  "/admin/otc": ["OTC request waiting for an escrow deal", "OTC requests waiting for an escrow deal"],
  "/admin/governance": ["ended proposal to finalize", "ended proposals to finalize"],
  "/admin/vesting": ["vesting series awaiting review", "vesting series awaiting review"],
  "/admin/clients": ["dossier to review", "dossiers to review"],
  "/admin/inquiries": ["inquiry to handle", "inquiries to handle"],
  "/admin/kyc": ["passport request to decide", "passport requests to decide"],
  "/admin/compliance": ["compliance alert to handle", "compliance alerts to handle"],
  "/admin/payouts": ["payout schedule overdue", "payout schedules overdue"],
};

/** Fixed labels of the reason keys (never data from the response). */
const PART_LABEL: Record<BadgePart, string> = {
  final: "final decision",
  documents: "documents to check",
  kyb: "KYB decision",
  new: "new",
  inReview: "in review",
  open: "open",
  escalated: "escalated",
  delivery: "delivery",
  conversion: "conversion",
  ready: "ready",
  issuerNotVerified: "issuer not KYB-verified",
  noShareClasses: "no share class yet",
  yours: "closable by you",
  issuers: "for the issuer to close",
};

/** Extra context per page, appended to the tooltip. */
const NOTE: Partial<Record<AdminBadgeHref, string>> = {
  "/admin/clients": "a dossier can be in several",
  "/admin/assets": "activation needs this wallet's admin record",
  "/admin/custody": "confirming a conversion needs the vault authority's wallet",
};

function listParts(parts: Partial<Record<BadgePart, number>> | undefined): string[] {
  return Object.entries(parts ?? {})
    .filter(([key, n]) => key in PART_LABEL && typeof n === "number" && n > 0)
    .map(([key, n]) => `${n} ${PART_LABEL[key as BadgePart]}`);
}

/** The pill's hover text, e.g. "65 dossiers to review — 41 final decision · 30 documents to check". */
export function badgeTitle(href: AdminBadgeHref, badge: AdminBadge): string {
  if (badge.count === null) {
    return badge.reason === "indexer"
      ? "Count unavailable — the indexer is catching up"
      : "Count unavailable — try again shortly";
  }
  const [one, many] = NOUN[href];
  const n = badge.count;
  let title = `${badgeText(n, badge.atLeast) ?? String(n)} ${n === 1 ? one : many}`;
  const parts = listParts(badge.parts);
  // A single reason equal to the whole count adds nothing.
  if (parts.length > 1 || (parts.length === 1 && Object.keys(badge.parts ?? {}).length > 1)) {
    title += ` — ${parts.join(" · ")}`;
  }
  const aside = listParts(badge.aside);
  if (aside.length > 0) title += ` (not counted: ${aside.join(" · ")})`;
  if (NOTE[href]) title += `; ${NOTE[href]}`;
  return title;
}

/** Why the numbers are out of date: no usable wallet session, or the reads keep failing. */
export type StaleCause = "session" | "error";

export type BadgeFlags = { stale?: boolean; staleCause?: StaleCause | null; fresh?: boolean };

/** Screen-reader suffix read after the link label: "Clients, 65 waiting". */
export function badgeSrText(badge: AdminBadge, flags: BadgeFlags = {}): string {
  if (badge.count === null) return "count unavailable";
  const text = badgeText(badge.count, badge.atLeast) ?? "0";
  return `${text} waiting${flags.fresh ? ", new since your last visit" : ""}${flags.stale ? ", may be out of date" : ""}`;
}

export type BadgeView = {
  /** "12", "99+", "7+", or "•" when the count is unavailable. */
  text: string;
  srText: string;
  title: string;
  /** Muted: unavailable (a dot) or out of date (the last number, greyed). */
  muted: boolean;
  /** Newer rows than at the viewer's last visit to the page. */
  fresh: boolean;
};

/** What the menu renders for one item, or null (no queue, or nothing waiting). */
export function badgeView(
  href: AdminBadgeHref,
  badge: AdminBadge | undefined,
  flags: BadgeFlags = {},
): BadgeView | null {
  if (!badge) return null;
  if (badge.count === null) {
    return { text: "•", srText: badgeSrText(badge), title: badgeTitle(href, badge), muted: true, fresh: false };
  }
  const text = badgeText(badge.count, badge.atLeast);
  if (!text) return null;
  const fresh = Boolean(flags.fresh);
  let title = badgeTitle(href, badge);
  if (fresh) title += ". New since your last visit";
  if (flags.stale) {
    title += flags.staleCause === "error"
      ? ". Not updated for a while — the last reads failed; it keeps retrying"
      : ". Not updated for a while — it refreshes once this wallet's session is renewed";
  }
  return { text, srText: badgeSrText(badge, { stale: flags.stale, fresh }), title, muted: Boolean(flags.stale), fresh };
}

/** Sum of the visible, known counts (the collapsed menu toggle). */
export function badgeTotal(
  badges: Partial<Record<AdminBadgeHref, AdminBadge>>,
  visible: (href: AdminBadgeHref) => boolean,
): number {
  let total = 0;
  for (const href of ADMIN_BADGE_HREFS) {
    const count = badges[href]?.count;
    if (typeof count === "number" && count > 0 && visible(href)) total += count;
  }
  return total;
}

/** What the menu renders: one pill per item and the sum for the collapsed toggle. */
export type BadgeMenu = {
  /** The pill of one menu item, or null (no queue, nothing waiting, not this viewer's). */
  view(href: string): BadgeView | null;
  /** The sum for the collapsed menu toggle, or null when nothing waits. */
  total: BadgeView | null;
};

export const NO_BADGE_MENU: BadgeMenu = Object.freeze({ view: () => null, total: null });

/** The menu of `caps` from a store snapshot (the server already filtered by role; this is R3's second half). */
export function badgeMenu(snapshot: AdminBadgesSnapshot, caps: ReadonlySet<Capability>): BadgeMenu {
  const flags = (href: AdminBadgeHref) => {
    const badge = snapshot.badges[href];
    return { stale: snapshot.stale, staleCause: snapshot.staleCause, fresh: isNewSinceSeen(badge?.latest, snapshot.seen[href]) };
  };
  const view = (href: string): BadgeView | null =>
    badgeVisible(href, caps) ? badgeView(href, snapshot.badges[href], flags(href)) : null;
  const shown = (href: AdminBadgeHref) => badgeVisible(href, caps);
  const text = badgeText(badgeTotal(snapshot.badges, shown));
  if (!text) return { view, total: null };
  const fresh = ADMIN_BADGE_HREFS.some((href) => shown(href) && (snapshot.badges[href]?.count ?? 0) > 0 && flags(href).fresh);
  return {
    view,
    total: {
      text,
      srText: `${text} waiting${fresh ? ", new since your last visit" : ""}${snapshot.stale ? ", may be out of date" : ""}`,
      title: `${text} waiting across the admin pages${fresh ? ". Something new since your last visit" : ""}`,
      muted: snapshot.stale,
      fresh,
    },
  };
}

// ── "New since your last visit" (per viewer, this browser only) ─────────────

export type SeenMap = Partial<Record<AdminBadgeHref, string>>;

function inSection(path: string | null, href: string): boolean {
  return !!path && (path === href || path.startsWith(`${href}/`));
}

/** True when the queue has a row newer than the viewer's last look at the page. */
export function isNewSinceSeen(latest: string | undefined, seen: string | undefined): boolean {
  if (!latest || !seen) return false;
  const a = Date.parse(latest);
  const b = Date.parse(seen);
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

/**
 * The seen marks after a read or a navigation: a queue the viewer has never
 * had a mark for gets one silently (no flood of dots on the first visit), and
 * the page being viewed is marked seen. Returns `seen` itself when nothing
 * changed.
 */
export function nextSeen(
  seen: SeenMap,
  badges: Partial<Record<AdminBadgeHref, AdminBadge>>,
  path: string | null,
): SeenMap {
  let next: SeenMap | null = null;
  for (const href of ADMIN_BADGE_HREFS) {
    const latest = badges[href]?.latest;
    if (!latest) continue;
    const mark = seen[href];
    if (mark === undefined || (inSection(path, href) && isNewSinceSeen(latest, mark))) {
      next ??= { ...seen };
      next[href] = latest;
    }
  }
  return next ?? seen;
}

// ── Store ───────────────────────────────────────────────────────────────────

export type BadgeRefreshReason = "mount" | "poll" | "focus" | "navigate" | "event";

export type AdminBadgesStoreDeps = {
  load(opts: { fresh: boolean; interactive: BadgeReadMode }): Promise<AdminBadges>;
  /** A live wallet session exists (hasWalletSession): reads need no prompt. */
  hasSession(): boolean;
  /** The tab is visible (polls skip hidden tabs). */
  visible(): boolean;
  /** Poll period for this viewer (BADGE_POLL_MS or BADGE_PROVIDER_POLL_MS). */
  pollMs: number;
  /** Where the "seen" marks live (localStorage in the browser); optional. */
  storage?: { read(key: string): SeenMap | null; write(key: string, seen: SeenMap): void };
};

export type AdminBadgesSnapshot = {
  key: string | null;
  badges: Partial<Record<AdminBadgeHref, AdminBadge>>;
  /** When the last successful read finished (0 = never, this key). */
  updatedAt: number;
  /**
   * No successful read for BADGE_STALE_POLLS poll periods: show muted. Judged
   * only when a read was skipped for want of a session or has failed — never
   * right before a read starts, so a tab coming back does not flash grey.
   */
  stale: boolean;
  staleCause: StaleCause | null;
  seen: SeenMap;
  /** Last error text (display/debug only); null after a success. */
  error: string | null;
};

export type AdminBadgesStore = {
  /**
   * Point the store at a viewer: `key` = `${network}|${wallet}`, or null when
   * the wallet is not eligible. A key change drops the snapshot, so wallet
   * A's counts are never shown to B. Re-binding the same key only swaps deps.
   */
  bind(key: string | null, deps: AdminBadgesStoreDeps | null): void;
  /** The current pathname, for the "seen" marks. */
  setPath(path: string | null): void;
  /** Resolves when the read (if any) settled; never rejects. */
  refresh(reason: BadgeRefreshReason): Promise<void>;
  getSnapshot(): AdminBadgesSnapshot;
  subscribe(listener: () => void): () => void;
};

export const EMPTY_BADGES_SNAPSHOT: AdminBadgesSnapshot = Object.freeze({
  key: null,
  badges: Object.freeze({}),
  updatedAt: 0,
  stale: false,
  staleCause: null,
  seen: Object.freeze({}),
  error: null,
}) as AdminBadgesSnapshot;

export function createAdminBadgesStore(opts: { now?: () => number; minGapMs?: number } = {}): AdminBadgesStore {
  const now = opts.now ?? Date.now;
  const minGapMs = opts.minGapMs ?? BADGE_MIN_GAP_MS;
  let key: string | null = null;
  let deps: AdminBadgesStoreDeps | null = null;
  let path: string | null = null;
  let snapshot: AdminBadgesSnapshot = EMPTY_BADGES_SNAPSHOT;
  let inFlight: { key: string; promise: Promise<void> } | null = null;
  let eventPending = false;
  let lastAttemptAt = 0;
  /** Keys whose one prompting attempt this page load has been spent. */
  const prompted = new Set<string>();
  const listeners = new Set<() => void>();

  function publish(next: AdminBadgesSnapshot) {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function update(patch: Partial<AdminBadgesSnapshot>) {
    publish({ ...snapshot, ...patch });
  }

  function saveSeen(seen: SeenMap) {
    if (seen === snapshot.seen || !key) return seen;
    try { deps?.storage?.write(key, seen); } catch { /* storage blocked: the marks live in memory */ }
    return seen;
  }

  function checkStale(cause: StaleCause) {
    if (!deps || snapshot.updatedAt === 0) return;
    const stale = now() - snapshot.updatedAt > deps.pollMs * BADGE_STALE_POLLS + minGapMs;
    const staleCause = stale ? cause : null;
    if (stale !== snapshot.stale || staleCause !== snapshot.staleCause) update({ stale, staleCause });
  }

  async function read(boundKey: string, d: AdminBadgesStoreDeps, reason: BadgeRefreshReason, mode: BadgeReadMode) {
    const fresh = reason === "event";
    let data: AdminBadges;
    try {
      try {
        if (mode === "session-only") prompted.add(boundKey);
        data = await d.load({ fresh, interactive: mode });
      } catch (err) {
        // The session the hint named was gone (401): this mount may still
        // spend its one prompt to start a new one.
        if (!(err instanceof WalletSessionRequiredError) || mode !== false || reason !== "mount" || prompted.has(boundKey)) throw err;
        prompted.add(boundKey);
        data = await d.load({ fresh, interactive: "session-only" });
      }
    } catch (err) {
      if (key !== boundKey) return;
      // No session and no prompt allowed: the numbers stay, the next tick re-checks.
      if (err instanceof WalletSessionRequiredError) {
        checkStale("session");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // A role refusal right after a grant (confirmed vs finalized): no numbers
      // until the next poll. Anything else keeps the last numbers.
      if (isRoleRefusal(message)) {
        update({ badges: {}, error: message });
      } else {
        update({ error: message });
        checkStale("error");
      }
      return;
    }
    if (key !== boundKey) return;
    const badges = data?.badges ?? {};
    publish({
      ...snapshot,
      badges,
      updatedAt: now(),
      stale: false,
      staleCause: null,
      seen: saveSeen(nextSeen(snapshot.seen, badges, path)),
      error: null,
    });
  }

  function refresh(reason: BadgeRefreshReason): Promise<void> {
    const boundKey = key;
    const d = deps;
    if (!boundKey || !d) return Promise.resolve();
    if (inFlight && inFlight.key === boundKey) {
      // An admin action during a read: run once more afterwards, fresh.
      if (reason === "event") eventPending = true;
      return inFlight.promise;
    }
    if (reason === "poll" && !d.visible()) return Promise.resolve();
    if (reason !== "event" && reason !== "mount" && now() - lastAttemptAt < minGapMs) return Promise.resolve();
    if (reason === "mount" && snapshot.updatedAt > 0 && now() - lastAttemptAt < minGapMs) return Promise.resolve();

    let mode: BadgeReadMode;
    if (d.hasSession()) mode = false;
    else if (reason === "mount" && !prompted.has(boundKey)) mode = "session-only";
    else {
      // No session and no prompt allowed: skip the call (a hidden tab's poll
      // returned above, so this is a viewer looking at old numbers).
      checkStale("session");
      return Promise.resolve();
    }

    lastAttemptAt = now();
    const promise = read(boundKey, d, reason, mode).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
      if (eventPending && key === boundKey) {
        eventPending = false;
        void refresh("event");
      }
    });
    inFlight = { key: boundKey, promise };
    return promise;
  }

  return {
    bind(nextKey, nextDeps) {
      if (nextKey === key) {
        deps = nextDeps;
        return;
      }
      key = nextKey;
      deps = nextDeps;
      eventPending = false;
      lastAttemptAt = 0;
      let seen: SeenMap = {};
      if (nextKey && nextDeps?.storage) {
        try { seen = nextDeps.storage.read(nextKey) ?? {}; } catch { seen = {}; }
      }
      publish({ ...EMPTY_BADGES_SNAPSHOT, key: nextKey, seen });
    },
    setPath(nextPath) {
      path = nextPath;
      const seen = nextSeen(snapshot.seen, snapshot.badges, path);
      if (seen !== snapshot.seen) update({ seen: saveSeen(seen) });
    },
    refresh,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
