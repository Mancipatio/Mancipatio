# Mainnet runbook: deploy, bootstrap, handover, upgrades

This is the operator runbook for putting `asset_registry` and `transfer_hook` on
mainnet and handing them to the Squads multisig. It follows design 3.3 rev 2
(Talas 3.3 + 3.4) and the owner decisions D1–D19, with these exceptions:

- **D13**: `program/scripts/idl-upload-sequential.cjs` (and `npm run idl:upload`)
  stays for now. It is deleted only after `chain:idl` check reports devnet
  `in-sync` (the D13 gate).
- **D15**: the TH "multisig" comment fix is not part of this work. No program
  code changed in Talas 3.

Anything marked **EXTERNAL** is a fact only the 6.1 rehearsal can prove. Do not
run a mainnet step whose EXTERNAL item is still open.

## Tools

The tools live in `front/scripts/chain/` and run from `front/`:

| Command | What it does | Sends? |
|---|---|---|
| `npm run chain:inventory` | Read-only inventory with findings for `CHAIN_PHASE` = `in-progress`, `pre-handover` or `handed-over`; also the SBPF version of the Release and the SIMD-0500 / rent feature state (§1) | never |
| `npm run chain:idl` | Canonical IDL: `CHAIN_IDL_MODE` = `check` (default), `send` or `prepare-export` | only with `CHAIN_SEND=1` |
| `npm run chain:bootstrap` | One bootstrap cycle (S1–S7) as a reviewed plan | only with `CHAIN_SEND=1` |
| `npm run chain:squads-export` | Unsigned vault transactions for the Squads Transaction Builder | never |
| `npm run chain:handover` | Ordered plan to move live roles to new keys (§19) | never |
| `npm run chain:emergency` | Out-of-band pause, unpause, blocklist and hook mode with a Ledger or a keypair, no front and no database (§11) | only with `CHAIN_SEND=1` |

Every run writes one evidence file (`CHAIN_OUTPUT`, schema
`mancipatio-chain-<tool>-v1`) even when it fails or is interrupted. Its
`status` is `completed`, `awaiting`, `aborted` or `failed`. A send run also
writes `<CHAIN_OUTPUT>.journal.jsonl`.

### Environment (runner contract)

| Variable | Rule |
|---|---|
| `CHAIN_NETWORK` | Required: `mainnet`, `devnet`, `testnet` or `localnet`. Must equal `NEXT_PUBLIC_NETWORK` if that is set. |
| `CHAIN_ALLOW_MAINNET=1` | Required for any mainnet run. |
| `CHAIN_RPC_URL` | https only (localnet may use http on a loopback host), no `user:pass@`. Never printed; evidence keeps the hostname only. Use the dedicated RPC. |
| `CHAIN_GENESIS_HASH` | Required on localnet (`solana genesis-hash`). Elsewhere, if set, it must equal the cluster's hash. |
| `CHAIN_OUTPUT` | Required. Must not exist. Inside the repository it must be git-ignored (for example `docs/…`); outside the repository anything goes. |
| `CHAIN_ROLE_MAP` | Required for bootstrap and squads-export, and for IDL send/prepare-export. Its sha256 goes into the plan digest. For handover it is the target (a handover target or a role map, §19). |
| `CHAIN_RELEASE_DIR` | Required on mainnet for bootstrap, idl and squads-export. `SHA256SUMS` is verified first. |
| `CHAIN_SEND=1`, `CHAIN_KEYPAIR`, `CHAIN_CONFIRM_PLAN` | Send mode needs all three. Without `CHAIN_SEND` every tool is a dry run. |
| `CHAIN_SIGNER` | chain:emergency only, instead of `CHAIN_KEYPAIR`: `usb://ledger`, `usb://ledger?key=<n>` or `usb://ledger?key=<n>/<m>` (the Solana CLI's derivation paths). |
| `CHAIN_CU_PRICE` | Micro-lamports per CU. Required when sending on mainnet; at most 2,000,000. |
| `CHAIN_RPS` | Requests per second, default 2, at most 20. On the public devnet RPC use `1`: its `getProgramAccounts` limit fails an inventory at 2 (observed 2026-09-24). |
| `CHAIN_DEADLINE_MIN` | Internal abort deadline. Defaults: inventory 20, bootstrap 60, idl 120, squads-export 10. |
| `CHAIN_REHEARSAL_SIGNERS` | localnet/devnet only: `superAdmin=<file>,blocklistAuthority=<file>,kycAuthority=<file>`, so the CLI signs X1/X2/X3/S6 in a rehearsal. |
| `CHAIN_RECOVER=1` | Resolves a leftover lock (see "Crash recovery"). Sends nothing. |
| `CHAIN_STATE_DIR` | Lock directory; default `~/.mancipatio/chain`. Refused on mainnet unless it is the default (the lock only excludes runs that share its directory). |

Tool-specific: `CHAIN_PHASE`, `CHAIN_SCAN_BUFFERS=0` (inventory);
`CHAIN_IDL_MODE`, `CHAIN_IDL_PROGRAM`, `CHAIN_IDL_SOURCE` (`release` is
mandatory on mainnet), `CHAIN_IDL_RESUME_BUFFER`, `CHAIN_SNAPSHOT_DIR` (idl);
`CHAIN_HANDOVER=1`, `CHAIN_CONFIRM_HANDOVER=<vault>`,
`CHAIN_HANDOVER_WHILE_PAUSED=1` (bootstrap); `CHAIN_SQUADS_OP`,
`CHAIN_SQUADS_INPUT`, `CHAIN_SQUADS_CONFIG_UNVERIFIED=1` (squads-export, off
mainnet only); `CHAIN_SITE_ORIGIN` (handover, wording only);
`CHAIN_EMERGENCY_OP`, `CHAIN_EMERGENCY_SIGNER`, `CHAIN_PAUSE_BITS`,
`CHAIN_WALLET`, `CHAIN_CONFIRM_WALLET`, `CHAIN_MINT`, `CHAIN_HOOK_MODE`,
`CHAIN_KYC_REGISTRY`, `CHAIN_EMERGENCY_IDL_UNCHECKED=1` (emergency, §11).

The runners never read `.env*` files. Export the variables in the shell, for
example from a small `set -a; . ~/mancipatio-mainnet/chain.env; set +a` file
that lives outside the repository and holds no keypair bytes.

### Safety rules the tools enforce

- The RPC must prove the pinned genesis hash before every call; a method
  outside the allowlist is refused (a dry run cannot call `sendTransaction`);
  every RPC error is replaced by `RPC <method> failed; details withheld`; only
  the RPC origin and path are reachable with `fetch`.
- Dry run is the default. A send run recomputes the plan and aborts unless its
  digest equals `CHAIN_CONFIRM_PLAN`. Before every step it re-probes at
  finalized, skips steps that already landed, refuses a diverged state,
  simulates the exact signed transaction with signature verification, writes
  the signature to the journal (fsync) and only then sends it with
  `maxRetries: 0`.
- A signature is never rebuilt. It is re-broadcast as the identical bytes, and
  declared dropped only after the finalized block height passed its
  `lastValidBlockHeight` and a history search finds nothing.
- One lock per network (`<network>-<genesis[0..8]>.lock`); a second send run
  on the same network is refused until the first one's signatures are
  resolved.
- On mainnet: the Release is mandatory, `front/idl/*.json` must be byte-equal
  to the Release IDLs, and `front/idl`, `front/lib`, `front/scripts/chain`,
  `front/scripts/ops/artifact-provenance.mjs`, `front/package.json` and
  `front/package-lock.json` must be clean (commit or stash first); the
  Release `.so` must equal the live ProgramData before a bootstrap or IDL
  send. In practice every mainnet `chain:idl`, `chain:bootstrap` and
  `chain:squads-export` run happens in a clean checkout of the tag whose
  Release is `CHAIN_RELEASE_DIR`.
- Hot keys: the deployer (bootstrap, IDL before handover) and the
  bufferWriter (buffers after handover). The deployment tools refuse any
  other key, and never load a Ledger key on mainnet. The one exception is
  chain:emergency (§11): it signs with the role key itself (a Ledger or that
  key's file), after checking on-chain that the key holds the role.

## 0. Preflight

### Merge gates (owner; before the chain CLI branch merges)

The front gate proves the tools against a fake chain, and
`tests/chain-release.test.ts` runs the workflow's own shell steps (build
hashes, artifact layout, bundle assembly, publish re-check) on a synthetic
workspace and loads the result with `loadRelease(…, {requireSums: true})`.
`actionlint` 1.7.7 with shellcheck 0.10.0 is clean on
`.github/workflows/*.yml`; re-run it after any workflow edit. What only a
real runner and devnet can prove stays open until these pass:

- [ ] Push the branch and run the workflow with a dry release:
      `gh workflow run verifiable-build.yml --ref <branch> -f dry_release=true`.
      The `build`, `idl-check` and `bundle` jobs pass; `publish` is skipped.
- [ ] Download the bundle and check it:
      `gh run download <run-id> -n release-dry-<sha> -D "$D/release-dry"`,
      then `(cd "$D/release-dry" && sha256sum --check SHA256SUMS)`.
- [ ] From `front/` on devnet (`CHAIN_NETWORK=devnet`, `CHAIN_RPC_URL`, a new
      `CHAIN_OUTPUT` under `$D` for each run), store every evidence file:
  - `npm run chain:inventory` without a role map, then with the devnet
    `CHAIN_ROLE_MAP` and `CHAIN_RELEASE_DIR="$D/release-dry"`
    (the Release must load; a ProgramData ≠ Release finding is expected when
    devnet runs another build);
  - `CHAIN_IDL_MODE=check npm run chain:idl`;
  - `npm run chain:bootstrap` as a dry run (no `CHAIN_SEND`) with the map.
- [ ] After the merge, before any mainnet tag: push a throwaway prerelease tag
      `v0.0.0-rc.<n>` on main. The `publish` job must pass the ancestry check,
      attest and create the prerelease; then run the attestation check below
      against it (`--source-ref refs/tags/v0.0.0-rc.<n>`).

### Legal gate (before S1)

No mainnet transaction (not even §2) before every item below is ticked
by the owner, with the document or decision it rests on filed outside the
repository (`~/mancipatio-mainnet/legal/`). The chain tools cannot check
these; the owner signs them off in the launch-day record (§0A, D0).

- [ ] **Lawyer's written opinion** on the service's qualification (the
      Serbian Law on Digital Assets, securities rules for the share classes,
      AML/CFT obligations) and on the owner decisions it depends on: purchase
      and OTC without KYC, KYC at conversion and delivery, clawback on Open
      classes, the €3M ceiling.
- [ ] **Licence** from the Securities Commission (Komisija za hartije od
      vrednosti) for the digital-asset service the opinion names, or the
      opinion that none is needed for the pilot scope.
- [ ] **Legal entity** registered; the operator named in the Terms, Privacy
      and imprint is that entity; the company wallet (§19) belongs to it.
- [ ] **Terms and Privacy** reviewed by the lawyer for mainnet:
      `TOS_VERSION` and `LAST_UPDATED` raised, the mainnet build's
      `MAINNET_LEGAL_COPY_APPROVED=true` set only after that review. The
      Terms and the `/security` page disclose the operator's on-chain powers
      (prog-vlast-8): the BlocklistAuthority blocks wallets (escrows too),
      switches a class between Open and KycGated in either direction and
      re-points its KYC registry; Admins claw back blocked and revoked
      holders; and, with the company wallet model (§19), that one key of the
      legal entity holds all of them together with the super admin.
- [ ] **Data processing agreements** with every processor that sees personal
      data: Supabase, Vercel, the RPC/webhook provider (Helius), the SMTP
      provider, Cloudflare Turnstile, Google (sign-in); records of processing
      and the retention schedule.
- [ ] **AML/CFT programme**: the written KYC/KYB procedures (ops/sop-admin.md
      is the operational part), risk assessment, compliance officer,
      suspicious-transaction reporting channel, record keeping.
- [ ] **Sanctions screening** decided and wired (at least the baseline the
      8.5 package delivers) and **geoblocking** of excluded jurisdictions
      (the KYC registry's blocked jurisdictions plus the front's geoblock).
- [ ] **Wind-down plan** (ops/wind-down-plan.md) reviewed by the lawyer and
      the termination clause in the Terms.

### Mainnet preflight

- [ ] **Release vX**: a `v*` tag on a commit that is on main, a GitHub Release
      produced by `verifiable-build.yml`, **immutable releases** turned on in
      the repository settings (D9). Download it to `~/mancipatio-mainnet/release-vX`
      and check:
      ```sh
      cd ~/mancipatio-mainnet/release-vX && sha256sum --check SHA256SUMS
      for f in *.so *.json hashes.txt sbf-sha256.txt SHA256SUMS; do
        gh attestation verify "$f" --repo Mancipatio/Mancipatio \
          --signer-workflow Mancipatio/Mancipatio/.github/workflows/verifiable-build.yml \
          --source-ref refs/tags/vX --deny-self-hosted-runners
      done
      ```
      Pinning the signer workflow and the tag matters: without them any
      workflow of the repository, on any branch, could produce a passing
      attestation.
- [ ] **security.txt** decided before the rc tag (D16).
- [ ] **Operator, licence and legal texts** (§17): the mainnet operator
      record, the licence (or counsel's written waiver), counsel's Terms,
      Privacy Policy, acceptance-dialog summary and risk warning are in
      `front/lib/legal/`, and
      `npx vitest run tests/legal-slots.test.ts --silent=false` reports them
      complete. A mainnet build is refused until then.
- [ ] **Program keypairs** backed up offline (two copies, not on the operator
      machine's synced folders).
- [ ] **Squads** multisig created with the D12 parameters: threshold ≥ 2,
      `config_authority` none (autonomous), time lock 0 until after the audit.
      Record `multisig`, `vaultIndex` (0), `vault` and every member with its
      permissions in the role map. `chain:inventory` must show the decode
      matching (finding code `squads` absent). **EXTERNAL #4** (layout) must be
      closed by the rehearsal dump.
- [ ] **Role map** (`front/scripts/chain/role-map.example.json` shows the
      shape with separate keys, `role-map.company.example.json` the company
      wallet model of §19): `network: mainnet`, the mainnet genesis hash,
      `programDataMaxLen` = `{ "assetRegistry": 3145728, "transferHook": 786432 }`
      (D8), `deployer` and `bufferWriter` hot keys (different keys, no role, not
      Squads members, D19), `superAdmin`, `admins[]` (never the SA),
      `blocklistAuthority`, `kyc.authority` (Ledgers, or the company wallet),
      `kyc.registry` = the KycRegistry PDA of the deployer (D3),
      `protocolTreasury` = the vault (D5) or, acknowledged, the company wallet,
      `protocolFeeBps: 0`, `unpauseBy: "superAdmin"` (D4),
      `kyc.tempAdminGrant: false` unless the 3.1 `kycProvider` gate is missing
      (D17). One key in several roles needs `acknowledgedRoleOverlaps` (§19);
      the map is refused on mainnet without it.
- [ ] **Dedicated RPC** and `CHAIN_CU_PRICE` decided (check recent
      prioritization fees).
- [ ] **Cluster gates**: `chain:inventory` with `CHAIN_RELEASE_DIR` shows no
      `sbpf-gate` blocker (SIMD-0500 against the Release's SBPF version) and
      its `rent` line matches the budget chosen in §1. The gate blocks only a
      deploy still to come: once the Release is live (ProgramData equal to
      it) and from the pre-handover phase on, an active SIMD-0500 is a
      warning (the deployed program keeps running and S7 writes no code),
      while `chain:squads-export op=upgrade` still refuses an SBPF v0-v2
      Release.
- [ ] **Operator front (D18)**, prepared before S1 so X1 can follow within
      minutes. The chosen variant is §0A: the mainnet **production**
      deployment on its real domain behind Vercel Deployment Protection
      (All Deployments, Vercel Authentication), so it is not public until
      Talas 7 while the schedulers reach it with the bypass header:
  - `NEXT_PUBLIC_NETWORK=mainnet`, the dedicated RPC, the mainnet Supabase
    project with every migration applied, `NEXT_PUBLIC_KYC_REGISTRY=<kyc.registry>`,
    **maintenance off** (maintenance refuses the signed wallet-transaction
    policy, so it would block X1, X2, X3 and S6; Deployment Protection, not
    maintenance, keeps the public out);
  - fallback if Vercel is unavailable: a local `next dev` on the operator
    machine with the same settings;
  - each operator key (the SA, BA and KYC Ledgers, or the company wallet,
    and the break-glass successor of §11) connects once, signs SIWS and the
    ToS (the `/issuer/*` TosGate) and becomes primary of its own account;
    none may already be a secondary wallet of another account;
  - fund the keys per the §1 operational budget;
  - **no public mainnet front until step 8** (Talas 7, §0A D11).
- [ ] 3.1 merged (the `kycProvider` layout gate, the D17 default; mainnet hides
      Initialize Platform and BlocklistBootstrap on `/issuer/authority` and
      `/admin/platform`) and 3.2 merged.
- [ ] The **6.1 rehearsal** (section 12) passed and every EXTERNAL item is
      closed.

## 0A. Launch day master sequence

One order from nothing to the public launch. The sections it points to keep
the details; this list decides the order and resolves where they disagreed
(uloge-runbook-4/-5, podaci-infra-4):

- §15 wants the alarm scheduler proven against the live mainnet site before
  §2, and the retry scheduler needs the site at its origin, but §0 forbids a
  public front before step 8, and maintenance (a database flag the operator
  front shares) would block X1/X2/X3/S6.
- §14 step 8 seeded the USDC FX row during the database bootstrap, §15 (D16)
  after the program bootstrap, and `/api/health` failed without it.

**Chosen variant (a): the production deployment behind Deployment
Protection.** The mainnet Vercel project serves its real domain from D4 on,
with Deployment Protection set to *All Deployments* with *Vercel
Authentication* (no paid add-on; operators are members of the Vercel team and
sign in). The public sees only Vercel's sign-in wall. pg_cron reaches
`/api/internal/*` with the *Protection Bypass for Automation* secret, which
the retry and alarm schedulers read from the Vault secret
`mancipatio_vercel_bypass_mainnet` and send as `x-vercel-protection-bypass`;
the external monitor sends the same header. Maintenance stays **off** the
whole time. `/api/health` reports a missing FX row as a warning
(`missing_before_first_sale`) until the first sale approval or sale exists,
so the FX row is seeded after the bootstrap (D10), as D16 wants. Why not the
alternatives: (b) a pre-launch mode that admits allowlisted wallets is new
code in every gate; (c) moving the alarm gate after step 8 leaves the
bootstrap (every authority change, the loader) unalarmed. Keep the window
between D4 and D11 short: the domain shows a sign-in wall meanwhile.

| Step | What | Who | Where |
|---|---|---|---|
| D0 | Legal gate ticked (§0), EXTERNAL items closed, go/no-go recorded | owner | §0, EXTERNAL |
| D1 | Accounts: Supabase Pro with PITR (mainnet project), Vercel Pro with the mainnet project, Helius paid plan (RPC and webhook), SMTP sender, external monitor, age backup key (G10) | owner | §14 step 1 |
| D2 | Devnet moves to `devnet.manci.io` (DNS, env, redeploy, schedulers re-installed) and keeps working | owner + operator | §18 A–C |
| D3 | Mainnet database: 0001–0075 and later, identity, preflights, schema backup, pg_cron and http, the Vault secret `mancipatio_retry_worker_mainnet`, retention | operator | §14 mainnet steps 1–6 |
| D4 | Mainnet Vercel project: env (§18 E list), Deployment Protection *All Deployments* + Vercel Authentication, a *Protection Bypass for Automation* secret stored in the Vault as `mancipatio_vercel_bypass_mainnet` (paste it in the Supabase Vault UI, never on a command line), `www.manci.io` and `manci.io` attached (§18 D), production READY on the release commit. Check: an anonymous `curl -I https://www.manci.io/` is refused by Vercel; with the bypass header `/api/health` answers `ok:true` (at most `paymentFx` `missing_before_first_sale`) | owner + operator | §18 D, §14 step 10 |
| D5 | Retry scheduler installed and enabled; edge function, Helius webhook with all four addresses, signed test delivery 202; `HEALTH_TOKEN`; external monitor on `/api/health/alarms` with the bypass header | operator | §14 steps 7, 9, 10 |
| D6 | Alarm scheduler installed, proven (test email) and enabled; `/api/health/alarms` 200 through the bypass. **The §15 gate holds**. Then the deployment smoke (§14 step 11) through the bypass: `MANCIPATIO_VERCEL_BYPASS_FILE=<file with the line VERCEL_AUTOMATION_BYPASS_SECRET=…>` (a file, never the value on a command line) | operator | §15 Mainnet project, §14 step 11 |
| D7 | 0075 heartbeat in `observe` (it proves nothing yet on quiet program IDs; the 24 h observation runs across D8–D12) | operator | §16 Mainnet |
| D8 | §0 mainnet preflight: Release, attestation, program keypair backup, Squads, role map (§19 company model if chosen), cluster gates, CU price, operator keys onboarded on the protected site | owner + operator | §0 |
| D9 | §2 deploy (hook first) → §3 IDL → §4 cycle 1 → §5 operator steps on the protected site → §6 pre-handover inventory → §7 S7 → §8 after handover (verify PDA, buffers, drain the deployer) | operator + role keys | §2–§8 |
| D10 | Super admin on `/admin/limits`: the USDC EUR rate (kind `rate`, max age ≤ 7 days) and the mainnet `platform_raise_limits` with FX headroom; the 0008 integrations config. `/api/health` is `ok:true` without warnings | super admin | §13, §14 step 8 |
| D11 | **Talas 7 go-live**: Deployment Protection back to *Standard Protection* (production domains public), delete the Vault secret `mancipatio_vercel_bypass_mainnet` and the bypass secret in Vercel (or rotate it), monitors without the header; the deployment smoke (§14 step 11) again **without** `MANCIPATIO_VERCEL_BYPASS_FILE` (it proves the site is public); announce | owner + operator | §18 D, §14 step 11 |
| D12 | First 24 h: `/api/priority-fee` answers `source: helius` (EXTERNAL #7), heartbeat switched `on` after its 24 h `observe`, alarms and badges reviewed | operator | §13, §16 |

The first public user can arrive only after D11. A failure at any step stops
the sequence there; nothing before D9 touches the chain.

## 1. Roles and budget

| Role | Key | Holds after handover |
|---|---|---|
| deployer | hot | nothing (drained in step 8) |
| bufferWriter | hot | nothing; writes buffers, then hands them to the vault |
| superAdmin (SA) | Ledger | platform admin (and its Admin record) |
| admins[] | Ledgers | Admin records |
| blocklistAuthority (BA) | Ledger | blocklist authority |
| kyc.authority | compliance Ledger | KYC registry authority (no Admin record) |
| Squads vault | multisig | both upgrade authorities, protocol treasury, IDL authority (as UA) |
| company wallet (§19, when chosen) | Ledger of the legal entity | SA with its Admin record, KYC registry authority, BA and the protocol treasury, in place of the four rows above; never a Squads member unless acknowledged |

Re-check every figure with `getMinimumBalanceForRentExemption` on the
mainnet RPC (`chain:inventory` prints it as its `rent` finding). Mainnet
rent is **5,080 lamports per byte** (plus 128 bytes of overhead) since
SIMD-0437-2 (epoch 1033); the later steps are not active yet (feature status
2026-09-24, Agave 4.3.0), so the figures may still drop. A local validator
keeps the old 6,960 in its genesis rent sysvar even with
`--clone-feature-set`, so rehearsal balances overstate mainnet rent by about
37 %.

Feature gates (Agave `feature-set/src/lib.rs`: the same keys on the v4.3 and
v4.4 branches and master, checked 2026-09-28; `chain:inventory` reads all of
them, `chain:squads-export op=upgrade` refuses an SBPF v0–v2 Release once
SIMD-0500 is active):

| Gate | Feature ID | Effect | Status 2026-09-24 |
|---|---|---|---|
| SIMD-0437-1 | `4a6f7o7iTcA8hRDCrPLkSatnt5Ykxiu36wo5p1Tt12wC` | 6,333 lamports/B | active |
| SIMD-0437-2 | `61BtM7BkDEE8Yq5fskEVAQT9mYA8qCejJWoLe5apqg81` | 5,080 lamports/B | active (slot 446256000) |
| SIMD-0437-3 | `rntCigrTppP5JdZz7K8TyN9sMzLdAcXp8SejYpVpX6D` | 2,575 lamports/B | not scheduled |
| SIMD-0437-4 | `rntD7invRBswCAdKtRsh1G4psKjrPdS3BKqtnA78C7N` | 1,322 lamports/B | not scheduled |
| SIMD-0437-5 | `rntTjNZ9boq8owDxjGVFHPfWNQPDaKiM5JcjxmDGg47` | 696 lamports/B | not scheduled |
| SIMD-0438 | `rnt8ZQpz2HYhX3DkYBDGjJS1a36mYq69oXka7JrhEdi` | back to 6,960 lamports/B | not scheduled |
| SIMD-0500 | `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` | no deployment of SBPF v0–v2 | not scheduled |
| SBPF v3 | `5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC` | deployment and execution of SBPF v3 | active |

solana.com/upgrades/reduced-rent lists `Ftxb3…`, `GsUBN…` and `mZdnR…` for
steps 3–5: those are the Agave **v4.2** keys (with `5AqsUgSb…` for
SIMD-0438), re-keyed in v4.3. `chain:inventory` probes them too and warns
(`feature-superseded`) if one is ever scheduled. The page's "expected in
Agave 4.4, November 2026" date for steps 3–5 is the only schedule published.

**Owner decision: mainnet waits for the rent drop.** Still open (owner):
which step to wait for (2,575, 1,322 or 696) and until which date; the
operational budget below gives the deployer figure for each. If Agave 4.4
slips past that date, re-decide between deploying at 5,080 (about 17.5 SOL
more locked for good, with no instruction to recover it) and waiting.

| Item | SOL at 5,080 |
|---|---|
| Registry ProgramData (3 MiB) | ≈ 15.98 |
| Hook ProgramData (768 KiB) | ≈ 4.00 |
| Registry deploy buffer (transient) | ≈ 12.55 |
| Hook deploy buffer (transient) | ≈ 1.98 |
| IDL metadata (both programs) | ≈ 0.26 |
| IDL update buffer (transient) | ≈ 0.24 |
| Bootstrap PDAs | < 0.05 |

The sum of every row is ≈ 35.1 SOL, an upper bound for the deployer's peak:
**fund 40**. About 20.3 SOL stays locked. `chain:bootstrap` refuses a cycle
the deployer cannot pay for (P0).

### Operational budget per key

Rent scales with lamports per byte; fees are small (5,000 lamports per
signature plus the priority fee: 200,000 CU at the mainnet floor of
100,000 µL/CU is 20,000 lamports, 0.00002 SOL, and 0.0004 SOL at the
2,000,000 cap). Top up
below the "refill below" line; the low-balance alarm planned in package 8.4
should use the same numbers.

| Key | What it pays | At 5,080 | At 2,575 | At 1,322 | At 696 | Fund | Refill below |
|---|---|---|---|---|---|---|---|
| deployer | ProgramData (locked), deploy buffers, IDL, bootstrap PDAs (peak) | 35.1 (20.3 locked) | 17.8 (10.3) | 9.2 (5.3) | 4.9 (2.8) | peak + 5 | — (drained after §8) |
| bufferWriter | both upgrade buffers (≈ 14.53 / 7.36 / 3.78 / 1.99), the IDL buffer (≈ 0.24 / 0.12 / 0.06 / 0.03), `solana program extend`; the buffer rent returns as the spill after the Squads execute | 14.8 | 7.5 | 3.9 | 2.1 | right before an upgrade, then drain | — |
| company wallet or KYC key | each passport (KycEntry 120 B): 0.00126 / 0.00064 / 0.00033 / 0.00017 SOL, so about 1.26 / 0.64 / 0.33 / 0.17 SOL per 1,000 passports; returned when a passport is closed | 1.3 per 1,000 | 0.64 | 0.33 | 0.17 | 2 | 0.5 |
| company wallet or SA | Admin records (0.00102 at 5,080), proposal PDAs (0.00135, refunded to the acceptor), KYB, treasury and pause fees | 0.05 | 0.03 | 0.02 | 0.01 | 0.2 | 0.05 |
| company wallet or Admins | what an Admin opens: OTC deals, custody vaults, distributions (the funder is the Admin, K16), rights issuances; each is a few thousandths of a SOL plus the tokens it moves | per operation | | | | 0.5 | 0.1 |
| company wallet or BA | one BlockEntry per blocked wallet (73 B: 0.00102 at 5,080) | 0.00102 each | 0.00052 | 0.00027 | 0.00014 | 0.1 | 0.02 |
| each Squads member | vault transaction and proposal accounts (a few thousandths of a SOL each; with no rent collector they are not refunded) | 0.01 per proposal | | | | 0.1 | 0.03 |
| Squads vault | verify PDAs through the verify program (≈ 0.01), its own fees | 0.02 | | | | 0.05 | 0.01 |

The company wallet holds several rows at once: fund it with the sum
(about 3 SOL at 5,080 for the pilot) and keep the sum of the refill lines.

## 2. Deploy (hook first)

Never `deploy` without `--buffer` (D7). Buffer keypairs are generated outside
the repository and never logged (`--silent`; a seed phrase in a log is a
leak).

```sh
R=~/mancipatio-mainnet/release-vX
K=~/mancipatio-mainnet/keys           # deployer.json, program keypairs, buffer keypairs
E=~/mancipatio-mainnet/evidence       # one new CHAIN_OUTPUT per run (never overwritten)
solana-keygen new --no-bip39-passphrase --silent -o "$K/buffer-transfer_hook.json"
solana program write-buffer "$R/transfer_hook.so" \
  --buffer "$K/buffer-transfer_hook.json" --keypair "$K/deployer.json" \
  --url "$MAINNET_RPC" --with-compute-unit-price "$CU_PRICE"
solana program deploy --program-id "$K/transfer_hook-keypair.json" \
  --buffer "$(solana-keygen pubkey "$K/buffer-transfer_hook.json")" \
  --upgrade-authority "$K/deployer.json" --keypair "$K/deployer.json" \
  --max-len 786432 --url "$MAINNET_RPC" --with-compute-unit-price "$CU_PRICE"
# then the same for asset_registry with --max-len 3145728
```

Check against the Release:

```sh
cd front
CHAIN_NETWORK=mainnet CHAIN_ALLOW_MAINNET=1 CHAIN_RPC_URL="$MAINNET_RPC" \
CHAIN_ROLE_MAP=~/mancipatio-mainnet/role-map.json CHAIN_RELEASE_DIR="$R" \
CHAIN_OUTPUT=$E/02-inventory.json \
npm run chain:inventory
```

At this point (phase `in-progress`, IDL not yet initialized, bootstrap not
yet run) expect exactly:

- info: `deployer-ua` (both programs);
- warnings: `platform-missing`, `blocklist-missing`, `idl` for both programs
  (status `init`), `kyc-registry` (the registry does not exist yet),
  `admin-missing` for every `admins[]` key, and `kyc-pin` if
  `NEXT_PUBLIC_KYC_REGISTRY` is exported in the shell;
- no `release-bytes`, `capacity`, `squads`, `buffer` or blocker.

## 3. IDL init

```sh
export CHAIN_NETWORK=mainnet CHAIN_ALLOW_MAINNET=1 CHAIN_RPC_URL="$MAINNET_RPC"
export CHAIN_ROLE_MAP=~/mancipatio-mainnet/role-map.json CHAIN_RELEASE_DIR="$R" CHAIN_IDL_SOURCE=release
CHAIN_OUTPUT=$E/03a-idl-check.json npm run chain:idl                         # both: init
CHAIN_OUTPUT=$E/03b-idl-plan.json CHAIN_IDL_MODE=send npm run chain:idl      # dry run: prints the digest
CHAIN_OUTPUT=$E/03c-idl-send.json CHAIN_IDL_MODE=send CHAIN_SEND=1 \
  CHAIN_KEYPAIR="$K/deployer.json" CHAIN_CONFIRM_PLAN=<digest> CHAIN_CU_PRICE="$CU_PRICE" \
  npm run chain:idl
CHAIN_OUTPUT=$E/03d-idl-check.json npm run chain:idl                         # both: in-sync
```

The send verifies after a finalized re-fetch: canonical, Utf8/Zlib/Json/Direct,
trimmed, and inflated bytes equal to the Release IDL. No extra metadata
authority is set (D6: the vault, as UA, runs IDL changes through Squads).

## 4. Bootstrap cycle 1

```sh
CHAIN_OUTPUT=$E/04a-bootstrap-plan.json npm run chain:bootstrap
```

Review the printed plan: every step, its preconditions, the signer (always the
deployer), which steps were simulated now and which are deferred ("depends on
S1"), the ACTION REQUIRED list and `NEXT_PUBLIC_KYC_REGISTRY=<address>` (already
pinned on the operator front). Default cycle 1 is S1, S2, S2b, S3 (each admin),
S4, (S4c), S4b, S5, all in one digest. Then send:

```sh
CHAIN_OUTPUT=$E/04b-bootstrap-send.json CHAIN_SEND=1 CHAIN_KEYPAIR="$K/deployer.json" \
  CHAIN_CONFIRM_PLAN=<digest> CHAIN_CU_PRICE="$CU_PRICE" npm run chain:bootstrap
```

It ends with `status: awaiting` and the Ledger actions. A fresh Platform starts
fully paused (0x3f).

## 5. Ledger steps (operator front)

In any order (the plan's ACTION REQUIRED lines name the same pages; a test
checks that each page exists and performs its action):

- **X3**: the BA Ledger accepts on `/issuer/authority` (or `/account/roles`
  → Waiting for your acceptance), then clicks Refresh.
- **X2**: the KYC Ledger accepts on **`/account/roles`** → Waiting for your
  acceptance → KYC provider (registry authority). Not `/admin/kyc`: until it
  accepts, the key is neither the kycProvider nor an Admin, so the admin gate
  refuses it. Temporary-grant path (D17 fallback, `kyc.tempAdminGrant: true`):
  cycle 1 also ran S3k, S5 waits; after X2 run cycle 2 (S3r removes the
  grant, then S5) with a new dry run and digest.
- **X1**: the SA Ledger accepts on `/issuer/authority` (or `/account/roles`),
  **clicks Refresh**, then **S6** on **`/admin/platform`**: PauseFlagsPanel →
  "Resume everything" (the accept gave the SA its Admin record, so the admin
  area opens).

`accept_platform_admin` closes the deployer's Admin record and creates the
SA's; no `add_admin(SA)` is ever needed. With the company wallet model (§19)
one wallet does X3, X2, X1 and S6, in that order.

## 6. Dry run again, pre-handover inventory

```sh
CHAIN_OUTPUT=$E/06a-bootstrap-plan.json npm run chain:bootstrap        # only S7 pending
CHAIN_OUTPUT=$E/06b-inventory.json CHAIN_PHASE=pre-handover npm run chain:inventory
```

The inventory must show **0 blockers**: SA, BA and KYC equal the map with no
pending transfer; the deployer holds nothing but the UA; `kyc.authority` holds
no Admin record (a warning, not a blocker, when the map acknowledges the
overlap, §19); the Squads decode matches exactly; the canonical IDL is in
sync with the Release and trimmed, with no extra authority; ProgramData equals
the Release; capacity ≥ `programDataMaxLen`. Smoke-test from the operator
front.

## 7. Handover (S7)

```sh
CHAIN_OUTPUT=$E/07a-plan.json CHAIN_HANDOVER=1 CHAIN_CONFIRM_HANDOVER=<vault> npm run chain:bootstrap
CHAIN_OUTPUT=$E/07b-send.json CHAIN_HANDOVER=1 CHAIN_CONFIRM_HANDOVER=<vault> CHAIN_SEND=1 \
  CHAIN_KEYPAIR="$K/deployer.json" CHAIN_CONFIRM_PLAN=<digest> CHAIN_CU_PRICE="$CU_PRICE" \
  npm run chain:bootstrap
CHAIN_OUTPUT=$E/07c-inventory.json CHAIN_PHASE=handed-over npm run chain:inventory   # 0 blockers
```

S7 runs its own live `pre-handover` inventory first and refuses on any
blocker. It sets both upgrade authorities to the vault in one transaction
(loader SetAuthority, the vault does not sign). `CHAIN_HANDOVER_WHILE_PAUSED=1`
exists for an emergency only.

## 8. After handover

- **Verify PDA through Squads** (EXTERNAL #5): fund the vault with about
  0.01 SOL (it pays each PDA's rent through the verify program), then for
  each program (`solana-verify` 0.5.1, rehearsed 2026-09-24):
  ```sh
  solana-verify export-pda-tx https://github.com/Mancipatio/Mancipatio \
    --program-id <program id> --uploader <vault> --commit-hash <tag commit> \
    --library-name <asset_registry|transfer_hook> --mount-path program \
    --encoding base58 --url "$MAINNET_RPC" > "$E/08-export-pda-<program>.txt"
  # the base58 transaction is the last line of that file
  CHAIN_OUTPUT=$E/08-verify-pda.json CHAIN_SQUADS_OP=wrap-external \
    CHAIN_SQUADS_INPUT=<file with {"transactionBase58": "…"}> npm run chain:squads-export
  ```
  `export-pda-tx` answered at once in the rehearsal (no Docker build, no
  clone left behind) and adds a
  `SetComputeUnitPrice(100000)` unless `--compute-unit-price 0`; the export
  drops it (a no-op inside a vault transaction) and lists it in the
  preconditions. The real verify instruction (`initialize`) names only the
  PDA, the vault (signer, pays the rent), the program and System: no
  ProgramData, so the program itself never checks who the upgrade authority
  is. Whether OtterSec's service honours a PDA depends on its off-chain
  check of the uploader against the current upgrade authority: upload from
  the vault, after the handover.
  The export refuses any signer but the vault, any program but the verify
  program and System, a verify instruction that the vault does not sign or
  that names neither of our program IDs, and every System instruction except
  a transfer from the vault into the derived verify PDA
  (`["otter_verify", vault, program]` under the verify program), 0.05 SOL at
  most in total. Each verify instruction must carry that PDA, and its
  accounts are limited to the vault, the referenced program, its verify PDA,
  its ProgramData and System, so an extra account cannot turn into a transfer
  destination. The preconditions list each program, its PDA and each
  transfer: check them before approving. Import, approve, execute.
- Close leftover buffers (`chain:inventory` lists them under `buffer`).
- Drain the deployer to the treasury or cold storage.
- Other vault actions check their inputs against the role map:
  `registry-ix` targets (`add_admin` → `admins[]`, `propose_platform_admin` →
  the SA or the vault, `initialize_blocklist_authority` → the map BA,
  `set_protocol_treasury` → the vault or the map treasury) need `"confirmTarget": "<same key>"`
  next to `instruction`/`args` for any other key; `initialize_platform` takes
  only the map treasury and fee; pause masks are integers 0–255.
  `set-upgrade-authority` to a new key needs `"confirmNewAuthority"`, and
  `metadata-set-authority` needs it for a key other than `metadataAuthority`.
  The deployer and bufferWriter are always refused as targets.
- Talas 7 (public launch) may proceed.

## 9. Upgrade through Squads

Every `chain:*` command here runs in a **clean checkout of the new tag
`vX+1`** with `CHAIN_RELEASE_DIR` = its downloaded Release (`$R2`): on
mainnet the tools refuse unless `front/idl` equals that Release's IDL and the
source paths are clean (see "Safety rules").

1. Maintenance on:
   `MANCI_ALLOW_MAINNET=1 bash front/scripts/ops/maintenance.sh mainnet on "…"`,
   wait about 70 s.
2. The bufferWriter writes both buffers (hook first) from pre-generated buffer
   keypairs outside the repository (D7; `--silent`, so no seed phrase reaches
   a log), and hands them to the vault:
   ```sh
   for p in transfer_hook asset_registry; do
     solana-keygen new --no-bip39-passphrase --silent -o "$K/upgrade-buffer-$p.json"
     solana program write-buffer "$R2/$p.so" \
       --buffer "$K/upgrade-buffer-$p.json" --keypair "$K/bufferWriter.json" \
       --url "$MAINNET_RPC" --with-compute-unit-price "$CU_PRICE"
     solana program set-buffer-authority "$(solana-keygen pubkey "$K/upgrade-buffer-$p.json")" \
       --new-buffer-authority <vault> --keypair "$K/bufferWriter.json" --url "$MAINNET_RPC"
   done
   ```
   A failed write is resumed with the same `--buffer` keypair. The export
   reads at finalized: wait until the `set-buffer-authority` is finalized
   (about 15–30 s), or it refuses with "buffer authority is <bufferWriter>,
   not the vault".
3. If capacity is short, extend **directly, not through Squads** (EXTERNAL
   #2, closed by the rehearsal): a vault transaction runs its instructions
   as CPIs, and loader-v3 refuses ExtendProgram through CPI ("not supported
   by inner instructions"); ExtendProgramChecked, the only CPI-able form, is
   abandoned (feature `ExtendProgCheckedWi11BeDe1eted…`, inactive). The
   unchecked ExtendProgram needs no authority, so the bufferWriter pays:
   ```sh
   solana program extend <program id> <bytes> --keypair "$K/bufferWriter.json" \
     --url "$MAINNET_RPC" --with-compute-unit-price "$CU_PRICE"
   ```
   `<bytes>` is at least 10240 (SIMD-0431, active on mainnet and enforced
   on-chain) unless it reaches the maximum size. Anyone can extend any
   upgradeable program this way; it changes no authority and no code.
   `CHAIN_SQUADS_OP=extend-program` refuses and prints this command.
4. `CHAIN_SQUADS_OP=upgrade`, input
   `{"buffers": {"transferHook": "<buffer>", "assetRegistry": "<buffer>"}}`,
   `CHAIN_RELEASE_DIR` = the new Release. One vault transaction, hook before
   registry; split exports say "execute strictly in order" (EXTERNAL #1). Import
   into the Squads Transaction Builder, approve, execute.
5. `chain:inventory` against the new Release, once the execution is
   finalized (every `chain:*` read is at finalized; a check right after the
   execute still sees the old state).
6. IDL: `CHAIN_IDL_MODE=prepare-export` with the bufferWriter keypair (`send`
   then refuses: the UA is the vault), then `CHAIN_SQUADS_OP=idl-update` with
   `CHAIN_SQUADS_INPUT=<CHAIN_OUTPUT>.idl-export.json`. EXTERNAL #3 (closed):
   Program Metadata's `setData` copies a buffer whatever its authority (the
   rehearsal executed it from a buffer the bufferWriter still held), so the
   hand-over of the buffer to the vault is what freezes the reviewed bytes
   between approval and execution; `idl-update` refuses a buffer the vault
   does not hold, and its `close` needs the vault as buffer authority.
   `setData` also resizes the metadata account to the new length, so a
   shrinking update is already trimmed; the planned `trim` only returns the
   excess rent.
7. Refresh the verify PDA (step 8).
8. Maintenance off.

## 10. Rollback

- **Check out the previous tag `vX`** (clean) and use its Release as
  `CHAIN_RELEASE_DIR`: the mainnet release-source guard refuses a checkout
  whose `front/idl` differs from the Release, so a rollback runs that tag's
  CLI. Rehearsed in 6.1 (second run: `review/71a`–`71e`, export from the
  rc.1 checkout, executed through Squads, inventory 0 findings).
- Deploy the previous Release `.so` through the same Squads flow (step 9,
  with `$R2` = the previous Release).
- The SA normalizes pause bits first (it may clear undefined bits).
- State-layout changes are not rollback-safe: fix forward.
- IDL: `CHAIN_IDL_MODE=prepare-export` with `CHAIN_IDL_SOURCE=release` from
  that same checkout, then `idl-update` (step 9.6). The pre-snapshot
  (`CHAIN_SNAPSHOT_DIR/<program>-idl-pre.json`) is evidence only; no tool
  path uploads it.
- Front: Vercel Instant Rollback.

## 11. Incidents

### Ground rules

- **First 15 minutes**, in this order: (1) is value moving right now? (2) if
  a platform flow is being abused, **pause** (`chain:emergency` below, or
  PauseFlagsPanel on `/admin/platform`); (3) if our front or database is the
  problem and still ours, **maintenance on**
  (`MANCI_ALLOW_MAINNET=1 bash front/scripts/ops/maintenance.sh mainnet on "…"`);
  (4) open the incident record (who noticed what, when); (5) tell people
  (below). Pausing stops platform entry flows only: exits, claims and
  wallet-to-wallet transfers keep working (the hook never reads the pause).
- **Contacts** live in the private on-call sheet `~/mancipatio-mainnet/on-call.md`
  (never in this public repository), filled before D0: incident lead and
  deputy, the company-wallet holder and deputy, every Squads member, the
  lawyer, the data-protection contact, the Securities Commission contact,
  and the support channels of the registrar, Vercel, Supabase, Helius and
  the SMTP provider. It also holds the user-notice and regulator-notice
  templates and the break-glass successor address (below).
- **Seed backups** (uloge-runbook-7): every Ledger that holds a role (the
  company wallet, separate role keys, each Squads member) has its recovery
  phrase on metal in two places, with named custodians; the company wallet's
  phrase is under dual control. A lost key without a backup is permanent for
  the SA and the BA (below).
- **Break-glass successor**: a second Ledger of the legal entity, its
  address in the on-call sheet. Before it is sealed (before D8) it is
  **onboarded on the mainnet operator front**: connected, signed in (SIWS),
  the Terms accepted, the primary wallet of its own account, funded with
  about 0.05 SOL. An accept needs exactly that, and there is no time for it
  in an incident. When a role key is at risk but still signs, the rotations
  below go to it within minutes (`npm run chain:handover` with it as the
  target prints the steps).
- **Rotations need the operator front.** Proposing and accepting the SA, the
  BA and the KYC authority happens only on `/account/roles`,
  `/admin/platform` and `/admin/kyc`, which need SIWS, so the front (Vercel,
  or the local `next dev` of §0) and the mainnet Supabase must work.
  `chain:emergency` pauses, blocks and switches hook modes without them, but
  it cannot rotate a role (follow-up: add propose/accept of the SA, BA and
  KYC authority to `chain:emergency`, same digest and Ledger path). If a role
  key is compromised while the front or the database is down, the rotation
  waits for them; meanwhile the attacker can propose and accept the role to
  itself, after which only the upgrade path below remains.
- **Who may pause**: any Admin; only the super admin clears. The program has
  **no pause-only role**: an Admin record carries every Admin power
  (`set_pause_flags` set, `approve_sale`, `revoke_sale_approval`,
  `clawback_from_holder`, `clawback_blocklisted_holder`,
  `create_distribution` / `distribute_batch`, opening, triggering,
  realizing and returning custody vaults, `create_otc_deal` /
  `cancel_otc_deal`, `create_rights_issuance`, `route_yield`, and more),
  each alone, without a second signature. With the company wallet model
  keep one more Admin record so a lost company wallet does not also remove
  the pause, but give it only to a fully trusted person of the legal entity
  and watch it with the authority alarms (§15). A pause-only role is a
  program item for package 8.3.
- Exercise these scenarios as a timed tabletop on devnet (6.5) and record it
  under `docs/mainnet-readiness/`.

### `chain:emergency` (out of band: no front, no database)

For a pause, an unpause, the blocklist and the hook mode when the front, the
database or SIWS is down, maintenance is on, or the front is the incident
(uloge-runbook-6, ops-qa-8, prog-vlast-8). It reads the signer's role at
finalized, simulates, prints a digest, and sends only with that digest:

```sh
cd front
export CHAIN_NETWORK=mainnet CHAIN_ALLOW_MAINNET=1 CHAIN_RPC_URL="$MAINNET_RPC" CHAIN_CU_PRICE=200000
# dry run: role check, IDL check, simulation, digest
CHAIN_OUTPUT=$E/inc-1-plan.json CHAIN_EMERGENCY_OP=pause CHAIN_EMERGENCY_SIGNER=<Admin or SA> \
  CHAIN_PAUSE_BITS=all npm run chain:emergency
# send with the Ledger (approve on the device; compare the message hash it shows)
CHAIN_OUTPUT=$E/inc-1-send.json CHAIN_EMERGENCY_OP=pause CHAIN_EMERGENCY_SIGNER=<same key> \
  CHAIN_PAUSE_BITS=all CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest> \
  CHAIN_SIGNER='usb://ledger?key=0' npm run chain:emergency
```

| `CHAIN_EMERGENCY_OP` | Inputs | Signer (checked on-chain) | Notes |
|---|---|---|---|
| `pause` | `CHAIN_PAUSE_BITS`: `all`, or names from `onboarding`, `primary`, `secondary`, `custody-entry`, `distributions`, `issuer-proceeds`, or an integer | any Admin or the SA | nothing to do when every bit is already set |
| `unpause` | `CHAIN_PAUSE_BITS` (`all` also clears undefined bits) | the SA only | the program refuses anyone else |
| `block`, `unblock` | `CHAIN_WALLET` | the BA | an off-curve wallet (an escrow PDA) needs `CHAIN_CONFIRM_WALLET=<same>`: blocking it stops exits from it |
| `hook-mode` | `CHAIN_MINT`, `CHAIN_HOOK_MODE=open` or `kyc-gated`, `CHAIN_KYC_REGISTRY` (kyc-gated only, a live registry) | the BA | Open lets any wallet receive the class; KycGated only live passports of that registry |

- **Setup, once per operator machine (before D8)**: the Solana CLI cannot
  sign an arbitrary program instruction with a Ledger, so the tool drives the
  Ledger Solana app through Ledger's Node packages. They are deliberately not
  app dependencies (no native module in CI or Vercel) and never go into
  `front/node_modules`. `front/scripts/chain/ledger/` pins them: exact
  versions in `package.json` (`@ledgerhq/hw-app-solana` 7.11.0,
  `@ledgerhq/hw-transport-node-hid-noevents` 6.36.0, `node-hid` 3.4.0
  through `overrides`) and the integrity of every tarball in
  `package-lock.json`, both under the mainnet source guard. Install them
  there, from the checkout of the Release tag:
  `cd front/scripts/chain/ledger && npm ci --ignore-scripts`.
  `--ignore-scripts` runs no install-time code on the machine that holds the
  role keys (node-hid 3 ships its prebuilt binaries inside the checked
  tarball). The install lands in a git-ignored `node_modules` there, and the
  tool refuses an install whose versions differ from the lock. Raising a
  version is a reviewed commit that regenerates that lock (`npm install
  --package-lock-only --ignore-scripts` in that directory). In the Solana app,
  enable **Blind signing** (our programs are not in its parser).
  `CHAIN_KEYPAIR=<file>` signs instead when the role key is a file.
- **Compare the hash before approving (mandatory).** With blind signing the
  device shows only the message hash. A second person reads the hash the
  tool prints aloud; the operator checks it against the device, at least the
  first 8 and the last 8 characters, and approves only when they match. A
  mismatch means something between the tool and the device changed the
  message: reject on the device, stop, and treat the operator machine as
  compromised.
- **Rehearse on devnet with the physical Ledger** before D8 (owner): a pause
  and an unpause by the SA, a block and an unblock by the BA.
- The send writes the same evidence and journal and takes the same network
  lock as the other tools: a lock left by another run blocks it until
  `CHAIN_RECOVER=1` resolves that lock.
- On mainnet the guarded source (`front/idl`, `front/lib`,
  `front/scripts/chain`, `front/package.json` and its lock) must be clean, as
  for every other sending tool: `front/lib` builds the instruction and
  `front/scripts/chain` signs it. Run from a clean checkout of the live
  Release tag; `CHAIN_EMERGENCY_DIRTY_OK=1` overrides it, and the dirty paths
  are recorded in the evidence (`sourceDirtyOverride`).
- On mainnet the live canonical IDL must define the instruction exactly as
  `front/idl` does; run from the checkout of the live Release tag, or set
  `CHAIN_EMERGENCY_IDL_UNCHECKED=1` (recorded in the evidence; the simulation
  and the finalized post-check still guard the result).
- It cannot stop wallet-to-wallet transfers (the hook does not read the
  pause), cannot undo anything, and changes no role.

### Scenarios

Each scenario: what it means, the first steps (who, with what), the
recovery, and what cannot be done. "Rotate" means propose from the current
key and accept from the new one on `/account/roles` (`chain:handover` prints
the ordered steps).

**Company wallet compromised** (it holds SA, Admin, KYC, BA and the
treasury, §19). The attacker can clear every pause, add Admins, set the
treasury, decide KYB, issue and revoke passports, block and unblock any
wallet (escrows too), switch or re-point hook modes, claw back blocked or
revoked holders, and propose every role to itself.
- First: while the key still signs for us, rotate SA, BA and KYC to the
  break-glass successor and accept at once (a proposal of the attacker
  overwrites ours, so accept before it can). This runs on the operator front
  (SIWS, Supabase, Vercel or the local `next dev`) with the successor
  already onboarded (ground rules); if the front or the database is down it
  cannot run. Maintenance on only after the accepts (maintenance refuses the
  front's wallet transactions, the rotations too); pause with
  `chain:emergency` (the attacker can clear it: it only slows automated
  abuse); tell the Squads members to prepare an emergency upgrade; notify
  (below).
- Recovery: set the treasury back; remove the Admin records the attacker
  added; revoke passports issued since the compromise (the index shows when);
  unblock wallets it blocked and restore clawed-back units through the
  issuer. If the attacker already holds the SA or the BA, the only way back
  is a program upgrade through Squads (the upgrade authority) with a
  recovery instruction: written, reviewed and executed under pressure, which
  takes days. Package 8.3 adds that recovery (upgrade authority, 7-day wait,
  the current holder can cancel); once it is deployed, start it at once.
- Cannot: undo executed transactions; stop wallet-to-wallet transfers;
  recover the SA or the BA without the upgrade authority; rotate anything
  while the front or the database is down (`chain:emergency` has no
  rotation yet).

**Company wallet lost** (not compromised). Nothing moves, but nobody can
clear the pause, grant or remove Admins, decide KYB, issue passports, block
or unblock, switch hook modes or set the treasury. A second Admin record
(ground rules), if the role map kept one, can still pause.
- First: restore it from the seed backup onto a new Ledger (the same key);
  pause if the platform must stop meanwhile.
- Recovery without a backup: the upgrade path above for the SA and the BA;
  for KYC the "KYC key lost" steps below, which also need the BA.
- Cannot: anything the SA or the BA signs, until the key is restored or the
  upgrade lands; pause at all, if no other Admin record exists.

**Super admin key compromised** (separate keys). The attacker clears pauses,
adds Admins, sets the treasury, decides KYB, stages issuer recoveries and
custody proposals. BA and KYC are unaffected.
- First: rotate the SA to the successor if it still signs; other Admins keep
  pausing (the attacker can clear it); maintenance on.
- Recovery: remove the attacker's Admins, set the treasury back, cancel its
  issuer recoveries (the issuer can cancel too) and custody proposals.
  Lost or taken over: the upgrade path above.
- Cannot: recover a lost or taken-over SA on-chain (only the upgrade path);
  undo KYB decisions or treasury payouts that already landed.

**An Admin key compromised or lost.**
- First: the SA runs `remove_admin` on `/admin/admins` (with the SA in the
  Squads vault: `chain:squads-export` `registry-ix remove_admin`); any other
  Admin pauses if needed.
- Recovery: its sale approvals stay valid after the removal (known limit of
  2B): revoke each one on `/admin/applications` (`revoke_sale_approval`);
  move its live custody vaults (`propose_custody_authority` by the SA, accept
  by another Admin, `/admin/custody`); cancel OTC deals it opened that should
  not settle (`/admin/otc`, any Admin). Its rights issuances cannot move
  (K19): milestones need its Admin record.
- Cannot: re-assign a rights issuance.

**Blocklist authority compromised.** The attacker can block escrow PDAs
(refunds and returns stop), switch KycGated classes to Open, re-point
registries, unblock sanctioned wallets.
- First: rotate the BA if it still signs (operator front); then undo with
  `chain:emergency` (`unblock`, `hook-mode`) signed by the new BA.
- Lost or taken over: the upgrade path above (8.3 adds the timelocked
  recovery).
- Cannot: recover the BA on-chain (only the proposing BA can name a
  successor); stop its blocks or hook-mode switches with the pause (the hook
  never reads it); reverse transfers that happened while a class was Open.

**KYC key compromised or lost.** Compromised: it issues passports (anyone can
receive KycGated units) or revokes them (receivers are refused). Rotate it if
it still signs (propose on `/admin/kyc`, accept on `/account/roles`), then
revoke every passport it issued since the compromise.
Lost: create a new registry from a key that never created one, re-point every
KycGated mint with `update_transfer_hook_config` (the BA; `chain:emergency
hook-mode kyc-gated` with `CHAIN_KYC_REGISTRY=<new>`), move the
`NEXT_PUBLIC_KYC_REGISTRY` pin (a redeploy), re-issue the passports.
- Cannot: get the old registry's authority back (only its holder proposes a
  successor); carry passports over to a new registry (they are re-issued,
  person by person); undo transfers to receivers the compromised key
  admitted.

**Issuer key lost.** The SA stages an issuer recovery (`/admin/issuers`,
7-day wait); pause `issuer-proceeds` meanwhile; revoke its unused sale
approvals (`/admin/applications`). Nobody but the SA can cancel it, since
the lost key does not sign.
- Cannot: shorten the 7 days.

**Issuer key compromised** (it still signs, for someone else). The recovery
is not a remedy: the current issuer key may cancel it
(`cancel_issuer_recovery` accepts the issuer authority or the SA), and a
rotation it proposes and accepts to itself retires it; it would do so after
every new attempt.
- First: if the issuer still controls the key too, it rotates at once to a
  fresh key (`/issuer/rotation`, accepted on `/account/roles`). Otherwise the
  BA blocks the issuer wallet (`chain:emergency` `block`: it can no longer
  send share units), an Admin pauses `issuer-proceeds`, the Admins revoke
  its sale approvals (`/admin/applications`, `revoke_sale_approval`), and
  the issuer is told.
- Recovery: an issuer recovery only works once the attacker stops
  cancelling; otherwise only a program upgrade through Squads, or winding
  the issuer's classes down (`ops/wind-down-plan.md`).
- Cannot: recover the issuer against a compromised key that still signs;
  undo payouts or transfers it already made.

**Squads member lost or compromised.** Below the threshold a member alone
cannot act. Replace it with a config transaction while the threshold is
reachable, update the role map and run `chain:inventory` (finding `squads`
absent). Cancel any Approved proposal it pushed (`squads-proposal`).
- Cannot: upgrade the programs once the threshold is no longer reachable
  (the platform keeps working, but the SA/BA upgrade path is gone too); this
  is why no single person may hold two member keys.

**Deployer or bufferWriter leaked.** After the handover they hold nothing:
confirm with `chain:inventory` (`deployer-role`, `bufferwriter-role`
absent), drain them, close their leftover buffers.

Before the handover (steps 2 to 7) the deployer is the upgrade authority,
so a leak is catastrophic: keep that window short.
- First: pause (`chain:emergency`, any Admin or the SA); if both programs are
  deployed and the pre-handover inventory allows it, run S7 at once
  (`CHAIN_HANDOVER=1`, §7), so both upgrade authorities move to the vault
  before the attacker uses the key. If the attacker already changed an
  upgrade authority or the code: abandon those program IDs, deploy a new
  Release under new program IDs (new keypairs, role map, registry and pins),
  and tell anyone who saw the old addresses.
- Cannot: take an upgrade authority back once the attacker holds it; trust
  code the attacker could have written.

**Vercel down or a bad deploy.** Chain state is safe. A bad deploy: Vercel
Instant Rollback. An outage: operators use the local operator front
(`next dev`, §0) or `chain:emergency`; post a status notice.
- Cannot: serve users (the public site is Vercel); run the retry worker or
  the alarm checks, which pg_cron calls on Vercel (they catch up after).

**Supabase down.** SIWS, sessions, every admin route, the KYC queue and the
alarms (they run on Vercel but read the database) stop; the chain continues.
Pause with `chain:emergency` if an exploit is suspected. After it returns:
check the alarm heartbeat and reconcile the index (`/admin/health` →
Reconcile); after data loss, restore from PITR (§14 Backups).
- Cannot: sign in, review KYC/KYB or rotate a role on the front (they all
  need the database); only `chain:emergency` works.

**RPC provider (Helius) down.** Switch `HELIUS_MAINNET_RPC` to the backup
provider (`SOLANA_MAINNET_RPC`) and redeploy; missed webhook deliveries are
re-queued by the gap scan within about 20 minutes and a full reconcile covers
the rest; meanwhile the heartbeat marks the mirror stale and the site reads
the chain.
- Cannot: receive webhooks until the provider is back (the gap scan and the
  reconcile fill the mirror afterwards).

**SMTP down.** Alarm emails fail and `/api/health/alarms` turns 503 (a failed
notification). Use the second channel once it exists (8.4 webhook); after
the fix re-queue the failed notifications (§15 Operations).
- Cannot: deliver any alarm until then (there is no second channel yet):
  watch `/admin/health` by hand.

**Personal data breach.** Contain (rotate the Supabase `sb_secret_` key and
`SESSION_SECRET`, revoke exposed tokens, close the leaking path), keep the
evidence, assess what data about how many people, then notify the
supervisory authority **within 72 hours** of becoming aware (Serbia: the
Commissioner for Information of Public Importance and Personal Data
Protection, Art. 52 ZZPL; for EU residents the authority the lawyer names),
tell the affected people without undue delay when the risk to them is high,
and record it in the breach register. Who: the data-protection contact with
the lawyer; templates in the on-call sheet.
- Cannot: recall data that left; stop the 72-hour clock while the
  investigation runs (notify in phases); erase what is on the chain (wallet
  addresses and transactions are public for good).

**DNS, registrar, Vercel or GitHub taken over (a drainer front).** A fake
page on our domain asks users to sign transfers. Maintenance does not help
(that page does not read our flag) and the pause only stops platform flows.
- First: pause (`chain:emergency`); warn users on every channel not to sign
  anything on manci.io until the all-clear; registrar: restore the records,
  change the password, 2FA, registry lock; Vercel and GitHub: revoke
  sessions, tokens and unknown members or deploy hooks, redeploy from a
  verified commit, check the env for tampering; rotate every secret the
  attacker could read (the Supabase key, `SESSION_SECRET`,
  `RETRY_WORKER_SECRET`, `HEALTH_TOKEN`, SMTP, the bypass secret).
- Then: the BA blocks the wallets receiving stolen units (the blocklist is
  sender-side, so they cannot move them on) and an Admin claws them back.
- Prevention (kritičar-6): DNSSEC and a CAA record on the apex, registrar 2FA
  and registry lock, an external monitor on the DNS records, branch
  protection on `main` (Vercel deploys it), a CSP (8.4).
- Cannot: reverse transfers users signed; stop transfers of wallets that are
  not blocked.

**Other.**
- Wrong pending proposal: platform and BA proposals cannot be cancelled,
  propose again to overwrite; a KYC proposal can be cancelled.
- Crash during a send: see below.

**Tell people.** Users: a banner (maintenance message) and email, what is
affected and what they should not do. The Securities Commission and the
lawyer: per the licence conditions. Squads members: for anything that may
need an upgrade.

### Crash recovery

A leftover lock blocks every send run on that network. Run the same tool with
`CHAIN_RECOVER=1` (and a new `CHAIN_OUTPUT`): it reads the journal the lock
points at, resolves every in-flight signature (finalized, failed, or dropped
after expiry) without sending anything, appends the outcomes and removes the
lock. A signature that landed but did not finalize keeps the lock; run
recovery again later. Recovery refuses while the process named in the lock is
still alive (a run between two steps has nothing unresolved, but still holds
the lock), and it only ever removes the lock it resolved. Then start a new dry
run: steps that landed are skipped.

An interrupted IDL update can resume its buffer with
`CHAIN_IDL_RESUME_BUFFER=<address>` (the journal records it before the buffer
is created); only chunks that differ are rewritten. If it stopped after
`setData`, the IDL already reads `in-sync`: the next `send` dry run plans the
missing `trim` (a shrinking update), and with `CHAIN_IDL_RESUME_BUFFER` set to
the journalled buffer it also closes that buffer. After handover,
`prepare-export` on such an IDL writes a trim-only spec for `idl-update`.

**Stopping a run.** Ctrl-C in the terminal also stops the vitest main
process, which can take the worker (the tool) down before it has drained its
in-flight signature and written the evidence; the lock and journal keep that
safe, but `CHAIN_RECOVER` is then needed. To stop gracefully, send SIGTERM to
the tool only: `kill -TERM <pid>` with the `pid` from the lock file
(`~/.mancipatio/chain/<network>-*.lock`). The tool stops sending, polls the
in-flight signature to a resolution and writes the evidence.

## 12. 6.1 rehearsal

- **Validator and features** (EXTERNAL #6): use the Agave release most of
  mainnet's stake runs (`solana feature status -um` lists software versions;
  4.3.0 on 2026-09-24). An older CLI does not know newer feature IDs, so read
  the feature list with that release too. Unpack its tarball outside the
  repository and run its binaries by path; the installed toolchain stays
  untouched. `solana-test-validator --clone-feature-set --url mainnet-beta`
  copies mainnet's activations into genesis (0 differences in the
  rehearsal), but not the rent sysvar (see §1).
- **Programs**: `--upgradeable-program <id> <Release .so> <throwaway
  deployer pubkey>` for both programs (the program keypairs are never
  needed), `--clone-upgradeable-program` for
  `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`,
  `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` and
  `verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC`, and `--clone` of the
  Squads program config (`BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`) and
  its treasury. Genesis programs have exactly the `.so` size: the deployer
  extends them to `programDataMaxLen` (`solana program extend`) before the
  first inventory. Pass `--mint <throwaway pubkey>`, `--bind-address
  127.0.0.1` and a scratch `solana -C <config>` everywhere, so no operator
  key or config is read.
- **Flow** (`CHAIN_NETWORK=localnet`, `CHAIN_GENESIS_HASH=$(solana genesis-hash)`):
  1. Create the multisig with the Squads CLI; dump its account and replace
     `front/tests/fixtures/squads-multisig-v4.json` (EXTERNAL #4).
  2. `chain:idl` send.
  3. `chain:bootstrap` cycles with `CHAIN_REHEARSAL_SIGNERS` for X1/X2/X3/S6.
  4. Inventory `pre-handover`, then S7.
  5. `chain:squads-export` `upgrade`, `idl-update` and `wrap-external`, each
     executed through Squads (EXTERNAL #1, #3, #5); the direct extend of §9.3
     (EXTERNAL #2).
  6. `CHAIN_RECOVER` drill: kill the process in the middle of an IDL send;
     also Ctrl-C once and `kill -TERM <lock pid>` once, and check that the
     evidence file exists after each.
  7. Rollback drill (section 10) from the previous tag's checkout.
  8. Operator-front drill on localnet with a Ledger.
- Resolve every EXTERNAL item below.

### Rehearsal record (2026-09-24, localnet only)

Agave 4.3.0 validator with mainnet's feature set, Release v0.0.0-rc.1 at the
real program IDs, cloned Squads v4 / Program Metadata / verify programs, a
real Squads multisig (threshold 2, members 2 × all + 1 × vote, vault index
0), throwaway keys. Evidence: `docs/mainnet-readiness/rehearsal-6.1/` (not
tracked).

- §3 IDL init by the deployer, §4 cycle 1 (S1–S5), §5 X3/X2/X1/S6 through
  `CHAIN_REHEARSAL_SIGNERS`, §6 pre-handover inventory 0 blockers, §7 S7,
  handed-over inventory 0 findings.
- §9 upgrade of both programs in one vault transaction (hook first) to
  another verifiable build, and the §10 rollback to rc.1 the same way;
  `idl-update` both ways (a growing update, then a shrinking one with
  `trim`); after the rollback, `chain:inventory` against rc.1 has 0
  findings.
- §8 verify PDAs for both programs uploaded by the vault through Squads.
- Drills: SIGTERM to the lock pid mid-send (evidence `aborted`, in-flight
  write drained, lock released), SIGKILL (no evidence, lock kept, a second
  send refused, `CHAIN_RECOVER` finalized the in-flight write and removed
  the lock), resume of the journalled IDL buffer (only missing chunks
  written). An external interrupt during cycle 1 left S5 drained and
  finalized; the next dry run skipped every landed step.
- Second run (review, 2026-09-24 12:32–12:59): the rollback from the
  previous tag's checkout (`review/71a`–`71e`: buffers from rc.1, the export
  made by the rc.1 checkout's CLI, executed through Squads, then inventory
  from that checkout and from the current CLI, 0 findings).
- Not rehearsed: the Squads web app (Transaction Builder import), a Ledger
  on the operator front, `chain:emergency` with a physical Ledger (the
  Ledger path is tested against a stand-in device only), and a
  `chain:handover` executed end to end (plan the devnet handover, §19).

## 13. App priority fee and payment tokens (Talas 4.2)

Configuration and checks only; the front enforces the rules
(`front/lib/priority-fee.ts`, `front/lib/payment-mints.ts`).

- **Priority fee.** Wallet sends and the co-signed envelopes (issuer recovery
  v2, KYC registry creation) get their price from `/api/priority-fee`,
  clamped per network (mainnet floor 100,000, cap 2,000,000 µL/CU; devnet
  1,000..100,000). The route asks the server RPC (`HELIUS_MAINNET_RPC` or
  `SOLANA_MAINNET_RPC`) for `getPriorityFeeEstimate`; an RPC that does not
  support that method answers the floor (`source: "floor"`). Helius is not
  required. After a deploy: `curl https://<origin>/api/priority-fee` and
  record `source` and `microLamports` (G8). Hotfix if it misbehaves: set the
  network's policy to `mode: "fixed"` at its floor.
- **Issuer recovery documents** are version 2 (compute budget included); a v1
  document is refused: prepare a new one.
- **Mainnet payment tokens.** Only `MAINNET_PAYMENT_MINTS` (USDC, kind
  `rate`) may enter. EURC (`eur_peg`) is added in code later, with its
  address verified from Circle (D6). Where the rule is enforced:
  - **Server (signed routes, authoritative):** FX rates
    (`/api/admin-config/fx-rates`), sale-approval reservations
    (`/api/sale-approvals/reserve`), OTC requests (`/api/otc/create`),
    payouts and payout schedules (`/api/payouts/create`,
    `/api/payout-schedules/upsert`) and new push-distribution plans
    (`/api/distribution-plans/prepare`).
  - **Browser only (before the wallet signs):** Buy, `create_offer`, the
    resell board, OTC contract/take/deposit, the payout airdrop, yield
    routing and push-distribution funding. `open_sale` uses the mint of an
    approval the reserve route already checked.
  - **Not enforced by the program:** a transaction built outside the app
    (for example an admin calling `approve_sale` directly) can name any
    mint. For sale approvals and sales the sale-capacity alarm below
    catches it; exits (cancel, refund, reclaim, claim, expire, payout
    release) are never blocked by the rule.
- **USDC EUR rate** (D18): seed it on `/admin/limits` (Super Admin) as kind
  `rate` with a maximum age of at most 7 days, and refresh it weekly.
  `/api/health` fails (503, uptime alarm) when the row is missing or older
  than its maximum age and warns from 80 % of it. Set the mainnet
  `platform_raise_limits` cap with at least 3 % FX headroom.
- **Unknown payment mints on chain.** An approval or sale the ledger cannot
  count (no EUR rate) or whose mint is not allowlisted raises a
  `compliance_alerts` row (source `sale-capacity`, severity high, no subject
  wallet; the approver is in the evidence) from every adoption path: the
  orphan scans, the worker and the confirm step. One unresolved alert per
  approval and reason. Resolve it by revoking the approval or adding the
  rate; an orphan that keeps failing is retried each minute (at most a few
  failures per run).

## 14. Database projects and ops targets (Talas 4.3)

Each Supabase project serves exactly one network. Migration 0070 records it
(`mancipatio_ops.deployment_identity`, read through
`public.deployment_network()`), and 0071 makes every `network` default follow
it and installs `manci_network_guard`: a mainnet project accepts only
`'mainnet'` rows, any other project never accepts `'mainnet'`.

### Targets and tools

`front/scripts/ops/targets.json` (tracked) names each project: network,
`projectRef`, `poolerHost`, `poolerPort` (5432, the session pooler),
`siteOrigin` and `backupAgeRecipient`. Mainnet stays `null` until Talas 7;
`SUPABASE_PROJECT_REFS` in `front/next.config.ts` must match it (a test
checks).

| Variable | Rule |
|---|---|
| `MANCI_TARGET` | Required by `scripts/db.sh`, no default. `maintenance.sh`, `backup.sh` and `supabase.sh` take the target as an argument and refuse a different `MANCI_TARGET`. |
| `MANCI_ALLOW_MAINNET=1` | Required for any target whose network is mainnet. |
| `MANCI_DB_BOOTSTRAP=1` | Per command, only while the project has no identity row (0001–0070 and `deployment-identity.sql`). Refused once the row exists. |
| `MANCI_PGPASSFILE` | Default `~/.mancipatio/pgpass`, mode 600: `<poolerHost>:5432:postgres:postgres.<ref>:<password>`, with `:` and `\` in the password escaped as `\:` and `\\` (see "Credential files"). Devnet may fall back to `.env.local` `SUPABASE_DB_URL` until Talas 7; mainnet never reads `.env*`. |
| `MANCI_PG_BIN` | `backup.sh`'s PostgreSQL client, default `/opt/homebrew/opt/postgresql@17/bin`; at least the server's major version. |

`db.sh` runs `scripts/ops/assert-target.sql` first in the same psql session:
unless the identity row matches the target (network and ref), psql stops
before any of your SQL. Files that read the target (`retry-scheduler.sql`,
`deployment-identity.sql`) must run via `-f`.

Every command below runs from `front/`.

### Credential files

Never put a password or key in a command line: the shell saves it to its
history file (zsh does by default). Create each file empty and mode 600
first, then add the secret from a silent prompt or an editor. `umask 077`
alone is not enough, because `>` keeps the mode of a file that already
exists.

```
install -d -m 700 ~/.mancipatio
install -m 600 /dev/null ~/.mancipatio/pgpass          # replaces any old file, mode 600
printf 'DB password: '; IFS= read -rs PW; echo
printf '%s:5432:postgres:postgres.%s:%s\n' aws-0-eu-west-1.pooler.supabase.com gvnckuzmuwozlcohtuhx \
  "$(printf '%s' "$PW" | sed 's/[\\:]/\\&/g')" >> ~/.mancipatio/pgpass
unset PW
```

The `sed` escapes `:` and `\` in the password as `\:` and `\\`, which
pgpass requires. If they are not escaped, the line silently fails to match,
and because the tools always pass `-w`, psql then reports only
`fe_sendauth: no password supplied`. The same applies if you edit the file by
hand (`${EDITOR:-vi} ~/.mancipatio/pgpass` after the `install` line). One line
per project; a mainnet line uses that target's `poolerHost` and `projectRef`.
The `install` line replaces an existing file: to add a second project, skip
it and only append (the file must still be mode 600; `db.sh` refuses
anything else).

Edge function secrets (`supabase.sh … secrets set --env-file`) work the same
way:

```
install -m 600 /dev/null ~/.mancipatio/devnet-edge.env
printf 'sb_secret key: '; IFS= read -rs KEY; echo
printf 'MANCI_SUPABASE_SECRET_KEY=%s\n' "$KEY" >> ~/.mancipatio/devnet-edge.env
unset KEY
```

For a bearer token (`HEALTH_TOKEN`), read it the same way into a variable
and pass `"$HEALTH_TOKEN"`; never paste the value into the command.

### Rules for migrations after 0071

1. A new `network` column uses `default public.deployment_network()` or no
   default, never a literal.
2. A migration that adds a `network` column ends with
   `select mancipatio_ops.install_network_guards();`.
3. Never seed rows with a literal network; use `public.deployment_network()`.

`tests/migration-chain.postgres.test.ts` enforces all three, including a full
chain run under a mainnet identity.

Before every migration: `bash scripts/ops/backup.sh <target> pre-<migration>`.

### Backups (D14, D17)

- Devnet: `backup.sh devnet <label>` writes a full and a schema-only dump
  (plaintext, 0600, test data) under `~/Backups/mancipatio/devnet/`.
- Mainnet: Supabase PITR is the primary restore point. `backup.sh mainnet
  <label>` is schema-only; `--data` pipes the dump through
  `age -r <backupAgeRecipient>` (G10: `age` installed, offline recipient key
  created and stored), so no plaintext reaches the disk. `--prune` removes
  this target's dumps older than 30 days.
- `pg_dump` does not copy Storage object bodies (D17, owner's choice: rclone
  export to encrypted storage, or Supabase's own durability).
- Restore drill (Talas 6.5): restore into a scratch project with its own
  `restore-drill` target (network mainnet, own ref, null origin);
  `pg_restore -l`, delete the `TABLE DATA mancipatio_ops deployment_identity`
  line, `pg_restore -L`; insert the drill identity with
  `deployment-identity.sql` (bootstrap); re-apply erasures (`anonymize_client`
  for every client whose `anonymized_at` in the live database is newer than
  the dump).

### Rollback of 0071

1. `backup.sh <target> pre-rollback-0071`.
2. `MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/rollback-0071.sql`
   (drops the guard; defaults stay dynamic and correct).
3. Only if `deployment_network()` itself fails as a default:
   `scripts/ops/rollback-0071-defaults.sql` (pins each default to the
   project's own network). 0070 stays; re-applying 0071 restores both.

### Edge function and Supabase CLI

`scripts/ops/supabase.sh <target> …` allows only `functions deploy
helius-webhook [--use-api]`, `secrets list`, `secrets set --env-file <file>`
(mode 600) and `secrets unset NAME…`, and appends `--project-ref` from the
target. Delete `front/supabase/.temp/` before the first use; the wrapper
refuses while a linked project is recorded there. A plain deploy bundles the
function in Docker; without a running Docker, add `--use-api` (Supabase
bundles it server-side; the project still comes from the target).

Before every deploy, `npm run check:edge` type-checks the function with Deno
against its import map (`deno.json`; Front CI runs the same step). It proves
the imports resolve and the code types; only a deploy proves the bundle (G4).

Rollback of the function: redeploy the code of the last commit before the
change, with the current wrapper (older commits may not have it), then
restore the working tree:

```
git checkout <previous commit> -- supabase/functions
bash scripts/ops/supabase.sh <target> functions deploy helius-webhook   # add --use-api without Docker
git checkout HEAD -- supabase/functions
git status --short supabase/functions                                   # expect no output
```

For the Talas 4.3 change, `<previous commit>` is the first parent of PR-B's
merge commit (`git rev-parse <merge commit>^1`; `e5c4d1a` if main has not
moved). That code reads the key Supabase injects
(`SUPABASE_SERVICE_ROLE_KEY`), so it needs no secret change while the
project's legacy API keys are still enabled.

Per project: `MANCI_SUPABASE_SECRET_KEY` (the project's `sb_secret_` key; no
legacy fallback), `HELIUS_WEBHOOK_SECRET`, `INDEXER_NETWORK`, and its own
Helius webhook URL. Set the secrets first, then deploy. A wrong
`INDEXER_NETWORK` is refused by the guard (503; Helius retries). G9: record
Helius's retry window; a delivery lost past it is recovered only by the
index reconcile (account state, not events).

### Retry scheduler

`MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/retry-scheduler.sql`
needs the target's `siteOrigin` and the Vault secret
`mancipatio_retry_worker_<network>`. It installs `mancipatio-retry-<network>`
DISABLED (G6: record the active state first, re-enable with
`cron.alter_job` if it was active). The install rolls back unless `cron.job`
ends with exactly one disabled job of that name running
`mancipatio_ops.invoke_retry_worker()` and no job still calling the dropped
`invoke_retry_worker_devnet()`; its last output is that job's row. That, and
the status SQL showing the same single job and the target's origin, are the
pass/fail gate before re-enabling. Mainnet's scheduler waits until the
mainnet front answers at its origin, which happens only after devnet moves to
`devnet.manci.io` (D15, §18). Until Talas 7 that front is behind Vercel
Deployment Protection (§0A): store the project's *Protection Bypass for
Automation* secret in the Vault as `mancipatio_vercel_bypass_<network>` and
both schedulers send it as `x-vercel-protection-bypass` (the install refuses
a malformed one; delete the secret after go-live).

### Devnet rollout of Talas 4.3 (PR-B)

The database steps run from the PR-B branch before the merge; the deployed
front and edge function keep working throughout, because 0070/0071 change
no behaviour for correct devnet rows and the old function keeps its key
until it is redeployed.

**A. Before the merge (owner, no writes).**

1. Vercel, devnet project, Settings → Environment Variables, **Production**
   scope: `NEXT_PUBLIC_SUPABASE_URL` must be exactly
   `https://gvnckuzmuwozlcohtuhx.supabase.co` (a trailing slash is fine).
   The production build now refuses any other devnet URL, and the PR's
   preview build proves only the Preview-scoped value. A failed production
   build leaves the previous deployment serving, so step C could not tell.
2. Credential files as above; `pg_dump` at least the server's major version
   (`brew install postgresql@17`, or set `MANCI_PG_BIN`).
3. `npm run check:edge` passes on the branch.

**B. Database (maintenance window of about 10 minutes).**

```
MANCI_DB_BOOTSTRAP=1 bash scripts/ops/backup.sh devnet pre-0070
MANCI_TARGET=devnet MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -Atc "select jobname||' active='||active from cron.job where jobname like 'mancipatio-%'"
MANCI_DB_BOOTSTRAP=1 bash scripts/ops/maintenance.sh devnet on "Database upgrade in progress, back in about 10 minutes."
sleep 70
MANCI_TARGET=devnet MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -f supabase/migrations/0070_deployment_identity.sql
MANCI_TARGET=devnet MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -f scripts/ops/deployment-identity.sql
MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0071_network_guard.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/preflight/supabase-readonly-identity.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/preflight/supabase-readonly-parity.sql
bash scripts/ops/maintenance.sh devnet off
```

- Record the second command's output (G6: whether `mancipatio-retry-devnet`
  is active).
- The identity preflight must show identity `devnet` /
  `gvnckuzmuwozlcohtuhx`, `tables_without_guard` `[]`,
  `defaults_not_dynamic` `{}` and `browser_insert_paths` `[]` (G5).
  `rows_of_other_networks` lists `platform_raise_limits` with its one
  `'mainnet'` seed row (0056); existing rows stay and are harmless.
- On any failure: maintenance stays on, then "Rollback of 0071" above.

**C. Merge PR-B, then prove the new front serves.**

1. Vercel → Deployments, Production: the deployment serving `www.manci.io`
   is READY **on the merge commit**. READY on an older commit means the
   production build failed; fix it (usually A.1) before going on.
2. `curl -s https://www.manci.io/api/health` returns `"ok":true`. This proves
   the database network check passed only together with C.1: the anonymous
   answer carries no commit.
3. When `HEALTH_TOKEN` is set on the deployment, also check the details
   (read the token with `IFS= read -rs HEALTH_TOKEN` first):
   `curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://www.manci.io/api/health`
   shows `commit` = the merge commit's first 12 characters and
   `checks.databaseNetwork.status` = `"ok"`.

**D. Retry scheduler.**

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler-status.sql
```

Pass: the install ends with one row `mancipatio-retry-devnet | f | devnet |
https://www.manci.io`, and the status shows that single job (one row, your
role as `username`) and the same config. Only then, and only if G6 recorded
it active:
`MANCI_TARGET=devnet bash scripts/db.sh -c "select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-retry-devnet'"`.
Afterwards `retry-scheduler-status.sql` shows `complete` runs within a few
minutes.

**E. Edge function.**

1. Supabase dashboard: enable the new API keys (the legacy ones stay
   enabled).
2. `rm -rf supabase/.temp`, then create `~/.mancipatio/devnet-edge.env` as
   under "Credential files".
3. ```
   bash scripts/ops/supabase.sh devnet secrets set --env-file ~/.mancipatio/devnet-edge.env
   bash scripts/ops/supabase.sh devnet secrets list
   bash scripts/ops/supabase.sh devnet functions deploy helius-webhook   # add --use-api without Docker
   ```
   `secrets list` must show `MANCI_SUPABASE_SECRET_KEY`,
   `HELIUS_WEBHOOK_SECRET` and `INDEXER_NETWORK`.
4. Send a signed test delivery: it answers 202 and its `indexer_jobs` are
   processed (G3, server side). Record Helius's retry window (G9).
5. On failure: the function rollback above (the old code needs no secret
   change).

**F. Front keys (design §8 5.5).** Switch the devnet front to the new keys,
Preview first, then Production:

1. Vercel, **Preview** scope: `NEXT_PUBLIC_SUPABASE_ANON_KEY` =
   `sb_publishable_…` and `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_…`
   (names unchanged, D13). Redeploy a preview (public variables are baked
   in at build time).
2. On the preview: sign in, open a page that reads data, make one signed
   write, and check that `/api/health` answers `"ok":true` (G3, browser and
   server).
3. The same two values in **Production** scope, redeploy production, then
   repeat C.1 and C.2 for that deployment.
4. Keep the legacy keys enabled for 7 green days. Rollback: set the legacy
   values back in the affected scope and redeploy.

### Mainnet project bootstrap (`MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1` throughout)

1. Create the project in eu-west-1: PITR on, new API keys, legacy JWT keys
   disabled. Record `projectRef`, `poolerHost` (G7: aws-0 or aws-1),
   `siteOrigin` and `backupAgeRecipient` in `targets.json` and
   `SUPABASE_PROJECT_REFS` (a PR). Add the pgpass line.
2. `MANCI_DB_BOOTSTRAP=1` for 0001–0070 (`db.sh -f supabase/migrations/<file>`
   each), then `MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -f
   scripts/ops/deployment-identity.sql`, then 0071 and later without
   bootstrap.
3. Preflights: availability, schema, parity (against devnet: no
   differences), `supabase-readonly-identity.sql` (identity mainnet, no
   tables without guard, no non-dynamic defaults, `browser_insert_paths`
   empty: G5).
4. `bash scripts/ops/backup.sh mainnet post-bootstrap` (schema only).
5. Enable pg_cron and http; add the Vault secret
   `mancipatio_retry_worker_mainnet` (and, from §0A D4, the bypass secret
   `mancipatio_vercel_bypass_mainnet`).
6. Retention: install, preview, enable.
7. Retry scheduler: install disabled; enable once the mainnet front answers
   (behind Deployment Protection, with the bypass secret: §0A D5).
8. After the program bootstrap (§0A D10, D16), the super admin on
   `/admin/limits`: `platform_raise_limits` for mainnet with FX headroom
   (D18) and the USDC FX row (kind `rate`, max age 7 days, weekly refresh);
   the 0008 integrations config for mainnet. Until the first sale approval
   `/api/health` reports the missing row as `paymentFx` warn
   `missing_before_first_sale`, not a failure.
9. Edge function secrets and deploy, Helius webhook, a signed test delivery
   answers 202 (G3: supabase-js 2.106.2 with `sb_secret_`).
10. Front: `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `sb_publishable_…`,
    `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_…` (the build and the server
    refuse other formats on mainnet); `HEALTH_TOKEN` and an uptime monitor on
    `/api/health` (D19; it sends the bypass header until Talas 7, §0A). Once the production deployment is READY on the
    intended commit, `/api/health` `ok:true` proves the database network
    check passed; with `HEALTH_TOKEN`, check `commit` and
    `checks.databaseNetwork.status` too.
11. `MANCIPATIO_LIVE_SMOKE=mainnet MANCI_ALLOW_MAINNET=1 npx vitest run
    --config scripts/ops/deployment-smoke.config.ts`, at §0A D6 with
    `MANCIPATIO_VERCEL_BYPASS_FILE` (the deployment is behind Deployment
    Protection; every request then sends `x-vercel-protection-bypass`) and
    again at D11 without it. Without the bypass the protected site answers
    Vercel's 401 and the smoke fails before its first check.

## 15. Alarms and the €3M ledger (Talas 4.4b + 5.1)

Design: `docs/mainnet-readiness/design-4.4b-5.1.md` (its migrations
0070/0071/0072 are **0072/0073/0074** here; the deployment network is 0070's
`public.deployment_network()`, there is no second identity table and no
`set-deployment-network.sql`).

### What runs

| Piece | Where | What |
|---|---|---|
| 0072 `onchain_event_jobs` | trigger on `indexer_events` | one alarm job per program transaction the indexer saw (webhook or gap scan) |
| Alarm worker | `POST /api/internal/alarms`, cron `mancipatio-alarms-<network>` | events → `compliance_alerts` (instruction-first, Squads CPIs and ALT keys included); checks → incidents with hysteresis; one email digest per run |
| Retry worker, stage 3 | `POST /api/internal/retry` (existing cron) | 0073 `spv_issuance_jobs`: closed sales and treasury mints booked from the finalized chain at the proven date; FX revaluations of held rows |
| Dead-man switch | `GET /api/health/alarms` (anonymous, 200/503) | database network, alarm heartbeat ≤ 5 min, no stuck or failed notification |

Both leases assert the deployment network (0072
`assert_deployment_network`, the 0071 guard's rule). Alarms ignore
maintenance mode and the program pause. System alerts never carry a wallet
or client (the passport gate is unaffected); emails carry a fixed label,
severity and time only, plus the summary and an explorer link for platform
alarms (pause, treasury, authorities, upgrades, incidents). Low alerts are
never emailed; high and critical notifications never give up.

### Configuration

| Variable | Where | Rule |
|---|---|---|
| `COMPLIANCE_ALERT_EMAIL` | Vercel (server) | Comma-separated, at most 5. **Devnet: `office@mancipatio.io`** (owner decision). Required on mainnet: without it `/api/health/alarms` answers 503 and alarm runs are `partial`. |
| `RETRY_WORKER_SECRET` | Vercel + Vault | Reused by the alarm worker (D8); the Vault secret stays `mancipatio_retry_worker_<network>`. |
| `NEXT_PUBLIC_SITE_URL`, `SMTP_*`, `EMAIL_FROM` | Vercel | Reused: the digest links `<site>/admin/compliance`. |
| `ALERT_WEBHOOK_URL` (+ `ALERT_WEBHOOK_TOKEN`, `ALERT_WEBHOOK_MIN_SEVERITY`, `ALERT_WEBHOOK_FORMAT`) | Vercel (server) | The second channel (8.4): one POST per digest, in parallel with the email; high and critical by default. `ALERT_WEBHOOK_FORMAT=json` (default): ntfy `https://ntfy.sh/<topic>?tpl=yes&t={{.title}}&m={{.text}}&p={{.priority}}`, or a relay reading `severity`/`alerts[]`. `ALERT_WEBHOOK_FORMAT=text` sends only `{"text": …}`: Slack, Mattermost and Google Chat incoming webhooks. Required by a mainnet build. A channel that fails while the other delivers does NOT turn `/api/health/alarms` red (nothing gets stuck): it opens its own incident, `alert-channel-webhook` or `alert-channel-email` (high, "Alert channel failing"), which the other channel delivers; it clears after three digests the channel delivers again. Only when every channel fails do rows stay pending and health answer 503 (`notify_pending:stuck`). Send a test alert after every change of the URL, token or format. |
| `ALARM_BALANCE_WATCH` | Vercel (server) | `label:address[:minSol]`, comma-separated: `sol-balance:<address>` (high) below the threshold (default 0.1 SOL). List every key that signs in an emergency. One company wallet in several roles may be listed under each label (`super-admin:<W>,admin:<W>,kyc:<W>`): one watch, every label, the highest threshold. |
| `ALARM_SQUADS_CONFIG` | Vercel (server) | The role map's `squads` object (JSON): `squads-config` (critical) on any drift of members, threshold, time lock or config authority; `squads-proposal:<proposal>` for EACH open proposal (Approved/Executing critical, Draft/Active high), so a second proposal pages even while the first is open or acknowledged. Reads the newest 100 transaction indexes and 100 older ones per minute in rotation. |

The complete list per network, with what a mainnet build requires:
`ops/env-vars.md`; secrets, owners and rotation: `ops/secrets.md`.

Helius (D22): the webhook of each project must list **both program IDs and
both ProgramData PDAs** (loader `SetAuthority` and `Close` do not reference
the program ID). Print the PDAs with:

```
node -e 'import("@solana/kit").then(async k=>{for(const p of ["FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS","GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy"]){const [a]=await k.getProgramDerivedAddress({programAddress:"BPFLoaderUpgradeab1e11111111111111111111111",seeds:[k.getAddressEncoder().encode(p)]});console.log(p,"→",a)}})'
```

The gap scan (every 5 minutes, window now−20 min … now−5 min) reads both
program IDs (asset_registry and, since 0075, transfer_hook), the
blocklist-authority PDA and both ProgramData PDAs, and re-queues any
finalized transaction the index misses that invokes a watched program
(asset_registry, transfer_hook, or a loader instruction on one of ours). A
transaction that only lists one of those addresses (anyone can add the
blocklist-authority PDA or a program ID as a read-only account; the webhook
never delivers the PDA ones) is ignored, so the PDA does not need to be in
the Helius list. A due scan that gets no time in a run (the cheap checks used the
budget) makes that run partial, so `last_ok_at` stops and
`/api/health/alarms` turns 503 within 5 minutes if it keeps happening; and
`indexer:gap-scan-overdue` (high) opens once no scan has started for 15
minutes. Before the first scan it only holds, so bootstrap raises no alert.

### Devnet rollout (migrations before the front)

**A. Preflight (read-only, from the branch).**

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/ledger-preflight.sql
```

Section 1 (duplicate sale bookings) must be empty, or 0073 refuses to run.
Decide on every row of sections 2, 3 and 4 before 0073: keep, or correct by
hand. Section 2 lists manual rows that name a sale, section 3 manual rows on
assets with server bookings, section 4 the server bookings 0073 will still
make (consumed sales and reserved treasury mints, `refused_by_0027` for the
ones the old calendar-year trigger refused) next to manual rows of the same
SPV and asset: a manual row that worked around such a refusal is counted
twice once the retry worker books the server row.

**B. 0072, then 0073** (the live front keeps working: expand steps only).
Do B, C and D on the same day: from 0072 on, every program transaction
queues an alarm job that nothing processes until the alarm job is enabled in
D.5 (and treasury-mint ledger jobs are created only by the alarm worker).

```
bash scripts/ops/backup.sh devnet pre-0072
MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0072_onchain_alarms.sql
MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0073_spv_issuance_jobs.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/preflight/supabase-readonly-identity.sql
```

The identity preflight must still show `tables_without_guard` `[]` and
`defaults_not_dynamic` `{}` (the new tables default to
`deployment_network()` and carry the guard). Expected effects: event jobs
start queueing with the next webhook delivery; every closed approved sale is
backfilled as a `sale_close` job (covered ones complete on their first
pass); a booking the old calendar-year trigger refused books on the next
retry run. Look for `OVER_CAP` alerts afterwards.

**C. Front.** Merge, then check that the production deployment is READY on
the merge commit and `curl -s https://www.manci.io/api/health` answers
`"ok":true`. Browser settle and treasury nudges are gone
(`/api/sale-approvals/settle` answers 410 for one release).

**D. Owner / operator settings.**

1. Vercel, devnet project, Production: `COMPLIANCE_ALERT_EMAIL=office@mancipatio.io`; redeploy.
2. Helius dashboard, the devnet webhook: add both ProgramData PDAs (above).
3. Alarm scheduler (after the retry scheduler, whose worker target it uses):
   ```
   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler.sql
   MANCI_TARGET=devnet bash scripts/db.sh -c "select mancipatio_ops.invoke_alarm_worker()"
   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler-status.sql
   ```
   Pass: the install ends with `mancipatio-alarms-devnet | f | devnet |
   https://www.manci.io`; the manual run is `complete` in `alarm_http_runs`
   and `worker_heartbeats` shows `alarms` with a fresh `last_ok_at` (and
   `retry` from the retry worker).
4. Test email:
   ```
   MANCI_TARGET=devnet bash scripts/db.sh -c "select public.raise_system_alert(public.deployment_network(),'test:rollout-'||to_char(now(),'YYYYMMDDHH24MISS'),'worker','worker:test','medium','Alarm email test (rollout)','{}'::jsonb,null,true)"
   ```
   The cron job is still disabled, so send it with one more manual run and
   check that the alert's `notify_state` is `sent` (and the email arrived at
   `office@mancipatio.io`):
   ```
   MANCI_TARGET=devnet bash scripts/db.sh -c "select mancipatio_ops.invoke_alarm_worker()"
   MANCI_TARGET=devnet bash scripts/db.sh -c "select notify_state, notify_error from public.compliance_alerts where dedup_key like 'test:rollout-%' order by created_at desc limit 1"
   ```
5. Enable the job:
   `MANCI_TARGET=devnet bash scripts/db.sh -c "select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-alarms-devnet'"`.
6. External monitor (D10): every 5 minutes on
   `https://www.manci.io/api/health/alarms`, alert on anything but 200.

**E. 0074 (contract), at least a day after C.** It drops the anonymous read
of `spv_issuances` and `record_spv_issuance`; the new front reads through
`/api/spvs/capacity` and `/api/spvs/issuances`.

```
bash scripts/ops/backup.sh devnet pre-0074
MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0074_ledger_contract.sql
```

**Expected bootstrap alerts** (D17): the first runs raise incidents for
whatever is already true (a stale USDC rate in use, old invalid jobs, an
indexer backlog) and the backfilled sales may raise `LINKED_EXISTING` or
`OVER_CAP`. The first runs also drain the alarm jobs queued since 0072: an
on-chain alarm (and its email) for every admin, authority, pause or loader
transaction made between B and D.5, and an `event-queue` incident (high when
the oldest job passed the fail threshold) until the queue is empty. Review
them, then resolve in bulk on `/admin/compliance`.

### Mainnet project

Apply 0001–0075 in order (0074 and 0075 are safe on a fresh project; 0075
seeds its heartbeat row in `observe`, see §16), the identity first as in §14. Then: env (`COMPLIANCE_ALERT_EMAIL` required), Vault
secret, retry scheduler, the Helius webhook with all four addresses, and the
alarm scheduler **enabled and proven** — **all before** the program deploy
and bootstrap (§2–§7), so every bootstrap action (including the loader
alarms) is alarmed and emailed. `alarm-scheduler.sql` installs the job
disabled; repeat the devnet steps D.3–D.6 with `MANCI_TARGET=mainnet
MANCI_ALLOW_MAINNET=1` and job `mancipatio-alarms-mainnet`:

1. install `alarm-scheduler.sql`, run `select mancipatio_ops.invoke_alarm_worker()`
   once, and check `alarm-scheduler-status.sql` (the run `complete`, a fresh
   `alarms` `last_ok_at`);
2. raise a `test:` alert (D.4), run `invoke_alarm_worker()` again, and confirm
   `notify_state = 'sent'` and the email at the mainnet recipients;
3. enable the job (`cron.alter_job(..., active := true)` on
   `mancipatio-alarms-mainnet`);
4. `curl -s -o /dev/null -w '%{http_code}' -H "x-vercel-protection-bypass: $BYPASS" https://<mainnet site>/api/health/alarms`
   answers `200` (read `BYPASS` with `IFS= read -rs BYPASS`; without the
   header Deployment Protection answers until Talas 7, §0A), and the external
   monitor watches it with the same header.

**Gate:** §2–§7 do not start until all four hold. FX rows
only through the Raise limits page by the super admin after bootstrap
(D16); check the EURC mint address against Circle's published address
before saving it.

### Responses

| Alert | First response |
|---|---|
| `onchain:program-upgrade` critical | Confirm a Squads proposal you expected (§9). Unexpected: incident (§11), pause (§11), rotate keys. |
| `onchain:treasury`, `onchain:platform-admin` accept, `onchain:blocklist-authority` accept | Compare with the signer matrix; unexpected = compromised key, §11. |
| `onchain:pause` critical (unpause) | Only the super admin clears; confirm who and why. |
| `onchain:issuer-permissions` critical (mint bit) | Check the issuer's KYB and the approval record. |
| `ledger:over-cap` critical | The chain acted past the limit; legal review, and stop new approvals for the subject. |
| `ledger:unreserved-mint` | Re-value the mint on the Raise limits page if its value is above the floor. |
| `fx:missing`, `fx:stale`, `ledger:capacity-holds` | Add or refresh the EUR rate on the Raise limits page; the jobs unblock and revalue by themselves. |
| `worker:retry-heartbeat`, `indexer:*` | `retry-scheduler-status.sql`, Vercel function logs, Helius delivery log. |
| `indexer:gap-scan-overdue` | The alarm run has no time left for the gap scan: look at the `onchain_event_jobs` backlog (`worker:event-queue`) and database latency in the Vercel logs; `worker_heartbeats.last_gap_scan_at` for `alarms` moves again once a scan starts. |

### Operations

- Re-queue notifications that gave up (after fixing SMTP):
  `update compliance_alerts set notify_state='pending', notify_attempts=0, next_notify_at=now() where notify_state='failed';`
  (a `failed` notification on an open alert keeps `/api/health/alarms` at 503
  until it is re-queued and sent, or the alert is resolved).
- Clear a hold after a manual review (the fact is counted another way):
  `select public.clear_capacity_hold(public.deployment_network(), '<subject>', '<ref>');`
  then resolve the related alerts.
- Delivery is at-least-once: a digest that timed out may arrive twice.

### Rollback

- Front: revert the Vercel deployment; disable the job with
  `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'mancipatio-alarms-<network>'`.
  The previous front works against 0072/0073 (signatures unchanged; the
  settle route is valid again with the old code before 0074), but it has no
  ledger stage: nothing processes `spv_issuance_jobs` (they wait for the new
  front) and nothing clears capacity holds, while 0073's
  `sale_capacity_hold_guard` and `record_spv_issuance` v2 keep refusing a
  held subject with `SUBJECT_ON_HOLD`, which the old front does not map.
  After the revert, list the holds
  (`select subject, ref, code, created_at from public.sale_capacity_holds where network = public.deployment_network();`)
  and clear each one after review with `clear_capacity_hold`, or drop the
  `sale_capacity_hold_guard` trigger as in the 0073 rollback below.
- 0072: `drop trigger indexer_events_enqueue_alarm_job on public.indexer_events;`
  and restore 0047's `acquire_retry_worker_lease` (the same body without its
  first `perform`). Tables and columns stay.
- 0073: `drop trigger sales_enqueue_close_job on public.sales; drop trigger
  sale_capacity_hold_guard on public.sale_capacity_reservations;` then
  re-apply `0066_sale_capacity.sql` and `0027_spv_cap_trigger.sql` (both
  re-runnable). Keep `spv_issuances_sale_once` and the new tables.
- 0074: `create policy "spv_issuances anon read" on public.spv_issuances for select using (true); grant select on public.spv_issuances to anon, authenticated;`
  and re-apply 0073 section 15 (`record_spv_issuance`).

### Implementation notes (where the code differs from the design text)

- Renumbered migrations 0072/0073/0074; the deployment network is 0070's
  `deployment_network()`. `assert_deployment_network` (0072) uses the 0071
  guard's rule (equal, or both non-mainnet), as `/api/health` does;
  `/api/health/alarms` checks it through 4.3's `checkDatabaseNetwork` (the
  same rule), not through the RPC.
- The 0072 trigger marks a job as a gap-scan job only when `ix_name =
  'GAP_SCAN'` and `payload.source = 'gap-scan'` (both, stricter than the
  design text).
- `sale_capacity_holds` has a `payment_mint` column (the FX incidents read it).
- `/api/compliance/list` accepts the pseudo-category `aml` (rows with no
  category: the AML alerts that predate 0072).
- `readAlarmHealth` lives in `lib/server/alarm-health.ts`, not `health.ts`.
- The retry worker also writes its heartbeat for a `partial` run (status
  `partial`; `last_ok_at` moves only on `processed`).
- The alarm checks record the cheap incidents before the gap scan, which runs
  under its own sub-deadline (checks deadline − 3 s); a scan that was started
  is stamped even when cut short (`gap-scan-incomplete`), and a checks stage
  that recorded fewer incidents than expected (or could not run a check) is
  `failed`: a partial run that never moves `last_ok_at`. The last scan's
  stamp is read before the cheap checks; a due scan that gets no time, or a
  stamp that cannot be read, counts as a check that could not run, and
  `gap-scan-overdue` (pass / hold while due / fail after 15 minutes without
  a scan) is reported on every run.
- Loader alarms also cover upgradeable-loader `Migrate` (tag 8) and any
  loader-v4 instruction on one of our programs (critical).
- Minimal-format on-chain alarms (holder or issuer related) carry only their
  own evidence fields, never the decoded arguments (no holder wallet or
  amount in clawback evidence).
- The digest reads critical and high rows first, then fills the rest.
- `report_incident` reopens only an alert the system resolved; a person's
  resolution or dismissal stays, and a refail opens a new alert.
- `FX_LOCK_DRIFT` runs in `bookingFlags`, i.e. on every booking path;
  every adoption at the current stale rate (job, orphan sale, orphan
  approval, terms that differ) places the `FX_REVALUE` hold; a counted sale
  also clears the hold its consumed approval left.
- `revalue_treasury_mint` and the Raise limits list accept only floor
  adoptions (`adopted_from.kind = 'unreserved_treasury_mint'`), never a
  reactivated reservation.
- The manual "book with signature" stays as the route
  `saleApprovals.treasuryMintBook` (block date, over-cap flags); it has no
  button: the ledger job and the backstop book every finalized mint.

## 16. Indexer freshness heartbeat (0075)

Design: `docs/mainnet-readiness/indexer-heartbeat-design.md` and its
critique (the code follows the critique where they differ).

### What runs

The mirror counts as fresh for 5 minutes after
`indexer_sync_state.checked_at`. Jobs and the full reconcile move it; on a
quiet network nothing did, so the site fell back to RPC reads and the
Issuers / Assets / Launchpad / Governance badges went muted. The retry
worker's indexer stage (after its job loop, inside the stage's 15 s budget,
at most once per `interval_seconds`) gathers chain evidence, and
`confirm_indexer_quiet` (SQL, under the sync-row lock that
`finish_indexer_job` and the reconcile take) moves `checked_at` only when the
mirror is proven in sync, and only to the time the evidence covers: the
block time of the finalized slot F the listings reach, minus 5 s, never
later than the plan's database time (normally 15–20 s before it). A run it cannot prove
leaves `checked_at` alone: the mirror goes stale and the site reads the
chain. The heartbeat never writes `status`, `last_slot` or `completed_at`,
never throws, and never makes a retry run `partial` (its outcome is the
response's `data.freshness`).

Per run (quiet network, 4 RPC calls plus the genesis check of the server
RPC, whose 30 s cache is cold at these intervals), first in parallel:
`getSlot('confirmed')`; one `getMultipleAccounts` at `finalized` (up to
`sample_size` mirrored accounts, rotating, plus the Clock sysvar, whose
`unix_timestamp` is F's block time); at most 2 finalized `getTransaction`
probes when a listed signature is missing from `indexer_events`. Then per
program `getSignaturesForAddress` at `confirmed`, `minContextSlot` =
max(F, tip − 75), 20 rows then 100 per page, at most 3 pages. At the
default 120 s that is 720 runs a day: 720 `getSlot`, 720
`getMultipleAccounts` and 1 440 `getSignaturesForAddress` (up to 3 pages
each while catching up, so at worst 4 320), plus up to 2 `getTransaction`
per run while a signature is missing, and 720 genesis checks; about 2.5 calls
a minute when quiet. Check the Helius plan's credit weight for
`getSignaturesForAddress` (it may bill it as a history call).

The proof (the first failing condition is `last_reason`):

| Code | Meaning | Response |
|---|---|---|
| `TIP_BASELINE`, `TIP_TOO_SOON` | first tip reading, or one too close / too old to judge a rate | none: the next run judges |
| `RPC_BEHIND`, `RPC_TIP_STALLED`, `RPC_TIP_IMPLAUSIBLE` | the confirmed tip went back, moved under 1 slot/s, or over 4 slots/s | provider health; persistent: change the RPC |
| `RPC_TIME_BEHIND`, `CLOCK_SKEW` | F's block time is more than 60 s before the plan's database time (a node lagging steadily: its tip still moves at the normal rate), or more than 5 s after it (the chain clock or the database clock is off) | provider health; persistent `RPC_TIME_BEHIND` on a healthy provider: compare `solana block-time` with the wall clock |
| `RPC_ERROR`, `RPC_TIMEOUT`, `NO_BUDGET` | no evidence this run (RPC failure, deadline, the job loop used the stage) | Vercel logs (codes only), provider status |
| `NOT_INITIALIZED`, `NOT_READY`, `NOT_RECONCILED` | no ready row, `warming`/`degraded`, or no full reconcile ever | run a full reconcile (`/admin/health` → Reconcile) |
| `PENDING_JOBS`, `OPEN_INCIDENT` | a pending / retrying / leased job, or an open `indexer-gap` / `indexer-degraded` | none while busy (jobs keep `checked_at` fresh); otherwise §15 |
| `LISTING_INCOMPLETE`, `CATCHING_UP`, `CURSOR_MOVED` | the listing did not reach the floor (its oldest row must be at or below it; a short page proves nothing); a cursor continues it next run | none: it catches up by itself (about 220 rows per program per run); persistent: reconcile |
| `RPC_INDEX_BEHIND` | an event delivered 1–10 min ago is above every listed row: the provider's signature index lags the webhook (also a ProgramData-only admin transaction, for up to 10 min) | provider; persistent: change the RPC |
| `UNINDEXED_SIGNATURE`, `UNDECODED_SIGNATURE`, `UNPROVEN_EVENT_SLOT`, `SLOT_MISMATCH` | a successful program transaction above the floor is not in the index, not decoded, was delivered without a slot, or with another slot | Helius delivery log; the gap scan re-queues within ~20 min; persistent: reconcile |
| `SAMPLE_MISMATCH` | a sampled mirrored account differs from the finalized chain (a job refreshed the wrong accounts, a skipped snapshot, a manual edit) | reconcile |
| (skipped) `NOT_INSTALLED` | the plan function is missing (front deployed before 0075, or the PostgREST schema cache not reloaded); logged once per instance at warn | apply 0075 / `notify pgrst, 'reload schema'` |
| `PLAN_SUPERSEDED`, `PLAN_EXPIRED` | a second run planned meanwhile, or the evidence took over 30 s | none |
| `OFF`, `DB_ERROR`, `INTERNAL_ERROR` | switched off at confirm time; the plan/confirm call failed (`DB_ERROR` is not recorded) | `DB_ERROR` persistent: is 0075 applied? |

In mode `on`, a successful program transaction missing for more than about
a minute also **expires** freshness at once (`checked_at` moved just past
the 5-minute window, `status` untouched, `last_expired_at` stamped), so the
site stops trusting the mirror before the window would end.

A missing signature whose transaction only lists a program ID (read-only, or
through a lookup table) is probed with a finalized `getTransaction` on the
next run and exempted when its complete status meta (inner instructions,
loaded keys, no error) shows it invokes no watched program; an answer
without that meta exempts nothing (a CPI, e.g. a multisig execute, would be
invisible). Until then it blocks the proof and (mode `on`) expires freshness. The watermarks advance
only on a live tip with a current index and a listing down to the floor,
capped at tip − 150 and at the finalized slot of the same run.

Alarm `indexer:freshness` (check `indexer-freshness`): age of the newer of
`checked_at` and the last proof; pass under 3 min, fail at 15 min; hold while
the indexer is not ready (`indexer-degraded` reports that) and for the first
30 minutes after the heartbeat row was created without a recorded run (a
heartbeat whose every plan or confirm call fails is judged by the age after
that, its summary says it never recorded a run); low in `observe` (never
emailed), medium in `on`.

Alarm `indexer:reconcile-age` (check `indexer-reconcile-age`, low, never
emailed): the last full reconcile is older than `reconcile_max_age_hours`
(default 168), or there was none. It is not a proof condition (the heartbeat
keeps proving from its watermarks); a reconcile also catches what a
transaction-level proof cannot, such as an account a job never wrote. Run
one from `/admin/health` → Reconcile when it fails.

Logs: routine declines (`PENDING_JOBS`, `NO_BUDGET`, `TIP_BASELINE`,
`TIP_TOO_SOON`, `CATCHING_UP`, `LISTING_INCOMPLETE`, `UNDECODED_SIGNATURE`,
`PLAN_SUPERSEDED`, `PLAN_EXPIRED`, `OPEN_INCIDENT`, `NOT_READY`, `OFF`) at
info, every other decline at error, reason codes only.

The gap scan (§15) also lists the transfer_hook program ID, so a missed
hook-only transaction is re-queued (the proof requires it indexed). Every
hooked transfer lists that ID, so it is paged last on its own budget of 2
pages and running out of it does not fail `gap-scan-incomplete` (its
evidence carries `hook_complete`): a hook-only transaction changes no
mirrored account.

### Configuration

One row per network in `public.indexer_heartbeat_state` (service role only):
`mode` `off` | `observe` (seeded: evaluate and record, never bump) | `on`;
`interval_seconds` 60–120 (default 120; the retry job runs every minute, so
anything above 120 would mean 180, where one missed run already outlasts the
5-minute window); `sample_size` 0–99 (default 99; the Clock sysvar is the
100th key of the same `getMultipleAccounts`); `reconcile_max_age_hours`
(default 168: the `indexer-reconcile-age` threshold only). No env var and no
cron change: it
rides the existing `mancipatio-retry-<network>` job and the server RPC
(`HELIUS_DEVNET_RPC`; on mainnet `HELIUS_MAINNET_RPC` is required, without
it every run is `RPC_ERROR`).

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/indexer-heartbeat-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -c "update public.indexer_heartbeat_state set mode = 'on', updated_at = now() where network = public.deployment_network()"
```

Operator reset of a program's watermark (e.g. after a provider was found to
have served an incomplete history): `delete from
public.indexer_heartbeat_watermarks where network =
public.deployment_network() and program = '<program ID>';` then run a full
reconcile (the floor falls back to its `last_slot`).

### Devnet rollout (migration before the front)

1. Preconditions (read-only): 0070–0074 applied; the retry job
   `mancipatio-retry-devnet` active and `worker_heartbeats` `retry`
   `last_ok_at` recent (`retry-scheduler-status.sql`); the Helius devnet
   webhook is **enhanced**, transaction types **ANY**, with no transaction
   status or type filter (any filter leaves signatures undelivered and the
   proof fails with `UNINDEXED_SIGNATURE` forever), and lists both program
   IDs and both ProgramData PDAs (§15).
2. `bash scripts/ops/backup.sh devnet pre-0075`, then
   `MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0075_indexer_heartbeat.sql`,
   then `scripts/preflight/supabase-readonly-identity.sql` still shows
   `tables_without_guard` `[]`. Expand-only: the live front ignores it.
3. Deploy the front (merge; production READY on the merge commit; the CI
   front job, which runs the `RUN_LOCAL_POSTGRES_TESTS=1` suites
   `indexer-heartbeat.postgres` and `migration-chain.postgres`, green).
   Before 0075 the plan call is skipped (`NOT_INSTALLED`, logged once per
   instance, runs stay `processed`) and the freshness alarm reports nothing,
   so the order is safe either way.
4. Run one full reconcile (`/admin/health` → Reconcile): the floor must be
   recent enough for the first listing to reach it (a cursor catches up
   about 220 rows per program per run otherwise).
5. Provider checks on the devnet endpoint (the one `HELIUS_DEVNET_RPC` names):
   a `getSignaturesForAddress` for the asset_registry program ID with
   `minContextSlot` = current slot + 10 000 must fail with "Minimum context
   slot has not been reached"; and one devnet transaction that lists the
   asset_registry program ID read-only, and one that loads it through an
   address lookup table, must each show up in `indexer_events` (if not, they
   are only ever exempted by probes, which costs a few minutes of
   staleness each).
6. Observe for at least 2 hours with the status script: one `TIP_BASELINE`,
   then `would_bump` in quiet minutes, short `PENDING_JOBS` /
   `UNDECODED_SIGNATURE` around activity, watermarks set, and
   `indexer-freshness` pass or low. No persistent `RPC_TIME_BEHIND` or
   `CLOCK_SKEW` (the provider's finalized block time against the database
   clock), and `last_proven_at` about 15–20 s before `planned_at`. Make one
   devnet transaction (e.g. a KYB step): the outcome is `would_bump` again
   within one or two runs.
7. Switch on (the `update ... mode = 'on'` above). Within one interval
   `checked_at` is fresh and the four badges show numbers.

Mainnet: the same steps on the mainnet project (`MANCI_TARGET=mainnet
MANCI_ALLOW_MAINNET=1`) after `HELIUS_MAINNET_RPC` and the webhook are
configured, with step 5 against the mainnet endpoint and at least 24 hours
of `observe`.

### Rollback

`mode = 'observe'` stops the bumps and expiries at once; `mode = 'off'` also
stops the RPC calls. A front revert leaves the tables inert. Nothing else
depends on 0075.

## 17. Operator, licence and legal texts (gap 2026-09-28, package 8.1)

The public site names its operator, licence and legal texts from committed,
typed slots; a mainnet build (`next.config.ts` `assertBuildMainnetLegal`)
refuses to start while any slot is incomplete and lists what is missing.
Devnet, testnet and localnet keep the pilot's texts and are never checked.

| Slot | File | Filled by |
|---|---|---|
| Operator: registered and short name, registered office, MB, PIB, register, governing law, forum for disputes, legal / privacy / security addresses, optional support and DPO addresses (support `null` = the contact form) | `front/lib/legal/operator.ts` (`OPERATORS.mainnet`) | owner (company data), counsel (law and forum) |
| Licence: authority, decision number and date, licensed services, register entry | same record, `licence` | owner, from the decision |
| Mainnet Terms, Privacy Policy, acceptance-dialog summary | `front/lib/legal/mainnet-copy.ts` | counsel |
| Purchase risk warning (ZDI art. 15(2)) | `front/lib/legal/risk-warning.ts` (`status: "counsel"` once approved) | counsel |
| External audit: firm, scope, date, public report URL (linked from `/risks` and `/about`) | `front/lib/legal/audit.ts` (`SECURITY_AUDIT`) | owner, when the report exists |

When the company and the licence arrive:

1. Fill `OPERATORS.mainnet` (no secrets: everything there is public in the
   business register and on the licence). Leave `pilotNotice` null. The
   security address must stay equal to `public/.well-known/security.txt` and
   the programs' embedded security.txt (a test checks the first).
2. Paste counsel's texts into `mainnet-copy.ts` as `LegalDocument`s; they do
   not repeat the operator, the governing law or the contacts, which the
   pages render from the operator record. `MAINNET_TERMS.version` is the
   Terms version every mainnet wallet accepts (`TOS_VERSION`); a later
   material change needs a new version. The devnet version stays
   `DEVNET_TOS_VERSION` (`front/lib/tos-version.ts`).
3. `npx vitest run tests/legal-slots.test.ts --silent=false` until the
   "mainnet legal slots" report says complete.
4. Review the rendered `/legal/terms`, `/legal/privacy`, `/legal/company`,
   `/risks`, the footer, a sale page and an OTC take confirmation with
   counsel. A production build (Vercel Preview included) refuses
   `NEXT_PUBLIC_NETWORK=mainnet` without `MAINNET_LEGAL_COPY_APPROVED=true`,
   so review on either:
   - a local dev server, which runs no build checks:
     `cd front && NEXT_PUBLIC_NETWORK=mainnet npx next dev` (the legal pages
     and the footer need no database; do not point it at any production
     Supabase project), or
   - a Preview deployment of the mainnet Vercel project with
     `MAINNET_LEGAL_COPY_APPROVED=true` set for the **Preview** environment
     only (it then also needs the other mainnet build checks: the Supabase
     project, the KYC registry pin).
5. Only after that review set `MAINNET_LEGAL_COPY_APPROVED=true` for the
   **Production** environment of the mainnet Vercel project.

A mainnet build must set `NEXT_PUBLIC_NETWORK=mainnet`: a production build
that leaves it unset while `NEXT_PUBLIC_SOLANA_RPC_URL` points at mainnet is
refused (the runtime would run as mainnet, but the build checks key on the
variable).

Build-time variables (mainnet Vercel project only, never `NEXT_PUBLIC_`):

- `MAINNET_LEGAL_COPY_APPROVED=true`: a person's assertion that counsel
  reviewed the pages as rendered.
- `MAINNET_LICENSE_NOT_REQUIRED=true`: **only** on counsel's written opinion
  that the services offered on mainnet need no licence. Keep the signed
  opinion on file and record its reference in MAINNET-PLAN.md. It is refused
  together with a recorded licence (contradictory).

Server variable (runtime): `TOS_SERVER_GATE=enforce` makes a TEST network
require a recorded Terms acceptance on `/api/launchpad/commit`,
`/api/otc/create` and `/api/resell/create` (409 without, 503 when it cannot
be checked), to rehearse mainnet, where it is always on. The client dialog
fails closed on mainnet regardless; it is mounted on the marketplace and
portfolio pages and on the `/markets/resell` board (whose OTC request is one
of the gated routes), so every gated route has a page that offers the
acceptance. Binding the Terms version into the purchase memo is a separate,
later change.

Whitepaper gate (lansiranje-2): on mainnet a sale approval
(`/api/sale-approvals/reserve`) and the sale's purchase document
(`/api/launchpad/terms`, `/api/launchpad/commit`) require either an
SSC-approved whitepaper with its decision reference **and the uploaded,
hash-verified decision document**, or an **offering exemption** recorded by
the super admin (Admin → asset → Whitepaper & disclosure: counsel's
reference and the reason; the server stamps who and when and writes an
`offering_exemption_record` audit event). On mainnet recording or changing
an SSC approval (status, reference, decision document, or a new whitepaper
file under an approval) is also the **super admin's**, and is refused
without the decision document; any admin may withdraw one. The exemption
columns come from migration `0076_offering_exemption.sql` (expand-only).
Devnet rollout: `bash scripts/ops/backup.sh devnet pre-0076`, then
`MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0076_offering_exemption.sql`;
the order against the front does not matter (test networks never select
the columns, and the admin form sends them only when an admin edits them).
The mainnet project gets it with the rest of the chain.

## 18. Domain cutover: `www.manci.io` to mainnet, devnet to `devnet.manci.io`

Today `www.manci.io` serves devnet, and both devnet cron jobs call it. The
mainnet schedulers, SIWS and the email links need the mainnet front on its
own origin, so devnet moves first (§0A D2) and mainnet takes the domain at
D4, still behind Deployment Protection. What depends on the origin:
`NEXT_PUBLIC_SITE_URL` sets the SIWS allowed origin (`lib/server/siws.ts`),
the Turnstile hostname check, the Google OAuth `redirect_uri`
(`<origin>/api/account/google/callback`) and every link in emails; the
session and OAuth cookies are host-only, so nothing carries over from one
host to the other (users sign in again); `scripts/ops/targets.json`
`siteOrigin` is the origin pg_cron calls (the scheduler installs refuse any
other).

**A. DNS (owner).** Add `devnet.manci.io` to the devnet Vercel project and
create the CNAME record Vercel shows at the registrar; wait for the
certificate. `manci.io` sends HSTS with `includeSubDomains`, so the new host
must be https from the start (Vercel is).

**B. Devnet project (owner).** Production scope: `NEXT_PUBLIC_SITE_URL=https://devnet.manci.io`;
Google Cloud, the devnet OAuth client: add
`https://devnet.manci.io/api/account/google/callback` as an authorized
redirect URI (and the origin); Cloudflare Turnstile: add `devnet.manci.io` to
the widget's hostnames. The devnet production build does not set
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` today (kritičar-14: the email login runs
without the check): set both Turnstile keys now or record the decision.
Redeploy (public variables are baked in at build time). Until step D, set
`www.manci.io` in the devnet project to redirect to `devnet.manci.io` (Vercel
domain redirect): SIWS now accepts only the new origin, and old links keep
working. Check: `curl -s https://devnet.manci.io/api/health` answers
`"ok":true` and `"network":"devnet"`, and a wallet signs in on the new host.

**C. Devnet schedulers (operator).** A PR sets `devnet.siteOrigin` to
`https://devnet.manci.io` in `front/scripts/ops/targets.json`; after it
merges, record the jobs' active state (G6), then:

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler-status.sql
```

Both installs leave their job disabled; re-enable each after a clean manual
run (§14 D, §15 D.3–D.5). Move the external monitors to
`https://devnet.manci.io/api/health` and `/api/health/alarms`. The Helius
devnet webhook calls the Supabase edge function, not the site: unchanged.

**D. Mainnet takes the domain (owner, §0A D4).** Remove `www.manci.io` and
`manci.io` from the devnet project and add them to the mainnet project
(`manci.io` redirects to `www`, as today; `mancipatio.io` keeps its 308 to
`www`). The mainnet project has Deployment Protection on *All Deployments*
with Vercel Authentication before the domain is attached. Mainnet uses its
own Google OAuth client (redirect URI on `www.manci.io`) and its own
Turnstile widget. A PR records `mainnet.siteOrigin = https://www.manci.io`,
the project ref, pooler host and backup recipient in `targets.json` and
`SUPABASE_PROJECT_REFS` (§14 mainnet step 1). At Talas 7 (§0A D11)
protection goes back to *Standard Protection*.

**E. Mainnet environment (names only; values live in Vercel, never in the
repository).** Package 8.4 keeps the full inventory of secrets; these are the
ones that differ per network or domain:

| Variable | Mainnet value or source |
|---|---|
| `NEXT_PUBLIC_NETWORK` | `mainnet` |
| `NEXT_PUBLIC_SITE_URL` | `https://www.manci.io` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | the mainnet project; `sb_publishable_…` and `sb_secret_…` only (§14 step 10) |
| `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_WS_URL`, `NEXT_PUBLIC_SOLANA_GENESIS_HASH` | the browser RPC (a key safe to expose, or a proxy) and the mainnet genesis |
| `HELIUS_MAINNET_RPC`, `SOLANA_MAINNET_RPC` | the server RPC (the heartbeat and the priority fee need Helius) and the backup |
| `NEXT_PUBLIC_KYC_REGISTRY` | the role map's `kyc.registry` (the KYC registry PDA of the deployer) |
| `SESSION_SECRET`, `RETRY_WORKER_SECRET`, `HEALTH_TOKEN` | new values, never devnet's; `RETRY_WORKER_SECRET` equals the Vault secret `mancipatio_retry_worker_mainnet` |
| `COMPLIANCE_ALERT_EMAIL`, `CONTACT_NOTIFY_EMAIL`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (or `RESEND_API_KEY`) | the company's mailboxes and sender |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the mainnet OAuth client |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | the mainnet widget |
| `MAINNET_LEGAL_COPY_APPROVED` | `true` only after the lawyer's review (§0 Legal gate) |
| `NEXT_PUBLIC_FEATURE_*` | mainnet defaults off (`PAYOUT_AIRDROP`, `STARTUP_RAISES`); `PASSPORT_CLOSE` and `ISSUER_ROTATION` per the owner's decision |
| `NEXT_PUBLIC_ALLOW_INDEXING` | only from Talas 7 |

## 19. Company wallet model and role handover

When the licence and the legal entity are in place, the entity opens **one
company wallet** (a Ledger it owns) that takes every operational role from
the owner's personal wallet `6AnF…`: the super admin (and its Admin record),
the KYC registry authority, the BlocklistAuthority and the protocol treasury.
The upgrade authority stays with the Squads vault (recommended: 2 of 3,
people other than the company wallet's holder).

**Role map.** `front/scripts/chain/role-map.company.example.json` is the
mainnet shape. One key in several roles is accepted only with an entry in
`acknowledgedRoleOverlaps` that names the key, its exact role set (from
`superAdmin`, `admin`, `kyc.authority`, `blocklistAuthority`,
`protocolTreasury`, `squads.member`) and a reason. Without it the map is
refused on every network but localnet (the rehearsal and e2e fixtures,
where it warns), so the devnet handover already proves the acknowledgement
mainnet needs; an acknowledgement for a key whose roles differ, or that no
longer shares roles, is refused as stale. With it
every tool that loads the map prints the consequences:

- one lost or compromised key affects every role at once, and no second
  signature stands in the way;
- it can clear the pause and also block wallets and switch hook modes, and
  there is no on-chain recovery of the SA or the BA (until 8.3, only a
  program upgrade through Squads);
- blocklist plus clawback with one key; KYC decisions and their enforcement
  together; the KYC registry and the hook's registry pin together; KYB and
  KYC together;
- protocol fees land on an operational key.

The treasury may leave the Squads vault only as such an acknowledged role
key. An acknowledged KYC and SA overlap stands in for `allowKycAdmin`, so
the pre-handover inventory reports `kyc-admin` as a warning. A vault that
one approval executes (threshold 1) is a single-key upgrade authority: not
recommended, and on mainnet it needs
`"acknowledgedSingleKeyUpgradeAuthority": "<squads.multisig>"`; raise the
threshold later with a Squads config transaction. The tools never move an
upgrade authority to a plain key.

Mitigations that go with the model: one more Admin record (§11 ground
rules), so a lost company wallet does not also remove the pause. It is not
a pause-only role: that key can approve sales, claw back, open custody and
OTC flows alone, so it belongs to a fully trusted person of the legal
entity, and the tools warn `NO SECOND ADMIN` when the map has none (the
company example keeps a placeholder for it). Also the break-glass successor,
onboarded on the front before it is sealed, and the seed backups (§11);
every authority change is an on-chain alarm to the company mailbox (§15);
split the roles again when people are available, with the same
`chain:handover` plan.

**Mainnet.** The company wallet enters through the bootstrap role map (§4–§7:
X3, X2, X1 and S6 are all its signatures); no handover is needed.

**Devnet: 6AnF… → the company wallet.** Write the target outside the
repository (`~/mancipatio-devnet/handover-company.json`), public keys only:

```json
{
  "schema": "mancipatio-handover-target-v1",
  "network": "devnet",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "kycRegistry": "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku",
  "superAdmin": "<company wallet>",
  "admins": ["<Admin records to keep, e.g. the e2e CLI key CekAgg…>"],
  "blocklistAuthority": "<company wallet>",
  "kycAuthority": "<company wallet>",
  "protocolTreasury": "<company wallet>",
  "issuerSuccessor": null,
  "acknowledgedRoleOverlaps": [
    {
      "key": "<company wallet>",
      "roles": ["superAdmin", "kyc.authority", "blocklistAuthority", "protocolTreasury"],
      "reason": "<why one wallet holds every role>"
    }
  ]
}
```

`custodySuccessor` (default: the new super admin) takes custody vaults whose
operator leaves; `issuerSuccessor` plans issuer rotations (null: each one
becomes a decision); `squadsVault` marks a treasury that is the vault. The
target follows the role map rules: the BA and the KYC authority are never
the vault, and a treasury that is neither the vault nor an acknowledged role
key is refused on mainnet (a warning elsewhere). A role map v2 is accepted
as the target as well.

```sh
cd front
CHAIN_NETWORK=devnet CHAIN_RPC_URL=https://api.devnet.solana.com CHAIN_RPS=1 \
CHAIN_ROLE_MAP=~/mancipatio-devnet/handover-company.json CHAIN_SITE_ORIGIN=https://www.manci.io \
CHAIN_OUTPUT=../docs/mainnet-readiness/handover/01-plan.json npm run chain:handover
```

It sends nothing. It prints, and writes to `01-plan.json.md`, the ordered
steps; each names the instruction, who signs (the current holder or the new
key), the page and control, what must be done first and what proves it:

1. **Prepare** (off-chain): the company wallet signs in on the site (SIWS,
   the Terms) as the primary wallet of its own account, and gets about
   0.05 SOL. Maintenance off.
2. **Grant**: `6AnF` runs `add_admin(company)` on `/admin/admins`, so the
   company wallet already works as an Admin while `6AnF` still holds
   everything.
3. **Move**, each proposed by `6AnF` and accepted by the company wallet on
   `/account/roles`: custody vaults `6AnF` operates (`/admin/custody`), the
   KYC registry authority (propose on `/admin/kyc`; the registry address,
   bitmaps and passports stay, so `NEXT_PUBLIC_KYC_REGISTRY` does not
   change), the BlocklistAuthority (`/account/roles`), then the treasury
   (`set_protocol_treasury`, `/admin/platform`).
4. **Super admin last**: `6AnF` proposes, the company wallet accepts; the
   accept closes `6AnF`'s Admin record. Until here `6AnF` could repair any
   step. When the target keeps `6AnF` in `admins`, the next step is
   `add_admin(6AnF)` by the company wallet on `/admin/admins`, right after
   the accept (its custody vaults and rights issuances have no Admin in
   between).
5. **Cleanup**: the company wallet removes the Admin records the target does
   not keep (their sale approvals stay valid: review and revoke them); then
   re-run the plan (only the verification step remains) and
   `chain:inventory`.

Decide before step 4: issuers `6AnF` holds (rotate on `/issuer/rotation`, or
keep `6AnF` as their issuer key; an Admin-key successor must accept before
step 4), rights issuances `6AnF` opened (K19: publish their milestones first,
or keep `6AnF` in the target's `admins`, which plans the re-grant after step
4), issuer recoveries it staged (stale after step 4). There is no role table in the database: roles are read
from the chain (`lib/server/admin-gate.ts`), so nothing changes there. The
upgrade authority (the devnet deployer) is not part of the handover. When
package 8.3 adds the timelock for the super-admin rotation and `add_admin`,
steps 2 and 4 wait for it: re-run the plan.

## EXTERNAL checks (open until the rehearsal proves them)

Status after the 6.1 rehearsal (2026-09-24, localnet; see §12):

1. **Partly open.** Proven: the vault seeds (`["multisig", multisig,
   "vault", 0]`, equal to `@sqds/multisig`), and that every exported
   transaction decompiles into a vault transaction the real Squads v4
   program creates, approves (2 of 3) and executes; the inner messages were
   283–417 B and the `vault_transaction_create` transaction about 260 B
   larger (417 B → 676 B), so the 800 B budget leaves room. Open: the Squads
   web app's Transaction Builder import of the exported base58/base64
   transaction (not reachable from a local validator).
2. **Closed.** SIMD-0431 is active on mainnet and enforced on-chain (an
   extend of 100 B fails). ExtendProgramChecked is abandoned
   (`ExtendProgCheckedWi11BeDe1eted…`, inactive), the unchecked
   ExtendProgram is accepted top-level and needs no authority, and neither
   form works through CPI, so never through Squads (§9.3).
3. **Closed.** `setData` accepts a buffer whatever its authority; the
   hand-over to the vault is the content freeze (§9.6).
4. **Closed.** A real multisig decodes with the repository decoder exactly
   as with `@sqds/multisig` (members sorted by key, 32 unused bytes at the
   end); it is the test fixture now.
5. **Mostly closed.** The verify program ID and the PDA seeds match
   `export-pda-tx` 0.5.1; its output is a legacy transaction with a
   `SetComputeUnitPrice` (dropped by the export) and one `initialize` over
   [PDA, vault (signer, payer), program, System]; wrapped and executed
   through Squads it created both PDAs. Open: whether OtterSec's service
   honours a PDA uploaded before the handover (off-chain; upload from the
   vault after it).
6. **Closed for 2026-09-24.** Mainnet runs Agave 4.3.0 on 71.5 % of stake;
   250 of the 287 features 4.3.0 knows are active, and a 4.3.0 validator with
   `--clone-feature-set` had the same activations. Watch before the deploy:
   SIMD-0500 (no deployment of SBPF v0–v2 programs) is inactive, and both
   Release programs are SBPF v0 (ELF `e_flags` 0, `e_machine` 263); once it
   activates, this Release can neither be deployed nor used for an upgrade,
   and the build must move to SBPF v3 (package 8.3). SIMD-0437-3..5 (rent)
   are inactive too. The feature check is now part of `chain:inventory`
   (findings `sbpf`, `sbpf-gate`, `rent`, `rent-reset`, `feature-superseded`;
   the IDs are in §1, Agave 4.4 keeps the 4.3 keys): run it with
   `CHAIN_RELEASE_DIR` right before the mainnet deploy (§0A D8), and
   `chain:squads-export op=upgrade` re-checks SIMD-0500 for every upgrade.
7. **Open (owner, cheap, before D9).** Phantom and Solflare (each also with a
   Ledger) keep an app-set SetComputeUnitPrice (G2): sign one devnet
   transaction with each and read the price in the explorer. After D5 the
   mainnet RPC answers `getPriorityFeeEstimate` (G8): `curl` the mainnet
   `/api/priority-fee` (with the bypass header before Talas 7) and expect
   `source: helius`; keep 24 h of samples and retune the floor if it never
   leaves it (§0A D12). The design fails safe (the floor is used on any
   oracle failure), so this is not a launch blocker.
