"use client";

import { useEffect, useRef } from "react";
import { useMaintenance } from "@/lib/maintenance-client";

/** Site-wide maintenance notice (root layout). The live region is always
 * mounted so screen readers announce the notice when it appears. While it
 * shows, its height is published as --maintenance-banner-h so the fixed
 * sidebar and sticky headers sit below it (see globals.css, workspace.css). */
export function MaintenanceBanner() {
  const state = useMaintenance();
  const banner = useRef<HTMLDivElement>(null);
  const enabled = state?.enabled === true;

  useEffect(() => {
    const root = document.documentElement;
    const element = banner.current;
    if (!enabled || !element) {
      root.style.removeProperty("--maintenance-banner-h");
      return;
    }
    const publish = () => root.style.setProperty("--maintenance-banner-h", `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--maintenance-banner-h");
    };
  }, [enabled]);

  return (
    <div className="maintenance-region" role="status" aria-live="polite">
      {enabled && (
        <div ref={banner} className="maintenance-banner">
          <strong>Maintenance</strong>
          <span>{state.message}</span>
          <span className="maintenance-banner-note">Browsing still works. Changes and wallet transactions are paused until it ends.</span>
        </div>
      )}
    </div>
  );
}
