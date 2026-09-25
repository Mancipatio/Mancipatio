// lib/admin-badges.ts — the client half of the admin menu counts: the view
// helpers (text, cap, screen-reader text, tooltip, visibility, total), the
// "new since your last visit" marks, the store (poll / focus / navigate /
// event refreshes, the one-prompt policy, stale and error handling) and the
// refresh event. Pure: fake loaders and clocks, no React, no wallet.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  badgeMenu,
  badgeSrText,
  badgeText,
  badgeTitle,
  badgeTotal,
  badgeView,
  badgeVisible,
  createAdminBadgesStore,
  EMPTY_BADGES_SNAPSHOT,
  isNewSinceSeen,
  nextSeen,
  notifyAdminBadges,
  ADMIN_BADGES_EVENT,
  type AdminBadges,
  type AdminBadgesStoreDeps,
  type BadgeReadMode,
  type SeenMap,
} from "@/lib/admin-badges";
import { ADMIN_BADGES_INDEXER_DELAY_MS } from "@/lib/admin-badges-events";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import type { Capability } from "@/lib/role-resolution";

const caps = (...list: Capability[]) => new Set<Capability>(list);
const ADMIN = caps("admin");
const SUPER = caps("admin", "superAdmin");
const PROVIDER = caps("kycProvider");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── View helpers ─────────────────────────────────────────────────────────────

describe("badgeText: hidden at 0, capped at 99+", () => {
  it.each([
    [0, undefined, null],
    [-3, undefined, null],
    [null, undefined, null],
    [1, undefined, "1"],
    [99, undefined, "99"],
    [100, undefined, "99+"],
    [4_321, undefined, "99+"],
    [7, true, "7+"],
    [150, true, "99+"],
  ] as const)("%s (atLeast %s) → %s", (count, atLeast, text) => {
    expect(badgeText(count, atLeast)).toBe(text);
  });
});

describe("badge wording", () => {
  it("screen-reader text", () => {
    expect(badgeSrText({ count: 12 })).toBe("12 waiting");
    expect(badgeSrText({ count: 250 })).toBe("99+ waiting");
    expect(badgeSrText({ count: null, reason: "indexer" })).toBe("count unavailable");
    expect(badgeSrText({ count: 3 }, { fresh: true, stale: true })).toBe("3 waiting, new since your last visit, may be out of date");
  });

  it("tooltips name the parts, the overlap and what is not counted", () => {
    expect(badgeTitle("/admin/clients", { count: 65, parts: { final: 41, documents: 30, kyb: 4 } }))
      .toBe("65 dossiers to review — 41 final decision · 30 documents to check · 4 KYB decision; a dossier can be in several");
    expect(badgeTitle("/admin/kyc", { count: 3, parts: { new: 1, inReview: 2 } }))
      .toBe("3 passport requests to decide — 1 new · 2 in review");
    expect(badgeTitle("/admin/assets", { count: 2, parts: { ready: 2 }, aside: { issuerNotVerified: 1, noShareClasses: 0 } }))
      .toBe("2 draft assets ready to activate (not counted: 1 issuer not KYB-verified); activation needs this wallet's admin record");
    expect(badgeTitle("/admin/launchpad", { count: 1, parts: { yours: 1 }, aside: { issuers: 2 } }))
      .toBe("1 expired sale you can close (not counted: 2 for the issuer to close)");
    expect(badgeTitle("/admin/otc", { count: 2 })).toBe("2 OTC requests waiting for an escrow deal");
    expect(badgeTitle("/admin/clients", { count: 7, atLeast: true, parts: { final: 7, documents: 0 } }))
      .toBe("7+ dossiers to review — 7 final decision; a dossier can be in several");
  });

  it("a null count explains itself", () => {
    expect(badgeTitle("/admin/issuers", { count: null, reason: "indexer" })).toBe("Count unavailable — the indexer is catching up");
    expect(badgeTitle("/admin/otc", { count: null, reason: "unavailable" })).toBe("Count unavailable — try again shortly");
  });

  it("badgeView: nothing at 0 or without a queue, a muted dot for null, the capped number otherwise", () => {
    expect(badgeView("/admin/otc", undefined)).toBeNull();
    expect(badgeView("/admin/otc", { count: 0 })).toBeNull();
    expect(badgeView("/admin/otc", { count: null, reason: "unavailable" })).toMatchObject({ text: "•", muted: true, srText: "count unavailable" });
    expect(badgeView("/admin/otc", { count: 120 })).toMatchObject({ text: "99+", muted: false, fresh: false, srText: "99+ waiting" });
    const stale = badgeView("/admin/otc", { count: 2 }, { stale: true, staleCause: "session" })!;
    expect(stale).toMatchObject({ text: "2", muted: true });
    expect(stale.title).toContain("Not updated for a while — it refreshes once this wallet's session is renewed");
    // Failing reads do not blame the session.
    const failing = badgeView("/admin/otc", { count: 2 }, { stale: true, staleCause: "error" })!;
    expect(failing.title).toContain("the last reads failed; it keeps retrying");
    expect(failing.title).not.toContain("session");
    expect(badgeView("/admin/kyc", { count: 2 }, { fresh: true })).toMatchObject({ fresh: true, srText: "2 waiting, new since your last visit" });
  });
});

describe("who sees which badge (display half of R3)", () => {
  it("Issuers only for the super admin; the KYC provider only its two pages", () => {
    expect(badgeVisible("/admin/issuers", ADMIN)).toBe(false);
    expect(badgeVisible("/admin/issuers", SUPER)).toBe(true);
    expect(badgeVisible("/admin/otc", ADMIN)).toBe(true);
    for (const href of ["/admin/otc", "/admin/applications", "/admin/compliance", "/admin/issuers"]) {
      expect(badgeVisible(href, PROVIDER)).toBe(false);
    }
    expect(badgeVisible("/admin/clients", PROVIDER)).toBe(true);
    expect(badgeVisible("/admin/kyc", PROVIDER)).toBe(true);
    // Items without a queue never get a badge.
    expect(badgeVisible("/admin", SUPER)).toBe(false);
    expect(badgeVisible("/admin/blocklist", SUPER)).toBe(false);
  });

  it("badgeTotal skips nulls, zeros and hidden hrefs", () => {
    const badges = { "/admin/otc": { count: 2 }, "/admin/kyc": { count: 3 }, "/admin/issuers": { count: 5 }, "/admin/governance": { count: null }, "/admin/vesting": { count: 0 } };
    expect(badgeTotal(badges, (h) => badgeVisible(h, ADMIN))).toBe(5);
    expect(badgeTotal(badges, (h) => badgeVisible(h, SUPER))).toBe(10);
    expect(badgeTotal(badges, (h) => badgeVisible(h, PROVIDER))).toBe(3);
  });

  it("badgeMenu: a provider never sees an admin count even if the server sent one", () => {
    const snapshot = { ...EMPTY_BADGES_SNAPSHOT, key: "devnet|W", badges: { "/admin/otc": { count: 4 }, "/admin/kyc": { count: 1 } } };
    const provider = badgeMenu(snapshot, PROVIDER);
    expect(provider.view("/admin/otc")).toBeNull();
    expect(provider.view("/admin/kyc")?.text).toBe("1");
    expect(provider.total?.text).toBe("1");
    const admin = badgeMenu(snapshot, ADMIN);
    expect(admin.total).toMatchObject({ text: "5", srText: "5 waiting", muted: false });
    expect(badgeMenu({ ...EMPTY_BADGES_SNAPSHOT, key: "devnet|W" }, ADMIN).total).toBeNull();
  });
});

// ── "New since your last visit" ──────────────────────────────────────────────

describe("seen marks", () => {
  const T1 = "2026-09-25T10:00:00.000Z";
  const T2 = "2026-09-25T11:00:00.000Z";

  it("the first sight of a queue is a silent baseline; a newer row is new until the page is visited", () => {
    const badges = { "/admin/kyc": { count: 1, latest: T1 } };
    const first = nextSeen({}, badges, "/admin");
    expect(first).toEqual({ "/admin/kyc": T1 });
    expect(isNewSinceSeen(T1, first["/admin/kyc"])).toBe(false);
    const later = { "/admin/kyc": { count: 2, latest: T2 } };
    const unchanged = nextSeen(first, later, "/admin/otc");
    expect(unchanged).toBe(first); // same object: nothing to persist
    expect(isNewSinceSeen(T2, unchanged["/admin/kyc"])).toBe(true);
    // Visiting the page (or a sub-page) marks it seen.
    expect(nextSeen(first, later, "/admin/kyc")).toEqual({ "/admin/kyc": T2 });
    expect(nextSeen(first, later, "/admin/kyc/anything")).toEqual({ "/admin/kyc": T2 });
    expect(nextSeen(first, later, "/admin/kycx")).toBe(first);
  });

  it("no latest or no mark means nothing new", () => {
    expect(isNewSinceSeen(undefined, T1)).toBe(false);
    expect(isNewSinceSeen(T2, undefined)).toBe(false);
  });
});

// ── Store ────────────────────────────────────────────────────────────────────

function response(badges: AdminBadges["badges"] = { "/admin/otc": { count: 2 } }): AdminBadges {
  return { network: "devnet", checkedAt: "2026-09-25T10:00:00.000Z", badges };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(opts: { session?: boolean; visible?: boolean; pollMs?: number } = {}) {
  let t = 10_000_000;
  const store = createAdminBadgesStore({ now: () => t });
  const loads: Array<{ fresh: boolean; interactive: BadgeReadMode }> = [];
  const env = { session: opts.session ?? true, visible: opts.visible ?? true };
  let impl: (o: { fresh: boolean; interactive: BadgeReadMode }) => Promise<AdminBadges> = async () => response();
  const saved = new Map<string, SeenMap>();
  const deps: AdminBadgesStoreDeps = {
    load: (o) => { loads.push(o); return impl(o); },
    hasSession: () => env.session,
    visible: () => env.visible,
    pollMs: opts.pollMs ?? 45_000,
    storage: { read: (k) => saved.get(k) ?? null, write: (k, s) => { saved.set(k, s); } },
  };
  store.bind("devnet|A", deps);
  return {
    store, loads, env, saved, deps,
    advance: (ms: number) => { t += ms; },
    setLoad: (next: typeof impl) => { impl = next; },
  };
}

describe("admin badges store: refreshes", () => {
  it("polls only while the tab is visible", async () => {
    const h = harness({ visible: false });
    await h.store.refresh("poll");
    expect(h.loads).toHaveLength(0);
    h.env.visible = true;
    await h.store.refresh("poll");
    expect(h.loads).toHaveLength(1);
    expect(h.store.getSnapshot().badges).toEqual({ "/admin/otc": { count: 2 } });
  });

  it("never overlaps reads; an event during a read runs once afterwards, fresh", async () => {
    const h = harness();
    const gate = deferred<AdminBadges>();
    h.setLoad(() => gate.promise);
    const first = h.store.refresh("mount");
    void h.store.refresh("poll");
    void h.store.refresh("focus");
    void h.store.refresh("event");
    void h.store.refresh("event");
    expect(h.loads).toHaveLength(1);
    h.setLoad(async () => response({ "/admin/otc": { count: 1 } }));
    gate.resolve(response());
    await first;
    await vi.waitFor(() => expect(h.loads).toHaveLength(2));
    expect(h.loads[1]).toEqual({ fresh: true, interactive: false });
    await vi.waitFor(() => expect(h.store.getSnapshot().badges["/admin/otc"]).toEqual({ count: 1 }));
  });

  it("an event refresh sends fresh:true and is not throttled", async () => {
    const h = harness();
    await h.store.refresh("mount");
    await h.store.refresh("event");
    await h.store.refresh("event");
    expect(h.loads.map((l) => l.fresh)).toEqual([false, true, true]);
  });

  it("focus and navigate are throttled from the last ATTEMPT (a failing server is not hammered)", async () => {
    const h = harness();
    h.setLoad(async () => { throw new Error("Admin badges unavailable — try again"); });
    await h.store.refresh("mount");
    h.advance(3_000);
    await h.store.refresh("navigate");
    await h.store.refresh("focus");
    expect(h.loads).toHaveLength(1);
    h.advance(10_000);
    await h.store.refresh("navigate");
    expect(h.loads).toHaveLength(2);
  });
});

describe("admin badges store: prompts", () => {
  it("with a session every read is non-interactive", async () => {
    const h = harness({ session: true });
    await h.store.refresh("mount");
    h.advance(60_000);
    await h.store.refresh("poll");
    await h.store.refresh("event");
    expect(h.loads.every((l) => l.interactive === false)).toBe(true);
  });

  it("without a session: one session-only attempt on mount, never on poll/focus/navigate, never again after a decline", async () => {
    const h = harness({ session: false });
    await h.store.refresh("poll");
    await h.store.refresh("focus");
    await h.store.refresh("navigate");
    await h.store.refresh("event");
    expect(h.loads).toHaveLength(0);
    h.setLoad(async () => { throw new WalletSessionRequiredError(); }); // declined
    await h.store.refresh("mount");
    expect(h.loads).toEqual([{ fresh: false, interactive: "session-only" }]);
    // A remount (navigating back into /admin) does not ask again.
    h.advance(60_000);
    await h.store.refresh("mount");
    await h.store.refresh("poll");
    expect(h.loads).toHaveLength(1);
    expect(h.store.getSnapshot().error).toBeNull();
  });

  it("once the page's own read started a session, polls use it without prompting", async () => {
    const h = harness({ session: false });
    h.setLoad(async () => { throw new WalletSessionRequiredError(); });
    await h.store.refresh("mount");
    h.env.session = true;
    h.setLoad(async () => response());
    h.advance(45_000);
    await h.store.refresh("poll");
    expect(h.loads.map((l) => l.interactive)).toEqual(["session-only", false]);
    expect(h.store.getSnapshot().badges["/admin/otc"]).toEqual({ count: 2 });
  });

  it("a hint the server refuses (401) on mount spends the one prompt, once", async () => {
    const h = harness({ session: true });
    h.setLoad(async (o) => {
      if (o.interactive === false) throw new WalletSessionRequiredError("The wallet session expired");
      return response();
    });
    await h.store.refresh("mount");
    expect(h.loads.map((l) => l.interactive)).toEqual([false, "session-only"]);
    h.setLoad(async () => { throw new WalletSessionRequiredError(); });
    h.advance(60_000);
    await h.store.refresh("mount");
    expect(h.loads.map((l) => l.interactive)).toEqual([false, "session-only", false]);
  });
});

describe("admin badges store: outcomes", () => {
  it("a role refusal empties the badges; another error keeps the last numbers", async () => {
    const h = harness();
    await h.store.refresh("mount");
    h.setLoad(async () => { throw new Error("Authorization check unavailable — try again"); });
    h.advance(60_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot()).toMatchObject({ badges: { "/admin/otc": { count: 2 } }, error: "Authorization check unavailable — try again" });
    h.setLoad(async () => { throw new Error("Admin or KYC provider privileges required"); });
    h.advance(60_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot().badges).toEqual({});
  });

  it("numbers go muted after two poll periods without a success, and recover on the next one", async () => {
    const h = harness({ pollMs: 45_000 });
    await h.store.refresh("mount");
    h.env.session = false; // the 12 h session ran out: polls skip the call
    h.advance(45_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot().stale).toBe(false);
    h.advance(70_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot()).toMatchObject({ stale: true, staleCause: "session" });
    const view = badgeMenu(h.store.getSnapshot(), ADMIN).view("/admin/otc");
    expect(view).toMatchObject({ text: "2", muted: true });
    expect(view?.title).toContain("session is renewed");
    h.env.session = true;
    await h.store.refresh("poll");
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, staleCause: null });
  });

  it("a hidden tab's polls never grey the numbers, and a tab coming back keeps them bright while it reads", async () => {
    const h = harness({ pollMs: 45_000 });
    await h.store.refresh("mount");
    h.env.visible = false;
    for (let i = 0; i < 5; i++) {
      h.advance(45_000);
      await h.store.refresh("poll");
    }
    expect(h.loads).toHaveLength(1);
    expect(h.store.getSnapshot().stale).toBe(false);
    // Back on the tab: the focus read starts with the old numbers still amber.
    h.env.visible = true;
    const gate = deferred<AdminBadges>();
    h.setLoad(() => gate.promise);
    const back = h.store.refresh("focus");
    expect(h.loads).toHaveLength(2);
    expect(h.store.getSnapshot().stale).toBe(false);
    expect(badgeMenu(h.store.getSnapshot(), ADMIN).view("/admin/otc")).toMatchObject({ muted: false });
    gate.resolve(response({ "/admin/otc": { count: 3 } }));
    await back;
    expect(h.store.getSnapshot()).toMatchObject({ stale: false, badges: { "/admin/otc": { count: 3 } } });
  });

  it("reads that keep failing go muted with their own cause, not the session's", async () => {
    const h = harness({ pollMs: 45_000 });
    await h.store.refresh("mount");
    h.setLoad(async () => { throw new Error("Admin badges unavailable — try again"); });
    h.advance(45_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot().stale).toBe(false);
    h.advance(70_000);
    await h.store.refresh("poll");
    expect(h.store.getSnapshot()).toMatchObject({ stale: true, staleCause: "error", badges: { "/admin/otc": { count: 2 } } });
    const view = badgeMenu(h.store.getSnapshot(), ADMIN).view("/admin/otc");
    expect(view).toMatchObject({ text: "2", muted: true });
    expect(view?.title).toContain("the last reads failed");
    expect(view?.title).not.toContain("session");
  });

  it("a key change drops the snapshot, and a late answer for the old key is ignored", async () => {
    const h = harness();
    const gate = deferred<AdminBadges>();
    h.setLoad(() => gate.promise);
    const pending = h.store.refresh("mount");
    h.store.bind("devnet|B", h.deps);
    expect(h.store.getSnapshot()).toMatchObject({ key: "devnet|B", badges: {}, updatedAt: 0 });
    gate.resolve(response({ "/admin/otc": { count: 9 } }));
    await pending;
    expect(h.store.getSnapshot().badges).toEqual({});
    // The new key reads on its own (the old read no longer blocks it).
    h.setLoad(async () => response({ "/admin/kyc": { count: 1 } }));
    await h.store.refresh("mount");
    expect(h.store.getSnapshot().badges).toEqual({ "/admin/kyc": { count: 1 } });
    h.store.bind(null, null);
    expect(h.store.getSnapshot()).toEqual({ ...EMPTY_BADGES_SNAPSHOT, key: null, seen: {} });
  });

  it("seen marks persist per viewer and the viewed page is marked on navigation", async () => {
    const h = harness();
    h.store.setPath("/admin");
    h.setLoad(async () => response({ "/admin/kyc": { count: 1, latest: "2026-09-25T10:00:00.000Z" } }));
    await h.store.refresh("mount");
    expect(h.saved.get("devnet|A")).toEqual({ "/admin/kyc": "2026-09-25T10:00:00.000Z" });
    h.setLoad(async () => response({ "/admin/kyc": { count: 2, latest: "2026-09-25T11:00:00.000Z" } }));
    await h.store.refresh("event");
    expect(badgeMenu(h.store.getSnapshot(), ADMIN).view("/admin/kyc")).toMatchObject({ text: "2", fresh: true });
    expect(badgeMenu(h.store.getSnapshot(), ADMIN).total).toMatchObject({ fresh: true });
    h.store.setPath("/admin/kyc");
    expect(badgeMenu(h.store.getSnapshot(), ADMIN).view("/admin/kyc")).toMatchObject({ fresh: false });
    expect(h.saved.get("devnet|A")).toEqual({ "/admin/kyc": "2026-09-25T11:00:00.000Z" });
    // Another wallet starts from its own marks.
    h.store.bind("devnet|B", h.deps);
    expect(h.store.getSnapshot().seen).toEqual({});
  });
});

// ── Refresh event ────────────────────────────────────────────────────────────

describe("notifyAdminBadges", () => {
  it("dispatches once, or again after the indexer delay", () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    notifyAdminBadges();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe(ADMIN_BADGES_EVENT);
    notifyAdminBadges({ afterIndexer: true });
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(ADMIN_BADGES_INDEXER_DELAY_MS);
    expect(dispatchEvent).toHaveBeenCalledTimes(3);
  });

  it("is a no-op without a window and never throws with a stubbed one", () => {
    expect(() => notifyAdminBadges()).not.toThrow();
    vi.stubGlobal("window", {});
    expect(() => notifyAdminBadges()).not.toThrow();
  });
});
