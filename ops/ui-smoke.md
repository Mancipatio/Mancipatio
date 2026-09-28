# UI smoke (Playwright)

A browser smoke of the front (ops-qa-5, plan 6.5): a **production build**
(`next build` + `next start` on `127.0.0.1:3310`) opened in Chromium, with
the chain, the database and the wallet replaced by deterministic stand-ins.
Nothing leaves the machine: a request to any host but the server under test
is refused and fails the test. Code: `front/ui-smoke/`, config:
`front/playwright.config.ts`. CI: `.github/workflows/front-ci.yml`, jobs
`ui-smoke` (localnet build) and `build-mainnet` (the same suite over the
mainnet build).

## What it checks

| Spec | What |
|---|---|
| `pages.spec.ts` | Every page of the app router (`front/app/**/page.tsx`, read from disk) without a wallet: HTTP 200, a visible navigation and heading (or the wallet gate, or a pilot "not available" notice), no error boundary, no uncaught error, no console error. Every `/admin` page shows the wallet gate and none of the console. On the mainnet build no page says "devnet" (one allowed mention: the disclosure policy on `/security`). |
| `wallet.spec.ts` | With the mock wallet: a super admin opens `/admin` and signs exactly one SIWS `auth.session` message for this origin and network (verified against the test key); the admin menu counts then ride on the session. A wallet without a role gets "Access denied" on admin-only and KYC pages and is never asked to sign. |
| `sale.spec.ts` | One Mature sale on the mock chain: the `PAUSE_PRIMARY` bit shows the pause message before a buy, an `IssuerFreeze` record shows the proceeds-freeze notice, neither shows otherwise. Geoblock (localnet only): a listed country gets `/not-available` in place of the sale, another country the sale, and `/api/launchpad/commit` answers 451 `GEOBLOCKED`. |
| `bundle.spec.ts` | The build carries none of the smoke's code (mock wallet, test key). |

Not covered: sending transactions (the mock wallet only signs messages), the
real server routes that need the database (`/api/auth/session` and the reads
in `support/api-mocks.ts` are stand-ins), a real RPC or indexer.

## Run it locally

From `front/`, port 3310 free:

```bash
npm ci
npx playwright install chromium          # once per Playwright version
npm run ui-smoke:build                   # localnet build, placeholder settings
npm run ui-smoke                         # starts next start on :3310 itself
```

The mainnet variant (the build carries CI fixture legal text, so delete it
afterwards):

```bash
CI=1 bash scripts/ci/mainnet-build.sh    # CI=1 keeps .next/
UI_SMOKE_NETWORK=mainnet npm run ui-smoke
rm -rf .next
```

One spec or test: `npm run ui-smoke -- ui-smoke/sale.spec.ts`,
`npm run ui-smoke -- -g "Access denied"`. Watch it: `-- --headed` or
`-- --ui`. A failure leaves a trace and screenshot in `ui-smoke/.results/`
(`npx playwright show-trace <dir>/trace.zip`); CI uploads them as the
`ui-smoke-localnet` / `ui-smoke-mainnet` artifact.

## How it is isolated

- **Settings**: `ui-smoke/env.json`. The default build is **localnet**
  (`NEXT_PUBLIC_NETWORK=localnet` with its own genesis hash): a devnet build
  must name the real devnet Supabase project (`next.config.ts`), a localnet
  build can point at a host that does not exist. The browser RPC, PubSub and
  Supabase hosts are reserved `.invalid` names; the server RPC is
  `127.0.0.1:18400`, where nothing listens; the server has no Supabase
  service key. `npm run ui-smoke:build` drops the shell's `NEXT_PUBLIC_*`,
  Supabase, RPC and session variables; the placeholders are process
  environment, which wins over any `.env*` file Next would read.
- **Chain**: `support/mock-chain.ts` answers JSON-RPC from in-memory
  accounts that `support/chain-fixtures.ts` encodes with the generated SDK
  (the program's own layouts). An RPC method it does not know fails the test.
- **Database**: `support/mock-supabase.ts` is an empty PostgREST (the pages
  then read the chain); `support/api-mocks.ts` answers the API reads every
  page makes (`/api/maintenance`, `/api/auth/me`, ...). A stand-in that
  answers an error on purpose (the sale document's 409) makes the browser's
  "Failed to load resource" line for it expected.
- **Wallet**: `support/mock-wallet.ts` registers a Wallet Standard wallet
  before the app loads and signs in the browser (WebCrypto Ed25519) with a
  test keypair derived from a fixed label. It lives in `ui-smoke/` only.
- **Third parties**: Cloudflare Turnstile (mainnet placeholders carry a site
  key) gets a stub script that renders nothing.

## Changing it

- A new static page is picked up by itself. A new **dynamic** page needs a
  concrete path in `DYNAMIC_PATHS` (`ui-smoke/routes.ts`): the suite refuses
  to load without one.
- A page that reads a new API route on load: add its answer to
  `defaultApi()` in `support/api-mocks.ts` (what a healthy deployment with no
  data would answer). A new RPC method: `support/mock-chain.ts`.
- Tags: `@localnet-only` tests are skipped on the mainnet build (SIWS: the
  mainnet placeholder site origin is not the local server's; geoblock: a
  mainnet build ignores a client-sent country header outside Vercel),
  `@mainnet-only` ones run only there.

## Known defect

The geoblock rewrite (`proxy.ts`) serves the statically prerendered
`/not-available` page under the original URL; the shared shell reads
`usePathname()`, so hydration fails (React #418) and the tree is rendered
again on the client. `/not-available` opened directly hydrates cleanly. The
geoblock test allows that one error by name
(`guard.allowKnownPageError`); remove the call once it is fixed.
