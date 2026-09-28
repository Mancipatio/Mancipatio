# Secrets inventory

Every credential the platform uses, by name only: where it lives, who owns
it, how and when it rotates, and what a rotation breaks. Values never go in
this repository, a chat, a ticket or a command line (runbook §14
"Credential files"). The variables themselves: [`ops/env-vars.md`](env-vars.md).

**Mainnet gets new values for every secret below.** Nothing is copied from
devnet: a devnet leak must never be a mainnet leak (session cookies, worker
authentication and the webhook would all be forgeable). Generate each one
fresh, for example `openssl rand -base64 48` for the shared secrets, straight
into the target store (Vercel, Supabase secrets or Vault), never through the
clipboard history or a file outside `~/.mancipatio/` (mode 600).

"Owner" is a role. Until the company exists the operator (one person) holds
every role; once the licence and the legal entity are in place the company
takes them over, and this table gets the names of the primary and the backup
holder of each (in the private operations notes, not here).

## Deployment secrets

| Secret | Lives in | Owner | Rotation | What a rotation breaks | Mainnet |
|---|---|---|---|---|---|
| `SESSION_SECRET` | Vercel (server) | Operator | Yearly, and at once on suspicion | Every wallet and account session: everyone signs in again | New, ≥ 32 |
| `RETRY_WORKER_SECRET` | Vercel + Vault `mancipatio_retry_worker_<network>` | Operator | Yearly; both stores in one window | Retry and alarm workers refuse calls until both match (`/api/health/alarms` goes red within 5 minutes) | New, ≥ 32 |
| `HELIUS_WEBHOOK_SECRET` | Supabase edge secrets + Helius webhook auth header | Operator | Yearly | Webhook deliveries are refused until both match; the gap scan repairs the window | New |
| `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`) | Vercel (server) | Operator | Yearly, and after any staff change | Server database access until redeployed | New project, new key |
| `MANCI_SUPABASE_SECRET_KEY` (`sb_secret_…`) | Supabase edge secrets | Operator | With the key above (a separate key per consumer is better) | The webhook stops enqueuing | New |
| Supabase database password | `~/.mancipatio/pgpass` (mode 600) | Operator | Yearly | `scripts/db.sh`, backups, preflights | New project, new password |
| `HELIUS_MAINNET_RPC` (server key) | Vercel (server) | Operator | Yearly, or on a leak | Server RPC until redeployed | New, server-only key |
| Browser RPC key in `NEXT_PUBLIC_SOLANA_RPC_URL` | Vercel (public, inlined) | Operator | When the domain restriction changes | Browser reads until the rebuild | New, restricted to the site's origin |
| `SMTP_PASS` | Vercel (server) | Operator | Yearly | All email (sign-in links, alerts) until redeployed | Its own mailbox or password |
| `RESEND_API_KEY` (if used) | Vercel (server) | Operator | Yearly | Fallback email | New |
| `TURNSTILE_SECRET_KEY` | Vercel (server) | Operator | With the widget | Sign-in and contact until both keys match | New widget for the mainnet domain |
| `GOOGLE_CLIENT_SECRET` | Vercel (server) | Operator | Yearly | Google sign-in | A separate OAuth client for mainnet |
| `HEALTH_TOKEN` | Vercel + the uptime monitor | Operator | Yearly | Monitor details until updated in both | New, ≥ 32 |
| `SENTRY_DSN` | Vercel (server) | Operator | When the project changes | Error reports | A mainnet project (EU region) |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN` | Vercel (server) | Operator | On staff change, or a leak | The second alert channel: while it fails, the `alert-channel-webhook` incident is emailed (alarm health stays green unless email fails too); send a test alert after rotating | A mainnet channel or topic |

## Operator credentials

| Credential | Lives in | Rotation | Notes |
|---|---|---|---|
| Vercel API token | operator machine (`~/.config/vercel/`) | Before it expires (September 2027) | Set a reminder a month ahead |
| GitHub account (repository admin) | hardware security key | — | 2FA with a hardware key; secret scanning and push protection on |
| Supabase account | password manager + 2FA | — | Owner of both projects |
| Helius, Cloudflare, Sentry, Google Cloud, DNS registrar accounts | password manager + 2FA | — | Each can take the site down or read its traffic |

## On-chain keys (not environment variables)

The platform roles are keys, not secrets in a store: super admin, Admins,
KYC registry authority, BlocklistAuthority, protocol treasury, and the
program upgrade authority. Owner decision (2026-09-28): once the company
exists, one company wallet takes over every role now held by the operator's
personal wallet; the upgrade authority stays with the Squads multisig. The
move is the on-chain two-step transfer of each role (runbook §7–8), never a
key copy. Keep the company wallet on a hardware device with a tested
backup, list it (and every Admin) in `ALARM_BALANCE_WATCH`, and the multisig
in `ALARM_SQUADS_CONFIG`, so a low balance or a Squads proposal pages the
team.

## On a suspected leak

1. Rotate the secret in its store(s) first, then redeploy (Vercel) or
   re-set (Supabase secrets, Vault) in the same window.
2. For `SESSION_SECRET`, expect every user to sign in again; for the worker
   and webhook secrets, watch `/api/health/alarms` return to 200.
3. Record the rotation (date, reason, who) in the private operations notes.
