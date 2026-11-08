# Manci

Manci issues, custodies, trades and vests tokenized real-world assets and
investments on Solana: an on-chain registry of issuers, assets and share
classes with Token-2022 mints behind a transfer hook (a blocklist check on
the sender of every transfer; receiver KYC and jurisdiction checks only on
KYC-gated classes, since classes are Open by default and KYC is checked when
tokens are converted into shares), primary sales, custody vaults, OTC deals,
distributions and vesting, plus the operator and investor web app.

## Status

The programs are **live on Solana mainnet since 2026-10-02**, deployed from
the release
[`v1.0.0-rc.1`](https://github.com/Mancipatio/Mancipatio/releases/tag/v1.0.0-rc.1)
(commit `ec254c4`). The first share class was tokenized on 2026-10-04 and
the first conversion of tokens into shares was recorded on 2026-10-10, the
day the site (<https://www.manci.io>) went public.

| Program | Mainnet address | Executable hash (`solana-verify`) |
| --- | --- | --- |
| `asset_registry` | `FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS` | `2cfb162e19605f4613f87988e3443a8d6e0f87db99b49822588649daaca955fa` |
| `transfer_hook` | `GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy` | `724cb70bd672698e39c28005e5dc99084cb50ec13e5363b2ffe26b33e294fbf6` |

- **Verified builds**: both programs are verified against that release
  with `solana-verify` (OtterSec's remote verification; status at
  `https://verify.osec.io/status/<program address>`). The hashes in the
  table are the release's `hashes.txt`. The `.so` files come from the
  reproducible build in `.github/workflows/verifiable-build.yml` and can
  be checked with `solana-verify verify-from-repo` against this
  repository (`--mount-path program`).
- **Upgrade authority**: a Squads vault
  (`CegfwedZiDfBAKVv4GdtNCH6cNHLUcGnxUNPJ9a7v8PQ`), currently a 1-of-1
  multisig with no time lock, so a single key can upgrade the programs
  (both programs' authority read back as that vault on 2026-10-18);
  upgrades follow the runbook (§9).
- **Devnet** runs the same program addresses with identical bytecode.
- **Not audited**: the programs have had internal security reviews and
  automated testing only; no independent external audit has been
  completed.
  <!-- Change this line only together with SECURITY_AUDIT in
  front/lib/legal/audit.ts. -->

The mainnet build left **KYC-only mode** on 2026-11-08 (owner decision;
`NEXT_PUBLIC_FEATURE_KYC_ONLY=false` in Vercel Production): besides sign-up
and identity verification (KYC for people, KYB for companies), primary
sales and issuance are open on the platform side, for equity only, and so
is conversion into company shares (switched on the same day: the Terms in
force offer it once switched on, with identity verification). Every other
pilot module (trading through Manci, token migration, vesting, rights,
distributions, governance, delivery) stays off until the Terms in force
offer it, and the program's pause flags decide on-chain (payout modules,
0x40, stay paused). The lockdown of 2026-10-10
(PR #78) returns by deleting that variable and redeploying
([`ops/env-vars.md`](ops/env-vars.md), "KYC-only mode and offered asset
classes"; "Pilot scope" for the module switches). The site serves the
commit last pushed to `release/mainnet`;
[`ops/release-checklist.md`](ops/release-checklist.md)
requires that commit to be the tip of `main` and checks it before the push.

## Repository

The public introduction is at `/`; `/app` opens the application overview.
The existing account, verification and marketplace routes retain their network
and feature controls. Documentation is at `/docs`.

| Path | What it is |
| --- | --- |
| `program/` | Anchor workspace with the two on-chain programs: `asset_registry` (`FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS`) and `transfer_hook` (`GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy`), their LiteSVM tests and IDL tooling |
| `front/` | Next.js app (investor, issuer and admin surfaces), the generated SDK (`lib/generated/`, from `front/idl/`), the Supabase migrations and the `helius-webhook` edge function (`supabase/`), and the operator CLIs (`scripts/chain/`, `scripts/ops/`) |
| `ops/` | Operator documents: the mainnet runbook, the admin SOP, the release checklist, the wind-down plan and the environment and secrets inventories (names only) |
| `scripts/` | `check-release-ancestry.sh`: the release guard (`release/mainnet` must be a fast-forward of `main`) |
| `.github/workflows/` | Front CI, program CI, the verifiable (reproducible) program build and the release guard |

## Build and test

Programs (`program/`; the pinned toolchain is what
`program/scripts/install-ci-toolchain.sh` installs: Agave 4.2.2 with
cargo-build-sbf 4.2.0 / platform-tools v1.56, SBPF v3):

```sh
cd program
cargo build-sbf --workspace --arch v3 --tools-version v1.56 -- --locked
cargo test --workspace --locked      # the tests load target/deploy/*.so: build first
cargo clippy --workspace --locked --all-targets -- -D warnings \
  -A clippy::too_many_arguments -A clippy::diverging_sub_expression
```

CI also builds the incident artifacts (`--features incident`, runbook §11)
and checks the ELF, the IDL and the ProgramData headroom
(`.github/workflows/program-ci.yml`).

Front (`front/`, Node 22.23):

```sh
cd front
npm ci
npx tsc --noEmit
npx eslint .
npx vitest run
```

The PostgreSQL suites (`tests/*.postgres.test.ts`) run the real migrations
on a throwaway local cluster when asked to:
`RUN_LOCAL_POSTGRES_TESTS=1 POSTGRES_BIN=<PostgreSQL 17 bin/> npx vitest run`.
They never connect to an existing database. `npm run check:codegen` and
`npm run check:idl` keep the generated SDK in step with the IDL.

## Operating it

Deployments, upgrades, incidents, alarms, the indexer and the database
projects are described in the runbook: [`ops/runbook-mainnet.md`](ops/runbook-mainnet.md).
Day-to-day admin duties: [`ops/sop-admin.md`](ops/sop-admin.md).
Releasing the front to mainnet: [`ops/release-checklist.md`](ops/release-checklist.md).

## Security

Report vulnerabilities to **security@mancipatio.io**. The policy (test only
on devnet or with your own funds, give us reasonable time before
disclosure) is at <https://www.manci.io/security>; the same contact is in
[`/.well-known/security.txt`](https://www.manci.io/.well-known/security.txt)
and in the programs' embedded security.txt. There is no bug bounty yet.

## Ask Manci

The public, English-only assistant reads published explanations, policies and
procedures from the `assistant_knowledge` database table. Admins manage it at
`/admin/assistant` (System → Assistant knowledge): create an entry, add its
public sources, save a private draft, then review and publish. Changes are
available on the next request without a website deployment. Drafts never reach
the public assistant or `/docs/manci-answers`. Unpublish before deleting an
entry; revision checks prevent overwriting another editor's changes.

Migration 0084 seeds the 26 previously published topics from
`front/lib/assistant/knowledge.ts`; that file is now seed/reference material,
not the live content store. Evidence includes the November 2026 presentations
and published mainnet operator record. Add only reviewed public summaries;
keep personal documents, private agreements and credentials out of this
library. The assistant has no account, document or transaction tools.

Apply migrations `0083_assistant_quota.sql` and `0084_assistant_knowledge.sql`
from `front/supabase/migrations` to the matching deployment database before
releasing, following the target-specific backup and migration procedure. Set
server-only `ANTHROPIC_API_KEY` on the relevant Vercel project; never prefix it
with `NEXT_PUBLIC_`. `ANTHROPIC_MODEL` defaults to `claude-haiku-4-5`.
For an API key without a workspace scope, also set server-only
`ANTHROPIC_WORKSPACE_ID` to the intended Claude Console workspace ID; keys
scoped to that workspace do not need this variable.
`SUPABASE_SERVICE_ROLE_KEY` and the canonical `NEXT_PUBLIC_SITE_URL` are required.

Shared limits default to 8 model attempts per IP/minute and 500 per UTC day.
Optional `MANCI_ASSISTANT_RATE_LIMIT_PER_MINUTE` and
`MANCI_ASSISTANT_DAILY_LIMIT` configure them. Missing credentials or an
unavailable quota store/provider gives a labelled answer from the published
library. If the knowledge store is unavailable, the assistant returns a safe
503; it never resurrects unpublished material from the static seed. An empty
published library gives a team handoff without a model call. Limits reached
return 429. Invalid input is rejected before quota or provider access.

Only the current and up to two preceding user questions and selected reference
excerpts reach Claude. Manci does not log or persist questions or answers.
Quota storage contains HMAC IP identifiers and counters only. The browser keeps
the conversation in memory. See `/legal/privacy#ask-manci` for the data-flow notice.

Tests cover retrieval, request boundaries, provider-output validation, fallback,
and durable quota limits. With `RUN_LOCAL_POSTGRES_TESTS=1`, the PostgreSQL
suites exercise concurrency, privileges, persistence and the full migration
chain. After deployment, verify a live Claude answer and its source links for
ownership, jurisdiction and lawyers, plus an unsupported question.
