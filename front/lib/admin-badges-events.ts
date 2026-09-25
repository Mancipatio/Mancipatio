// "The admin menu counts changed — read them again now." Fired by the client
// wrappers after a successful admin write (lib/clients.ts, lib/passport.ts,
// lib/otc.ts, …) and by the pages after an on-chain admin transaction;
// components/admin-badges.tsx listens. The 45 s poll is the safety net, so a
// missed call only delays a number.
//
// No imports on purpose: the wrapper modules that call this are also loaded
// on the server (a route imports a helper from them), where it is a no-op.

export const ADMIN_BADGES_EVENT = "admin:badges-refresh";

/** On-chain changes reach the indexer mirror through the webhook: ask again after this. */
export const ADMIN_BADGES_INDEXER_DELAY_MS = 12_000;

export function notifyAdminBadges(opts: { afterIndexer?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const fire = () => {
    try {
      window.dispatchEvent(new Event(ADMIN_BADGES_EVENT));
    } catch { /* no DOM events (tests, a stubbed window) */ }
  };
  fire();
  if (opts.afterIndexer) setTimeout(fire, ADMIN_BADGES_INDEXER_DELAY_MS);
}
