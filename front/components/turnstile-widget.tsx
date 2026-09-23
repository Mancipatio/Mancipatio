"use client";

// Cloudflare Turnstile challenge for the public forms (email sign-in, contact).
// Renders nothing — and never loads Cloudflare's script — unless this build
// has NEXT_PUBLIC_TURNSTILE_SITE_KEY. Tokens are single-use: after each
// submission the parent remounts the widget (change its `key`) for a new one.

import { useEffect, useRef, useState } from "react";
import { turnstileSiteKey, type TurnstileAction } from "@/lib/turnstile";

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | null | undefined;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

// Loaded from Cloudflare only: Turnstile does not support a proxied or
// self-hosted copy of api.js.
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    const script = document.createElement("script");
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile unavailable")));
      script.onerror = () => reject(new Error("Turnstile unavailable"));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      // Let a later mount try again (e.g. after the network comes back).
      script.remove();
      loading = null;
      throw error;
    });
  }
  return loading;
}

export function TurnstileWidget({ action, onToken }: {
  action: TurnstileAction;
  /** A fresh token, or null when the current one expired or failed. */
  onToken: (token: string | null) => void;
}) {
  const siteKey = turnstileSiteKey();
  const container = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  const [failed, setFailed] = useState(false);

  useEffect(() => { onTokenRef.current = onToken; });

  useEffect(() => {
    const element = container.current;
    if (!siteKey || !element) return;
    let cancelled = false;
    let widgetId: string | null | undefined;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        widgetId = api.render(element, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "flexible",
          // The token travels in the JSON body, not a hidden form field.
          "response-field": false,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "timeout-callback": () => onTokenRef.current(null),
          "error-callback": () => { onTokenRef.current(null); },
        });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (widgetId) {
        try { window.turnstile?.remove(widgetId); } catch { /* already gone */ }
      }
    };
  }, [siteKey, action]);

  if (!siteKey) return null;
  return <div className="turnstile-widget">
    <div ref={container} style={failed ? undefined : { minHeight: 65 }} />
    {failed && <p className="account-notice account-notice--error" role="alert">
      The security check could not load. Check your connection or allow challenges.cloudflare.com, then reload the page.
    </p>}
  </div>;
}
