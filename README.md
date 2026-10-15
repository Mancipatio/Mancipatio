# Manci

Manci issues, custodies, trades and vests tokenized real-world assets and
investments on Solana: an on-chain registry of issuers, assets and share
classes with Token-2022 mints behind a transfer hook (KYC, jurisdiction and
blocklist checks on every transfer), primary sales, custody vaults, OTC
deals, distributions and vesting, plus the operator and investor web app.

## Status

The programs are **live on Solana mainnet since 2026-10-02**, deployed from
the release
[`v1.0.0-rc.1`](https://github.com/Mancipatio/Mancipatio/releases/tag/v1.0.0-rc.1)
(commit `ec254c4`):

| Program | Mainnet address | Executable hash (`solana-verify`) |
| --- | --- | --- |
| `asset_registry` | `FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS` | `2cfb162e19605f4613f87988e3443a8d6e0f87db99b49822588649daaca955fa` |
| `transfer_hook` | `GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy` | `724cb70bd672698e39c28005e5dc99084cb50ec13e5363b2ffe26b33e294fbf6` |

- **Verified builds**: both programs are verified against that release
  with `solana-verify` (OtterSec's remote verification; status at
  `https://verify.osec.io/status/<program address>`). The hashes are the
  release's `hashes.txt`.
- **Upgrade authority**: a Squads vault
  (`CegfwedZiDfBAKVv4GdtNCH6cNHLUcGnxUNPJ9a7v8PQ`), currently a 1-of-1
  multisig with no time lock, so a single key can upgrade the programs;
  upgrades follow the runbook (§9).
- **Devnet** runs the same program addresses with identical bytecode.
- **Not audited**: the programs have had internal security reviews and
  automated testing only; no independent external audit has been
  completed.
  <!-- Change this line only together with SECURITY_AUDIT in
  front/lib/legal/audit.ts. -->

Which product modules are switched on is decided per network by the Terms
in force, the module switches and the program's pause flags
([`ops/env-vars.md`](ops/env-vars.md), "Pilot scope").

## Repository

| Path | What it is |
| --- | --- |
| `program/` | Anchor workspace with the two on-chain programs: `asset_registry` (`FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS`) and `transfer_hook` (`GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy`), their LiteSVM tests and IDL tooling |
| `front/` | Next.js app (investor, issuer and admin surfaces), the generated SDK (`lib/generated/`, from `front/idl/`), the Supabase migrations and the `helius-webhook` edge function (`supabase/`), and the operator CLIs (`scripts/chain/`, `scripts/ops/`) |
| `ops/` | Operator documents: the mainnet runbook, the admin SOP, the wind-down plan and the environment and secrets inventories (names only) |
| `.github/workflows/` | Front CI, program CI and the verifiable (reproducible) program build |

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

## Security

Report vulnerabilities to **security@mancipatio.io**. The policy (test only
on devnet or with your own funds, give us reasonable time before
disclosure) is at <https://www.manci.io/security>; the same contact is in
[`/.well-known/security.txt`](https://www.manci.io/.well-known/security.txt)
and in the programs' embedded security.txt. There is no bug bounty yet.
