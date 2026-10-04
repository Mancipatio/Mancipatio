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
| `npm run chain:squads-export` | Unsigned vault transactions for the Squads Transaction Builder (also the upgrade authority's veto and recoveries, and the incident build, §11) | never |
| `npm run chain:handover` | Ordered plan to move live roles to new keys, with each step's timelock (§19) | never |
| `npm run chain:emergency` | Out-of-band pause, unpause, blocklist, hook mode and an issuer proceeds freeze with a Ledger or a keypair, no front and no database (§11) | only with `CHAIN_SEND=1` |
| `npm run chain:accept` | The bootstrap steps a role key signs itself (A3, X3, X2, X1, S5c, S6) with that key's Ledger or keypair, no front, no SIWS (§5) | only with `CHAIN_SEND=1` |
| `npm run chain:direct-buy` | **Devnet only** (refused on every other cluster, whatever `CHAIN_ALLOW_MAINNET` says): buys units of an Open sale by calling the program directly with a test key, no sign-in and no Terms, to verify the off-platform buy alarm (§15, "Buys by wallets not linked to the platform") | only with `CHAIN_SEND=1` |

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
| `CHAIN_ROLE_MAP` | Required for bootstrap, accept and squads-export, and for IDL send/prepare-export. Its sha256 goes into the plan digest. For handover it is the target (a handover target or a role map, §19). |
| `CHAIN_RELEASE_DIR` | Required on mainnet for bootstrap, idl and squads-export. `SHA256SUMS` is verified first. |
| `CHAIN_SEND=1`, `CHAIN_KEYPAIR`, `CHAIN_CONFIRM_PLAN` | Send mode needs all three. Without `CHAIN_SEND` every tool is a dry run. |
| `CHAIN_SIGNER` | chain:emergency and chain:accept only, instead of `CHAIN_KEYPAIR`: `usb://ledger`, `usb://ledger?key=<n>` or `usb://ledger?key=<n>/<m>` (the Solana CLI's derivation paths). |
| `CHAIN_CU_PRICE` | Micro-lamports per CU. Required when sending on mainnet; at most 2,000,000. |
| `CHAIN_RPS` | Requests per second, default 2, at most 20. On the public devnet RPC use `1`: its `getProgramAccounts` limit fails an inventory at 2 (observed 2026-09-24). |
| `CHAIN_DEADLINE_MIN` | Internal abort deadline. Defaults: inventory 20, bootstrap 60, idl 120, squads-export 10, emergency 15, accept 15, direct-buy 10. |
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
`CHAIN_KYC_REGISTRY`, `CHAIN_ISSUER`, `CHAIN_FREEZE_REASON_SHA256`,
`CHAIN_EMERGENCY_IDL_UNCHECKED=1`, `CHAIN_EMERGENCY_CLOSE_BOOTSTRAP=1`
(emergency, §11); `CHAIN_ACCEPT_OP`,
`CHAIN_ACCEPT_SIGNER` (accept, §5); `CHAIN_BUY_SALE`, `CHAIN_BUY_UNITS`,
`CHAIN_BUY_BUYER`, `CHAIN_BUY_TERMS` (direct-buy, devnet only, §15).

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
  Release is `CHAIN_RELEASE_DIR`. `chain:accept` is not in v1.0.0-rc.1: it
  runs from its own clean checkout of the reviewed commit that has it, whose
  `program`, `front/idl` and `front/lib` equal the live tag (§5, "Which
  checkout").
- Hot keys: the deployer (bootstrap, IDL before handover) and the
  bufferWriter (buffers after handover). The deployment tools refuse any
  other key, and never load a Ledger key on mainnet. The two exceptions
  sign with the role key itself (a Ledger or that key's file):
  chain:emergency (§11), after checking on-chain that the key holds the
  role, and chain:accept (§5), after checking that the key is the role
  map's key for the step and that the chain holds a live proposal to it.

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
      A closed pilot may start from a 1-of-1 multisig (threshold 1, one
      member with initiate, vote and execute) under
      `acknowledgedSingleKeyUpgradeAuthority` = the multisig (§19). The
      operator can create it without the Squads app: one Squads v4
      `multisig_create_v2` with a fresh create key, `config_authority` and
      `rent_collector` none, time lock 0, the member a Ledger that is neither
      the company wallet nor a hot key, and the deployer as the payer only
      (never a member, D19). The create key fixes the multisig address and
      stays secret until the create lands (whoever holds it can create the
      multisig at that address first, with other members); afterwards check
      the account at finalized against the intent. On 2026-10-02 the program
      config's `multisig_creation_fee` was 0 and the create cost the deployer
      0.0015 SOL (165 B of rent and two signatures); Squads can change the
      fee, so read it again right before the send.
      The role map validator needs the real `squads.multisig` and
      `squads.vault` (addresses, the vault equal to
      `PDA(["multisig", multisig, "vault", vaultIndex])`) before any tool
      loads the map, so the first preflight `chain:inventory` already needs
      them: take both from the create's dry run (the same create key gives
      the same address). Until the create lands that inventory reports
      `squads` (multisig account not found); after it the finding is gone.
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
      `unpauseMask` = the areas the pilot opens (35 = 0x23: onboarding,
      primary issuance, issuer proceeds; the company example), never 0x40,
      `kyc.tempAdminGrant: false` unless the 3.1 `kycProvider` gate is missing
      (D17). One key in several roles needs `acknowledgedRoleOverlaps` (§19);
      the map is refused on mainnet without it. The upgrade authority (the
      vault) holds no operational role (design 8.3 O-10, review finding 6):
      the map refuses the vault in `admins[]`, and `chain:inventory` blocks a
      live super admin, blocklist authority or Admin record that is an
      upgrade authority (`sa-is-ua`, `ba-is-ua`, `admin-is-ua`; before S7
      against the vault S7 installs). No company-wallet key is a Squads
      member either (the §19 residuals).
- [ ] **A v1.0.0-rc (or later) Release, SBPF v3**: the mainnet Platform is
      initialized only by a v1 build (a fresh v1 Platform is 0xFF: every
      pause bit plus the bootstrap marker, bit 7). An rc.x build leaves 0x40
      clear, which `chain:inventory` blocks on mainnet (`payout-modules`), as
      it blocks a Release `.so` that is not SBPF v3 (`release-sbpf`). The
      Release also carries the incident build (`*-incident.so`, §11); it is
      never deployed outside an incident.
- [ ] **Dedicated RPC** and `CHAIN_CU_PRICE` decided (check recent
      prioritization fees).
- [ ] **`chain:accept` checkout**, when a role key is a Ledger used through
      Phantom, Solflare or Jupiter (§5, "Which checkout"): a second clean
      checkout, next to the Release tag's, of the reviewed commit that has
      `chain:accept`; `git diff --quiet v1.0.0-rc.1 HEAD -- program front/idl
      front/lib` exits 0 there; `npm ci` in its `front/` and the Ledger
      packages installed in that checkout
      (`cd front/scripts/chain/ledger && npm ci --ignore-scripts`; an install
      in the tag's checkout does not count).
- [ ] **Operator CLI ≥ 4.0 for an SBPF v3 Release** (v0.0.0-rc.2 on; its
      hashes.txt says `arch: v3`): `solana --version` prints
      `solana-cli 4.2.x` (the train of the verifiable-build image) on the
      machine that runs `write-buffer`, `deploy --buffer`, `upgrade` and
      `extend` (§2, §9). Agave 3.1.13 refuses the final v3 ELF before any
      RPC call ("ELF error: Failed to parse ELF file: invalid file header"):
      that fails closed but stops the run. Unpack the Agave v4.2.2 release
      tarball for the operator's platform outside the repository, check its
      sha256 (`solana-release-aarch64-apple-darwin.tar.bz2`:
      `580bb4bcdb439756645a83d856964a8d7b700512356ada819ad89a40bd76bca4`),
      and run its `solana` by path or first on `PATH` for these steps only,
      as in §12. `solana-verify` stays 0.5.1.
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
  - each operator key whose wallet can sign an off-chain message (the SA,
    BA and KYC keys, or the company wallet, and the break-glass successor of
    §11) connects once, signs SIWS and the ToS (the `/issuer/*` TosGate) and
    becomes primary of its own account; none may already be a secondary
    wallet of another account;
  - a Ledger used through Phantom, Solflare or Jupiter cannot sign SIWS (an
    off-chain message), so it skips the item above: its bootstrap steps go
    through `chain:accept` (§5) and its incident steps through
    `chain:emergency` (§11), and neither needs an account on the front;
  - **known limitation, to resolve before D10** (the bootstrap, D9, is not
    blocked): after the bootstrap such a key still cannot use the operator
    front, because the front asks for SIWS before every transaction
    (`front/lib/transaction-wallet-policy.ts`). With the company model that
    key is the SA, the KYC authority and the BA at once, so D10 (the SA on
    `/admin/limits` and `/admin/platform`), KYC passports (`/admin/kyc`), the
    other `/admin/*` work and every rotation (§11) wait until the front signs
    with the Ledger directly (open PR #49, "Ledger (USB) wallet", not merged
    on 2026-10-02) or the role moves to a key that can sign SIWS (a handover,
    §19). The same holds for a break-glass successor that is such a Ledger.
    The owner decides which path, and records it in the launch-day record;
  - fund the keys per the §1 operational budget, each address taken from
    the role map or its device, never from a transaction history (§1,
    "Addresses");
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
whole time. `/api/health` reports a missing or stale FX row as a warning
(`missing_before_first_sale` / `stale_before_first_sale`) until the first
sale approval or sale exists, so the FX row is seeded after the bootstrap
(D10), as D16 wants. Why not the
alternatives: (b) a pre-launch mode that admits allowlisted wallets is new
code in every gate; (c) moving the alarm gate after step 8 leaves the
bootstrap (every authority change, the loader) unalarmed. Keep the window
between D4 and D11 short: the domain shows a sign-in wall meanwhile.

| Step | What | Who | Where |
|---|---|---|---|
| D0 | Legal gate ticked (§0), EXTERNAL items closed, go/no-go recorded | owner | §0, EXTERNAL |
| D1 | Accounts: Supabase Pro with PITR (mainnet project), Vercel Pro with the mainnet project, Helius paid plan (RPC and webhook), SMTP sender, external monitor, age backup key (G10) | owner | §14 step 1 |
| D2 | Mainnet database: 0001–0075 and later, identity, preflights, schema backup, pg_cron and http, the Vault secret `mancipatio_retry_worker_mainnet`, retention | operator | §14 mainnet steps 1–6 |
| D3 | Right before D4, devnet releases `www.manci.io`: the three devnet cron jobs disabled, devnet `NEXT_PUBLIC_SITE_URL=https://devnet.manci.io` and a redeploy. Devnet is out of service until it moves to `devnet.manci.io` (DNS at GoDaddy, the devnet project, the schedulers re-installed), last by the owner's order of 2026-10-02: at any time after D4, nothing in D5–D12 depends on it | owner + operator | §18 R; later §18 A–C |
| D4 | Mainnet Vercel project: env (§18 E list; every variable and build guard in `ops/env-vars.md`, a mainnet build refuses without `SENTRY_DSN`, `ALERT_WEBHOOK_URL`, `HEALTH_TOKEN`, the Turnstile keys, `SESSION_SECRET` and `NEXT_PUBLIC_SITE_URL`), Deployment Protection *All Deployments* + Vercel Authentication, a *Protection Bypass for Automation* secret stored in the Vault as `mancipatio_vercel_bypass_mainnet` (paste it in the Supabase Vault UI, never on a command line), `www.manci.io` and `manci.io` attached (§18 D), production READY on the release commit. Check: an anonymous `curl -I https://www.manci.io/` is refused by Vercel; with the bypass header `/api/health` answers `ok:true` (at most `paymentFx` `missing_before_first_sale` or `stale_before_first_sale`) | owner + operator | §18 D, §14 step 10 |
| D5 | Retry scheduler installed and enabled; edge function, Helius webhook with all four addresses, signed test delivery 202; `HEALTH_TOKEN`; external monitor on `/api/health/alarms` with the bypass header | operator | §14 steps 7, 9, 10 |
| D6 | Alarm scheduler installed, proven (a `high` test alert delivered by email AND by the webhook, §15 Mainnet project step 2) and enabled; `/api/health/alarms` 200 through the bypass. **The §15 gate holds**. Then the deployment smoke (§14 step 11) through the bypass: `MANCIPATIO_VERCEL_BYPASS_FILE=<file with the line VERCEL_AUTOMATION_BYPASS_SECRET=…>` (a file, never the value on a command line) | operator | §15 Mainnet project, §14 step 11 |
| D7 | 0075 heartbeat in `observe` (it proves nothing yet on quiet program IDs; the 24 h observation runs across D8–D12) | operator | §16 Mainnet |
| D8 | §0 mainnet preflight: Release, attestation, program keypair backup, Squads, role map (§19 company model if chosen), cluster gates, CU price, the operator keys that can sign SIWS onboarded on the protected site, the `chain:accept` checkout for a Ledger that cannot | owner + operator | §0 |
| D9 | §2 deploy (hook first) → §3 IDL → §4 cycle 1 → §5 operator steps (on the protected site, or `chain:accept` for a Ledger that cannot sign SIWS) → §6 pre-handover inventory → §7 S7 → §8 after handover (verify PDA, buffers, drain the deployer) | operator + role keys | §2–§8 |
| D10 | First the super admin on `/admin/limits`: the manual USDC fallback (kind `rate`, max age ≤ 7 days on mainnet) and the mainnet `platform_raise_limits` with FX headroom; the 0008 integrations config. Only then the operator installs `fx-scheduler.sql`, runs `select mancipatio_ops.invoke_fx_refresh()`, checks `fx-scheduler-status.sql` and enables `mancipatio-fx-mainnet` (§15 "Automatic EUR rate"; 0080 is applied to the mainnet project before `release/mainnet` is fast-forwarded to the commit that carries it, §15 "Apply migration 0080"): the automatic USDC rate then shows as current on `/admin/limits`, with the manual one as its fallback. `/api/health` is `ok:true` without warnings. The pilot pause mask `0x1c` is set on `/admin/platform` (§8) and the sanctions list is `fresh` on `/admin/compliance` (§15 "Sanctions list"). Then the mainnet 6.4 drill: D1 (redeliver S1, no new transaction) and D3 (timed full reconcile) | super admin, then operator | §8, §13, §14 step 8, §15, §16 "6.4 drill" |
| D11 | **Talas 7 go-live**: first, Privacy clause 11 checked against the chain and the role map (§17, "State on 2026-10-02"); then Deployment Protection back to *Standard Protection* (production domains public), delete the Vault secret `mancipatio_vercel_bypass_mainnet` and the bypass secret in Vercel (or rotate it), monitors without the header; the deployment smoke (§14 step 11) again **without** `MANCIPATIO_VERCEL_BYPASS_FILE` (it proves the site is public); announce | owner + operator | §18 D, §14 step 11 |
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
| company wallet (§19, when chosen) | Ledger of the legal entity | SA with its Admin record, KYC registry authority, BA and the protocol treasury, in place of the four rows above; never the upgrade authority, and never a Squads member (O-10) |

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
(Release v1.0.0-rc.1 was deployed at 5,080 on 2026-10-02, with the owner's
go; the last column below is what that deploy measured.)

| Item | SOL at 5,080 | Mainnet 2026-10-02 (rc.1) |
|---|---|---|
| Registry ProgramData (3 MiB) | ≈ 15.98 | 15.981 |
| Hook ProgramData (768 KiB) | ≈ 4.00 | 3.996 |
| Program accounts (36 B each) | ≈ 0.002 | 0.0017 |
| IDL metadata (both programs) | ≈ 0.31 | 0.3076 (registry 54,672 B, hook 5,614 B) |
| Bootstrap PDAs (cycle 1) | < 0.01 | not yet (localnet: 7 PDAs, 855 B, 0.009 at 5,080) |
| Fees (about 2,720 buffer writes, 2 deploys, 80 IDL steps) | 0.02–0.03 | ≈ 0.016 at 200,000 µL/CU |
| Registry deploy buffer (transient) | ≈ 11.27 (rc.1 `.so`, 2,217,968 B) | 11.268, returned by its deploy |
| Hook deploy buffer (transient) | ≈ 1.98 (rc.1 `.so`, 389,432 B) | 1.979, returned by its deploy |

The deployer's peak is the **largest** balance it needs at one time, not
the sum of the rows. Loader-v3 `DeployWithMaxDataLen` first moves the
buffer's lamports to the payer and only then charges the ProgramData rent,
and each buffer is smaller than its ProgramData, so a buffer row never adds
to its ProgramData row. Proven twice on 2026-10-02: on localnet a payer left
with less than the ProgramData rent after `write-buffer` still deployed
(rehearsal B, probe 04d; evidence in
`~/mancipatio-mainnet/evidence/rehearsal-2026-10-02/B-localnet/`, not
tracked), and on mainnet the deployer held 8.41 SOL after the registry
`write-buffer`, against 15.98 SOL of ProgramData rent, and the deploy
succeeded. The peak is therefore what stays locked plus the fees:
mainnet spent about 20.30 SOL (the Squads create, both deploys and the IDL
init), and the projection with bootstrap cycle 1 at the 2,000,000 µL/CU cap
is ≈ 20.33. **Fund ≥ 21** (peak ≈ 20.33 plus margin). The IDL init writes
straight into the canonical metadata account and uses no IDL buffer (one
exists only for an IDL update, §9.6, paid by the bufferWriter).
`chain:bootstrap` refuses a cycle the deployer cannot pay for (P0). On
2026-10-02 the deployer started with 23.69 SOL, kept 3.39 after §3 and sent
1 SOL to the company wallet, 0.2 to the Squads member and 0.2 to the second
Admin before §4 (1.99 left; cycle 1 needs about 0.02).

Two limits on that margin:

- After the registry `write-buffer` the deployer has little left (8.4 SOL
  on 2026-10-02, about 5.7 when funded with 21). An interrupted
  `write-buffer` must be resumed with the **same** `--buffer` keypair: the
  CLI writes only the missing chunks (rehearsal B, probe 05). A second
  buffer does not fit: it needs another 11.27 SOL while the first one still
  holds its rent. Close an abandoned buffer only with
  `msol program close <BUFFER>` (§2; its rent comes back, minus the fee),
  never `close <PROGRAM_ID>`, which shuts the program for good.
- Before it sends, solana-cli 4.2.2 checks that the payer holds the buffer
  rent plus every write's fee priced at the 1,400,000 CU placeholder (the
  real limit is set later from a simulation, so this amount is not spent):
  for the registry 2,311 × (5,000 + 1.4 × CU price) lamports, 0.66 SOL at
  200,000 µL/CU and 6.5 SOL at the 2,000,000 cap. With 21 SOL keep
  `CU_PRICE` below about 1,700,000 µL/CU.

### Operational budget per key

Rent scales with lamports per byte; fees are small (5,000 lamports per
signature plus the priority fee: 200,000 CU at the mainnet floor of
100,000 µL/CU is 20,000 lamports, 0.00002 SOL, and 0.0004 SOL at the
2,000,000 cap). Top up
below the "refill below" line; the low-balance alarm takes the same numbers
as its thresholds (`ALARM_BALANCE_WATCH`, §15 Configuration).

| Key | What it pays | At 5,080 | At 2,575 | At 1,322 | At 696 | Fund | Refill below |
|---|---|---|---|---|---|---|---|
| deployer | ProgramData and program accounts, IDL, bootstrap PDAs (all locked); each deploy buffer comes back at its deploy, so the peak is the locked sum plus fees | 20.3 (all locked) | 10.3 | 5.3 | 2.8 | peak + margin (≥ 21 at 5,080) | — (drained after §8) |
| bufferWriter | both upgrade buffers (≈ 14.53 / 7.36 / 3.78 / 1.99), the IDL buffer (≈ 0.24 / 0.12 / 0.06 / 0.03), `solana program extend`; the buffer rent returns as the spill after the Squads execute | 14.8 | 7.5 | 3.9 | 2.1 | right before an upgrade, then drain | — |
| company wallet or KYC key | each passport (KycEntry 120 B): 0.00126 / 0.00064 / 0.00033 / 0.00017 SOL, so about 1.26 / 0.64 / 0.33 / 0.17 SOL per 1,000 passports; returned when a passport is closed | 1.3 per 1,000 | 0.64 | 0.33 | 0.17 | 2 | 0.5 |
| company wallet or SA | Admin records (0.00102 at 5,080), proposal PDAs (0.00135, refunded to the acceptor), KYB, treasury and pause fees | 0.05 | 0.03 | 0.02 | 0.01 | 0.2 | 0.05 |
| company wallet or Admins | what an Admin opens: OTC deals, custody vaults, distributions (the funder is the Admin, K16), rights issuances; each is a few thousandths of a SOL plus the tokens it moves | per operation | | | | 0.5 | 0.1 |
| company wallet or BA | one BlockEntry per blocked wallet (73 B: 0.00102 at 5,080) | 0.00102 each | 0.00052 | 0.00027 | 0.00014 | 0.1 | 0.02 |
| each Squads member | vault transaction and proposal accounts (a few thousandths of a SOL each; with no rent collector they are not refunded) | 0.01 per proposal | | | | 0.1 | 0.03 |
| Squads vault | verify PDAs through the verify program (≈ 0.01), its own fees | 0.02 | | | | 0.05 | 0.01 |

The company wallet holds several rows at once: fund it with the sum
(about 3 SOL at 5,080 for the pilot) and keep the sum of the refill lines
(0.5 + 0.05 + 0.1 + 0.02 = 0.67 SOL; its `ALARM_BALANCE_WATCH` threshold).

### Addresses: from the role map or the device, never from a history

Address poisoning reached the company wallet 18 seconds after its first
funding. On 2026-10-02, 67 slots after the deployer's transfer to it (slot
452669395), `8vKzHsb57uKJZfQtQAVjqvVdFET9NziuwFanD3sa8ezV`, an address with
the deployer's first four and last four characters (`8vKzGepf…8ezV`), sent
the company wallet 1,000 lamports (slot 452669462), so that the look-alike
sits in the wallet's history next to the real sender. Take every address for
a transfer or a role (funding the keys, draining the deployer in §8, a
handover target in §19) only from the role map or read it on the signing
device itself, never from an explorer, a wallet's activity list or an
earlier transaction, and compare it in full, not by its ends. Send nothing
to such an address.

## 2. Deploy (hook first)

Never `deploy` without `--buffer` (D7). Buffer keypairs are generated outside
the repository and never logged (`--silent`; a seed phrase in a log is a
leak).

**The RPC URL stays off the command line.** The chain tools never print it,
but solana-cli 4.2.2 and solana-verify 0.5.1 print the whole RPC URL, the
provider's `api-key` included, in some error messages (the TPU client's
leader-schedule timeout, for example, prints the websocket URL), and a
command-line argument shows in `ps` and in the shell history. So the URL
lives only in a CLI config file outside the repository (mode 600), written
without echoing it, and every `solana` call against mainnet goes through a
wrapper that reads that file and redacts the output:

```sh
# the config file; printf is a shell builtin, so the URL is in no process's argv
( umask 077; set -a; . ~/mancipatio-mainnet/chain.env; set +a
  printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: %s\ncommitment: confirmed\n' \
    "$MAINNET_RPC" "$HOME/mancipatio-mainnet/keys/deployer.json" \
    > ~/mancipatio-mainnet/solana-mainnet.yml )

# the wrapper, `msol` below (on PATH, or call it by its path)
cat > ~/mancipatio-mainnet/tools/msol <<'EOF'
#!/bin/bash
# solana 4.2.2 against mainnet: the URL only from the config file, api-key redacted
set -o pipefail
"$HOME/mancipatio-mainnet/tools/agave-4.2.2/solana-release/bin/solana" \
  -C "$HOME/mancipatio-mainnet/solana-mainnet.yml" "$@" 2>&1 \
  | sed -u -E 's/(api-key=)[A-Za-z0-9_-]+/\1REDACTED/g'
exit "${PIPESTATUS[0]}"
EOF
chmod 700 ~/mancipatio-mainnet/tools/msol
```

The wrapper returns the CLI's exit status (`PIPESTATUS[0]` in bash). An
interactive zsh has no `PIPESTATUS` (the expansion is just empty): when the
operator pipes `msol` into `tee`, read the status as `${pipestatus[1]}`
(zsh arrays start at 1). `solana-verify` takes the same config file with
`-c`; where it needs the RPC (§8 `export-pda-tx`), give it `-c` instead of
`--url` and pass its stderr through the same `sed`. `solana-verify
get-executable-hash` of a local file needs no RPC at all, which is how the
hash check below works.

**Sending.** `write-buffer` sends the write transactions over TPU (QUIC,
straight to the next leaders), while the buffer creation and the deploy go
through the RPC; writes that do not land are re-signed and sent again up to
`--max-sign-attempts` times (default 5, each round about one blockhash
lifetime). Use `--max-sign-attempts 30` for `write-buffer` and `deploy`.
If TPU sending fails (the TPU client cannot start, or writes keep
expiring), run the same command again with the **same** `--buffer` plus
`--use-rpc --max-sign-attempts 60`: everything then goes through
`sendTransaction`, which a Helius Developer plan limits to 5 per second
while the CLI schedules about 100 per second, so expect 429 answers and more
rounds.

```sh
R=~/mancipatio-mainnet/release-vX
K=~/mancipatio-mainnet/keys           # deployer.json, program keypairs, buffer keypairs
E=~/mancipatio-mainnet/evidence       # one new CHAIN_OUTPUT per run (never overwritten)
msol --version   # an SBPF v3 Release (hashes.txt `arch: v3`) needs solana-cli 4.x (§0)
solana-keygen new --no-bip39-passphrase --silent -o "$K/buffer-transfer_hook.json"
msol program write-buffer "$R/transfer_hook.so" \
  --buffer "$K/buffer-transfer_hook.json" --keypair "$K/deployer.json" \
  --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 30
# before the deploy: the buffer holds exactly the Release bytes, and the deployer holds the buffer
BUF=$(solana-keygen pubkey "$K/buffer-transfer_hook.json")
msol program show "$BUF"                                        # Authority: the deployer
msol program dump "$BUF" "$E/02-transfer_hook-buffer.so"
shasum -a 256 "$R/transfer_hook.so" "$E/02-transfer_hook-buffer.so"   # equal (same size too)
msol program deploy --program-id "$K/transfer_hook-keypair.json" \
  --buffer "$BUF" \
  --upgrade-authority "$K/deployer.json" --keypair "$K/deployer.json" \
  --max-len 786432 --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 30
# then the same for asset_registry with --max-len 3145728
```

Hash check: the live code must equal the Release (`solana-verify` hashes a
local dump, so no RPC URL reaches it):

```sh
for p in transfer_hook asset_registry; do
  msol program dump "$(solana-keygen pubkey "$K/$p-keypair.json")" "$E/02-$p-onchain.so"
  solana-verify get-executable-hash "$E/02-$p-onchain.so"
done
grep -E '^(transfer_hook|asset_registry):' "$R/hashes.txt"   # the same two hashes; never an -incident line
msol program show --buffers                                  # empty: each deploy closed its buffer
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

- info: `deployer-ua` (both programs), `sbpf` for each program (the Release
  `.so` is SBPF v3, with the SIMD-0500 state) and `rent` (lamports per byte
  and the SIMD-0437 steps);
- warnings: `platform-missing`, `blocklist-missing`, `idl` for both programs
  (status `init`), `kyc-registry` (the registry does not exist yet),
  `admin-missing` for every `admins[]` key, and `kyc-pin` if
  `NEXT_PUBLIC_KYC_REGISTRY` is exported in the shell;
- with the company wallet model (§19) also the warnings `ba-is-sa` (the
  blocklist authority is the super admin) and `role-overlap` (the
  acknowledged overlap, with its consequences); the evidence's
  `roleMapWarnings` repeat the overlap and, for a 1-of-1 multisig, add
  `SINGLE-KEY UPGRADE AUTHORITY (acknowledged)`;
- no `release-bytes`, `capacity`, `squads`, `buffer` or blocker.

After §3 the two `idl` warnings are gone and the rest stays until §4.

**Measured (2026-10-02, Release v1.0.0-rc.1, solana-cli 4.2.2).** With
`--with-compute-unit-price` the CLI writes 960 B per transaction (1,012 B
without): 406 writes for the hook and 2,311 for the registry, plus one
buffer creation each (the CLI source, and the counts of rehearsal B). On
mainnet, at 200,000 µL/CU over TPU, the hook buffer took 7 s and the
registry buffer 27 s, without errors; each deploy was one transaction (two
signatures) of 1–2 s. Both buffer dumps equalled their
`.so`, both live hashes equalled `hashes.txt`, no buffer was left, and the
inventory showed 0 blockers and 12 findings: exactly the set above for the
company model with one `admins[]` key.

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

The init writes straight into each canonical metadata account (fund,
allocate, extend, write, initialize), with no IDL buffer. On mainnet
(2026-10-02, rc.1) it was 80 transactions for both programs and took about
7.5 minutes (455 s): every step waits for its confirmation, at the tool's
`CHAIN_RPS` request rate. A `chain:inventory` afterwards shows the §2 set
without the two `idl` warnings (10 findings on 2026-10-02).

## 4. Bootstrap cycle 1

**The bootstrap window (v1.0.0-rc, design 8.3 §5.4).** `initialize_platform`
writes `pause_flags = 0xFF`: every pause bit (0x7F) plus bit 7, the one-way
bootstrap marker. While bit 7 is set the 48-hour timelocks of `add_admin` and
`accept_platform_admin` are waived at execution (propose and execute may
follow each other at once); the 14-day expiry is not. Any clear of a pause
bit (`set_pause_flags` with a nonzero clear mask, `set_pause(false)`) closes
bit 7 for good, and nothing can set it again. So the order is mandatory:
every role step (the Admin grants S3/A3, X3, X2, S5/X1, S3r) lands first,
then the final super admin closes the window explicitly (**S5c**,
`set_pause_flags(0, 0x80)`), then it unpauses (**S6**, `map.unpauseMask`
only, never 0x40). The deployer never unpauses on mainnet. Every plan prints
a `bootstrap window:` line with the chain time, and a step that waits for a
timelock shows `timelock (48 hours after …): Executable from … (in …), until …`.

```sh
CHAIN_OUTPUT=$E/04a-bootstrap-plan.json npm run chain:bootstrap
```

Review the printed plan: every step, its preconditions, the signer (always the
deployer), which steps were simulated now and which are deferred ("depends on
S1"), the ACTION REQUIRED list and `NEXT_PUBLIC_KYC_REGISTRY=<address>` (already
pinned on the operator front). Default cycle 1 is S1, S2, S2b, S3 (one
`propose_admin` per `admins[]` key), S4, (S4c), S4b, all in one digest; S5
waits until every Admin grant is executed (A3). Then send:

```sh
CHAIN_OUTPUT=$E/04b-bootstrap-send.json CHAIN_SEND=1 CHAIN_KEYPAIR="$K/deployer.json" \
  CHAIN_CONFIRM_PLAN=<digest> CHAIN_CU_PRICE="$CU_PRICE" npm run chain:bootstrap
```

It ends with `status: awaiting` and the Ledger actions. The Platform is 0xFF
(fully paused, bootstrap window open). When `chain:bootstrap` runs from a
checkout that has `chain:accept` (§5, "Which checkout"), it follows each
ACTION REQUIRED line of a step a role key signs itself (A3, X3, X2, X1, S5c,
S6) with its `chain:accept` command (§5, the CLI path for a Ledger). From the
v1.0.0-rc.1 tag's checkout it does not (that code predates the tool): take
the command from the §5 table.

## 5. Ledger steps (operator front, or `chain:accept` on the CLI)

A Ledger used through Phantom or Solflare cannot sign SIWS, so it cannot use
these pages at all: it takes the same steps on the CLI with `chain:accept`
(end of this section). The plan's ACTION REQUIRED lines name the same pages
(a test checks that each page exists and performs its action). In this
order:

- **A3** (each `admins[]` key): the Admin's own Ledger takes the role on
  `/account/roles` → Waiting for your acceptance → Admin (`add_admin` is
  signed by the NEW admin key since v1.0.0-rc; it pays its Admin record).
  At once while the bootstrap window is open; after a closed window, 48
  hours after S3 and within 14 days (re-run the plan: it shows when).
- **X3**: the BA Ledger accepts on `/issuer/authority` (or `/account/roles`
  → Waiting for your acceptance), then clicks Refresh.
- **X2**: the KYC Ledger accepts on **`/account/roles`** → Waiting for your
  acceptance → KYC provider (registry authority). Not `/admin/kyc`: until it
  accepts, the key is neither the kycProvider nor an Admin, so the admin gate
  refuses it. Temporary-grant path (D17 fallback, `kyc.tempAdminGrant: true`):
  cycle 1 also ran S3k (its A3k is the KYC key's own `add_admin`); after X2
  the next cycle removes the grant (S3r, or S3r.cancel when A3k never ran).
- **Cycle 2** (deployer): a new dry run and digest, then send: **S5**
  proposes the super admin (inside the window: acceptable at once).
- **X1**: the SA Ledger accepts on `/issuer/authority` (or `/account/roles`)
  and **clicks Refresh**. Every A3 must have landed before it: the accept
  makes the deployer's staged grants stale (6152). It is refused while a
  recovery by the upgrade authority is pending (6155).
- **S5c**: the SA closes the bootstrap window on **`/admin/platform`** →
  PauseFlagsPanel → "Close bootstrap window" (`set_pause_flags(0, 0x80)`).
  From here every Admin grant and every super admin rotation waits 48 hours.
- **S6**: the SA clears exactly the pilot's areas, `map.unpauseMask` (0x23
  in the company example: Onboarding, Primary issuance, Issuer proceeds),
  one area at a time in the PauseFlagsPanel. Not "Resume everything": it
  clears all six emergency areas (and bit 7), which would open the areas
  the pilot keeps closed (then set 0x1c again, §8). No tool or button ever
  clears the payout modules (0x40) with anything else: the program refuses
  a clear mask that mixes 0x40 with other bits (6154), and 0x40 stays set
  on mainnet (D2). `chain:bootstrap` checks `pauseFlags & unpauseMask = 0`
  after S6, and plans S7 only then. The areas outside `unpauseMask` (0x1c in
  the company example) stay paused through S7 and after it: the inventory
  reports them as `pilot-paused` (info), never as a blocker, so the handover
  needs no `CHAIN_HANDOVER_WHILE_PAUSED` (the Platform reads **0x5c**).

`accept_platform_admin` closes the deployer's Admin record and creates the
SA's; no grant for the SA is ever needed. With the company wallet model (§19)
one wallet does X3, X2, X1, S5c and S6, in that order (its Admin record comes
from X1; `admins[]` holds the second Admin, whose Ledger does A3).

### CLI path: `chain:accept` (a Ledger behind Phantom or Solflare)

**Why.** The operator front asks a wallet for a SIWS message signature
before it lets it send any transaction (`front/lib/transaction-wallet-policy.ts`),
and a Ledger used through Phantom, Solflare or Jupiter cannot sign an
off-chain message (Ledger support: "Unable to sign off-chain messages with
Ledger Solana wallet created in third-party wallets"; supabase/auth#2277;
the published `@solana/wallet-adapter-ledger` 0.9.30 has no `signMessage`).
The Ledger Solana app does sign transactions (blind signing for our
programs), so `chain:accept` signs each of these steps on the device
directly, with the pinned Ledger packages, the device setup and the hash
check of `chain:emergency` (§11: "Setup, once per operator machine" and
"Compare the hash before approving").

Every run reads the role map and the chain at finalized and refuses before
any signature: a `CHAIN_ACCEPT_SIGNER` that is not the role map's key for
the step; a missing, foreign, stale or expired proposal (`chain:bootstrap`
then proposes it again); a step out of order (A3 before X1, X1 before S5c,
every role step and S5c before S6, as the bootstrap plan orders them; S5c
and S6 before the Platform exists); a step already done is `completed` with
nothing to do. The dry run simulates,
prints the step's `requires` lines and the plan digest (the role map's
sha256 is in it); the send needs that digest and re-checks the `requires`
lines at finalized right before the device signs. On mainnet the checkout
must be clean and the live canonical IDL must define the instruction exactly
as `front/idl` does (no overrides, unlike `chain:emergency`), and
`CHAIN_CU_PRICE` is required. The role key pays the fee; A3 and X1 also pay
an Admin record (73 B plus the 128 B overhead: 1,021,080 lamports, about
0.00102 SOL, at mainnet's 5,080 lamports/B, §1). The tool reads the rent at
run time (`getMinimumBalanceForRentExemption`) and refuses an underfunded
key with the amount; a localnet rehearsal, still at 6,960 lamports/B (§1),
asks 1,398,960 for the record and 1,403,960 with the fee.

**Which checkout.** The live Release tag v1.0.0-rc.1 predates `chain:accept`:
its `front/package.json` has no such script (`npm run chain:accept` there
fails with "Missing script"), and its `chain:bootstrap` prints no
`chain:accept` lines. Run the tool from a second clean checkout (for example
`~/mancipatio-mainnet/checkout-accept`, next to the tag's) of the reviewed
commit that has it: the commit that merged it to main, or a later reviewed
commit or ops tag for which the check below still holds. There:

```sh
git diff --quiet v1.0.0-rc.1 HEAD -- program front/idl front/lib && echo "same as the live tag"
git rev-parse HEAD                                  # the commit the evidence records (headCommit)
(cd front && npm ci)                                # the runner's own dependencies, as in the tag's checkout
(cd front/scripts/chain/ledger && npm ci --ignore-scripts)   # the Ledger packages (§11), in THIS checkout
```

The diff must be empty: the program, the IDL and the instruction builders
are then exactly the live Release's, and only the tooling differs. The
mainnet guards hold as for any sending tool (a clean `front/idl`,
`front/lib`, `front/scripts/chain` and package files; the live canonical IDL
of the instruction), but they cannot tell which commit this is: the tool
prints `source    commit <HEAD>` and the evidence keeps it, so compare it
with the reviewed commit before the send. A Ledger install in the tag's
checkout does not count for this one.

```sh
cd front     # the chain:accept checkout above (clean, Ledger packages installed)
export CHAIN_NETWORK=mainnet CHAIN_ALLOW_MAINNET=1 CHAIN_RPC_URL="$MAINNET_RPC" \
  CHAIN_ROLE_MAP=~/mancipatio-mainnet/role-map.json CHAIN_CU_PRICE="$CU_PRICE"
# 1. dry run: role key, order, window, IDL, simulation; prints the plan digest
CHAIN_OUTPUT=$E/05-a3-plan.json CHAIN_ACCEPT_OP=add-admin CHAIN_ACCEPT_SIGNER=<admins[0]> \
  npm run chain:accept
# 2. send: the device must answer with CHAIN_ACCEPT_SIGNER at that path; compare
#    the message hash the tool prints with the device screen before approving
CHAIN_OUTPUT=$E/05-a3-send.json CHAIN_ACCEPT_OP=add-admin CHAIN_ACCEPT_SIGNER=<admins[0]> \
  CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest> CHAIN_SIGNER='usb://ledger?key=<n>' npm run chain:accept
```

| Order | Step | `CHAIN_ACCEPT_OP` | `CHAIN_ACCEPT_SIGNER` (role map) | Waits for |
|---|---|---|---|---|
| 1 | A3 | `add-admin` | each `admins[]` key, its own Ledger | its S3 (cycle 1) |
| 2 | X3 | `accept-blocklist-authority` | `blocklistAuthority` | S2b (cycle 1) |
| 3 | X2 | `accept-kyc-registry-authority` | `kyc.authority` | S4b (cycle 1) |
| – | cycle 2 | `npm run chain:bootstrap` (deployer, §5 above) | | S5 |
| 4 | X1 | `accept-platform-admin` | `superAdmin` | S5 and every A3 |
| 5 | S5c | `close-bootstrap-window` | `superAdmin` | X1 and every A3 |
| 6 | S6 | `first-unpause` (clears exactly `unpauseMask`) | `superAdmin` | every role step, X1, S5c |

With the company model (§19) rows 2 to 6 are the company Ledger and row 1
the second Admin's Ledger. Each send ends with a `next:` line (the next
`chain:accept` command, or the deployer's cycle). `<n>` is the account
index of the key on the device: the tool reads the key at that path first
and refuses, naming the key it found, when it is not `CHAIN_ACCEPT_SIGNER`;
a key the wallet derived at `44'/501'/<n>'/0'` is `usb://ledger?key=<n>/0`.
Rehearse once with the physical Ledger before mainnet (a devnet or localnet
role map whose keys are on that device). After S6, §6 as usual.

## 6. Dry run again, pre-handover inventory

```sh
CHAIN_OUTPUT=$E/06a-bootstrap-plan.json npm run chain:bootstrap        # only S7 pending
CHAIN_OUTPUT=$E/06b-inventory.json CHAIN_PHASE=pre-handover npm run chain:inventory
```

The inventory must show **0 blockers**: SA, BA and KYC equal the map with no
pending transfer; no staged Admin grant (`pending-admin`), no super admin or
blocklist recovery (`pending-recovery`), no rc.x transfer account
(`legacy-transfer`); bit 7 closed (`bootstrap-open`) and 0x40 set
(`payout-modules`); every area of `unpauseMask` clear (`paused`; the pilot
areas outside it are the info `pilot-paused`); the deployer holds nothing but the UA; the vault S7
installs holds no role (`sa-is-ua`, `ba-is-ua`, `admin-is-ua`);
`kyc.authority` holds no Admin record (a warning, not a blocker, when the map
acknowledges the overlap, §19); the Squads decode matches exactly; the
canonical IDL is in sync with the Release and trimmed, with no extra
authority; ProgramData equals the Release (not its incident build); capacity
≥ `programDataMaxLen`. Smoke-test from the operator front.

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
exists for an emergency only (an area of `unpauseMask` still paused); the
pilot areas outside the mask never need it. 07c keeps reporting them as
`pilot-paused` (info) for as long as the pilot runs.

## 8. After handover

- **Verify PDA through Squads** (EXTERNAL #5): fund the vault with about
  0.01 SOL (it pays each PDA's rent through the verify program), then for
  each program (`solana-verify` 0.5.1, rehearsed 2026-09-24):
  ```sh
  solana-verify export-pda-tx https://github.com/Mancipatio/Mancipatio \
    --program-id <program id> --uploader <vault> --commit-hash <tag commit> \
    --library-name <asset_registry|transfer_hook> --mount-path program \
    --base-image "$(sed -n 's/^base image: //p' "$R/hashes.txt")" \
    --arch "$(sed -n 's/^arch: //p' "$R/hashes.txt")" \
    --encoding base58 --url "$MAINNET_RPC" > "$E/08-export-pda-<program>.txt"
  # the base58 transaction is the last line of that file
  CHAIN_OUTPUT=$E/08-verify-pda.json CHAIN_SQUADS_OP=wrap-external \
    CHAIN_SQUADS_INPUT=<file with {"transactionBase58": "…"}> npm run chain:squads-export
  ```
  `--base-image` and `--arch` are stored in the PDA and OtterSec's rebuild
  uses exactly them: they must be the Release's hashes.txt `base image:` and
  `arch:` (`v3` from v0.0.0-rc.2 on; without `--arch`, solana-verify builds
  v0 and the hash does not reproduce). The export refuses a verify
  instruction whose `--base-image`, `--arch` (absent = v0) or commit differ
  from the Release in `CHAIN_RELEASE_DIR`; `sed` prints nothing for an
  rc.1-shaped hashes.txt without an `arch:` line, so drop the flag there.
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
- **Pilot pause mask (8.5).** On mainnet (Terms clause 2), *Trading through
  Manci* (0x04), *Custody entry* (0x08) and *Distributions* (0x10) stay
  paused, flags **0x1c**, for as long as their module switches are off
  (`ops/env-vars.md`, "Pilot scope"), and the payout modules (0x40) stay
  off for good on mainnet (D2). With `unpauseMask: 35` (0x23) S6 already
  left them set: the Platform reads **0x5c**. Otherwise set them on
  **`/admin/platform`** → PauseFlagsPanel, one "Pause" per area (any Admin
  may SET bits; only the Super Admin clears them). The program refuses those
  flows, and the front says so before any wallet opens
  (`front/lib/pause-gate.ts`). Governance, vesting-series creation and
  custody-vault types read no pause bit of their own; the module switches
  hide them and the wallet path refuses them before the wallet opens
  (`MODULE_FLOWS` in the same file). After an incident's "Resume
  everything" (which never clears 0x40), set 0x1c again. Check:
  `/admin/platform` shows exactly those three areas and the payout modules
  paused (`0x5c`) **before the first sale opens** (D10). The Terms of
  2026-10-03 say conversion into company shares is not available yet and,
  once the Operator switches it on, is available where the issuer offers it
  (with KYC; clauses 2 and 12). Switching it on needs
  `NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION=true` and clearing 0x08, and
  on-chain 0x08 also opens delivery entry, which the Terms keep switched off
  (its module switch stays off): put the wording of that to counsel, and
  publish Terms that no longer say "not available yet", before either step.
- Close leftover buffers (`chain:inventory` lists them under `buffer`).
- Drain the deployer to the treasury or cold storage (the destination from
  the role map or its device, never from a transaction history: §1,
  "Addresses").
- Other vault actions check their inputs against the role map:
  `registry-ix` targets (`propose_admin` → `admins[]`, never the vault;
  `propose_platform_admin` and `propose_platform_recovery` → the SA or the
  vault, `initialize_blocklist_authority` → the map BA,
  `set_protocol_treasury` → the vault or the map treasury; hook-ix
  `propose_blocklist_recovery` → the map BA) need `"confirmTarget": "<same key>"`
  next to `instruction`/`args` for any other key; `initialize_platform` takes
  only the map treasury and fee; pause masks are integers 0–255, a set mask
  holds only 0x7f and a clear mask holds 0x40 only on its own (6154).
  `add_admin` is signed by the new Admin key, so through Squads only when
  the vault itself was proposed, which `propose_admin` refuses (Admin == UA).
  The vault as the super admin (k4 fallback, or a recovery to the vault) is
  an inventory blocker (`sa-is-ua`): rotate it on to a Ledger right after.
  Every v1 role op exports as one vault transaction inside the Squads inner
  budget (the size guard; `execute_platform_recovery`, the largest, has 10
  accounts).
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
   msol --version   # the §2 wrapper; an SBPF v3 Release (hashes.txt `arch: v3`) needs solana-cli 4.x (§0)
   for p in transfer_hook asset_registry; do
     solana-keygen new --no-bip39-passphrase --silent -o "$K/upgrade-buffer-$p.json"
     msol program write-buffer "$R2/$p.so" \
       --buffer "$K/upgrade-buffer-$p.json" --keypair "$K/bufferWriter.json" \
       --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 30
     msol program set-buffer-authority "$(solana-keygen pubkey "$K/upgrade-buffer-$p.json")" \
       --new-buffer-authority <vault> --keypair "$K/bufferWriter.json"
   done
   ```
   A failed write is resumed with the same `--buffer` keypair (§2,
   "Sending", for the `--use-rpc` fallback). The export
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
   msol program extend <program id> <bytes> --keypair "$K/bufferWriter.json" \
     --with-compute-unit-price "$CU_PRICE"
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
- **From v1.0.0-rc back to an rc.x build** (design 8.3, devnet plan
  "Rollback (Phase B)"): rc.x ignores the issuer freezes, the party
  blocklist checks, the deadline bounds, the timelocks and bit 0x40, so
  before the Squads upgrade the SA sets *Primary issuance* (0x02) and
  *Distributions* (0x10) (Startup raises and the payout / Merkle modules
  reopen under rc.x otherwise), plus *Issuer proceeds* (0x20) while any
  `IssuerFreeze` is live (rc.x lifts every freeze silently), and closes the
  bootstrap window if bit 7 is still set (`set_pause_flags(0, 0x80)`).
  Under rc.x `add_admin` is instant again. The v1 PDAs (IssuerFreeze,
  PendingAdmin, AuthorityProposal, the recoveries) are invisible to rc.x and
  come back into force after a return to v1; `chain:inventory` then blocks
  bit 7 while any pause bit is clear.
- State-layout changes are not rollback-safe: fix forward.
- IDL: `CHAIN_IDL_MODE=prepare-export` with `CHAIN_IDL_SOURCE=release` from
  that same checkout, then `idl-update` (step 9.6). The pre-snapshot
  (`CHAIN_SNAPSHOT_DIR/<program>-idl-pre.json`) is evidence only; no tool
  path uploads it.
- Front: Vercel Instant Rollback. To a deployment older than the automatic
  EUR rate (PR #53, migration 0080), in this order:
  1. the manual USDC row on `/admin/limits` is fresh (kind `rate`, max age
     at most 7 days on mainnet; `fx-scheduler-status.sql` shows `fresh`):
     refresh it there FIRST if not. The old front reads only `fx_rates`
     (health, alarms, the admin page), and once the automatic rows are gone
     the ledger counts that row too;
  2. the fx off switch (§15 "Automatic EUR rate", about 45 seconds:
     `scripts/ops/fx-auto-off.sql` disables `mancipatio-fx-<network>`, waits
     for a run in flight, deletes the network's `fx_auto_rates` rows and
     checks nothing came back; the old front has no `/api/internal/fx`);
  3. the Instant Rollback;
  4. close the open `fx-*` incidents by hand: the old front's alarm worker
     has no fx checks, so `fx-auto-stale`, `fx-fallback`, `fx-source-down`,
     `fx-depeg`, `fx-divergence` and `fx-jump` are no longer cleared
     automatically (the off switch itself opens `fx-auto-stale` for its
     first minutes). Resolve each of their alerts on `/admin/compliance`
     with the note "fx job off: rolled back to a front before #53", then
     mark the incidents cleared so a later return starts clean:
     `MANCI_TARGET=<t> bash scripts/db.sh -c "update public.alarm_incidents set cleared_at = now(), pass_streak = 0, updated_at = now() where network = public.deployment_network() and cleared_at is null and split_part(check_key, ':', 1) in ('fx-auto-stale','fx-fallback','fx-source-down','fx-depeg','fx-divergence','fx-jump')"`
     (mainnet: `MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1`).

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
  it cannot rotate a role. `chain:accept` (§5) covers only the bootstrap's
  own accepts to the role map's keys; a rotation to a successor has no CLI
  path yet (follow-up: its propose and the successor's accept on the CLI,
  same digest and Ledger path), so a role key that is a Ledger behind
  Phantom, Solflare or Jupiter cannot rotate at all until the §0 known
  limitation is resolved. If a role
  key is compromised while the front or the database is down, the rotation
  waits for them; meanwhile the attacker can propose and accept the BA or
  KYC role to itself (no timelock), after which only the recovery below
  remains. The upgrade authority's veto, its recoveries and the incident
  build go through `chain:squads-export` and need no front; only the
  successor's execute is on `/account/roles`.
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
  and watch it with the authority alarms (§15). Package 8.3 did not add a
  pause-only role (not in v1).
- **Timelocks and the upgrade authority (v1.0.0-rc, design 8.3 §5–§7).**
  - An Admin grant (`propose_admin`, then `add_admin` signed by the new key)
    and a super admin rotation (`propose_platform_admin`, then
    `accept_platform_admin`) wait **48 hours** and expire 14 days after that.
    The super admin, any Admin **and the upgrade authority** (the Squads
    vault: `chain:squads-export` `registry-ix cancel_admin_proposal` /
    `cancel_platform_admin_transfer`) can cancel them. `remove_admin`, every
    pause and the freeze stay instant. Each proposal raises a critical alarm
    (§15): an unexpected one is cancelled inside its window.
  - A **lost** super admin or blocklist authority: the upgrade authority
    proposes the successor (`registry-ix propose_platform_recovery`,
    `hook-ix propose_blocklist_recovery`); the successor executes 7 days
    later, within 14 days, on `/account/roles`. The current holder or the
    upgrade authority can cancel it. While it is pending the role cannot be
    rotated (6155 / hook 6020), so a compromised holder cannot slip away.
  - A **compromised** super admin or blocklist authority can cancel that
    recovery. The terminal answer is the Release's **incident build**
    (zero delay, only the upgrade authority cancels): the playbook under
    "Company wallet compromised".
  - The KYC authority has no on-chain recovery: a lost KYC key is replaced
    (the four steps under "KYC key compromised or lost").
  - After any super admin change, cancel the Admin grants staged in earlier
    tenures: `chain:inventory` lists them as stale `pending-admin`, and a
    return of that key to the role would revive them (K1.10).
  - With one company wallet for SA, Admin, KYC and BA (§19) the upgrade
    authority is the only veto and the only recovery (O-10): the vault is a
    Squads multisig with at least two people, none of whose keys is the
    company wallet, and `chain:inventory` blocks the upgrade authority as SA,
    BA or Admin (`sa-is-ua`, `ba-is-ua`, `admin-is-ua`). The 30-day clawback
    grace protects nobody then: the same key revokes and claws back.
- Exercise these scenarios as a timed tabletop on devnet (6.5) and record it
  under `docs/mainnet-readiness/`.

### Accepted program risks (v1.0.0-rc)

Known behaviours that v1.0.0-rc keeps on purpose; each goes into the audit
package as an accepted risk with the operating rule that contains it.

- **`trigger_custody_vault` checks only its operator** (gap 2026-09-28
  prog-vlast-12, low). It moves an Active vault to Triggered when the vault
  `authority` (an Admin) signs; it does not look at the vault type, the
  deposit or the beneficiary's KYC. The KYC of a DeliveryEscrow's
  beneficiary is checked only at `realize_custody_vault`, so a vault
  triggered while the beneficiary's passport is missing or expired cannot
  realize (6069 `ReceiverNotApproved`, 6070 `ReceiverKycExpired`), and a
  Triggered vault takes no more deposits (6086 `VaultNotAcceptingDeposits`).
  No token can leave to the wrong party: the escrow stays put until the
  beneficiary's KYC is renewed and the vault realizes, or it is returned
  (`return_custody_vault` accepts Active and Triggered DeliveryEscrow
  vaults). Rule: trigger a DeliveryEscrow only after checking on
  `/admin/custody` that the beneficiary's passport is verified and valid
  past the planned realize; if one was triggered anyway, renew the KYC and
  realize, or return the vault. A later release may add the same KYC check
  to the trigger of a DeliveryEscrow (not in v1).

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
| `pause` | `CHAIN_PAUSE_BITS`: `all` (0x7f), or names from `onboarding`, `primary`, `secondary`, `custody-entry`, `distributions`, `issuer-proceeds`, `payout-modules`, or an integer | any Admin or the SA | nothing to do when every bit is already set |
| `unpause` | `CHAIN_PAUSE_BITS` (`all` = the six emergency areas and bit 7, never the payout modules; `payout-modules` only on its own, and on mainnet only with `CHAIN_ENABLE_PAYOUT_MODULES=<the signing SA>`, the recorded D2 owner decision after a vote of at least 7 days, never an incident step) | the SA only | the program refuses anyone else, and a clear mask mixing 0x40 with other bits (6154); the tool refuses a mainnet clear of 0x40 without the override, and `chain:squads-export` `registry-ix set_pause_flags` without `"confirmPayoutModules": "<multisig>"`. While the bootstrap window is open (bit 7, before S5c) any clear closes it for good and puts every later A3 and X1 behind 48 hours: the tool refuses it without `CHAIN_EMERGENCY_CLOSE_BOOTSTRAP=1` (recorded as `closeBootstrapOverride`); the bootstrap closes the window with `chain:accept` (S5c, §5) |
| `block`, `unblock` | `CHAIN_WALLET` | the BA | an off-curve wallet (an escrow PDA) needs `CHAIN_CONFIRM_WALLET=<same>`: blocking it stops exits from it |
| `hook-mode` | `CHAIN_MINT`, `CHAIN_HOOK_MODE=open` or `kyc-gated`, `CHAIN_KYC_REGISTRY` (kyc-gated only, a live registry) | the BA | Open lets any wallet receive the class; KycGated only live passports of that registry |
| `freeze-issuer` | `CHAIN_ISSUER` (the Issuer PDA), `CHAIN_FREEZE_REASON_SHA256` (sha256 of the trimmed case-file reason, as `/admin/issuers` hashes it: `printf %s "<reason>" \| shasum -a 256`) | any Admin or the SA | D1: stops that issuer's sales and proceeds exits (6143); a second freeze is a no-op; only the SA lifts it, never this tool (§11 "Issuer proceeds freeze") |

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
  `cd front/scripts/chain/ledger && npm ci --ignore-scripts`; for
  `chain:accept` again in its own checkout (§5, "Which checkout").
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
treasury, §19). The attacker can clear every pause (0x40 only in a call of
its own, a critical alarm), remove every Admin, set the treasury, decide KYB,
freeze and unfreeze issuers, issue and revoke passports, block and unblock
any wallet (escrows too), switch or re-point hook modes, claw back blocked or
revoked holders, cancel every recovery, rotate the BA and the KYC authority
to itself at once, and propose Admin grants and the super admin rotation to
itself (48 hours, cancellable by the upgrade authority).
- First (minutes): the Squads members cancel every Admin grant and super
  admin rotation the attacker stages (`chain:squads-export` `registry-ix
  cancel_admin_proposal {"newAdmin": …}` / `cancel_platform_admin_transfer`;
  the critical alarms name them) and keep watching; the second Admin pauses
  with `chain:emergency` (the attacker can clear it: it only slows automated
  abuse); if the key still signs for us, rotate the BA and the KYC authority
  to the break-glass successor and accept at once (no timelock; operator
  front, the successor already onboarded). The super admin cannot be moved
  that way (48 hours, and the attacker is the SA and cancels): it goes
  through the incident build. Maintenance on only after the accepts; tell
  the Squads members; notify (below).
- **Incident build** (design 8.3 §7.4; every vault step through Squads,
  the successor's steps on `/account/roles`):
  1. Cancel what is staged: every `PendingAdmin` and platform
     `AuthorityProposal` (`registry-ix cancel_admin_proposal` /
     `cancel_platform_admin_transfer`); `chain:inventory` shows none left.
  2. The bufferWriter writes the live Release's `asset_registry-incident.so`
     and `transfer_hook-incident.so` into buffers and hands them to the vault
     (§9 step 2, same commands with the `-incident.so` files); then
     `CHAIN_SQUADS_OP=upgrade` with
     `{"artifact": "incident", "confirmIncident": true, "buffers": {…}}`
     (the export checks the bytes against the Release's incident build and
     its sbf-sha256.txt; hook before registry). Verified by the Release's
     `-incident:` hashes only, never through a verify PDA.
  3. `registry-ix propose_platform_recovery {"newAdmin": "<successor>"}` and,
     for the BA, `hook-ix propose_blocklist_recovery {"newAuthority":
     "<successor>"}` (a successor outside the role map needs
     `"confirmTarget"`); they may be separate transactions: the compromised
     key cannot cancel them in the incident build, and while they are
     pending it cannot rotate the role away (6155 / 6020).
  4. The successor executes both on `/account/roles` at once
     (`execute_platform_recovery`, hook `execute_blocklist_recovery`).
  5. Restore the release build at once: `CHAIN_SQUADS_OP=upgrade` with the
     release `.so` buffers (no `artifact`). **Mandatory check before the
     incident is closed:** `CHAIN_RELEASE_DIR=$R CHAIN_PHASE=handed-over
     npm run chain:inventory` shows no `incident-bytes` (the evidence file
     goes into the incident record). Nothing else watches for it: the
     upgrade raised one critical `onchain:program-upgrade` alarm (for the
     incident deploy, and one for the restore), no alarm stays open while the
     incident build is live, and `incident-bytes` is a blocker of this manual
     inventory only (with `CHAIN_RELEASE_DIR`). An incident closed without
     this step can leave the zero-delay recovery and the proposer-only cancel
     live.
  6. The new super admin reviews every change made during the compromise:
     Admin records (remove the attacker's), the treasury, sale approvals,
     KYB decisions, issuer freezes, pause bits (set 0x40 and the pilot mask
     again); revoke passports issued since the compromise; unblock wallets
     the attacker blocked and restore clawed-back units through the issuer;
     cancel leftover proposals; rotate the KYC registry (or replace it,
     below).
  Cost: two upgrades (about 14 SOL of buffer rent each, returned) plus the
  Squads quorum's reaction time; rehearse it on localnet (8.7).
- Cannot: undo executed transactions; stop wallet-to-wallet transfers;
  recover the KYC registry on-chain; recover anything if the upgrade
  authority were the company wallet too (never allowed, O-10).

**Company wallet lost** (not compromised). Nothing moves, but nobody can
clear the pause, grant or remove Admins, decide KYB, issue passports, block
or unblock, switch hook modes or set the treasury. A second Admin record
(ground rules), if the role map kept one, can still pause and freeze.
- First: restore it from the seed backup onto a new Ledger (the same key);
  pause if the platform must stop meanwhile.
- Recovery without a backup (D4, no incident build needed): the upgrade
  authority proposes the successor for the SA (`registry-ix
  propose_platform_recovery`) and the BA (`hook-ix
  propose_blocklist_recovery`); 7 days later, within 14 days, the successor
  executes both on `/account/roles`. Only the upgrade authority can cancel
  them (the lost key does not sign). Then the KYC registry: the "KYC key
  lost" steps below (step 2 needs the new BA).
- Cannot: anything the SA, the BA or the KYC key signs during those 7 days;
  pause at all, if no other Admin record exists.

**Super admin key compromised** (separate keys). The attacker clears pauses,
adds Admins, sets the treasury, decides KYB, stages issuer recoveries and
custody proposals. BA and KYC are unaffected.
- First: rotate the SA to the successor if it still signs; other Admins keep
  pausing (the attacker can clear it); maintenance on.
- Recovery: the upgrade authority cancels the attacker's Admin grants and
  its super admin rotation (48 hours to do so); remove the attacker's
  Admins, set the treasury back, cancel its issuer recoveries (the issuer
  can cancel too) and custody proposals (the SA, or the vault's current
  operator while it is an Admin). Lost: the D4 recovery (7 days). Taken
  over (it cancels the recovery): the incident build above.
- Cannot: shorten the 7 days without the incident build; undo KYB decisions
  or treasury payouts that already landed.

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
- First: rotate the BA if it still signs (operator front, no timelock);
  then undo with `chain:emergency` (`unblock`, `hook-mode`) signed by the
  new BA.
- Lost: the D4 hook recovery (`hook-ix propose_blocklist_recovery`, 7
  days). Taken over (it cancels the recovery): the incident build above
  (the hook part).
- Cannot: stop its blocks or hook-mode switches with the pause (the hook
  never reads it); reverse transfers that happened while a class was Open;
  pause the blocklist gates (a compromised BA can block buyers, takers,
  founders, vesting recipients and OTC expiries until it is replaced).

**KYC key compromised or lost.** Compromised: it issues passports (anyone can
receive KycGated units) or revokes them (receivers are refused). Rotate it if
it still signs (propose on `/admin/kyc`, accept on `/account/roles`), then
revoke every passport it issued since the compromise.
Lost: the program has no KYC recovery by design (signer matrix §5); the
registry is replaced, as `kyc_registry_authority.rs` documents:

1. create a replacement registry (admin co-signed) from a key that has
   NEVER created one — each creator's `["kyc_registry", key]` seed slot is
   single-use, and the lost key's slot stays occupied;
2. re-point each KycGated mint with `update_transfer_hook_config`
   (KycGated -> KycGated, the new registry passed as `kyc_registry_account`;
   the BA: `chain:emergency hook-mode kyc-gated` with
   `CHAIN_KYC_REGISTRY=<new>`);
3. set the front's `NEXT_PUBLIC_KYC_REGISTRY` pin to the new address and
   redeploy — until then every KYC surface keeps resolving the dead registry
   (the pin fails closed, it never falls back to a scan);
4. re-issue passports in the new registry (entries do not carry over).

Until step 2 a holder approved only in the old registry still passes the
hook; after it, only the new registry's passports count. Until the repoint,
old passports cannot be revoked.
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
Instant Rollback (to a deployment older than PR #53: a fresh manual USDC row,
then the fx off switch, first; the `fx-*` incidents closed by hand after it,
§10). An outage: operators use the local operator front
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

**SMTP down.** Alarm emails fail; the webhook (the second channel, §15
Configuration) keeps delivering. The first sign is the `alert-channel-email`
incident (high, "Alert channel failing"), which arrives through the webhook.
High and critical alerts keep arriving there, and `/api/health/alarms` stays
200 while the webhook delivers them: do not wait for a 503. Medium alerts go
to the webhook only with `ALERT_WEBHOOK_MIN_SEVERITY=medium` (default
`high`): otherwise they have no channel, stay pending and turn
`/api/health/alarms` 503 after three failed attempts. Set it to `medium` for
the outage (Vercel env and a redeploy), or read `/admin/compliance` by hand.
A 503 while no medium alert is pending means the webhook fails too (every
channel is down) or another check failed (§15 What runs). Fix the transport
(`SMTP_*`, or `RESEND_API_KEY` as the fallback), redeploy, then re-queue the
notifications that gave up (§15 Operations) and send a test alert; the
incident clears after three digests email delivers.
- Cannot: email anyone until the transport is back (sign-in links and
  account emails fail too); page anyone at all if the webhook fails as well:
  then watch `/admin/compliance` and `/admin/health` by hand.

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
  protection on `main` (Vercel deploys it), a CSP (report-only in 8.4, so it
  blocks nothing yet; enforcement per `ops/env-vars.md` "Content-Security-Policy").
- Cannot: reverse transfers users signed; stop transfers of wallets that are
  not blocked.

**Issuer proceeds freeze (D1) and the O-9 SOP.** When an issuer is
suspected of fraud or its funds must be held (a court or regulator
request, a KYB failure found late):
- Freeze: any Admin, on `/admin/issuers` → Proceeds freeze (the reason text
  goes to the audit log, its SHA-256 on chain), or out of band with
  `chain:emergency` `CHAIN_EMERGENCY_OP=freeze-issuer CHAIN_ISSUER=<issuer
  PDA> CHAIN_FREEZE_REASON_SHA256=<sha256 of the trimmed reason text>`.
  It refuses that issuer's `open_sale`, `buy`, `close_sale`,
  `open_payout_vault`, `release_payout` and `claim_founder_yield` (6143);
  the exits of what the issuer does not receive stay open (offer cancels,
  OTC expiries and Admin cancels, custody returns, investor yield and
  claims). There is no on-chain refund of sale payments: the money buyers
  paid stays in the proceeds or payout escrow until the super admin
  unfreezes it or a program upgrade (disclosed in the Terms, on `/security`
  and on `/risks`). An OTC deal whose party is blocked cannot expire; an
  Admin cancels it (`cancel_otc_deal`) to return the deposits (O-11). The
  issuer, launchpad, payout and rights pages show "Proceeds frozen" and
  refuse these actions before any wallet opens.
- The freeze does not stop the issuer wallet's own secondary sales (offers,
  OTC) or P2P transfers (O-9). If that matters, the BA blocks the issuer's
  authority wallet(s) (`chain:emergency block`), with its consequences:
  a public sanctions marker; every outgoing unit transfer of that wallet
  stops, for every issuer under it; its holdings become clawable
  (`clawback_blocklisted_holder`, irreversible through the quarantine);
  and an unfreeze does **not** unblock it (`remove_from_blocklist`
  separately). The freeze and the unfreeze raise the critical
  `onchain:issuer-freeze` alarm. While the freeze lasts, every trade or
  transfer by the frozen issuer's authority wallet raises the high
  `onchain:frozen-issuer-activity` alarm (design 8.3 §5, O-9): it signs an
  offer, a take, an OTC deposit or a unit transfer, its offer is taken, an
  OTC deal names it or a buyer settles its deal, or it owns the source of a
  hooked transfer. On that alarm decide at once whether the BA blocks the
  wallet (above). The alarm needs the 0079 mirror (`issuer_freezes`) and the
  alarm worker; it is a go-live condition for O-9. Units moved away before
  the freeze, or before the block, stay out of reach.
- Unfreeze: the super admin only, on `/admin/issuers` (or
  `chain:squads-export registry-ix unfreeze_issuer_proceeds` when the vault
  is the super admin); the rent returns to the freezer.
- A rollback to an rc.x program lifts every freeze silently: set
  *Issuer proceeds* (0x20) first (§10).

**Other.**
- Wrong pending proposal (v1.0.0-rc): a super admin rotation or an Admin
  grant is cancelled by the super admin, any Admin or the upgrade
  authority; a custody rotation by the super admin or the vault's current
  operator (with its Admin record); a BA, KYC or issuer proposal by its
  current holder. Proposing again also overwrites (and restarts the clock).
- An OTC deal whose permissionless expiry fails with 6144 (a deposited
  party is blocked, O-11): an Admin cancels it on `/admin/otc`
  (`cancel_otc_deal`, a legal-reviewed decision: the refund goes to the
  blocked party too).
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

### Rehearsal record (2026-10-02, `chain:accept`, localnet only)

Agave 4.2.2 with mainnet's feature set, Release v1.0.0-rc.1 loaded at the
real program IDs (`--upgradeable-program`, then `program extend` to
`programDataMaxLen`), a Squads 1-of-1 and a role map of exactly the mainnet
shape (company model, one more Admin, `unpauseMask` 1), throwaway keys; the
role keys signed with their files (`CHAIN_KEYPAIR`). Evidence:
`~/mancipatio-mainnet/evidence/rehearsal-2026-10-02/T2-localnet-accept/`.

- §3 IDL init (80 transactions, in-sync), §4 cycle 1, then on the CLI:
  A3 (the second Admin's key) → X3 → X2 → cycle 2 (S5) → X1 → S5c (0xff →
  0x7f) → S6 (0x7f → 0x7e, exactly `unpauseMask`) with `chain:accept`;
  `chain:bootstrap` then planned only S7; `pre-handover` inventory 0
  blockers; S7; `handed-over` inventory 0 blockers.
- Refused before any signature, as expected: X1 before A3, X3 by a key that
  is not the role map's BA, S6 before X1 and S5c.
- Not rehearsed: a physical Ledger with `chain:accept` (the Ledger path is
  tested against a stand-in device only; check the account path of the key
  the wallet created before mainnet), and mainnet itself.
- Despite `--bind-address 127.0.0.1` the validator listened on every
  interface for RPC (`*:18899`), RPC PubSub (`*:18900`) and the faucet
  (`*:19900`); only gossip stayed on 127.0.0.1 (`01-listen-sockets.txt`).
  Harmless with throwaway keys, but the next rehearsal also passes
  `--rpc-bind-address 127.0.0.1` (not yet verified to cover all three) or
  firewalls those ports, and records the listening sockets again.

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
- **USDC EUR rate** (D18; automatic since 0080, §15 "Automatic EUR
  rate"): the fx job keeps an automatic rate, the median of four public
  USDC/EUR order books (Kraken, Coinbase, Bitstamp, Bitvavo), refused when
  they disagree by more than 1 % or the median is further from the ECB
  reference rate than a band that grows with the age of the fix (2.5 % for
  a fix up to a day old, one point per further day, at most 5 %), valid 15
  minutes and renewed every minute. The
  manual row on `/admin/limits` (Super Admin, kind `rate`, maximum age at
  most 7 days) stays as the fallback while the automatic rate is missing or
  out of date, or, ticked as an override, counts over it: keep it seeded.
  `/api/health` judges the rate that counts (`checks.paymentFx.origin`):
  it fails (503, uptime alarm) when none exists or none is fresh, warns
  `auto_stale` while the manual fallback counts, `manual_override` while an
  override counts, `fallback_missing` / `fallback_stale` while the
  automatic rate counts but the manual fallback behind it is missing or out
  of date (alarm `fx:fallback`), and from 80 % of the maximum age. Before
  the first sale approval or sale a missing or stale rate only warns
  (`missing_before_first_sale` / `stale_before_first_sale`). Set the mainnet
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
`siteOrigin` and `backupAgeRecipient`. Mainnet's project is recorded since
2026-09-30 and its `siteOrigin` (`https://www.manci.io`, devnet's
`https://devnet.manci.io`, §18) since 2026-10-02; its `backupAgeRecipient`
is still `null`. `SUPABASE_PROJECT_REFS` in `front/next.config.ts` must
match the refs (a test checks).

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

### Client-documents bucket limits (0077, package 8.4)

`0077_client_documents_bucket_limits.sql` pins the upload route's limits on
the private KYC bucket `client-documents` (15 MiB; PDF, PNG, JPEG, DOCX), as
0031 and 0048 did for the other document buckets. Expand-only: the route
already refuses everything the bucket now refuses, and existing objects are
untouched. Devnet rollout, after 0076 and in any order against the front:
`bash scripts/ops/backup.sh devnet pre-0077`, then
`MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0077_client_documents_bucket_limits.sql`;
check with `select id, file_size_limit, allowed_mime_types from
storage.buckets where id = 'client-documents';` (15728640 and the four
types). The mainnet project gets it with the rest of the chain.

### Role-state mirror (0079, package 8.3)

`0079_indexer_role_state.sql` adds the indexer mirror of the v1.0.0-rc role
state: `issuer_freezes`, `pending_admins`, `authority_proposals`,
`platform_recoveries`, `blocklist_authority_proposals` and
`blocklist_recoveries` (service role only; the admin menu badges of Admins
and Platform and the `role-change-pending` incident read them), and extends
`apply_indexer_snapshot` to write them (for the 14 existing tables the body is
0047's). Expand-only, but apply it BEFORE the v1.0.0-rc front: without it
that front's indexer jobs for these accounts stay pending (indexer degraded).
Devnet: `bash scripts/ops/backup.sh devnet pre-0079`, then
`MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0079_indexer_role_state.sql`,
then a full reconcile (`/admin/health` → Run reconcile) to fill the tables;
its result also lists any rc.x `AuthorityTransfer` / `BlocklistAuthorityTransfer`
left on chain (never mirrored). Rollback: re-apply 0047's
`apply_indexer_snapshot` and drop the six tables (only with the previous front).

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
refuses while a linked project is recorded there. The CLI (2.101) records the
project again on every call, so the wrapper removes `front/supabase/.temp/`
after each call it runs (also when the call fails or is interrupted) and
exits with the CLI's status: consecutive wrapper calls need no manual
`rm -rf`. A refusal means something outside the wrapper linked a project:
find out what before deleting it. A plain deploy bundles the
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
mainnet front answers at its origin, which happens at §0A D4, after devnet
releases `www.manci.io` (§18 R, D). Until Talas 7 that front is behind Vercel
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

1. Vercel → Deployments, Production: the deployment serving `devnet.manci.io`
   is READY **on the merge commit**. READY on an older commit means the
   production build failed; fix it (usually A.1) before going on.
2. `curl -s https://devnet.manci.io/api/health` returns `"ok":true`. This proves
   the database network check passed only together with C.1: the anonymous
   answer carries no commit.
3. When `HEALTH_TOKEN` is set on the deployment, also check the details
   (read the token with `IFS= read -rs HEALTH_TOKEN` first):
   `curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://devnet.manci.io/api/health`
   shows `commit` = the merge commit's first 12 characters and
   `checks.databaseNetwork.status` = `"ok"`.

**D. Retry scheduler.**

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler-status.sql
```

Pass: the install ends with one row `mancipatio-retry-devnet | f | devnet |
https://devnet.manci.io`, and the status shows that single job (one row, your
role as `username`) and the same config. Only then, and only if G6 recorded
it active:
`MANCI_TARGET=devnet bash scripts/db.sh -c "select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-retry-devnet'"`.
Afterwards `retry-scheduler-status.sql` shows `complete` runs within a few
minutes.

**E. Edge function.**

1. Supabase dashboard: enable the new API keys (the legacy ones stay
   enabled).
2. `rm -rf supabase/.temp` (once: later wrapper calls clean up after
   themselves), then create `~/.mancipatio/devnet-edge.env` as under
   "Credential files".
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
   (D18) and the USDC FX row as the manual fallback (kind `rate`, max age
   7 days); the operator installs, proves and enables the fx scheduler
   (§15 "Automatic EUR rate", 0080); the 0008 integrations config for
   mainnet. Until the first sale approval
   `/api/health` reports the missing row as `paymentFx` warn
   `missing_before_first_sale` (a stale one `stale_before_first_sale`), not
   a failure.
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
| Retry worker, last stage | `POST /api/internal/retry` (existing cron) | `share_class_distribution` audit rows `pending` (5 min to 7 days old) whose transaction has no server row yet (looked up by its id, derived from the signature; a final row posted to the unsigned `/api/audit`, the browser's or anyone's, does not count), oldest first (the last 7 h first, then the backlog): the server's own final row, `success` / `failed` (`tx_error`) from the finalized chain, or `failed` "Not found on chain (expired)" only when it is certain: 6 h after its pending row neither `getSignatureStatuses` (history) nor `getTransaction` (finalized) knows the transaction in the same run, and no final row posted to `/api/audit` says `success` for it (such a conflict stays `pending`, counted as `review`, logged with code `review`: look up the signature on an explorer). The row asserts only the chain status (actor `server`, `metadata.reconciled_by_server`, `chain_outcome`, `pending_row_ids`); what the pending row reported is only in `metadata.client_claims` (`verified: false`). `/api/audit` refuses actor `server` and drops those metadata keys from a caller's row. The admin audit page shows one final row per transaction, the server's when there is one (another final row that says a different status is shown on it as a "Status conflict", not as a duplicate; the server row's claimed actor and target from `client_claims` are shown, and searchable, as "Unverified claim"); it labels a row "Server / chain check" only when `/api/audit/list` recognizes it by its id, actor and `actor_source` `retry-worker` (`lib/server/reconciled-audit.ts`), never by its metadata. A stop or a row held for review is logged (`[retry-worker] audits {…}`) and reported in `audits` (`code`, counters with `deferred` and `review`); never makes the run partial (`lib/server/distribution-audits.ts`) |
| Dead-man switch | `GET /api/health/alarms` (anonymous, 200/503) | database network, alarm heartbeat ≤ 5 min, no stuck or failed notification |
| Automatic EUR rate (0080) | `POST /api/internal/fx`, cron `mancipatio-fx-<network>` (every minute) | the median of four public USDC/EUR order books, checked against the ECB → `fx_auto_rates` (15 min); every run in `fx_rate_observations`; the ledger reads `fx_effective_rate` (§15 "Automatic EUR rate") |

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
| `ALERT_WEBHOOK_URL` (+ `ALERT_WEBHOOK_TOKEN`, `ALERT_WEBHOOK_MIN_SEVERITY`, `ALERT_WEBHOOK_FORMAT`) | Vercel (server) | The second channel (8.4): one POST per digest, in parallel with the email; high and critical by default. `ALERT_WEBHOOK_FORMAT=json` (default): ntfy `https://ntfy.sh/<topic>?tpl=yes&t={{.title}}&m={{.text}}&p={{.priority}}`, or a relay reading `severity`/`alerts[]`. `ALERT_WEBHOOK_FORMAT=text` sends only `{"text": …}`: Slack, Mattermost and Google Chat incoming webhooks. Required by a mainnet build. A channel that fails while the other delivers does NOT turn `/api/health/alarms` red (nothing the other channel carries gets stuck): it opens its own incident, `alert-channel-webhook` or `alert-channel-email` (high, "Alert channel failing"), which the other channel delivers; it clears after three digests the channel delivers again. Only when every channel fails do rows stay pending and health answer 503 (`notify_pending:stuck`); with email down, that includes the medium rows below `ALERT_WEBHOOK_MIN_SEVERITY` (§11 "SMTP down"). Send a test alert after every change of the URL, token or format. |
| `ALARM_BALANCE_WATCH` | Vercel (server) | `label:address[:minSol]`, comma-separated: `sol-balance:<address>` (high) below the threshold (default 0.1 SOL). List every key that signs in an emergency. Set each `minSol` from the "Refill below" column of §1 (Operational budget per key). One company wallet in several roles may be listed under each label (`super-admin:<W>,admin:<W>,kyc:<W>`): one watch, every label, the HIGHEST threshold, not the sum. So give such a wallet the sum of its roles' refill lines as its threshold, e.g. `company:<W>:0.67` (or `super-admin:<W>:0.67,admin:<W>,kyc:<W>`): each role's own line (0.5 at most) or the 0.1 default fires only below the §1 refill level. |
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
the merge commit and `curl -s https://devnet.manci.io/api/health` answers
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
   https://devnet.manci.io`; the manual run is `complete` in `alarm_http_runs`
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
   `https://devnet.manci.io/api/health/alarms`, alert on anything but 200.

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
2. raise a `test:` alert as in D.4 but with severity `'high'` (the webhook
   takes high and critical only, `ALERT_WEBHOOK_MIN_SEVERITY`), run
   `invoke_alarm_worker()` again, and confirm `notify_state = 'sent'`, the
   email at the mainnet recipients AND the message on the webhook's channel
   or topic; no `alert-channel-email` or `alert-channel-webhook` incident is
   open on `/admin/compliance` (either one means that channel failed);
3. enable the job (`cron.alter_job(..., active := true)` on
   `mancipatio-alarms-mainnet`);
4. `curl -s -o /dev/null -w '%{http_code}' -H "x-vercel-protection-bypass: $BYPASS" https://<mainnet site>/api/health/alarms`
   answers `200` (read `BYPASS` with `IFS= read -rs BYPASS`; without the
   header Deployment Protection answers until Talas 7, §0A), and the external
   monitor watches it with the same header.

**Gate:** §2–§7 do not start until all four hold. FX rows
only through the Raise limits page by the super admin after bootstrap
(D16); check the EURC mint address against Circle's published address
before saving it. The fx scheduler (automatic USDC rate) is installed and
enabled at D10, after the manual USDC fallback (§15 "Automatic EUR rate");
0080 itself is applied to the mainnet project before `release/mainnet` is
fast-forwarded to a commit that carries it (§15 "Apply migration 0080").

### Sanctions list (8.5, migration 0078)

The screened routes (commit, purchase record, OTC request and escrow
opening, resell listing, passport application and issuance, verification)
check the wallet against the OFAC SDN list's Solana addresses
(`front/lib/server/sanctions.ts`). On mainnet they refuse (503) while the
list is older than 3 days, empty or unreadable, so the list must be loaded
and its daily job running **before the first sale opens**:

1. apply `0078_sanctions_screening.sql` (expand-only);
2. install and prove the job (after the retry scheduler, like the alarms):
   ```
   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/sanctions-scheduler.sql
   MANCI_TARGET=<t> bash scripts/db.sh -c "select mancipatio_ops.invoke_sanctions_refresh()"
   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/sanctions-scheduler-status.sql
   ```
   Pass: the run is `complete` with `refresh_state processed`, and
   `sanctions_list_state` shows today's `refreshed_at`, the Treasury's
   `published_on` and a non-zero `address_count` (4 on 2026-09-23). Then
   enable `mancipatio-sanctions-<network>` (`cron.alter_job(..., active := true)`);
3. `/admin/compliance` → "Wallet screening lists" shows `fresh`. "Refresh
   now" runs the same job by hand. The alarm worker's `sanctions-list`
   incident pages in two steps on mainnet: **medium** as soon as the last
   refresh attempt failed or the list is older than 36 hours (the routes
   still work: fix the job or the parser now), **high** when it is older
   than 3 days, empty or unreadable (the routes refuse from then on).

**A hit** opens one critical alert per wallet (emailed through the alarm
outbox) and the request is refused; an open alert also blocks passport
issuance. The alert's "Prepare the blocklist entry" link opens
`/admin/blocklist` with the wallet filled in: the BlocklistAuthority reviews
and signs `add_to_blocklist` (nothing is sent automatically). The buy
itself cannot be refused off-chain (an Open class mints without the hook,
and the program has no buyer blocklist check), so the buyer is screened
after the fact in two places, and a hit there means the buy **already
landed** (the alert carries the transaction): blocklist, then claw back per
the clawback procedure:
- `launchpad/record-purchase` (route `launchpad/record-purchase`): the
  record is written anyway (it must match the chain) and the hit is
  reported; it never answers 403 or 503;
- the alarm worker (route `on-chain buy (indexer)`, role `onchain-signer`):
  it screens the signer of every finalized `buy`, `create_offer` and
  `take_offer` the indexer delivers, **also for a wallet that calls the
  program with its own script** and never touches the site. With the list
  unusable on mainnet the job stays pending (`SANCTIONS_UNAVAILABLE`) and
  is screened once the list is fresh again.
The sale page's pre-check (`compliance/screen-wallet`) stops a listed buyer
who uses the UI before the wallet opens; that is the only screen that
prevents rather than detects. A wallet on the OFAC list that is not yet on
the on-chain blocklist passes the program also after 8.3, so the
after-the-fact screen stays. What the baseline does not do: EU and
UN lists, batch rescreening of existing holders, risk scoring; those need a
provider (Chainalysis, TRM, …) plugged into `SANCTIONS_PROVIDERS`, and
counsel decides whether the pilot needs them.

**Distribution recipients ("Send to wallets", rehearsal 2026-10-03, no
migration).** The issuer's direct transfers never pass a server, so the
panel screens every recipient (`/api/compliance/screen-recipients`) and the
server now **records each screen**: one `audit_events` row, category
`compliance` (server-only: the unsigned `/api/audit` refuses it, so no
browser can forge one), `ix_name = 'sanctions_screening'`, the share class
as `target_label`, with each wallet's result (`clear`, `hit`, or
`unscreened` off mainnet while the list could not answer), the list
publication used (`list_version`: source, publish date, SHA-256 prefix of
the file) and the run. A record that cannot be written refuses the screen
(503). Right before signing, `/api/compliance/distribution-evidence` checks
that **every** recipient of the run has a screening of that share class
from the last **15 minutes** whose latest result is clear (`unscreened`
passes only where the screen is not enforced), else 409 and the panel
signs nothing; it writes one `distribution_screening_evidence` row (the
evidence id). The panel takes the evidence again at plan time when it is
older than 10 minutes, signs no group with a row whose evidence is older
than 15, and every `share_class_distribution` audit row carries it per
recipient (`metadata.recipients[].screening`: screening id, time, list
version, result, evidence id; `screening_complete`). A sender who sends
outside the site is not stopped by this; the alarm worker does not screen
plain transfers either. Queries:
- one wallet's screenings: `select created_at, actor_wallet, target_label,
  metadata->>'list_version' as list_version, metadata->'results'->>'<wallet>'
  as result from audit_events where category = 'compliance' and ix_name =
  'sanctions_screening' and metadata->'results' ? '<wallet>' order by
  created_at desc;`
- a run's evidence: `select created_at, metadata->'recipients' from
  audit_events where ix_name = 'distribution_screening_evidence' and
  metadata->>'run_id' = '<run id>';`

### Buys by wallets not linked to the platform (D2, 2026-10-03)

Buying share tokens of an Open class needs no KYC, but it needs a wallet
linked to the platform: connected and signed in on the site, the Terms in
force accepted (a `tos_acceptances` row for the wallet and that version,
written by the signed `/api/tos/accept`) and the sanctions screen passed.
The site enforces this before the wallet opens: the Terms gate on the
marketplace (fails closed on mainnet) and the sale page's pre-check
`compliance/screen-wallet` (sanctions first, then the recorded acceptance:
409 without it, 503 when it cannot be read, on mainnet; on devnet only with
`TOS_SERVER_GATE=enforce`). The program cannot: an Open-class `buy` needs
only the buyer's signature, and no program change is planned for it. A buy
made by calling the program directly is not supported, and it is detected
after the fact (`front/lib/server/onchain-link-check.ts`, no migration):

- The alarm worker checks every finalized `buy` the indexer delivers,
  top-level or through another program, Open or KYC-gated. If the buyer has
  no acceptance of the Terms version in force, recorded by 2 minutes after
  the buy's block time, it opens one alert per transaction and buyer:
  source `onchain:unlinked-buy`, **high** on mainnet (medium elsewhere),
  the wallet as subject, the transaction attached, AML (no system
  category). The evidence lists each buy's sale, share class, mint and
  units, plus `via_cpi`, `purchase_recorded`, `account_linked`,
  `terms_version_required` and `terms_accepted` (the wallet's latest
  acceptance, if any). The email shows the label and the time only.
- Anyone can make such buys in any number (fresh wallets, several buyers in
  one transaction), so the email is coalesced: a row is emailed only when
  its wallet has no open or escalated `onchain:unlinked-buy` alert and no
  other `onchain:unlinked-buy` row is still pending in the outbox. The rest
  are written with `notify_state = 'skipped'` and
  `evidence.not_emailed = {reason, alert_id}` (`wallet-alert-open` or
  `alert-pending`, and the row whose email covers it). They are open alerts
  like any other: listed in `/admin/compliance`, blocking the passport.
  One email can therefore stand for many buys: review every open
  `onchain:unlinked-buy` row (Operations query below), not only the one
  the email names. A burst puts about one row per digest into the outbox,
  so it never holds back other alerts.
- The 2 minutes cover a wallet that accepts the Terms right after buying,
  and clock skew. Until then the job waits
  (`onchain_event_jobs.last_error = 'LINK_GRACE'`), then decides once; it
  never stays pending long enough to trip the `event-queue` lag check (5
  minutes). A purchase record alone does not clear the alert. A read or
  write that fails retries the job (`DB_UNAVAILABLE`), never decides.
- The version in force is the deployed one, except for a buy before its
  date or before anyone had accepted it (the minutes before a Terms update
  was deployed, a gap-scan buy processed after it): then any version the
  wallet accepted counts, and `terms_version_required` says `any`.
- An open alert blocks passport issuance for that wallet until it is
  resolved (so it is reviewed before a passport for conversion, D3).

Response:
1. Open the alert in `/admin/compliance`. `via_cpi` true, or no purchase
   record: the buy did not come through the site. `purchase_recorded` true
   without an acceptance: a site buy whose acceptance was not recorded
   (devnet: the Terms gate fails open when the database is unreachable).
   Ask the holder to accept the Terms and resolve with that reason. A
   KYC-gated class's buyer holds a passport: usually resolve with the
   reason too.
2. Decide whether to block **[legal: counsel's criteria]**. Open-class
   units are bearer instruments and move without KYC: if you block, do it
   at once. Units moved out before the block stay out of reach.
3. Block: "Prepare the blocklist entry" opens `/admin/blocklist` with the
   wallet filled in; the BlocklistAuthority reviews and signs
   `add_to_blocklist` (out of band: `chain:emergency` `block`, §11).
4. Claw back: "Claw back <mint>" opens `/admin/kyc` with the holder and the
   share class filled in (one link per mint the buys name). An Admin runs
   the preflight (path `clawback_blocklisted_holder`; the panel opens the
   class's quarantine vault if it is missing), checks the amount and signs.
5. Resolve the alert with the reason and the signatures (this also lifts
   the passport block). Record it in the case file.

Expected false positives: issuer or Operator wallets that buy without having
accepted the Terms (have them accept first); on devnet, a site buy while the
Terms gate failed open (no server check there unless
`TOS_SERVER_GATE=enforce`). On mainnet the pre-check refuses a site buy
without the current version, also from a sale page opened before a Terms
update.

Devnet verification (the alarm cron enabled): a UI buy by a wallet that
accepted the Terms raises nothing; a script buy from a fresh wallet shows
`LINK_GRACE`, then within about 3 minutes a medium alert with the evidence
above; the same wallet accepting at T + 60 s on a second buy raises nothing;
`select signature, status, last_error, attempts from onchain_event_jobs where
last_error = 'LINK_GRACE';` shows nothing pending for longer than 4 minutes.

The script buy is `npm run chain:direct-buy` (from `front/`, **devnet
only**: `CHAIN_NETWORK` must be `devnet`, any other cluster is refused
before `CHAIN_ALLOW_MAINNET` is read, and the RPC is pinned to the devnet
genesis). It builds the sale page's own instructions
(`lib/purchase-builder`: the buyer's two token accounts, then `buy` with its
gate accounts and receiver tail) and sends them with a test key, without the
site's sign-in, Terms gate, sanctions pre-check or purchase record:

1. Make a fresh test key that has never signed in on the devnet site
   (`solana-keygen new --no-bip39-passphrase -o /tmp/direct-buy.json`,
   outside the repository), fund it with devnet SOL and with the sale's
   payment mint (devnet USDC or the test mint), at least
   `units × price_per_unit` base units.
2. Optional, for the exact sale-page transaction (with the document
   acceptance memo): save `GET https://<devnet site>/api/launchpad/terms?sale=<sale>`
   to a file and set `CHAIN_BUY_TERMS` to it. Without it the buy is sent
   bare, as a script would; the alarm treats both alike.
3. Dry run (nothing is signed or sent; it probes the sale, builds, simulates
   and prints the plan digest):
   `CHAIN_NETWORK=devnet CHAIN_RPC_URL=<devnet RPC> CHAIN_OUTPUT=/tmp/direct-buy-1.json
   CHAIN_BUY_SALE=<sale PDA> CHAIN_BUY_UNITS=1 CHAIN_BUY_BUYER=<test key address>
   npm run chain:direct-buy`. Status `awaiting`.
4. Send: the same variables with a new `CHAIN_OUTPUT`, plus `CHAIN_SEND=1`,
   `CHAIN_CONFIRM_PLAN=<digest>` and `CHAIN_KEYPAIR=/tmp/direct-buy.json`
   (it must be `CHAIN_BUY_BUYER`). The evidence file records
   `buySignature`; the transaction is waited for until finalized.
5. Expect, with the alarm cron enabled: the buy's job shows `LINK_GRACE`,
   then within about 3 minutes one open `onchain:unlinked-buy` alert
   (medium on devnet) for the test key in `/admin/compliance`, with
   `purchase_recorded: false` and `terms_accepted: null` in its evidence;
   the Operations query above lists it. Resolve it with the reason "devnet
   verification of the off-platform buy alarm".

### Automatic EUR rate (0080)

The EUR value of USDC that sale approvals, adoptions, the treasury floor and
revaluations count with is no longer only typed in by hand. Every minute
`POST /api/internal/fx` (`front/lib/server/fx-refresh.ts`, the retry
worker's credential, job `mancipatio-fx-<network>`) asks four public
USDC/EUR order books that need no key (Kraken, Coinbase, Bitstamp,
Bitvavo) and the ECB daily reference rate (`eurofxref-daily.xml`, cached 15
minutes), on mainnet and devnet alike (testnet and localnet have no USDC:
the run is skipped), and:

- takes the **median** of the usable answers (a sane, uncrossed book); fewer
  than two is `TOO_FEW_SOURCES`;
- refuses when the answers differ by more than **1 %** of the median
  (`SOURCE_DIVERGENCE`), or when the median is further from 1 / (ECB USD per
  EUR), one USDC taken as one USD, than the **band for the fix's age**
  (`ECB_DEVIATION`: a depeg, a large EUR/USD move since the fix, or broken
  feeds). The ECB fixes once a TARGET working day, so the anchor is up to
  ~1.6 days old on an ordinary day, 3.6 over a weekend and 5.6 at Easter:
  the band is 2.5 % for a fix up to a day old (counted from 00:00 UTC of its
  date), one point more per further day, at most 5 %
  (`lib/fx-auto.ts` `ecbTolerance`; each run records the band it used,
  `ecb_tolerance_bps`). Without an ECB rate younger than 6 days
  `ECB_UNAVAILABLE` / `ECB_STALE` (a new instance whose ECB request fails
  falls back to the anchor the last accepted run stored, while it is younger
  than that); without the mint's decimals from chain within the run's
  15-second budget `DECIMALS_UNAVAILABLE`; a rate or refusal the
  database's CHECKs refuse (the 0.2–5 EUR bounds of the rate columns) is
  recorded as refused `INVALID_FX_RATE` (if even that is refused, the run
  answers failed `INVALID_FX_RATE`, HTTP 503, the code in `fx_http_runs`);
- otherwise writes `public.fx_auto_rates` (valid **15 minutes**, with the
  per-source quotes and the ECB anchor). Every run, accepted or refused, is a
  row of `public.fx_rate_observations` (kept 30 days). Rate limit, before
  any source is asked: `claim_fx_auto_run` takes the run's slot atomically
  (per-mint lock; no observation and no other claim within 20 seconds), so
  concurrent calls (a leaked worker secret, a runaway scheduler) answer
  `skipped THROTTLED` without asking anyone, and a run whose recording fails
  still holds its slot. The writers refuse a second observation within 20
  seconds as well.

A refusal is about the whole run: the median is not taken over the sources
that agree. One venue answering a wrong but plausible price (a sane book
more than 1 % away from the others) refuses every run (`SOURCE_DIVERGENCE`)
until it is fixed or removed; the automatic rate then goes stale after 15
minutes and the manual fallback counts. Only a source that does not answer
at all (`TIMEOUT`, `HTTP_ERROR`, `PARSE_ERROR`, …) is simply left out while
two usable ones remain.

The rate that counts (`public.fx_effective_rate`; `front/lib/fx-effective.ts`
is the same rule): an `eur_peg` row; else a manual row ticked **override**;
else a fresh automatic rate; else a fresh manual row (the **fallback**);
else the most recently observed one, which reservations refuse as
`FX_RATE_STALE`; neither row is `FX_RATE_MISSING`. A reservation still locks
the rate it was made at with its source (`auto: median of … (ECB <date>: …)`
or the manual source), and booking never uses a newer one.

#### Apply migration 0080

Apply 0080 to each network's database BEFORE a front that carries the
automatic rate (PR #53) is built for that network: the new front reads
`fx_auto_rates` and calls `claim_fx_auto_run`, and its fx route answers
`failed NOT_INSTALLED` without them. Which push builds which front decides
the order:

1. **devnet 0080, then merge #53.** `main` deploys the devnet project, so
   the merge itself is the devnet front deploy;
2. **mainnet 0080, then fast-forward `release/mainnet`** to that `main`.
   The mainnet Vercel project (`manci-mainnet`) builds only its production
   branch `release/mainnet` (Ignored Build Step: only production), so the
   merge to `main` does not touch mainnet, and the fast-forward is the
   mainnet front deploy;
3. then, at §0A D10, the super admin's fresh manual USDC fallback, and only
   after it the fx scheduler ("Install, prove, enable" below).

Expand only: without automatic rows every reader behaves as before. The
file is frozen at sha256
`5e7d01d37c18428df99b8a55eb7b44400a3d676f22dac3f2a01a32763a42943d`
(`shasum -a 256 supabase/migrations/0080_fx_auto_rates.sql` first). Devnet:

```
bash scripts/ops/backup.sh devnet pre-0080
MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0080_fx_auto_rates.sql
MANCI_TARGET=devnet bash scripts/db.sh -c "insert into supabase_migrations.schema_migrations(version,name) values ('0080','fx_auto_rates') on conflict (version) do nothing"
MANCI_TARGET=devnet bash scripts/db.sh -c "select to_regprocedure('public.claim_fx_auto_run(text,text)') is not null as claim, to_regprocedure('public.fx_effective_rate(text,text)') is not null as resolver, (select count(*) from pg_constraint where conname like 'fx_%_eur_per_token_bounds') as bounds, has_table_privilege('service_role','public.fx_auto_rates','SELECT') as service_reads, has_table_privilege('service_role','public.fx_auto_rates','INSERT') as service_writes, (select count(*) from public.fx_auto_rates) as automatic_rows, (select version from supabase_migrations.schema_migrations where version='0080') as recorded"
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/preflight/supabase-readonly-identity.sql
```

Mainnet: the same with `MANCI_ALLOW_MAINNET=1` (`backup.sh` needs it too;
its mainnet dump is schema-only, PITR is the restore point):

```
export MANCI_ALLOW_MAINNET=1
bash scripts/ops/backup.sh mainnet pre-0080
MANCI_TARGET=mainnet bash scripts/db.sh -f supabase/migrations/0080_fx_auto_rates.sql
MANCI_TARGET=mainnet bash scripts/db.sh -c "insert into supabase_migrations.schema_migrations(version,name) values ('0080','fx_auto_rates') on conflict (version) do nothing"
MANCI_TARGET=mainnet bash scripts/db.sh -c "select to_regprocedure('public.claim_fx_auto_run(text,text)') is not null as claim, to_regprocedure('public.fx_effective_rate(text,text)') is not null as resolver, (select count(*) from pg_constraint where conname like 'fx_%_eur_per_token_bounds') as bounds, has_table_privilege('service_role','public.fx_auto_rates','SELECT') as service_reads, has_table_privilege('service_role','public.fx_auto_rates','INSERT') as service_writes, (select count(*) from public.fx_auto_rates) as automatic_rows, (select version from supabase_migrations.schema_migrations where version='0080') as recorded"
MANCI_TARGET=mainnet bash scripts/db.sh -f scripts/preflight/supabase-readonly-identity.sql
unset MANCI_ALLOW_MAINNET
```

Pass: `t | t | 2 | t | f | 0 | 0080`, and the identity preflight still shows
`tables_without_guard` `[]` and `defaults_not_dynamic` `{}`. Only then
merge (devnet) or fast-forward (mainnet).

`supabase_migrations.schema_migrations` is bookkeeping: `db.sh` applies
the file whatever it lists, and the verification query proves the objects,
not the row. The insert is `on conflict (version) do nothing`, so
re-running the block is harmless (0080 itself is re-runnable). The
hand-applied migrations before it were recorded the same way: devnet lists
0075–0079, and the mainnet bootstrap of 2026-09-30 recorded 0001–0079. An
earlier version missing from a list is not a fault.

#### Install, prove, enable

After 0080, the front that carries it and the retry scheduler; at §0A D10
on mainnet, and in any case only after the super admin has seeded a fresh
manual USDC fallback on `/admin/limits` (kind `rate`, max age at most 7 days
on mainnet). Devnet:

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -c "select mancipatio_ops.invoke_fx_refresh()"
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-scheduler-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -c "select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-devnet'"
```

Mainnet:

```
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-scheduler.sql
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -c "select mancipatio_ops.invoke_fx_refresh()"
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-scheduler-status.sql
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -c "select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-mainnet'"
```

The install leaves the job disabled; enable it (the last line) only when
the status passes: the run is `complete` with `refresh_state accepted`,
`fx_auto_rates` holds the network's USDC with `fresh = t`, and the
effective row shows `origin auto` (a `refused` run is complete too: read
its `code` and the ECB deviation next to its band, `ecb_deviation_bps` /
`ecb_tolerance_bps`, before enabling). `/admin/limits` then shows the
automatic rate, its sources, the ECB anchor and the last run; `/api/health`
`checks.paymentFx.origin` is `auto`. The install refuses while
`fx_effective_rate` is the manual-only resolver of the rollback below:
re-apply 0080 first.

Keep the manual USDC row seeded as the fallback (kind `rate`, max age at
most 7 days on mainnet): `fx:fallback` and `/api/health`
(`fallback_missing` / `fallback_stale`) report it while the automatic rate
counts. Tick **Override the automatic rate** only to pin a rate on purpose
(a feed you distrust); `/api/health` warns `manual_override` while it
counts, and `/admin/limits` warns (without refusing) when the override is
more than 2 % away from a current (fresh) automatic rate; against a stale
one it does not warn. Every manual write (save or delete) is an audit
event (`fx_rate_update` / `fx_rate_delete` on `/admin/audit`, category
Launchpad) with the kind, rate, max age, override flag, the row it
replaced and the fresh automatic rate with the gap to it. An override past
its own max age still counts (fail-closed): approvals refuse
`FX_RATE_STALE` until it is renewed or saved unticked. A front deployed
ahead of 0080 still saves a manual rate (without the column); only an
override is refused until 0080 is applied.

**Off switch** (no rollback needed): BOTH halves, the job disabled AND the
network's automatic rows deleted (a disabled job alone leaves a fresh
automatic rate counting for up to 15 minutes; deleted rows alone come back
with the next run).

1. **Before it**, check that the manual USDC row is fresh
   (`fx-scheduler-status.sql`, the manual rows: `fresh`; or `/admin/limits`)
   and refresh it on `/admin/limits` FIRST if it is not: from the delete on
   it is the rate that counts, and a stale one makes approvals refuse
   `FX_RATE_STALE`.
2. Run the one file (about 45 seconds). It disables the job and commits,
   waits 40 seconds for a run already in flight (the job's statement
   timeout is 30 s, its HTTP call stops at 25 s, the route's `maxDuration`
   is 30 s), deletes the network's automatic rows, and after a 5-second
   settle checks that the job is still disabled and no automatic row came
   back. An ERROR "NOT off: …" means just that: run it again. The last
   result set shows the manual rows that count from then on:

   ```
   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-auto-off.sql
   MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-auto-off.sql
   ```

3. The off switch itself raises `fx-auto-stale` for a few minutes: right
   after the delete there is no automatic row while the job ran in the last
   5 minutes (medium on mainnet; high only if the mint is in use and no
   fresh manual row covers it, which step 1 prevents; low elsewhere). Once
   the last run is 5 minutes old the job counts as off and the `fx-*` checks
   pass; an incident clears after 3 passes and 5 minutes without a failure.
   Clearing takes about **10 minutes** in all.

Back on: if the manual-only resolver of the rollback below was applied,
re-apply 0080 first (`db.sh -f supabase/migrations/0080_fx_auto_rates.sql`;
`fx-scheduler.sql` refuses otherwise); then install, prove and enable as
above.

The alarm worker watches the job (`fxAutoReports`; nothing while there is
no automatic row and no run in the last 5 minutes: before the first run, or
from about 5 minutes after the off switch):

| Incident | Severity | Fails when |
|---|---|---|
| `fx-auto-stale:<mint>` | high only on mainnet for a mint in use (a live approval, an open sale or a raise limit hold paid in it, as `fx-stale`) when no fresh manual rate covers it; otherwise medium on mainnet, low elsewhere (never emailed) | the automatic rate is past its 15 minutes, or there is none while the job runs (a run in the last 5 minutes) |
| `fx-fallback:<mint>` | medium (missing: medium on mainnet, low elsewhere) | while the automatic rate counts, the manual fallback behind it is missing, past its max age, or within 2 days (at most half its max age) of it |
| `fx-source-down:<mint>` | medium | a source gave no usable answer for 15 minutes while the job runs |
| `fx-depeg:<mint>` | high | the newest three price verdicts since the last accepted run (`ECB_DEVIATION` / `SOURCE_DIVERGENCE`; other refusal codes are skipped) are all refusals and at least one is `ECB_DEVIATION`: the median deviates from the ECB reference of that date by more than the band for its age (fewer: hold). The two codes alternate in a real depeg, so they count together |
| `fx-divergence:<mint>` | medium | the same three verdicts are all `SOURCE_DIVERGENCE` (fewer: hold; mixed with `ECB_DEVIATION`: hold, `fx-depeg` reports it) |
| `fx-jump:<mint>` | medium | the accepted rates of the last hour moved more than 1 % (hold above 0.5 %) |

`fx-expiring` and `fx-stale` judge the rate that counts: while the automatic
rate is fresh a stale manual row raises neither (`fx-fallback` reports it
instead), and `fx-expiring` is about a manual rate only.


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
| `onchain:low-balance` (`sol-balance:<address>`, high) | Top the key up to its "Fund" line (§1 Operational budget per key) from the company's funds; it clears once the balance stays at or above 1.25 × its threshold. A balance that dropped without an operation you know of: compare with the signer matrix, unexpected = compromised key, §11. |
| `onchain:squads-config` (`squads-config:<multisig>`, critical) | Members, threshold, time lock or config authority differ from `ALARM_SQUADS_CONFIG` (the role map). A change you approved: update the role map and `ALARM_SQUADS_CONFIG`, redeploy. Unexpected: incident (§11), tell the Squads members, pause if the upgrade authority may be lost. |
| `onchain:squads-proposal` (`squads-proposal:<proposal>`, Approved/Executing or unreadable critical, Draft/Active high) | Compare with the proposal you expected (§9: the upgrade's buffer, hash and the members who approve). Expected: nothing to do, it clears once the proposal is final (executed, rejected or cancelled) or stale. Unexpected: incident (§11); members reject it and do not execute. |
| `fx:expiring` (`fx-expiring:<mint>`, medium) | Refresh the EUR rate on the Raise limits page (`/admin/limits`) before its max age: past it `fx:stale` follows and the sales that need the rate stop (on mainnet `/api/health` fails for the default mint). Since 0080 only a manual rate that counts expires this way (the automatic one is renewed every minute). |
| `fx:auto-stale` (`fx-auto-stale:<mint>`, low / medium / high) | The fx job stopped or every run is refused: `fx-scheduler-status.sql` (outcome, `code`, the quotes), the Vercel logs of `/api/internal/fx`. Medium (mainnet): the manual fallback counts meanwhile, or nothing is paid in the mint yet; check that the fallback is recent. High (mainnet, the mint in use): no fresh rate counts and approvals refuse: refresh the manual rate on `/admin/limits` now, then fix the job. Low: off mainnet. Switched off on purpose: the off switch above raises it itself for a few minutes and it clears after about 10 minutes (§15 "Off switch" step 3); after an Instant Rollback to a front older than #53 it is closed by hand (§10). |
| `fx:depeg` (`fx-depeg:<mint>`, high) | The USDC/EUR median deviates from the ECB reference of the date the summary names by more than the band (2.5 % growing to 5 % with the fix's age): a USDC depeg, a large EUR/USD move since the fix, or broken sources. Check a venue and EUR/USD by hand. A real depeg: the last automatic rate counts for its 15 minutes, then the manual fallback; decide with the owner whether to pin a manual override (and at which rate) or to stop approvals. A broken ECB file or source: the status SQL shows the quotes. |
| `fx:fallback` (`fx-fallback:<mint>`, medium; low off mainnet when missing) | The automatic rate counts, but the manual fallback behind it is missing or (about to be) out of date: if the automatic rate stops, approvals stop 15 minutes later. Refresh the manual USDC rate on `/admin/limits` (unticked, not an override). |
| `fx:divergence` (`fx-divergence:<mint>`, medium) | Every run is refused: the automatic rate is NOT written and, 15 minutes after the last accepted run, the manual fallback counts (`fx:auto-stale` follows; check the fallback is recent). The evidence (`sources`) shows the venue that is off. One venue wrong: remove or replace it in `front/lib/fx-auto.ts` (`FX_SOURCES`) and deploy; a disorderly market: wait, or pin a manual override with the owner. |
| `fx:source-down` (`fx-source-down:<mint>`, medium) | One venue gives no usable answer (the evidence names it); the others carry the rate while at least two answer. If it persists, replace the source in `front/lib/fx-auto.ts`. |
| `fx:jump` (`fx-jump:<mint>`, medium) | The automatic rate moved more than 1 % within an hour: compare with the market (EUR/USD does move that much on central-bank days). Unexpected: pin a manual override on `/admin/limits` and investigate. |
| `worker:alert-channel` (`alert-channel-email` or `alert-channel-webhook`, high) | That channel failed a digest; the other one delivered this alert. Fix the channel (SMTP or Resend; `ALERT_WEBHOOK_*`: §11 "SMTP down"), send a test alert, re-queue what gave up (Operations); it clears after three digests it delivers. |
| `worker:ops-watch-config` | `ALARM_BALANCE_WATCH` or `ALARM_SQUADS_CONFIG` does not parse: correct it and redeploy (no balance or Squads watch until then). |
| v1.0.0-rc role changes, all critical: `onchain:admin-grant` (propose / cancel an Admin grant), `onchain:admin-record` (`add_admin`, the new key executes it; `remove_admin`, instant: a Super Admin removing Admins also removes their veto, K1.1c), `onchain:platform-admin` (Super Admin rotation propose / accept / cancel), `onchain:platform-recovery` and `onchain:blocklist-recovery` (the upgrade authority's recoveries: propose / cancel / execute), `onchain:blocklist-authority` (rotation propose / accept / cancel) | Compare with the signer matrix and the change you planned (§19). Unexpected proposal: cancel it inside its window (Admin grant and Super Admin rotation: the Super Admin, any Admin or the upgrade authority; Super Admin recovery: the Super Admin or the upgrade authority; blocklist recovery or rotation: the blocklist authority, or the upgrade authority for a recovery), then treat the proposer's key as compromised, §11. Unexpected execute or accept: incident, §11. |
| `onchain:role-change-pending` (`role-change-pending`, high) | The "timelock running" incident: a staged Admin grant, Super Admin rotation or upgrade-authority recovery is live (the evidence counts each kind and names the next eta). Expected: nothing to do, it clears once each one is executed, cancelled or expired. Otherwise as the row above. |
| `onchain:issuer-freeze` (critical) | A freeze: confirm it with the Admin who froze (the reason's SHA-256 is in the evidence and on `/admin/issuers`; the text is in the audit log); follow the freeze SOP (O-9). An unfreeze: only the Super Admin can; confirm the decision. |
| `onchain:frozen-issuer-activity` (high) | A frozen issuer's authority wallet traded or moved units (the evidence names the issuer, its role and the instructions). Check the transaction and decide at once whether the BA blocks the wallet (§11 "Issuer proceeds freeze", O-9); record the decision in the freeze's case file. |
| `onchain:unlinked-buy` (high on mainnet, wallet as subject, AML) | A buy by a wallet without the Terms in force accepted by 2 minutes after it (D2). Follow §15 "Buys by wallets not linked to the platform": check the evidence, decide **[legal]**, block (BlocklistAuthority), claw back (Admin), resolve with the reason. |
| `onchain:bootstrap-open` (`bootstrap-open`, critical, mainnet) | Bit 0x80 is open while an emergency area is clear: add_admin and the Super Admin rotation run without their 48 hours (typically a rollback to rc.x that unpaused, §10). Or it is still open, every area paused, 72 hours after the Platform's first indexed transaction (`initialize_platform`; the evidence has `opened_at` and `hours_open`): Day D is over and S5c was forgotten (K1.11). Either way the SA closes it at once on `/admin/platform` ("Close bootstrap window", `set_pause_flags(0, 0x80)`); then review every Admin grant and rotation since the rollback or since Day D (§11). The half of the rule that needs the role map (bit 7 still open once the final SA holds the platform, sooner than 72 hours) is checked by `chain:inventory` only. |
| `onchain:payout-modules` (`payout-modules`, critical, mainnet) and `onchain:pause` "Payout modules switched ON" | Bit 0x40 must stay set on mainnet (D2). Unexpected: set it again (`set_pause_flags(0x40, 0)`, any Admin) and treat the Super Admin key as compromised, §11. |
| Admin actions that move money or tokens: `onchain:vault-vote`, `onchain:yield-route`, `onchain:milestone`, `onchain:proposal`, `onchain:supply-lock`, `onchain:custody-vault`, `onchain:sale-approval` | Compare with the signer matrix and the admin decision behind it (the request or approval on the admin pages). A short voting window (critical or high) is checked with the issuer. Unexpected: that Admin key is compromised, §11 ("An Admin key compromised or lost"). |

### Operations

- Re-queue notifications that gave up (after fixing SMTP):
  `update compliance_alerts set notify_state='pending', notify_attempts=0, next_notify_at=now() where notify_state='failed';`
  (a `failed` notification on an open alert keeps `/api/health/alarms` at 503
  until it is re-queued and sent, or the alert is resolved).
- Clear a hold after a manual review (the fact is counted another way):
  `select public.clear_capacity_hold(public.deployment_network(), '<subject>', '<ref>');`
  then resolve the related alerts.
- Delivery is at-least-once: a digest that timed out may arrive twice.
- Buys by wallets not linked to the platform (D2), newest first:
  `select created_at, severity, wallet, tx_signature, status, notify_state, evidence->'buys' from compliance_alerts where source = 'onchain:unlinked-buy' order by created_at desc limit 20;`

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
- 0080: all of it, in this order (not either/or):
  1. FIRST make sure the manual USDC row is fresh (refresh it on
     `/admin/limits` if not): from the delete on it is the rate that counts;
  2. the off switch, one file that disables `mancipatio-fx-<network>` AND,
     after waiting for a run in flight, deletes the network's
     `fx_auto_rates` rows (§15 "Off switch"; an ERROR "NOT off" means run
     it again):
     `MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-auto-off.sql`,
     on mainnet
     `MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-auto-off.sql`;
  3. optionally, only after that, make the resolver manual-only (the
     ledger functions keep calling it):
     `MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-manual-only.sql`,
     on mainnet
     `MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-manual-only.sql`
     (a file: the function's `$$` body inside `db.sh -c "..."` would be
     expanded by the shell; it refuses while the job is active or any
     automatic row of the network is left).

  The off switch raises `fx-auto-stale` itself for a few minutes; it clears
  after about 10 minutes (with a front older than #53, by hand: §10).
  Tables, column and writers stay. Back on: re-apply 0080 (it restores the
  resolver and its comment; `fx-scheduler.sql` refuses to install over the
  manual-only one), then install, prove and enable. Re-applying 0066 or
  0073 (their own rollbacks) restores the direct `fx_rates` reads, so
  re-apply 0080 after them.

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
- The digest reads critical rows first, then high, then fills the rest
  (oldest first within each): a backlog of high rows never holds back a
  newer critical one.
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

### 6.4 drill: redelivery, lost delivery, full reconcile (devnet)

What it proves on the live stack (gap 2026-09-28 podaci-infra-9,
ops-qa-12): a redelivered transaction changes nothing, a lost one comes back
through the gap scan and alarms, the heartbeat stops advertising the mirror
while it is missing, and how long a full reconcile takes. The same four
cases, plus snapshots applied out of order, run offline in CI on the
migration chain (`tests/indexer-resilience.postgres.test.ts`); the
reconcile's cost per account comes from `npm run ops:reconcile-bench`
(below). Evidence goes to `docs/mainnet-readiness/drill-6.4/`.

Preconditions: the devnet heartbeat in `on` (status script above), the
retry and alarm schedulers active (`retry-scheduler-status.sql`,
`alarm-scheduler-status.sql`), no pending `indexer_jobs`, and the Helius
devnet webhook enhanced, type ANY, with the 4 addresses (§15). Run from
`front/`. Every check below is read-only:

```
MANCI_TARGET=devnet bash scripts/db.sh -Atq -v sig=<signature> -f scripts/ops/indexer-drill-status.sql
```

With `-Atq` (unaligned, tuples only, quiet) it prints exactly the lines
this section quotes: first `events|jobs|alarm_jobs|alerts` for that
transaction, then one row each for the event (`delivery`: `webhook` or
`gap-scan`), the indexer job, the alarm job, the sync state, the heartbeat,
the last gap scan and the indexer incidents, each starting with its name
and in the column order of `scripts/ops/indexer-drill-status.sql` (CI runs
it the same way, after `assert-target.sql`). Without `-Atq` psql prints
aligned tables with headers instead.

**D1. Redelivery.** Make one devnet transaction that invokes asset_registry
(a KYB step on `/admin/issuers` is enough); call its signature S1. Within
about two minutes the status shows `1|1|1|n`, `delivery` `webhook` and the
indexer job `complete`. Record `n` and the job's `attempts`, A. A is
usually 1; it is 2 when the retry run took the job before S1's slot was
finalized (about 13 s after it: the job reads at `finalized` with
`minContextSlot` = the event's slot, so that run leaves it `pending` and a
run a minute or two later completes it). One pending attempt before finality
is normal, the same path the offline case 4 proves. Deliver S1 again: in the
Helius dashboard (Webhooks → the devnet webhook → logs) resend that
delivery, or replay its logged request body (a JSON array, saved as
`d1-s1.json`) yourself, reading the webhook's authentication header without
echoing it:

```
REF=$(node scripts/ops/target.mjs devnet | cut -d'|' -f2)
printf 'Helius auth header: '; IFS= read -rs HELIUS_AUTH; echo
for i in 1 2; do printf 'Authorization: %s\n' "$HELIUS_AUTH" | curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "https://$REF.supabase.co/functions/v1/helius-webhook" \
  -H @- -H 'Content-Type: application/json' --data @d1-s1.json; done
unset HELIUS_AUTH
```

The header reaches curl on its standard input (`-H @-`, curl 7.55 or later;
`printf` is a shell builtin), so the secret is never a process argument that
`ps` or process accounting would show, the same rule as D4/D6: never on a
command line.

Expected: `202` each time; the status still `1|1|1|n` with the same `n`,
the job still `complete` with the same `attempts` A (nothing reopened, the
mirror not written again), `sync` `ready`. Anything else is a failed drill.

**D2. Lost delivery.** Break the webhook's delivery: Helius dashboard →
edit the devnet webhook → Authentication Header: append `-drill` → re-select
transaction type ANY (the edit form shows it empty) → save. Do not
screenshot that form (it shows the header in clear). Note the time T0 and
make one devnet transaction as in D1 (S2). Expected, by the clock:

- T0 + 2–4 min: `heartbeat` `last_reason` `UNINDEXED_SIGNATURE`,
  `last_expired_at` set, `sync` `checked_age_seconds` over 300 (the site
  reads the chain; the Issuers / Assets / Launchpad / Governance badges go
  muted). The status for S2 is `0|0|0|0`.
- T0 + 5–10 min (the first gap scan whose window, 20 to 5 minutes back,
  holds S2): `1|1|1|n` with `delivery` `gap-scan` and the alarm job's
  `source` `gap-scan`; incident `indexer-gap` open (`last_fail_at` set) and
  an `indexer:gap` alert (high, emailed: "1 finalized program
  transaction(s) were missing from the index (1 re-queued)").
- One or two minutes later: the indexer job `complete`, the heartbeat
  `bumped` again, `sync` fresh.
- About 15–20 min after the repair: `indexer-gap` `cleared_at` set (three
  passing scans and 5 minutes).

At T0 + 25 min restore the header (edit → the original value → ANY →
save). In the Helius logs, record every attempt of S2's delivery (count,
times, status codes): that is Helius's retry window (G9, §14). A retry that
arrives after the restore answers `202` and leaves S2 at `1|1|1|n` (D1
again). Resolve the drill's `indexer:gap` alert in `/admin/compliance` as
planned.

**D3. Full reconcile, timed.** The operator runner (read-only on the chain:
it allows only `getGenesisHash` and `getProgramAccounts`; it writes the
devnet mirror like `/admin/health` → Reconcile) with the devnet keys of
`.env.local`:

```
MANCIPATIO_RECONCILE=devnet \
MANCIPATIO_RECONCILE_PROJECT=$(node scripts/ops/target.mjs devnet | cut -d'|' -f2) \
MANCIPATIO_RECONCILE_OUTPUT=../docs/mainnet-readiness/drill-6.4/reconcile-devnet.json \
  npx vitest run --config scripts/ops/reconcile-index.config.ts
```

Expected: the summary's `readiness` `ready` at `context_slot`, `legacy`
`[]`, and after D1–D2 every table with `missing` 0, `rebuilt` 0 and
`deleted` 0 (the jobs and the gap scan already caught up; a non-zero value
is an account those paths missed: investigate before mainnet).
`elapsed_ms` is the duration: with today's ~40 devnet accounts, a few
seconds. The offline benchmark (`RUN_LOCAL_POSTGRES_TESTS=1
POSTGRES_BIN=<PostgreSQL 17 bin/> npm run ops:reconcile-bench`, 28.9.,
the slower of the cold and the warm run at each size; a routine reconcile
over an existing mirror is warm, and was the slower one at 20 000 and
50 000 accounts: about 0.54 ms per program account plus about 4.4 s fixed, with a 20 ms
database round trip, 1 s per provider scan and 20 MB/s) puts the 45 s
route budget at about 75 000 program accounts, and the single registry
scan under 2 s at 50 000 (the per-call bound is 12 s). Its decoding and
database time were measured on a laptop's CPU and a local PostgreSQL, not
on a Vercel function or the Supabase instance, so the figure is an
estimate; D3's `elapsed_ms` is the measurement. Rule: on mainnet,
once `elapsed_ms` passes 20 s or the summed `onchain` counts pass 30 000,
plan the reconcile's split into resumable per-table runs before the next
growth step; decoding and the snapshot writes dominate, so splitting only
the scan would not help.

**Mainnet: D1 and D3 again, after D10 and before D11 (§0A).** Not
earlier: before §2 (D9) the programs do not exist and nothing before D9
touches the chain, so there is no asset_registry transaction to redeliver,
and a reconcile of an undeployed program is trivially `ready` with an
`elapsed_ms` that measures nothing. After D10 the mirror holds the
bootstrap's real accounts, and the site is still behind Deployment
Protection, so a failed drill stops the sequence before the first public
user. No transaction is made for the drill (a mainnet KYB step would be
real issuer state): D1 redelivers S1 (`initialize_platform`, §4 cycle 1; its
signature is the step `S1` line of `$E/04b-bootstrap-send.json.journal.jsonl`),
whose indexer job completed on Day D. Record `n` and A first, then resend
S1's delivery from the Helius dashboard (the mainnet webhook's logs), or
replay its logged body with the mainnet webhook's own authentication header
(the mainnet project's receiver checks its own secret, never the devnet
one):

```
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -Atq -v sig=<S1> -f scripts/ops/indexer-drill-status.sql
REF=$(MANCI_ALLOW_MAINNET=1 node scripts/ops/target.mjs mainnet | cut -d'|' -f2)
printf 'Helius mainnet auth header: '; IFS= read -rs HELIUS_AUTH; echo
for i in 1 2; do printf 'Authorization: %s\n' "$HELIUS_AUTH" | curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "https://$REF.supabase.co/functions/v1/helius-webhook" \
  -H @- -H 'Content-Type: application/json' --data @d1-s1.json; done
unset HELIUS_AUTH
MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -Atq -v sig=<S1> -f scripts/ops/indexer-drill-status.sql
```

Expected as in D1: `202` each time, the same `n` and A, `sync` `ready`.
Then D3, with the mainnet env file named explicitly (there is no
`.env.local` default on mainnet):

```
MANCI_ALLOW_MAINNET=1 MANCIPATIO_RECONCILE=mainnet \
MANCIPATIO_RECONCILE_PROJECT=$(MANCI_ALLOW_MAINNET=1 node scripts/ops/target.mjs mainnet | cut -d'|' -f2) \
MANCIPATIO_RECONCILE_ENV_FILE=<mainnet env file> \
MANCIPATIO_RECONCILE_OUTPUT=../docs/mainnet-readiness/drill-6.4/reconcile-mainnet.json \
  npx vitest run --config scripts/ops/reconcile-index.config.ts
```

Expected: `readiness` `ready`, `legacy` `[]`, and `missing`, `rebuilt` and
`deleted` 0 in every table (the bootstrap's jobs already wrote every
account; a non-zero value is an account they missed: investigate before
D11). D2 is a devnet drill only.

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
| Operator: registered name; short name, or `{ notAssigned: <reason> }` where the register has none; registered office; the company registration number and the tax identification number, each as `{ value, label, shortLabel }` under the name its jurisdiction gives it (Serbia: `registration number (MB)` / `MB`, `tax ID (PIB)` / `PIB`; BVI: `BVI company number`), the tax number `{ notAssigned: <reason> }` only once the owner confirms in writing that none is assigned (`null` until then); register; optional registered agent and date of incorporation; governing law, forum for disputes; legal / privacy / security addresses, optional support and DPO addresses (support `null` = the contact form) | `front/lib/legal/operator.ts` (`OPERATORS.mainnet`) | owner (company data; governing law and forum: BVI, 2026-09-30) |
| Licence: authority, decision number and date, licensed services, register entry | same record, `licence` | owner, from the decision |
| Mainnet Terms, Privacy Policy, acceptance-dialog summary | `front/lib/legal/mainnet-copy.ts` | counsel |
| Purchase risk warning (drafted against ZDI art. 15(2), i.e. for a Serbian operator; see below) | `front/lib/legal/risk-warning.ts` (`status: "counsel"` once approved) | counsel |
| External audit: firm, scope, date, public report URL (linked from `/risks` and `/about`) | `front/lib/legal/audit.ts` (`SECURITY_AUDIT`) | owner, when the report exists |

The pages render every number under the name stored with it (footer
`<shortLabel> <value>`, legal pages `<label> <value>`, `/legal/company` the
label as the row title); no jurisdiction's names are written in code. A
plain `null` short name or tax number is "not filled in" (or not yet
confirmed) and refused; only an explicit `{ notAssigned: <reason> }` passes
(the reason is kept for review and not rendered; a reason still marked "to
be confirmed" is refused). The registration number has no such exemption.

**State on 2026-09-30.** `OPERATORS.mainnet` is filled from the Certificate
of Incorporation (name, company number, date of incorporation, and the
register as the certificate names its issuer) and the Memorandum of
Association (§3 registered office, §4 registered agent): **Manci
International Ltd.**, a BVI business company limited by shares, BVI company
number 2219023, incorporated 2026-09-28, registered office (the registered
agent's office) Trinity Chambers, PO Box 4301, Road Town, Tortola, British
Virgin Islands, registered agent SHRM Trustees (BVI) Limited, register:
Registrar of Corporate Affairs, BVI Financial Services Commission (the
certificate's text names "the Registrar of Corporate Affairs, of the British
Virgin Islands"; its seal, an image outside the PDF's text layer, adds "BVI
Financial Services Commission"; no public link to the company's entry is
recorded).
Short name: `{ notAssigned }` (both documents give a single registered
name). Tax identification number: `null` — neither document mentions one,
and **the owner is to confirm** in writing whether one is assigned; then
record the number under its name, or `{ notAssigned: <reason> }` with the
date of the confirmation. No licence (counsel's written opinion →
`MAINNET_LICENSE_NOT_REQUIRED=true`; record the opinion's reference in
MAINNET-PLAN.md). Contacts unchanged (the security address equals
`public/.well-known/security.txt` and both programs' security.txt; a test
checks all three). Governing law and forum (owner's decision 2026-09-30):
the laws of the British Virgin Islands and the courts of the British Virgin
Islands (counsel may replace the forum with arbitration). Still missing (the
"mainnet legal slots" report lists exactly these): `taxId` (owner), the
licence or the waiver, the mainnet Terms, Privacy Policy, acceptance-dialog
summary and counsel's risk warning.

**State on 2026-10-02 (owner's decisions in chat that day).** The slots are
complete; the "mainnet legal slots" report says so with
`MAINNET_LICENSE_NOT_REQUIRED=true`, and a mainnet build is refused only
without that waiver (no licence is recorded):
- Tax identification number: `{ notAssigned }`. The owner confirmed in
  writing that the company has none (BVI business companies are not
  assigned one).
- Counsel approved the drafts of 2026-09-30 (the mainnet kit's
  `05-mainnet-copy.draft.ts` and `06-privacy.draft.ts`; the `[COUNSEL]`
  notes of the `.md` versions are not on the site). Terms, acceptance-dialog
  summary and Privacy Policy are in `mainnet-copy.ts` verbatim, dated
  `2026-10-02`. The Terms version every mainnet wallet accepts is therefore
  `2026-10-02` (the dialog shows `v2026-10-02`; `tosVersionFor("mainnet")`
  has no fallback any more). The purchase risk warning is the draft's,
  `status: "counsel"`.
- One wording change by the owner: Privacy clause 11 now names which keys a
  hardware wallet holds. The company's Ledger holds super admin, KYC
  authority, BlocklistAuthority and treasury; a Squads multisig whose member
  is a separate Ledger holds the upgrade authority; the second administrator
  uses a software wallet. If that changes (§19, the role map), clause 11
  changes with it. The clause describes the state after the handover (§7
  S7, §19), so before the site is public (§0A D11) check it: the 07c
  `handed-over` inventory has 0 blockers (the chain equals the role map:
  super admin, Blocklist Authority, `kyc.authority`, the treasury, every
  Admin record, both upgrade authorities on the Squads vault), and the role
  map itself matches the clause (`superAdmin`, `kyc.authority`,
  `blocklistAuthority` and `protocolTreasury` are the company Ledger; the
  Squads member is a separate Ledger; `admins` is the one software-wallet
  administrator). If either differs, change clause 11 first.
- Still for the owner before the Production build: counsel's written licence
  opinion on file (its reference in MAINNET-PLAN.md), then
  `MAINNET_LICENSE_NOT_REQUIRED=true`. After the review of the rendered pages
  (step 4 below), `MAINNET_LEGAL_COPY_APPROVED=true`.

**State on 2026-10-03 (owner's decisions D1-D7, counsel approved the
model; the wording is a DRAFT until counsel confirms it).** Terms, Privacy
Policy, acceptance-dialog summary and risk warning points 3, 4, 7 and 10
are version `2026-10-03` in `mainnet-copy.ts` / `risk-warning.ts` (PR
"Legal: Terms v2026-10-03 draft"): open classes are bearer instruments
bought, held and transferred with no KYC; buying needs only a wallet linked
to the platform (connected and signed in, the Terms in force accepted,
sanctions screening passed); a buy outside the platform is not supported
and may lead to the blocklist and clawback (no program change); public
primary sales, each approved by the Operator, up to 365 days, EUR 3M per
issuer over any 12 months; issuer direct transfers from the treasury; KYC
only for conversion (where the issuer offers it) and delivery; trading
through Manci, Startup raises, distributions, vesting, governance, Rights
and delivery stay off; conversion is "not available yet" until the
Operator switches it on (§8). "Buying outside the platform" means a
purchase in a primary sale only: units received through an issuer's direct
transfer or from another wallet are not one. The EUR 3M limit applies per
issuer, or per SPV where it issues through one (0066), and on mainnet the
admin routes refuse a platform or client limit above EUR 3,000,000
(`lib/raise-cap.ts`). The new version makes every mainnet wallet accept
again (`TOS_VERSION`; the 2026-10-02 rows stay as history).
- `MAINNET_LEGAL_COPY_APPROVED=true` is already set in production and is
  not bound to a version, so the hold is in code: the risk warning's
  `status` is `"draft"` (`lib/legal/risk-warning.ts`), and a mainnet build
  refuses it (`Purchase risk warning: still engineering's draft`). A
  `release/mainnet` that carries version 2026-10-03 does not build before
  counsel has confirmed the exact text (step 4 below on a local dev
  server). In the commit that records counsel's confirmation, set the status
  to `"counsel"` and flip the expectations that follow it
  (`tests/legal-slots.test.ts`: the "is held as a draft", "mainnet legal
  slots report" and "refuses a mainnet production build" tests;
  `scripts/ci/mainnet-build.sh`: the committed slots back to
  `expect_config_pass`). If counsel confirms on a later day, change
  `version` and `lastUpdated` of both documents to that day first.
- **Done on 2026-10-03:** the owner stated that counsel confirmed the exact
  2026-10-03 wording, recorded in PR #57 (merged): the risk warning's
  `status` is `"counsel"`, the tests and `scripts/ci/mainnet-build.sh`
  expect the committed slots to build, and `release/mainnet` carries
  version 2026-10-03 (live on mainnet). The `"draft"` status stays the
  in-code hold for any later version counsel has not confirmed yet.
- Before that release: check that no mainnet raise limit is above EUR
  3,000,000 (`select * from platform_raise_limits where network =
  'mainnet'`; `select l.* from client_raise_limits l join clients c on c.id
  = l.client_id where c.network = 'mainnet' and l.annual_raise_cap_eur >
  3000000`; `select id, annual_cap_eur from spvs where network = 'mainnet'
  and annual_cap_eur > 3000000`). The routes refuse new ones; rows written
  before them are not changed.
- Not yet enforced by code (the Terms are worded so they stay true):
  `/api/compliance/screen-wallet` checks the signature and sanctions but
  not the Terms acceptance (only the browser's `TosGate` does); a buy made
  outside the platform is screened against sanctions only
  (`lib/server/onchain-screening.ts`), nothing flags it as off-platform
  yet, so the Terms say the Operator "monitors" rather than "detects".

Written for a Serbian operator, now to be put to counsel for a BVI one.
Whether each of these still applies with a BVI operator, and whether the
wording changes, is counsel's decision, not engineering's; nothing below
is a conclusion:

- The purchase risk warning was first drafted against ZDI art. 15(2)
  (`front/lib/legal/risk-warning.ts:6-8`; the article is named in the
  source, not on the page); its wording is counsel's since 2026-10-02.
- The devnet Privacy Policy cites GDPR (`front/app/(marketing)/legal/privacy/devnet-privacy.tsx:109`,
  `:175`). The controller block names GDPR art. 13 only in a source comment
  (`front/components/legal/controller-section.tsx:5`); the rendered block
  cites no law.
- The personal-data breach step in §11 ("Personal data breach", line 1168
  of this file) names the Serbian Commissioner and Art. 52 ZZPL as the
  supervisory authority.
- §0 Legal gate (line 133 of this file) asks for an opinion on the Serbian
  Law on Digital Assets and for a licence from the Serbian Securities
  Commission (Komisija za hartije od vrednosti), or the opinion that none is
  needed.
- Texts on the site that assume the Serbian offering regime: the
  whitepaper-approval badges, written for ZDI art. 17(3) (named in source
  comments), that read "Approved by / Not approved by the Serbian Securities
  Commission"
  (`front/app/marketplace/launchpad/page.tsx:363-373`,
  `front/app/marketplace/launchpad/[sale]/page.tsx:1162-1197`,
  `front/app/marketplace/assets/[id]/page.tsx:293`,
  `front/lib/whitepaper-approval.ts:22`,
  `front/app/(marketing)/markets/whitepapers/page.tsx:21`); the asset status
  labels "Securities Commission (Serbia)" (`front/components/asset-detail.tsx:69-73`);
  the "Serbian SPV, capped at EUR 3 million per SPV per year" risk text
  (`front/app/(marketing)/risks/page.tsx:132-133`) and the other "Serbian
  SPV" wording on the marketing and issuer pages (`grep -rn "Serbian SPV"
  front/app front/components front/lib`).
- The devnet Terms and the earlier legal analysis assume Serbian law.

When a detail changes (or, for a new company, when its data arrive):

1. Edit `OPERATORS.mainnet` (no secrets: everything there is public in the
   business register and on the licence). Leave `pilotNotice` null. The
   security address must stay equal to `public/.well-known/security.txt` and
   the programs' embedded security.txt (a test checks both).
2. Paste counsel's texts into `mainnet-copy.ts` as `LegalDocument`s; they do
   not repeat the operator, the governing law or the contacts, which the
   pages render from the operator record. `MAINNET_TERMS.version` is the
   Terms version every mainnet wallet accepts (`TOS_VERSION`); a later
   material change needs a new version. The devnet version stays
   `DEVNET_TOS_VERSION` (`front/lib/tos-version.ts`).
3. `npx vitest run tests/legal-slots.test.ts --silent=false` until the
   "mainnet legal slots" report says complete. (CI's mainnet build,
   `front/scripts/ci/mainnet-build.sh`, loads the config once with the
   committed slots and the licence waiver, then proves the guard with an
   invented fixture of these slots written into its throwaway checkout; the
   content of the committed values is checked by this test.)
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
     project, the KYC registry pin, the RPC and operations settings of
     `ops/env-vars.md`, where an operations requirement can be waived by name
     for the Preview with `MAINNET_OPS_WAIVERS`).
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

Today `www.manci.io` serves devnet, and the three devnet cron jobs (retry,
alarms, sanctions) call it. The mainnet schedulers, SIWS and the email links
need the mainnet front on its own origin, so devnet releases `www.manci.io`
first (R, §0A D3), mainnet takes the domain at D4 (D), still behind
Deployment Protection, and devnet moves to `devnet.manci.io` last (A, B, C).
What depends on the origin:
`NEXT_PUBLIC_SITE_URL` sets the SIWS allowed origin (`lib/server/siws.ts`),
the Turnstile hostname check, the Google OAuth `redirect_uri`
(`<origin>/api/account/google/callback`) and every link in emails; the
session and OAuth cookies are host-only, so nothing carries over from one
host to the other (users sign in again); `scripts/ops/targets.json`
`siteOrigin` is the origin pg_cron calls (the scheduler installs refuse any
other).

**Order chosen by the owner on 2026-10-02.** `targets.json` already records
both origins: `mainnet.siteOrigin = https://www.manci.io`,
`devnet.siteOrigin = https://devnet.manci.io` (PR `feat/mainnet-legal-texts`,
covering the PRs of C and D). The order is R, D, then A, B, C: mainnet
takes the domain first; the devnet DNS at GoDaddy (A), the devnet project
(B) and the devnet schedulers (C) come last, at any time after D (nothing in
§0A D5–D12 depends on them). **Devnet is out of service from R until B**:
no host serves the devnet build at the origin it signs and links with.

**R. Devnet releases `www.manci.io` (owner + operator, §0A D3, right before
D).**
1. Disable the four devnet jobs. Until C they would keep calling
   `https://www.manci.io`, and once that host serves mainnet they are refused
   there (another worker secret, Deployment Protection):
   ```
   MANCI_TARGET=devnet bash scripts/db.sh -c "select cron.alter_job(jobid, active := false) from cron.job where jobname in ('mancipatio-retry-devnet','mancipatio-alarms-devnet','mancipatio-sanctions-devnet','mancipatio-fx-devnet')"
   ```
   Re-install them at C.
2. Devnet project, Production scope: `NEXT_PUBLIC_SITE_URL=https://devnet.manci.io`,
   then redeploy (public variables are baked in at build time). Without
   this, after D the devnet build would still sign SIWS for, and put in every
   email and alert link (`lib/server/account-origin.ts`,
   `lib/server/system-alerts.ts`), `https://www.manci.io`: the mainnet site.
   With it those links point at a host that has no DNS until A: dead, never
   mainnet. The Google OAuth redirect URI and the Turnstile hostname of B
   only add a host, so they may be done now too.
3. No redirect from `www.manci.io` to `devnet.manci.io`: from D on,
   `www.manci.io` belongs to the mainnet project. Old devnet links (emails,
   bookmarks) then open the mainnet site; no devnet session carries over
   (the cookies are host-only).

Alternative, only if devnet must keep working until B: in step 2 use the
devnet project's production `*.vercel.app` alias instead (it must answer
without Vercel's sign-in wall), and add that origin to the devnet Google
OAuth client and the Turnstile widget; B then switches all three to
`devnet.manci.io`.

Other things that read the devnet origin:
- the deployment smoke: `MANCIPATIO_LIVE_SMOKE=devnet` now probes
  `devnet.manci.io` and refuses `SMOKE_ORIGIN=https://www.manci.io`
  (mainnet's origin). Between R and B there is nothing to probe: run it
  after B (with the alternative, `SMOKE_ORIGIN=<the alias>`; its SIWS case
  needs the origin the build was given in `NEXT_PUBLIC_SITE_URL`);
- the 100-user simulator: `front/scripts/sim/lib/constants.ts`
  `SITE_ORIGIN` is `targets.json` `devnet.siteOrigin`,
  `https://devnet.manci.io` (PR #54); it refuses `www.manci.io` and a site
  whose `/api/health` does not report devnet. Between R and B there is
  nothing to run it against;
- `CHAIN_SITE_ORIGIN` in the devnet handover example (§19).

`public/.well-known/security.txt` and the programs' security.txt name
`www.manci.io`, which is right for mainnet.

**A. DNS (owner, after D).** Add `devnet.manci.io` to the devnet Vercel
project and create the CNAME record Vercel shows at the registrar (GoDaddy);
wait for the certificate. `manci.io` sends HSTS with `includeSubDomains`, so the new host
must be https from the start (Vercel is).

**B. Devnet project (owner).** Production scope: `NEXT_PUBLIC_SITE_URL=https://devnet.manci.io`
(set since R, unless R used the alternative);
Google Cloud, the devnet OAuth client: add
`https://devnet.manci.io/api/account/google/callback` as an authorized
redirect URI (and the origin); Cloudflare Turnstile: add `devnet.manci.io` to
the widget's hostnames. The devnet production build does not set
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` today (kritičar-14: the email login runs
without the check): set both Turnstile keys now or record the decision.
Redeploy if anything baked in at build time changed. No redirect from
`www.manci.io` (R step 3). Check: `curl -s https://devnet.manci.io/api/health`
answers `"ok":true` and `"network":"devnet"`, a wallet signs in on the new
host, and the devnet deployment smoke (§14 step 11,
`MANCIPATIO_LIVE_SMOKE=devnet`) passes.

**C. Devnet schedulers (operator).** `devnet.siteOrigin` is
`https://devnet.manci.io` in `front/scripts/ops/targets.json` (since
2026-10-02). Once `devnet.manci.io` answers (A, B), record the jobs' active
state (G6), then (the retry scheduler first: the alarm, sanctions and fx
installs refuse an origin other than the retry worker's; the fx job exists
once 0080 is applied):

```
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/sanctions-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-scheduler.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/retry-scheduler-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/alarm-scheduler-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/sanctions-scheduler-status.sql
MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-scheduler-status.sql
```

The installs leave their job disabled; re-enable each after a clean manual
run (§14 D, §15 D.3–D.5, §15 "Sanctions list", §15 "Automatic EUR rate"). Move the external monitors to
`https://devnet.manci.io/api/health` and `/api/health/alarms`. The Helius
devnet webhook calls the Supabase edge function, not the site: unchanged.

**D. Mainnet takes the domain (owner, §0A D4, right after R).** Remove `www.manci.io` and
`manci.io` from the devnet project and add them to the mainnet project
(`manci.io` redirects to `www`, as today; `mancipatio.io` keeps its 308 to
`www`). The mainnet project has Deployment Protection on *All Deployments*
with Vercel Authentication before the domain is attached. Mainnet uses its
own Google OAuth client (redirect URI on `www.manci.io`) and its own
Turnstile widget. `targets.json` records `mainnet.siteOrigin =
https://www.manci.io` (since 2026-10-02) and the project ref and pooler host
(2026-09-30, also in `SUPABASE_PROJECT_REFS`); the backup recipient follows
(§14 mainnet step 1). At Talas 7 (§0A D11)
protection goes back to *Standard Protection*.

**E. Mainnet environment (names only; values live in Vercel, never in the
repository).** The complete list, with what each mainnet build guard
requires and what happens when a variable is unset, is
`ops/env-vars.md`; owners and rotation of every secret are in
`ops/secrets.md`. These are the ones that differ per network or
domain, or that a mainnet build refuses without:

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
| `SENTRY_DSN` | the https DSN of an EU-region Sentry project for mainnet (build guard `sentry`) |
| `ALERT_WEBHOOK_URL` (+ `ALERT_WEBHOOK_TOKEN`, `ALERT_WEBHOOK_FORMAT`, `ALERT_WEBHOOK_MIN_SEVERITY`) | the second alert channel, an https URL of a mainnet channel or topic (build guard `alert-webhook`; §15 Configuration) |
| `ALARM_BALANCE_WATCH` | every key that signs in an emergency, with the §1 "Refill below" thresholds (§15 Configuration) |
| `ALARM_SQUADS_CONFIG` | the role map's `squads` object (§15 Configuration) |
| `MAINNET_LEGAL_COPY_APPROVED` | `true` only after the lawyer's review (§0 Legal gate) |
| `MAINNET_LICENSE_NOT_REQUIRED` | unset; `true` only on counsel's written opinion that no licence is needed, while no licence is recorded (§17) |
| `MAINNET_OPS_WAIVERS` | empty (every operations guard applies; `ops/env-vars.md` "Mainnet operations guards and waivers") |
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
- it can clear the pause and also block wallets and switch hook modes; a
  lost key is recovered only by the upgrade authority after 7 days (D4), a
  compromised one only with the incident build (§11), for the SA and the BA
  at once;
- blocklist plus clawback with one key; KYC decisions and their enforcement
  together; the KYC registry and the hook's registry pin together; KYB and
  KYC together;
- protocol fees land on an operational key;
- (v1.0.0-rc, O-10) the timelock veto and the recoveries rest on the
  upgrade authority alone: no Admin can veto the company wallet's own
  proposals (it is the SA and removes Admins at once), and the 30-day
  clawback grace protects nobody (the same key revokes and claws back).

The treasury may leave the Squads vault only as such an acknowledged role
key. An acknowledged KYC and SA overlap stands in for `allowKycAdmin`, so
the pre-handover inventory reports `kyc-admin` as a warning. A vault that
one approval executes (threshold 1) is a single-key upgrade authority: not
recommended, and on mainnet it needs
`"acknowledgedSingleKeyUpgradeAuthority": "<squads.multisig>"`; raise the
threshold later with a Squads config transaction. The tools never move an
upgrade authority to a plain key, and the upgrade authority never holds an
operational role: the role map refuses the vault in `admins[]`, a handover
target refuses it as SA or Admin, and `chain:inventory` blocks SA, BA or an
Admin record equal to an upgrade authority (review finding 6). The
minimum for this model (O-10): the vault is a Squads multisig of at least
two people, none of whose keys is the company wallet. Recommended on top:
one independent Admin (below) and the KYC authority on its own key, so
the clawback grace means something.

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
X3, X2, X1, S5c and S6 are all its signatures, inside the bootstrap window,
so no 48-hour wait); no handover is needed. Initialize the mainnet Platform
only when the company wallet and the Squads vault exist, and close the
bootstrap window right after X1 (S5c): an open window is a blocker after X1.

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
CHAIN_ROLE_MAP=~/mancipatio-devnet/handover-company.json CHAIN_SITE_ORIGIN=https://devnet.manci.io \
CHAIN_OUTPUT=../docs/mainnet-readiness/handover/01-plan.json npm run chain:handover
```

It sends nothing. It reads the chain clock and prints, and writes to
`01-plan.json.md`, the ordered steps; each names the instruction, who signs
(the current holder or the new key), **when** (now, `T+48h`, or the chain
window of a proposal already on chain), the page and control, what must be
done first and what proves it. Since v1.0.0-rc (D3) every proposal goes out
at T and every timelocked execution follows at T+48h, so the handover takes
about 48 hours, not one wait per role:

1. **Prepare** (off-chain): the company wallet signs in on the site (SIWS,
   the Terms) as the primary wallet of its own account, and gets about
   0.05 SOL. Maintenance off.
2. **T: proposals** by `6AnF`: `propose_admin(company)` on `/admin/admins`
   (so the company wallet works as an Admin before the rotation; it also
   needs that record to take custody vaults), then
   `propose_platform_admin(company)` on `/account/roles` (Change Super
   Admin). Both start their 48 hours now. Any Admin or the upgrade
   authority can cancel either inside its window.
3. **T: instant moves**, each proposed by `6AnF` and accepted by the
   company wallet on `/account/roles`: the KYC registry authority (propose
   on `/admin/kyc`; the registry address, bitmaps and passports stay, so
   `NEXT_PUBLIC_KYC_REGISTRY` does not change), the BlocklistAuthority
   (`/account/roles`), then the treasury (`set_protocol_treasury`,
   `/admin/platform`). No timelock: 14 days to accept.
4. **T+48h: executions**, in this order: the company wallet runs its own
   `add_admin` (`/account/roles` → Waiting for your acceptance → Admin);
   `6AnF` proposes the custody vaults it operates to the company wallet
   (`/admin/custody`) and the company wallet accepts; **the super admin
   last**: the company wallet accepts the platform admin. The accept closes
   `6AnF`'s Admin record and makes every grant `6AnF` staged stale (6152),
   so each `add_admin` lands before it. Until here `6AnF` could repair any
   step. When the target keeps `6AnF` in `admins`, the company wallet
   proposes `6AnF` again right after the accept and `6AnF` executes 48 hours
   later (T+96h); its custody vaults and rights issuances have no Admin in
   between.
5. **Cleanup**: the company wallet removes the Admin records the target does
   not keep (their sale approvals stay valid: review and revoke them) and
   cancels every Admin grant the plan does not execute (stale ones of an
   earlier super admin included, K1.10); then re-run the plan (only the
   verification step remains) and `chain:inventory` (no `pending-admin`, no
   `pending-recovery`).

Decide before step 4: issuers `6AnF` holds (rotate on `/issuer/rotation`, or
keep `6AnF` as their issuer key; an Admin-key successor must accept before
the super admin accept), rights issuances `6AnF` opened (K19: publish their
milestones first, or keep `6AnF` in the target's `admins`, which plans the
re-grant after the accept), issuer recoveries it staged (stale after the
accept), and any recovery by the upgrade authority that is pending (the
accept is refused while it is, 6155 / 6020). There is no role table in the
database: roles are read from the chain (`lib/server/admin-gate.ts`), so
nothing changes there. The upgrade authority (the devnet deployer) is not
part of the handover; the plan warns when the target would make it the SA,
the BA or an Admin.

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
