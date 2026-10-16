# Release checklist: the front to mainnet

The mainnet Vercel project (`manci-mainnet`) builds only its production
branch `release/mainnet` (runbook §15, "Apply migration 0080"). A front
release is the owner's push of a commit of `main` to that branch, without
`--force`: `release/mainnet` is always fast-forwarded from `main`, never
cherry-picked and never built from a feature branch. The programs have their
own path (runbook §9, through Squads).

1. **Branch ancestry.** `bash scripts/check-release-ancestry.sh` from a
   checkout with `origin`: exit 0 means `origin/main` is an ancestor of
   `origin/release/mainnet` (at most a warning about commits the release has
   and `main` does not: merge those into `main` first). Exit 1 lists the
   commits of `main` missing on the release. The same check runs on every
   push to `release/mainnet` ("Release guard",
   `.github/workflows/release-guard.yml`): a red run means the live site
   does not carry everything merged to `main`.
2. **CI green** on the `main` commit being released: Front CI (tsc, eslint,
   vitest, the mainnet build with placeholder values; `front-ci.yml`) and,
   when `program/` changed, Program CI. A program change is not released by
   this push (runbook §9).
3. **Environment diff.** For the range `git log --oneline
   origin/release/mainnet..<main sha>`: variables added or changed in
   `ops/env-vars.md`, `front/lib/features.ts` and `front/next.config.ts` are
   set in Vercel Production before the push (`NEXT_PUBLIC_*` values are
   build-time); migrations added under `front/supabase/migrations` are
   applied to the mainnet project first (runbook §14 "Rules for migrations
   after 0071", §15). KYC-only mode and the asset classes stay as decided
   (`ops/env-vars.md`, "KYC-only mode and offered asset classes": unset
   means locked, equity only).
4. **Push (owner).** `git push origin <40-hex main sha>:refs/heads/release/mainnet`,
   never with `--force`. A rollback is Vercel Instant Rollback (runbook
   §10), not a push of an older commit.
5. **Health and commit.** `curl -s -H "Authorization: Bearer $HEALTH_TOKEN"
   https://www.manci.io/api/health` answers `"ok":true` and its `commit` is
   the first 12 characters of the pushed sha (runbook §14 C.3 shows the
   devnet form). Until it is, the build is queued or failed, or the domain
   was not auto-assigned after an Instant Rollback: Vercel → Deployments.
6. **Smoke.** Sign-in (wallet and email) and `/verify` load; in KYC-only
   mode `/marketplace/launchpad` shows "Paused.", the sidebar has no
   Primary sales and no Issuer workspace, and the home page shows one
   Equity tile (`ops/env-vars.md`, the post-deploy check of "KYC-only
   mode"). Then each PR's own post-deploy check, from its description or
   the runbook section it names.
7. **Pause mask.** `/admin/platform` shows the mask of the mode in force
   (runbook §8, "Pause mask by mode": 0x7F in KYC-only mode). The push
   changes no bit; a bit the release needs is set or cleared on-chain,
   never assumed.
8. **Log it** in MAINNET-PLAN.md (the owner's local log, not in this
   repository): the sha, the time, the env changes and any pause-mask
   transaction, with the `/api/health` commit as evidence.
