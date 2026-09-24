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

All four tools live in `front/scripts/chain/` and run from `front/`:

| Command | What it does | Sends? |
|---|---|---|
| `npm run chain:inventory` | Read-only inventory with findings for `CHAIN_PHASE` = `in-progress`, `pre-handover` or `handed-over` | never |
| `npm run chain:idl` | Canonical IDL: `CHAIN_IDL_MODE` = `check` (default), `send` or `prepare-export` | only with `CHAIN_SEND=1` |
| `npm run chain:bootstrap` | One bootstrap cycle (S1–S7) as a reviewed plan | only with `CHAIN_SEND=1` |
| `npm run chain:squads-export` | Unsigned vault transactions for the Squads Transaction Builder | never |

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
| `CHAIN_ROLE_MAP` | Required for bootstrap and squads-export, and for IDL send/prepare-export. Its sha256 goes into the plan digest. |
| `CHAIN_RELEASE_DIR` | Required on mainnet for bootstrap, idl and squads-export. `SHA256SUMS` is verified first. |
| `CHAIN_SEND=1`, `CHAIN_KEYPAIR`, `CHAIN_CONFIRM_PLAN` | Send mode needs all three. Without `CHAIN_SEND` every tool is a dry run. |
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
mainnet only).

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
  bufferWriter (buffers after handover). The tools refuse any other key, and
  never load a Ledger key on mainnet.

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
- [ ] **Program keypairs** backed up offline (two copies, not on the operator
      machine's synced folders).
- [ ] **Squads** multisig created with the D12 parameters: threshold ≥ 2,
      `config_authority` none (autonomous), time lock 0 until after the audit.
      Record `multisig`, `vaultIndex` (0), `vault` and every member with its
      permissions in the role map. `chain:inventory` must show the decode
      matching (finding code `squads` absent). **EXTERNAL #4** (layout) must be
      closed by the rehearsal dump.
- [ ] **Role map** (`front/scripts/chain/role-map.example.json` shows the
      shape): `network: mainnet`, the mainnet genesis hash,
      `programDataMaxLen` = `{ "assetRegistry": 3145728, "transferHook": 786432 }`
      (D8), `deployer` and `bufferWriter` hot keys (different keys, no role, not
      Squads members, D19), `superAdmin`, `admins[]` (never the SA),
      `blocklistAuthority`, `kyc.authority` (Ledgers),
      `kyc.registry` = the KycRegistry PDA of the deployer (D3),
      `protocolTreasury` = the vault (D5), `protocolFeeBps: 0`,
      `unpauseBy: "superAdmin"` (D4), `kyc.tempAdminGrant: false` unless the
      3.1 `kycProvider` gate is missing (D17).
- [ ] **Dedicated RPC** and `CHAIN_CU_PRICE` decided (check recent
      prioritization fees).
- [ ] **Operator front (D18)**, prepared before S1 so X1 can follow within
      minutes:
  - a local `next dev` on the operator machine with
    `NEXT_PUBLIC_NETWORK=mainnet`, the dedicated RPC, the mainnet Supabase
    project with every migration applied,
    `NEXT_PUBLIC_KYC_REGISTRY=<kyc.registry>`, **maintenance off** (maintenance
    refuses the signed wallet-transaction policy, so it would block X1, X2, X3
    and S6);
  - alternative: a password-protected Vercel preview (production build; needs
    the legal ack and an https `NEXT_PUBLIC_SITE_URL`);
  - each Ledger (SA, BA, KYC) connects once, signs SIWS and the ToS (the
    `/issuer/*` TosGate) and becomes primary of its own account; none may
    already be a secondary wallet of another account;
  - fund each Ledger with about 0.05 SOL;
  - **no public mainnet front until step 8.**
- [ ] 3.1 merged (the `kycProvider` layout gate, the D17 default; mainnet hides
      Initialize Platform and BlocklistBootstrap on `/issuer/authority` and
      `/admin/platform`) and 3.2 merged.
- [ ] The **6.1 rehearsal** (section 12) passed and every EXTERNAL item is
      closed.

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

Re-check every figure with `getMinimumBalanceForRentExemption` (rent is
6,960 lamports per byte plus 128 bytes of overhead):

| Item | SOL |
|---|---|
| Registry ProgramData (3 MiB) | ≈ 21.90 |
| Hook ProgramData (768 KiB) | ≈ 5.47 |
| Registry deploy buffer (transient) | ≈ 17.19 |
| Hook deploy buffer (transient) | ≈ 2.72 |
| IDL metadata (both programs) | ≈ 0.36 |
| IDL update buffer (transient) | ≈ 0.33 |
| Bootstrap PDAs | < 0.05 |

Deployer peak ≈ 45.5 SOL: **fund 50**. About 27.7 SOL stays locked. With the
CI-budget sizes instead of D8: peak ≈ 38.3, locked ≈ 20.8. `chain:bootstrap`
refuses a cycle the deployer cannot pay for (P0).

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

In any order:

- **X3**: the BA Ledger accepts on `/issuer/authority`, then clicks Refresh.
- **X2**: the KYC Ledger accepts on `/admin/kyc` (needs the 3.1 kycProvider
  gate). Temporary-grant path (D17 fallback, `kyc.tempAdminGrant: true`):
  cycle 1 also ran S3k, S5 waits; after X2 run cycle 2 (S3r removes the
  grant, then S5) with a new dry run and digest.
- **X1**: the SA Ledger accepts on `/issuer/authority`, **clicks Refresh**,
  then **S6**: PauseFlagsPanel → "Resume everything".

`accept_platform_admin` closes the deployer's Admin record and creates the
SA's; no `add_admin(SA)` is ever needed.

## 6. Dry run again, pre-handover inventory

```sh
CHAIN_OUTPUT=$E/06a-bootstrap-plan.json npm run chain:bootstrap        # only S7 pending
CHAIN_OUTPUT=$E/06b-inventory.json CHAIN_PHASE=pre-handover npm run chain:inventory
```

The inventory must show **0 blockers**: SA, BA and KYC equal the map with no
pending transfer; the deployer holds nothing but the UA; `kyc.authority` holds
no Admin record; the Squads decode matches exactly; the canonical IDL is in
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

- **Verify PDA through Squads** (EXTERNAL #5): `solana-verify export-pda-tx …
  --uploader <vault>` for each program, then
  ```sh
  CHAIN_OUTPUT=$E/08-verify-pda.json CHAIN_SQUADS_OP=wrap-external \
    CHAIN_SQUADS_INPUT=<file with {"transactionBase58": "…"}> npm run chain:squads-export
  ```
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
  `set_protocol_treasury` → the vault) need `"confirmTarget": "<same key>"`
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
   A failed write is resumed with the same `--buffer` keypair.
3. If capacity is short: `CHAIN_SQUADS_OP=extend-program`, input
   `{"program": "asset_registry", "bytes": <n ≥ 10240>}` (SIMD-0431 minimum;
   EXTERNAL #2). Fund the vault for the rent first.
4. `CHAIN_SQUADS_OP=upgrade`, input
   `{"buffers": {"transferHook": "<buffer>", "assetRegistry": "<buffer>"}}`,
   `CHAIN_RELEASE_DIR` = the new Release. One vault transaction, hook before
   registry; split exports say "execute strictly in order" (EXTERNAL #1). Import
   into the Squads Transaction Builder, approve, execute.
5. `chain:inventory` against the new Release.
6. IDL: `CHAIN_IDL_MODE=prepare-export` with the bufferWriter keypair (`send`
   then refuses: the UA is the vault), then `CHAIN_SQUADS_OP=idl-update` with
   `CHAIN_SQUADS_INPUT=<CHAIN_OUTPUT>.idl-export.json`. The setData buffer
   authority rule is EXTERNAL #3.
7. Refresh the verify PDA (step 8).
8. Maintenance off.

## 10. Rollback

- **Check out the previous tag `vX`** (clean) and use its Release as
  `CHAIN_RELEASE_DIR`: the mainnet release-source guard refuses a checkout
  whose `front/idl` differs from the Release, so a rollback runs that tag's
  CLI. Rehearse this in 6.1.
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

- Any Admin can pause (`set_pause_flags` sets bits); only the SA clears.
- Bad holder: BA `add_to_blocklist`, then the clawback flow.
- KYC: revoke the passport. Lost KYC key: create a new registry from a key
  that never created one, re-point every KycGated mint with
  `update_transfer_hook_config`, move the `NEXT_PUBLIC_KYC_REGISTRY` pin,
  re-issue passports.
- Wrong pending proposal: platform and BA proposals cannot be cancelled,
  propose again to overwrite; a KYC proposal can be cancelled.
- UA compromised before handover: catastrophic, so keep the window between
  step 2 and step 7 short.
- Crash during a send: see below.
- Squads member loss: rotate members through a config transaction (threshold
  still reachable), then update the role map and re-run the inventory.

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

- **Features**: list the features inactive on mainnet
  (`solana feature status -um`) and start `solana-test-validator --reset` with
  `--deactivate-feature <id>` for each (EXTERNAL #6), using the validator
  version that matches mainnet.
- **Programs**: `--upgradeable-program` for both Release `.so` files, and
  `--clone-upgradeable-program ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf --url mainnet-beta`.
- **Flow** (`CHAIN_NETWORK=localnet`, `CHAIN_GENESIS_HASH=$(solana genesis-hash)`):
  1. Create the multisig with the Squads CLI; dump its account and replace
     `front/tests/fixtures/squads-multisig-v4.json` (EXTERNAL #4).
  2. `chain:idl` send.
  3. `chain:bootstrap` cycles with `CHAIN_REHEARSAL_SIGNERS` for X1/X2/X3/S6.
  4. Inventory `pre-handover`, then S7.
  5. `chain:squads-export` `upgrade`, `idl-update`, `extend-program` and
     `wrap-external`, each executed through Squads (EXTERNAL #1, #2, #3, #5).
  6. `CHAIN_RECOVER` drill: kill the process in the middle of an IDL send;
     also Ctrl-C once and `kill -TERM <lock pid>` once, and check that the
     evidence file exists after each.
  7. Rollback drill (section 10) from the previous tag's checkout.
  8. Operator-front drill on localnet with a Ledger.
- Resolve every EXTERNAL item below.

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
`devnet.manci.io` (D15).

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
   `mancipatio_retry_worker_mainnet`.
6. Retention: install, preview, enable.
7. Retry scheduler: install disabled; enable once the mainnet front answers.
8. `platform_raise_limits` for mainnet with FX headroom (D18); the USDC FX
   row (kind `rate`, max age 7 days, weekly refresh); the 0008
   integrations config for mainnet.
9. Edge function secrets and deploy, Helius webhook, a signed test delivery
   answers 202 (G3: supabase-js 2.106.2 with `sb_secret_`).
10. Front: `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `sb_publishable_…`,
    `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_…` (the build and the server
    refuse other formats on mainnet); `HEALTH_TOKEN` and an uptime monitor on
    `/api/health` (D19). Once the production deployment is READY on the
    intended commit, `/api/health` `ok:true` proves the database network
    check passed; with `HEALTH_TOKEN`, check `commit` and
    `checks.databaseNetwork.status` too.
11. `MANCIPATIO_LIVE_SMOKE=mainnet MANCI_ALLOW_MAINNET=1 npx vitest run
    --config scripts/ops/deployment-smoke.config.ts`.

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

Helius (D22): the webhook of each project must list **both program IDs and
both ProgramData PDAs** (loader `SetAuthority` and `Close` do not reference
the program ID). Print the PDAs with:

```
node -e 'import("@solana/kit").then(async k=>{for(const p of ["FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS","GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy"]){const [a]=await k.getProgramDerivedAddress({programAddress:"BPFLoaderUpgradeab1e11111111111111111111111",seeds:[k.getAddressEncoder().encode(p)]});console.log(p,"→",a)}})'
```

The gap scan (every 5 minutes, window now−20 min … now−5 min) reads the
asset_registry program, the blocklist-authority PDA and both ProgramData
PDAs, and re-queues any finalized transaction the index misses that invokes
a watched program (asset_registry, transfer_hook, or a loader instruction on
one of ours). A transaction that only lists one of those addresses (anyone
can add the blocklist-authority PDA as a read-only account; the webhook
never delivers it) is ignored, so the PDA does not need to be in the Helius
list. A due scan that gets no time in a run (the cheap checks used the
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

Apply 0001–0074 in order (0074 is safe on a fresh project), the identity
first as in §14. Then: env (`COMPLIANCE_ALERT_EMAIL` required), Vault
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
4. `curl -s -o /dev/null -w '%{http_code}' https://<mainnet site>/api/health/alarms`
   answers `200`, and the external monitor watches it.

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

## EXTERNAL checks (open until the rehearsal proves them)

1. Squads Transaction Builder import format, vault seeds and the inner size
   budget (800 B assumed).
2. Whether mainnet rejects the unchecked ExtendProgram and whether SIMD-0431 is
   active (the tag-9 layout itself is confirmed).
3. The PM `setData` buffer-authority rule.
4. The Squads v4 `Multisig` layout (the S7 gate depends on the decode).
5. The OtterSec verify program ID, the verify PDA seeds
   (`["otter_verify", uploader, program]`), the `export-pda-tx` flags and
   output (instructions: verify signed by the vault, with only the vault,
   program, PDA, ProgramData and System as accounts, plus at most a System
   transfer into the PDA), and whether a PDA uploaded by the hot UA before
   handover is honoured after it. If the real output differs, wrap-external
   refuses it; change the inspector, never loosen it to "any writable
   account".
6. The mainnet feature list and validator version at rehearsal time.
7. Phantom and Solflare keep an app-set SetComputeUnitPrice (G2), and the
   mainnet RPC's answer to `getPriorityFeeEstimate` (G8: `source`, 24 h of
   samples; retune the floor if it never leaves it).
