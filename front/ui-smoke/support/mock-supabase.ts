// A stand-in for the browser's Supabase reads (PostgREST): every table is
// empty, every RPC answers null. The pages treat an empty indexer as "read
// the chain instead", so the mock chain decides what they show. Writes,
// storage and realtime are refused.
import type { Page } from "@playwright/test";

export class MockSupabase {
  readonly requests: string[] = [];

  /** Answers every *.supabase.co host and the build's own Supabase host. */
  async attach(page: Page, supabaseUrl: string | undefined) {
    const hosts = new Set([supabaseUrl ? new URL(supabaseUrl).host : ""].filter(Boolean));
    const isSupabase = (url: URL) => hosts.has(url.host) || url.hostname.endsWith(".supabase.co");
    await page.route((url) => isSupabase(url), async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      this.requests.push(`${request.method()} ${url.pathname}`);
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, HEAD, PATCH, DELETE, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (/^\/rest\/v1\/rpc\/[^/]+$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: "null" });
      const table = /^\/rest\/v1\/[^/]+$/.test(url.pathname);
      if (!table || (request.method() !== "GET" && request.method() !== "HEAD")) {
        return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: JSON.stringify({ message: "ui-smoke: not mocked" }) });
      }
      const single = (request.headers().accept ?? "").includes("vnd.pgrst.object");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { ...cors, "Content-Range": "*/0" },
        body: request.method() === "HEAD" ? "" : single ? "null" : "[]",
      });
    });
    await page.routeWebSocket((url) => isSupabase(url), (ws) => ws.close({ code: 1008, reason: "ui-smoke: realtime is not mocked" }));
  }
}
