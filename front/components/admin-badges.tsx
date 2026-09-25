"use client";

// AdminBadgesProvider — feeds the admin menu's count pills (app/admin/layout.tsx
// wraps the navigation in it). One module-level store, so the numbers survive
// /admin/* navigation; the rules, the store and the prompt policy are in
// lib/admin-badges.ts, the server half in app/api/admin/badges.
//
// Eligible viewers: an admin, or the KYC provider. A wallet that is only the
// blocklist authority never calls the endpoint (its pages have no queue).
// Refreshes: on mount, every 45 s while the tab is visible (90 s for a KYC
// provider without an Admin record), on focus / tab return, on navigation
// (throttled) and on the "admin:badges-refresh" event after admin actions.

import { useWalletConnection } from "@solana/react-hooks";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useRole } from "@/lib/auth";
import { detectNetwork } from "@/lib/network";
import { hasWalletSession } from "@/lib/siws-client";
import {
  ADMIN_BADGES_EVENT,
  BADGE_POLL_MS,
  BADGE_PROVIDER_POLL_MS,
  badgeMenu,
  createAdminBadgesStore,
  EMPTY_BADGES_SNAPSHOT,
  fetchAdminBadges,
  type SeenMap,
} from "@/lib/admin-badges";
import { AdminBadgesContext } from "@/components/admin-badges-context";

const SEEN_KEY_PREFIX = "manci:admin-badges-seen:v1:";

/** Per-viewer "seen" marks: a convenience only, so a blocked storage is fine. */
const seenStorage = {
  read(key: string): SeenMap | null {
    try {
      const raw = window.localStorage.getItem(SEEN_KEY_PREFIX + key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeenMap) : null;
    } catch {
      return null;
    }
  },
  write(key: string, seen: SeenMap) {
    try {
      window.localStorage.setItem(SEEN_KEY_PREFIX + key, JSON.stringify(seen));
    } catch { /* private window / blocked storage */ }
  },
};

const adminBadgesStore = createAdminBadgesStore();

export function AdminBadgesProvider({ children }: { children: ReactNode }) {
  const conn = useWalletConnection();
  const { loading, capabilities } = useRole({ kyc: true });
  const pathname = usePathname();
  const network = detectNetwork();
  const session = conn.wallet;
  const wallet = conn.connected ? (session?.account.address.toString() ?? null) : null;
  const isAdmin = capabilities.has("admin");
  const eligible = !loading && wallet !== null && (isAdmin || capabilities.has("kycProvider"));
  const key = eligible ? `${network}|${wallet}` : null;
  const pollMs = isAdmin ? BADGE_POLL_MS : BADGE_PROVIDER_POLL_MS;

  // The loader always uses the newest session object without re-binding.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!key || !wallet) {
      adminBadgesStore.bind(null, null);
      return;
    }
    adminBadgesStore.bind(key, {
      load: (opts) => fetchAdminBadges(sessionRef.current, opts),
      hasSession: () => hasWalletSession(wallet),
      visible: () => document.visibilityState !== "hidden",
      pollMs,
      storage: seenStorage,
    });
    void adminBadgesStore.refresh("mount");
    const poll = () => void adminBadgesStore.refresh("poll");
    const focus = () => void adminBadgesStore.refresh("focus");
    const visibility = () => {
      if (document.visibilityState === "visible") focus();
    };
    const event = () => void adminBadgesStore.refresh("event");
    const timer = window.setInterval(poll, pollMs);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener(ADMIN_BADGES_EVENT, event);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener(ADMIN_BADGES_EVENT, event);
    };
  }, [key, wallet, pollMs]);

  useEffect(() => {
    adminBadgesStore.setPath(pathname);
    void adminBadgesStore.refresh("navigate");
  }, [pathname]);

  const snapshot = useSyncExternalStore(
    adminBadgesStore.subscribe,
    adminBadgesStore.getSnapshot,
    () => EMPTY_BADGES_SNAPSHOT,
  );
  const menu = useMemo(
    () => badgeMenu(snapshot.key === key ? snapshot : EMPTY_BADGES_SNAPSHOT, capabilities),
    [snapshot, key, capabilities],
  );
  return <AdminBadgesContext.Provider value={menu}>{children}</AdminBadgesContext.Provider>;
}
