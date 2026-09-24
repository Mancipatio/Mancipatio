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
| `CHAIN_RPS` | Requests per second, default 2, at most 20. |
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

1. Maintenance on: `bash front/scripts/ops/maintenance.sh mainnet on "…"`, wait
   about 70 s.
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
