// Stand-ins for the app's own API routes, for the reads that need the
// database (Supabase) the smoke server does not have. A route without a
// stand-in reaches the real server under test; `calls` records both.
import type { Page, Request, Route } from "@playwright/test";

export type ApiCall = { method: string; path: string; body: unknown; mocked: boolean };
export type ApiHandler = (request: Request) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

const ok = (data: unknown) => ({ json: { ok: true, data } });

/** Reads every page makes on load, answered as a healthy deployment with no
 *  signed-in account would (the real routes answer 503 without Supabase). */
export function defaultApi(network: string): Record<string, ApiHandler> {
  return {
    // app/api/maintenance/route.ts: the banner's state (MaintenanceState).
    "/api/maintenance": () => ({ json: { enabled: false, message: null, network } }),
    // app/api/auth/me/route.ts: no email/Google account on this browser.
    "/api/auth/me": () => ok({ account: null }),
    // app/api/tos/status/route.ts: the connected wallet accepted the current
    // Terms before (a returning user; the ToS prompt is not under test).
    "/api/tos/status": () => ok({ accepted: true }),
    // app/api/profiles/public/route.ts: no public issuer profiles yet.
    "/api/profiles/public": () => ok([]),
    // app/api/launchpad/commitment-aggregate/route.ts: nothing pledged yet.
    "/api/launchpad/commitment-aggregate": () =>
      ok({ pledged: "0", confirmed: "0", settled: "0", backers: 0, pledgers: 0, unverified: 0, paymentMint: null }),
    // app/api/launchpad/terms/route.ts: what the server answers for a sale
    // whose issuer has not published a verified document (409).
    "/api/launchpad/terms": () => ({
      status: 409,
      json: { ok: false, error: "The issuer must publish a verified document version before accepting investments in the app" },
    }),
  };
}

export class ApiMock {
  readonly calls: ApiCall[] = [];
  /** Paths answered with an error status on purpose: the browser logs
   *  "Failed to load resource" for them, which the guard then expects. */
  readonly failedOnPurpose = new Set<string>();
  private readonly handlers: Map<string, ApiHandler>;

  constructor(network: string) {
    this.handlers = new Map(Object.entries(defaultApi(network)));
  }

  /** Answers `path` (exact, no query) with `handler` from now on. */
  on(path: string, handler: ApiHandler) {
    this.handlers.set(path, handler);
  }

  static ok = ok;

  async attach(page: Page) {
    await page.route(/^http:\/\/127\.0\.0\.1:3310\/api\//, async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const handler = this.handlers.get(path);
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
      this.calls.push({ method: request.method(), path, body, mocked: !!handler });
      if (!handler) return route.fallback();
      const response = await handler(request);
      if ((response.status ?? 200) >= 400) this.failedOnPurpose.add(path);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify(response.json),
      });
    });
  }
}
