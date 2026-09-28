// The smoke's test object: every test gets a mock chain on the build's RPC
// endpoints, a Supabase stand-in, the API stand-ins of support/api-mocks.ts,
// a Turnstile stand-in, and a guard that fails the test on an uncaught page error, a console error
// or a request to any host but the server under test (such a request is
// refused, so nothing leaves the machine).
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import env from "../env.json";
import { MockChain, type SmokeNetwork } from "./mock-chain";
import { MockSupabase } from "./mock-supabase";
import { ApiMock } from "./api-mocks";

export const NETWORK: SmokeNetwork = process.env.UI_SMOKE_NETWORK === "mainnet" ? "mainnet" : "localnet";
export const ENV = env[NETWORK] as Record<string, string>;
export const ENDPOINTS = { rpc: ENV.NEXT_PUBLIC_SOLANA_RPC_URL, ws: ENV.NEXT_PUBLIC_SOLANA_WS_URL };
const GENESIS_HASH = NETWORK === "mainnet" ? CLUSTER_GENESIS_HASHES.mainnet : ENV.NEXT_PUBLIC_SOLANA_GENESIS_HASH;
const SERVER = "http://127.0.0.1:3310";

// Cloudflare Turnstile (components/turnstile-widget.tsx) on a build with a
// site key (the mainnet placeholders): a stand-in for its explicit-render API
// that renders nothing and never produces a token.
const TURNSTILE_SCRIPT = /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js(\?.*)?$/;
const TURNSTILE_STUB = `window.turnstile = {
  render: function () { return "ui-smoke-turnstile"; },
  reset: function () {},
  remove: function () {},
  getResponse: function () { return undefined; },
};`;

export class PageGuard {
  readonly pageErrors: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly externalRequests: string[] = [];
  private readonly allowedConsole: RegExp[] = [];
  private readonly knownPageErrors: RegExp[] = [];

  constructor(
    page: Page,
    private readonly mocked: (url: URL) => boolean,
    private readonly failedOnPurpose: ReadonlySet<string>,
  ) {
    page.on("pageerror", (error) => this.pageErrors.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(`${message.text()} @ ${message.location().url}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (url.origin !== SERVER && !this.mocked(url)) this.externalRequests.push(request.url());
    });
  }

  /** Console errors a test provokes on purpose (a refused request). */
  allowConsole(...patterns: RegExp[]) {
    this.allowedConsole.push(...patterns);
  }

  /** An uncaught error that is a KNOWN, reported defect: the test names it
   *  and why; remove the call once the defect is fixed. */
  allowKnownPageError(pattern: RegExp) {
    this.knownPageErrors.push(pattern);
  }

  /** A browser "Failed to load resource" line for an API path a mock
   *  answered with an error status on purpose. */
  private expectedFailure(text: string): boolean {
    const match = /^Failed to load resource: the server responded with a status of \d+ .* @ (\S+)$/.exec(text);
    return !!match && this.failedOnPurpose.has(new URL(match[1]).pathname);
  }

  assertClean() {
    const console = this.consoleErrors.filter(
      (text) => !this.expectedFailure(text) && !this.allowedConsole.some((p) => p.test(text)),
    );
    const pageErrors = this.pageErrors.filter((text) => !this.knownPageErrors.some((p) => p.test(text)));
    expect.soft(pageErrors, "uncaught errors in the page").toEqual([]);
    expect.soft(console, "console errors").toEqual([]);
    expect.soft(this.externalRequests, "requests to hosts other than the server under test").toEqual([]);
  }
}

type Fixtures = { chain: MockChain; supabase: MockSupabase; api: ApiMock; guard: PageGuard };

// The fixture callback is named `provide`, not Playwright's usual `use`: the
// React hooks lint rule would take `use(...)` for React's hook.
export const test = base.extend<Fixtures>({
  chain: async ({ page }, provide) => {
    const chain = new MockChain(GENESIS_HASH);
    await chain.attach(page, ENDPOINTS);
    await provide(chain);
    expect.soft([...chain.unknownMethods], "RPC methods the mock does not answer").toEqual([]);
  },
  supabase: async ({ page }, provide) => {
    const supabase = new MockSupabase();
    await supabase.attach(page, ENV.NEXT_PUBLIC_SUPABASE_URL);
    await provide(supabase);
  },
  api: async ({ page }, provide) => {
    const api = new ApiMock(NETWORK);
    await api.attach(page);
    await provide(api);
  },
  guard: [
    async ({ page, chain, supabase, api }, provide, testInfo: TestInfo) => {
      void [chain, supabase];
      const mockedHosts = new Set([new URL(ENDPOINTS.rpc).host, new URL(ENDPOINTS.ws).host]);
      if (ENV.NEXT_PUBLIC_SUPABASE_URL) mockedHosts.add(new URL(ENV.NEXT_PUBLIC_SUPABASE_URL).host);
      const mocked = (url: URL) =>
        mockedHosts.has(url.host) || url.hostname.endsWith(".supabase.co") || TURNSTILE_SCRIPT.test(url.href);
      await page.route(TURNSTILE_SCRIPT, (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
      );
      // Page routes (the mocks) come first; whatever reaches this context
      // route is going somewhere else and is refused.
      await page.context().route((url) => url.origin !== SERVER, (route) => route.abort("blockedbyclient"));
      const guard = new PageGuard(page, mocked, api.failedOnPurpose);
      await provide(guard);
      if (testInfo.status === testInfo.expectedStatus) guard.assertClean();
    },
    { auto: true },
  ],
});

export { expect };
