"use client";

// Live maintenance state for the banner: polls GET /api/maintenance every
// 30 s while the tab is visible, again on focus, and takes any fresher state
// announced by a refused request or a pre-send check (lib/maintenance.ts).

import { useEffect, useState } from "react";
import { fetchMaintenance, MAINTENANCE_EVENT, type MaintenanceState } from "@/lib/maintenance";

const POLL_MS = 30_000;

/** null until the first answer; a failed poll keeps the last known state. */
export function useMaintenance(): MaintenanceState | null {
  const [state, setState] = useState<MaintenanceState | null>(null);
  useEffect(() => {
    let inFlight = false;
    // fetchMaintenance announces its result; the listener below applies it.
    async function refresh() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try { await fetchMaintenance(); } finally { inFlight = false; }
    }
    function onAnnounce(event: Event) {
      const next = (event as CustomEvent<MaintenanceState>).detail;
      if (next && typeof next.enabled === "boolean") setState(next);
    }
    const poll = () => { void refresh(); };
    window.addEventListener(MAINTENANCE_EVENT, onAnnounce);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    const timer = window.setInterval(poll, POLL_MS);
    poll();
    return () => {
      window.removeEventListener(MAINTENANCE_EVENT, onAnnounce);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
      window.clearInterval(timer);
    };
  }, []);
  return state;
}
