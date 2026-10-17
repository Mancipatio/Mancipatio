# Release checklist: the front to mainnet

The mainnet Vercel project (`manci-mainnet`) builds only its production
branch `release/mainnet` (runbook §15, "Releasing the front to mainnet"). A
front release is the owner's push of the tip of `main` to that branch,
without `--force`: `release/mainnet` is always fast-forwarded from `main`,
never cherry-picked and never built from a feature branch. The programs have
their own path (runbook §9, through Squads).

1. **Candidate check, before the push.** With `<sha>` the 40-hex sha of the
   `main` commit you will push, from the repository root of a checkout
   with `origin` (the script path is relative; `RELEASE_GUARD_STRICT` reads
   exactly `1`, another value exits 2):
   `RELEASE_GUARD_STRICT=1 bash scripts/check-release-ancestry.sh <sha>`.
   It must exit 0 with no `::warning::`: the candidate contains the tip of
   `origin/main` and nothing that is not on `main`, so it is that tip. Exit
   1 names the fault: commits of `main` the candidate misses (release the
   tip instead), or commits of the candidate that are not on `main` (a
   feature branch: merge it into `main` and release that tip). Run without
   an argument it compares `origin/main` with the current
   `origin/release/mainnet`: on a normal release it exits 1, and the commits
   it lists are exactly what goes live (the range of step 3). This check is
   the defence; the workflow of step 4 only reports, after the build has
   started.
2. **CI green** on the `main` commit being released: Front CI (tsc, eslint,
   vitest, the mainnet build with placeholder values; `front-ci.yml`) and,
   when `program/` changed, Program CI. A program change is not released by
   this push (runbook §9).
3. **Environment diff.** For the range `git log --oneline
   origin/release/mainnet..<sha>`: variables added or changed in
   `ops/env-vars.md`, `front/lib/features.ts` and `front/next.config.ts` are
   set in Vercel Production before the push (`NEXT_PUBLIC_*` values are
   build-time); migrations added under `front/supabase/migrations` are
   applied to the mainnet project first (runbook §14 "Rules for migrations
   after 0071", §15). KYC-only mode and the asset classes stay as decided
   (`ops/env-vars.md`, "KYC-only mode and offered asset classes": unset
   means locked, equity only).
4. **Push (owner), then the Release guard.** `git push origin <40-hex main sha>:refs/heads/release/mainnet`,
   never with `--force`. A push refused as non-fast-forward means that
   `release/mainnet` carries commits `main` lacks (the no-argument run of
   step 1 lists them as `::warning::`): merge `origin/release/mainnet` into
   `main` through a PR and start again at step 1; never `--force`. The
   "Release guard" run on the pushed commit (Actions → Release guard;
   `.github/workflows/release-guard.yml` runs the script of step 1 against
   that commit) must be green: red means the live site is missing commits
   of `main`. GitHub reads a push workflow from the pushed commit, so a
   commit from a branch created before the workflow was merged runs no
   guard at all (the shape of 2026-10-15): a missing run is a fault too,
   not a pass. A manual run (workflow_dispatch) checks the branch tip, and
   a re-run the commit pushed then, against the current `origin/main`, so
   it is red whenever `main` has unreleased commits: the next release's
   work, not a fault of the live one. A rollback is Vercel Instant Rollback
   (runbook §10), not a push of an older commit.
5. **Health and commit.** Read the token without echo (`IFS= read -rs
   HEALTH_TOKEN`, runbook §14 "Credential files") and send the header
   through stdin, never on the command line, which `ps` shows:
   `printf 'header = "Authorization: Bearer %s"\n' "$HEALTH_TOKEN" | curl -fsS --max-time 10 -K - https://www.manci.io/api/health`
   answers `"ok":true` and its `commit` is the first 12 characters of the
   pushed sha (runbook §14 C.3 shows the devnet form). Until it is, the
   build is queued or failed, or the domain was not auto-assigned after an
   Instant Rollback: Vercel → Deployments.
6. **Smoke.** Sign-in (wallet and email) and `/verify` load; in KYC-only
   mode `/marketplace/launchpad` shows "Paused.", the sidebar has no
   Primary sales and no Issuer workspace, and the home page (equity only)
   has no "Explore by asset class" section and no class tiles, no Primary
   sales tab and no link to `/marketplace/launchpad` or `/apply`, while its
   "Know what you own" card links "Read the equity guide"
   (`ops/env-vars.md`, the post-deploy check of "KYC-only mode";
   `front/tests/asset-classes.test.ts` pins this as the mainnet default).
   Class tiles or a Primary sales tab mean that `NEXT_PUBLIC_ASSET_CLASSES`
   or `NEXT_PUBLIC_FEATURE_KYC_ONLY` is set in Vercel Production (unset is
   the lockdown): correct the variable and Redeploy; an Instant Rollback
   would return to the previous build. Then each PR's own post-deploy
   check, from its description or the runbook section it names.
7. **Pause mask.** `/admin/platform` shows the mask of the mode in force
   (runbook §8, "Pause mask by mode": 0x7F in KYC-only mode). The push
   changes no bit; a bit the release needs is set or cleared on-chain,
   never assumed.
8. **Log it** in MAINNET-PLAN.md (the owner's local log, not in this
   repository): the sha, the time, the env changes and any pause-mask
   transaction, with the `/api/health` commit as evidence.
