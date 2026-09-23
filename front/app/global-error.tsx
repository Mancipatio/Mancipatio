"use client";

// Last-resort error UI: replaces the root layout when it (or anything the
// segment error.tsx cannot catch) fails. It renders its own document, so it
// cannot rely on globals.css; styles are inline and follow the OS theme.
// Nothing is sent anywhere from here: server errors are already reported by
// instrumentation.ts, and the digest lets support match this page to the log.

import { useEffect } from "react";

const CSS = `
  :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --line: #cbd5e1; --accent: #0f172a; --on-accent: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #020617; --fg: #f1f5f9; --muted: #94a3b8; --line: #334155; --accent: #f1f5f9; --on-accent: #020617; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
    background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 28rem; text-align: center; }
  .eyebrow { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .3em; text-transform: uppercase; color: #dc2626; margin: 0; }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: .75rem 0 0; }
  p { color: var(--muted); font-size: .9rem; line-height: 1.5; margin: .75rem 0 0; }
  .ref { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 2rem; }
  button, a { font: inherit; font-size: .9rem; border-radius: 8px; padding: 8px 16px; cursor: pointer; text-decoration: none; }
  button { background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent); font-weight: 500; }
  a { color: var(--fg); border: 1px solid var(--line); }
  button:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
`;

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Visible only in this browser's console.
    console.error("[manci:global-error]", error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Manci</title>
        <meta name="robots" content="noindex" />
        <style>{CSS}</style>
      </head>
      <body>
        <main>
          <p className="eyebrow">Error</p>
          <h1>Something went wrong</h1>
          <p>
            Manci could not load this page. Please try again in a moment, or
            start again from the homepage.
          </p>
          {error.digest ? <p className="ref">Reference: {error.digest}</p> : null}
          <div className="actions">
            <button type="button" onClick={() => retry()}>
              Try again
            </button>
            {/* A full page load on purpose: the app shell itself failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">Go to the homepage</a>
          </div>
        </main>
      </body>
    </html>
  );
}
