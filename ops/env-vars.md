# Environment variables by network

Every variable the deployed code reads (`grep -rhoE "process\.env\.[A-Z0-9_]+"`
over `front/app`, `front/lib`, `front/components`, `front/instrumentation.ts`,
`front/next.config.ts`, and `Deno.env` in `front/supabase/functions`), with
what a mainnet deployment needs. Names only: values live where the "Set in"
column says, never in this repository. Secrets and their rotation:
[`ops/secrets.md`](secrets.md).

Legend. **Public**: inlined into the browser bundle (`NEXT_PUBLIC_*`) or
otherwise not confidential. **Secret**: a credential; server env only.
**Build**: read by `next build` (a `NEXT_PUBLIC_*` value is baked in: changing
it needs a redeploy). **Guard**: `next build` refuses a mainnet build without
it (`front/next.config.ts`); an operations guard can be waived by name with
`MAINNET_OPS_WAIVERS` (see below).

## Vercel (front), per environment

| Variable | Kind | Mainnet | Devnet | When unset | Read by |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_NETWORK` | Public, build | `mainnet` (guard) | `devnet` | Vercel builds refuse; any production build refuses when the RPC URL names mainnet; locally sniffed from the RPC URL, else devnet | `lib/network.ts` |
| `NEXT_PUBLIC_SITE_URL` | Public, build | https origin of the site (guard `site-url`) | `https://www.manci.io` | Email sign-in, account emails and links answer 503 in production | `lib/server/account-origin.ts`, alert links |
| `NEXT_PUBLIC_SUPABASE_URL` | Public, build | `https://<mainnet ref>.supabase.co` (guard; ref recorded in `SUPABASE_PROJECT_REFS` and `scripts/ops/targets.json`) | devnet project | No database | `lib/supabase*.ts` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public, build | `sb_publishable_…` (guard) | publishable key | No browser database reads | `lib/supabase.ts` |
| `NEXT_PUBLIC_KYC_REGISTRY` | Public, build | platform KYC registry address (guard) | registry address | Mainnet and Vercel production refuse; else scan fallback | `lib/kyc-registry-pin.ts` |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Public, build | https URL of the paid provider, a **browser key restricted to the site's origin** (guard; refused when it carries the server URL's key, path token or user info, or is the server's endpoint) | optional | Public cluster endpoint (mainnet: api.mainnet-beta, unusable under load) | `lib/network.ts` |
| `NEXT_PUBLIC_SOLANA_WS_URL` | Public, build | wss URL of the same provider, with the browser key (guard; the same server-key check) | optional | Derived from the RPC URL | `lib/network.ts` |
| `NEXT_PUBLIC_SOLANA_GENESIS_HASH` | Public, build | leave unset | leave unset | Built-in cluster hashes (a conflicting value is refused); localnet requires it | `lib/network-identity.ts` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public, build | Turnstile widget of the mainnet domain, never a Cloudflare test key (guard `turnstile`) | recommended | No bot check on email sign-in and the contact form | `lib/turnstile.ts` |
| `NEXT_PUBLIC_ALLOW_INDEXING` | Public, build | `true` to be indexed (Vercel production only) | unset | `noindex` | `lib/indexing.ts` |
| `NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP` | Public, build | owner decision | ignored (on) | Off on mainnet | `lib/features.ts` |
| `NEXT_PUBLIC_FEATURE_STARTUP_RAISES` | Public, build | owner decision | ignored (on) | Off on mainnet | `lib/features.ts` |
| `NEXT_PUBLIC_FEATURE_ISSUER_ROTATION` | Public, build | **`true` recommended** (owner decision: issuer recovery = super admin + 7 days; off hides the admin recovery panel) | kill switch only (`false`) | Off on mainnet | `lib/features.ts` |
| `NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE` | Public, build | `false` until the lawyer signs off D13 | ignored (on) | Off on mainnet | `lib/features.ts` |
| `NEXT_PUBLIC_FEATURE_SECONDARY_TRADING` | Public, build | pilot: leave unset (off); see "Pilot scope" | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_GOVERNANCE` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_VESTING` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_RIGHTS` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_DISTRIBUTIONS` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY` | Public, build | pilot: leave unset (off) | kill switch (`false`) | Off on mainnet | `lib/features.ts` `pilotModules` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | `sb_secret_…` of the mainnet project (runtime refuses anything else) | secret key | Server database access fails | `lib/supabase-server.ts` |
| `SESSION_SECRET` | Secret | ≥ 32 characters, new for mainnet (guard `session-secret`) | set | Wallet and account sessions off (every read signs) | `lib/server/siws-session.ts`, account sessions |
| `RETRY_WORKER_SECRET` | Secret | ≥ 32, new; the same value as Vault `mancipatio_retry_worker_mainnet` | set | Retry and alarm workers refuse every call | `lib/server/retry-worker.ts` |
| `HELIUS_MAINNET_RPC` (or `SOLANA_MAINNET_RPC`) | Secret (key in the URL) | server key of the paid provider (guard) | — | Mainnet server fails closed | `lib/server/rpc.ts` |
| `HELIUS_DEVNET_RPC` / `HELIUS_TESTNET_RPC` / `SOLANA_LOCALNET_RPC` | Secret | — | recommended (proves the Helius path before mainnet) | Public endpoint | `lib/server/rpc.ts` |
| `COMPLIANCE_ALERT_EMAIL` | Public (addresses) | required (≤ 5 addresses) | `office@mancipatio.io` | `/api/health/alarms` 503 on mainnet | `lib/server/system-alerts.ts` |
| `ALERT_WEBHOOK_URL` | Secret (the URL is the credential) | https (guard `alert-webhook`) | recommended | Email is the only alert channel | `lib/server/system-alerts.ts` |
| `ALERT_WEBHOOK_TOKEN` | Secret | optional (bearer for ntfy or a relay) | optional | No Authorization header | `lib/server/system-alerts.ts` |
| `ALERT_WEBHOOK_MIN_SEVERITY` | Public | `high` (default) | default | `high`; without email the webhook takes every row | `lib/server/system-alerts.ts` |
| `ALERT_WEBHOOK_FORMAT` | Public | `json` (ntfy, a relay) or `text` (Slack, Mattermost, Google Chat: `{"text": …}` only) | default | `json` | `lib/server/system-alerts.ts` |
| `ALARM_BALANCE_WATCH` | Public (keys) | recommended: every key that signs in an emergency, `minSol` from the "Refill below" column of runbook §1 (one company wallet may be listed under each of its roles; the watch takes the highest threshold, not the sum, so give it the sum of its refill lines) | optional | No balance alarm | `lib/server/ops-watch.ts` |
| `ALARM_SQUADS_CONFIG` | Public | recommended: the role map's `squads` object | — | No Squads watch | `lib/server/ops-watch.ts` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` | Public config | required (email) | set | Resend fallback, else no email | `lib/server/email.ts` |
| `SMTP_PASS` | Secret | required, its own mailbox or password for mainnet | set | as above | `lib/server/email.ts` |
| `EMAIL_FROM` | Public | required | set | No email | `lib/server/email.ts` |
| `RESEND_API_KEY` | Secret | optional (fallback transport) | optional | SMTP only | `lib/server/email.ts` |
| `CONTACT_NOTIFY_EMAIL` | Public | recommended | set | Contact submissions are stored, not mailed | `app/api/inquiries/create` |
| `TURNSTILE_SECRET_KEY` | Secret | required with the site key, never a Cloudflare test key (guard `turnstile`; the server answers 503 with one in production) | recommended | Tokens not checked | `lib/server/turnstile.ts` |
| `GOOGLE_CLIENT_ID` | Public | a **separate** OAuth client with the mainnet redirect URIs | set | Google sign-in off | `lib/server/account-google.ts` |
| `GOOGLE_CLIENT_SECRET` | Secret | of that client | set | Google sign-in off | `lib/server/account-google.ts` |
| `HEALTH_TOKEN` | Secret | ≥ 32, no whitespace (guard `health-token`) | recommended | `/api/health` never shows details | `lib/server/health.ts` |
| `SENTRY_DSN` | Secret-ish (project key) | `https://<key>@<org>.ingest.de.sentry.io/<project id>` of an EU project: the guard `sentry` applies the runtime parser's rules | recommended | Server errors only in Vercel logs | `lib/request-error-report.ts` |
| `TOS_SERVER_GATE` | Server, runtime | leave unset: mainnet always enforces the Terms acceptance on the signed buy and sell routes | `enforce` only to rehearse the mainnet behaviour | No server check off mainnet (the client-side dialog only) | `lib/server/tos-gate.ts` |
| `GEOBLOCK_COUNTRIES` | Server, build + runtime | **counsel's list** (guard): ISO 3166 codes `KP,IR,CU,SY,UA-43,…`, or `none` written down on purpose; see "Geoblocking" | optional (unset blocks nothing) | Mainnet build refused; at runtime mainnet transactional routes answer 451 | `lib/geoblock.ts`, `proxy.ts` |
| `SANCTIONS_SCREENING` | Server, runtime | leave unset: mainnet always refuses the screened routes (commit, purchase record, OTC request, resell listing, passport, verification) while the OFAC SDN list is older than 3 days, empty or unreadable (503) | `enforce` only to rehearse that on devnet | Off mainnet an unusable list is only logged; a hit is refused on every network | `lib/server/sanctions.ts` |
| `MAINNET_LEGAL_COPY_APPROVED` | Build | `true` only after counsel reviewed the rendered mainnet pages (guard; runbook §17) | — | Mainnet build refused | `next.config.ts` |
| `MAINNET_LICENSE_NOT_REQUIRED` | Build | `true` **only** on counsel's written opinion that no licence is needed, while `OPERATORS.mainnet.licence` is null; refused together with a recorded licence (guard; runbook §17) | — | Mainnet build refused while no licence is recorded | `lib/legal/readiness.ts` |
| `MAINNET_OPS_WAIVERS` | Build | empty; see below | — | Every operations guard applies | `next.config.ts` |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `NODE_ENV` | Platform | set by Vercel | set by Vercel | — | build guards, `/api/health` commit |

### Mainnet operations guards and waivers

A mainnet `next build` refuses without each of these, by name:
`sentry`, `health-token`, `turnstile`, `alert-webhook`, `session-secret`,
`site-url` (`MAINNET_OPS_REQUIREMENTS` in `front/next.config.ts`).
`MAINNET_OPS_WAIVERS=sentry,turnstile` (comma-separated) waives the named
ones for that build and logs it; an unknown name fails the build. A waiver
is a conscious, temporary decision: write down why and until when.
Independent of the waivers, a mainnet build also needs the legal copy flag,
the operator and legal slots in `front/lib/legal/` (the operator record, the
licence or `MAINNET_LICENSE_NOT_REQUIRED`, counsel's Terms, Privacy Policy,
acceptance summary and risk warning: runbook §17), the mainnet Supabase
project, the KYC registry pin and the RPC settings above. CI proves all of it
on every change (`front/scripts/ci/mainnet-build.sh`): placeholder variables,
and an invented legal-slot fixture written into its throwaway checkout only.

### Feature flags

`NEXT_PUBLIC_FEATURE_*` read `true`, `1`, `yes`, `on` as on and `false`,
`0`, `no`, `off` as off, in any case; any other value fails a production
build. On mainnet a flag is off unless it reads as on. Decisions for the
owner before the mainnet build: `ISSUER_ROTATION=true` (recommended),
`PASSPORT_CLOSE=false` until D13, `STARTUP_RAISES` and `PAYOUT_AIRDROP`
explicitly on or off.

### Pilot scope (module switches)

The mainnet pilot is closed and narrow: primary sales of one issuer's
Mature class in USDC. Every other product module has a switch
(`lib/features.ts` `pilotModules`, same spellings and build guard as the
flags above). **On mainnet a module is off unless its variable reads as
on; on devnet, testnet and localnet it is on unless it reads as off**
(`=false` rehearses the pilot scope on devnet).

| Module | Variable | Entry routes that answer 403 when off | Pages |
|---|---|---|---|
| Secondary trading (OTC deals, offers, resell board) | `NEXT_PUBLIC_FEATURE_SECONDARY_TRADING` | `/api/otc/create`, `/api/otc/admin-screen`, `/api/otc/admin-update` (status `created`), `/api/resell/create` | `/marketplace/otc`, `/markets/resell` (notice only); `/portfolio/offers`, `/deals`, `/listings`, `/admin/otc`, `/admin/resell` (notice above the page) |
| Governance | `NEXT_PUBLIC_FEATURE_GOVERNANCE` | none (on-chain only) | `/marketplace/governance`, `/portfolio/governance` (notice only); `/admin/governance` |
| Vesting series | `NEXT_PUBLIC_FEATURE_VESTING` | `/api/vesting-series/create`, `/prepare-creation`, `/admin-review` | `/portfolio/vesting`, `/issuer/vesting-series`, `/admin/vesting` |
| Rights-Token issuances | `NEXT_PUBLIC_FEATURE_RIGHTS` | `/api/vesting/create` (the rights builder) | `/portfolio/rights` (with distributions), `/admin/rights` |
| Distributions | `NEXT_PUBLIC_FEATURE_DISTRIBUTIONS` | `/api/distribution-plans/prepare`, `/bind` | `/portfolio/rights` (with rights) |
| Conversion into shares | `NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION` | `/api/conversion/create` | `/portfolio/conversion`, `/admin/custody` (with delivery) |
| Physical delivery | `NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY` | `/api/delivery/create` | `/portfolio/delivery`, `/admin/custody` (with conversion) |

Off means: the entry routes answer 403 with "…: not available in the pilot
on Solana mainnet." before any work, the navigation, section tabs and
marketplace cards hide the module, and its pages carry that notice
(`lib/pilot-scope.ts`, rendered by `AppShell`). Exits of existing positions
stay open everywhere (cancels, withdrawals, deal declines and archives,
claims, refunds, custody returns), like the program's emergency pause.
Payout airdrops (`PAYOUT_AIRDROP`) and Startup raises (`STARTUP_RAISES`)
keep their own flags; admin payout records (`/api/payouts/create`) are not
gated. The switches are the platform's scope; the program's pause bits are
the on-chain one (runbook: which bits the pilot keeps set), and
`lib/pause-gate.ts` reads those before a wallet signs.

### Geoblocking

Which countries the platform does not serve is **counsel's decision**
(pravo-compliance-6); the code only enforces it. `GEOBLOCK_COUNTRIES` holds
comma-separated ISO 3166-1 alpha-2 codes, plus `CC-REGION` codes (ISO
3166-2 subdivision, best effort: matched only when Vercel reports the
region, e.g. `UA-43` Crimea, `UA-40` Sevastopol, `UA-14` Donetsk, `UA-09`
Luhansk). A mainnet build refuses to start without it; `none` is accepted
only as a written decision that nothing is blocked. Any production build
refuses a malformed value.

`proxy.ts` reads Vercel's `x-vercel-ip-country` (and
`x-vercel-ip-country-region`) on:
- the transactional API routes (`lib/geoblock.ts` `GEOBLOCKED_API_ROUTES`:
  commit, purchase record, the buyer's pre-buy screen, OTC request, resell
  listing, passport application, verification, raise applications,
  conversion and delivery requests, vesting-series requests, Terms
  acceptance): a listed country answers **451**, and on mainnet so does a
  request without the country header (fail closed);
- the app pages (`/marketplace`, `/portfolio`, `/issuer`, `/verify`,
  `/onboarding`, `/apply`): a listed country sees `/not-available` instead;
  a page without the header is served.
Exits (cancels, refunds, claims), reads, the marketing and legal pages, the
admin console and the internal worker routes are not geoblocked. Off
mainnet an unset list blocks nothing. IP geolocation is one line (VPNs pass
it): the Terms' eligibility clause and the wallet sanctions screen are the
others. Changing the list needs a redeploy of the same build settings.

## Supabase

| Name | Where | Kind | Mainnet |
|---|---|---|---|
| `MANCI_SUPABASE_SECRET_KEY` | Edge function secrets (`helius-webhook`) | Secret (`sb_secret_…`) | new, of the mainnet project |
| `HELIUS_WEBHOOK_SECRET` | Edge function secrets | Secret (the webhook's auth header) | new |
| `INDEXER_NETWORK` | Edge function secrets | Public | `mainnet` (a wrong one is refused by the 0071 guard) |
| `SUPABASE_URL` | Provided by Supabase | Public | — |
| `mancipatio_retry_worker_<network>` | Vault (`scripts/ops/*-scheduler.sql`) | Secret | equal to Vercel `RETRY_WORKER_SECRET` |
| `mancipatio_vercel_bypass_<network>` | Vault (`scripts/ops/*-scheduler.sql`, read on every call, sent as `x-vercel-protection-bypass`) | Secret | the Vercel *Protection Bypass for Automation* secret while the deployment is behind Deployment Protection (runbook §0A D4); deleted at D11 (`ops/secrets.md`) |

## Operator machine (scripts)

`scripts/db.sh`, `scripts/ops/*` and the chain CLI read `MANCI_TARGET`,
`MANCI_ALLOW_MAINNET`, `MANCI_DB_BOOTSTRAP`, `MANCI_PGPASSFILE`,
`MANCI_PG_BIN`, `MANCIPATIO_RETRY_SECRET_FILE`, `MANCIPATIO_VERCEL_BYPASS_FILE`
(the deployment smoke through Deployment Protection, runbook §0A D6),
`MAINTENANCE_OPERATOR` and
the credential files under `~/.mancipatio/` (runbook §14 "Credential files").
None of them is a deployment variable.

## Content-Security-Policy

Every page sends `Content-Security-Policy-Report-Only`
(`contentSecurityPolicy()` in `front/next.config.ts`): nothing is blocked,
violations are posted to `/api/csp-report` and logged as
`[csp] {"directive","blocked","page","disposition"}` (origin and path only).
The origins come from the build's env (Supabase, the browser RPC and its
WebSocket, Turnstile; the Vercel toolbar on Preview). `script-src` still
allows `'unsafe-inline'` because Next's inline bootstrap scripts need a
nonce. The path to enforcement:

1. Deploy report-only to devnet and read the `[csp]` lines for at least a
   week of normal use (wallet connects, sign-in with email and Google, KYC
   upload, admin pages). Add each legitimate origin to
   `contentSecurityPolicy()` with the reason in a comment; anything else is
   a finding.
2. Add a per-request nonce: a `proxy.ts` that generates it and sets the
   policy with `script-src 'self' 'nonce-<n>' 'strict-dynamic'` (Next adds
   the nonce to its own scripts), and drop `'unsafe-inline'` from
   `script-src`. Nonce pages render dynamically: measure before and after.
3. Ship the nonce policy report-only for another week, then rename the
   header to `Content-Security-Policy` on devnet, then on mainnet, keeping
   the report endpoint. Update `front/tests/security-headers.test.ts`.
