#!/usr/bin/env bash
# Release guard: release/mainnet must be a fast-forward of origin/main.
#
# The mainnet Vercel project builds only its production branch
# release/mainnet (ops/runbook-mainnet.md §15, "Apply migration 0080"), and
# a release is a push of a main commit to it: never a cherry-pick, never a
# feature branch. This checks that every commit of origin/main is on the
# release ref, so a change merged to main cannot be left out of mainnet
# silently. On 2026-10-15 the branch was pushed from a commit that had
# diverged from main before the KYC-only lockdown (#78), and the two then
# carried the same subjects as different commits.
#
#   bash scripts/check-release-ancestry.sh [<release ref>]
#
# The release ref defaults to origin/release/mainnet (the Release guard
# workflow passes the pushed commit). Unless RELEASE_GUARD_NO_FETCH=1, main
# and release/mainnet are fetched from origin first. Exit 1, with the commits
# of main that are missing, when main is not an ancestor of the release;
# commits on the release that are not on main are only a warning (main
# receives them next). Needs no secret: the checkout's remote access is enough.
set -euo pipefail

main_ref="${RELEASE_GUARD_MAIN_REF:-origin/main}"
release_ref="${1:-origin/release/mainnet}"

if [[ "${RELEASE_GUARD_NO_FETCH:-0}" != "1" ]]; then
  git fetch --quiet origin main release/mainnet
fi

main_sha="$(git rev-parse --verify --quiet "${main_ref}^{commit}")" \
  || { echo "::error::cannot resolve ${main_ref}" >&2; exit 2; }
release_sha="$(git rev-parse --verify --quiet "${release_ref}^{commit}")" \
  || { echo "::error::cannot resolve ${release_ref}" >&2; exit 2; }
echo "main:    ${main_ref} = ${main_sha}"
echo "release: ${release_ref} = ${release_sha}"

ahead="$(git log --oneline "${main_sha}..${release_sha}")"
if [[ -n "${ahead}" ]]; then
  echo "::warning::commits on ${release_ref} that are not on ${main_ref} (merge them into main next; a cherry-pick is not a release from main):"
  echo "${ahead}"
fi

if git merge-base --is-ancestor "${main_sha}" "${release_sha}"; then
  echo "ok: ${main_ref} is an ancestor of ${release_ref} (a fast-forward release)."
  exit 0
fi

echo "::error::${release_ref} does not contain ${main_ref}: commits of main missing on the release:"
git log --oneline "${release_sha}..${main_sha}"
echo "Fix: merge any release-only commits listed above into main, then fast-forward (never cherry-pick, never --force):"
echo "  git push origin <main sha>:refs/heads/release/mainnet   # ops/release-checklist.md"
exit 1
