#!/usr/bin/env bash
# Release guard: release/mainnet must be a fast-forward of origin/main.
#
# The mainnet Vercel project builds only release/mainnet (ops/runbook-mainnet.md
# §15, "Releasing the front to mainnet"), and a release is a push of the tip
# of main to it: never a cherry-pick, never a feature branch. This checks that
# every commit of origin/main is on the release ref, so a change merged to
# main cannot be left out of mainnet silently (on 2026-10-15 a push from a
# branch that had diverged before the KYC-only lockdown, #78, did just that).
#
#   bash scripts/check-release-ancestry.sh [<release ref>]
#
# The ref defaults to origin/release/mainnet (the current release); the
# release checklist passes the candidate sha before the push, the Release
# guard workflow the pushed commit. Exit 1, listing the commits of main that
# are missing, when main is not an ancestor of the ref. Commits on the ref
# that are not on main are a warning (main receives them next), or exit 1
# with RELEASE_GUARD_STRICT=1 (the pre-push form: such a candidate is a
# feature branch, not the tip of main). RELEASE_GUARD_NO_FETCH=1 skips the
# fetch of main and release/mainnet (explicit refspecs, so a single-branch
# clone sees both); RELEASE_GUARD_MAIN_REF replaces origin/main. No secret.
set -euo pipefail

main_ref="${RELEASE_GUARD_MAIN_REF:-origin/main}"
release_ref="${1:-origin/release/mainnet}"
strict="${RELEASE_GUARD_STRICT:-0}"

if [[ "${RELEASE_GUARD_NO_FETCH:-0}" != "1" ]]; then
  git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main \
    +refs/heads/release/mainnet:refs/remotes/origin/release/mainnet
fi

main_sha="$(git rev-parse --verify --quiet "${main_ref}^{commit}")" \
  || { echo "::error::cannot resolve ${main_ref}" >&2; exit 2; }
release_sha="$(git rev-parse --verify --quiet "${release_ref}^{commit}")" \
  || { echo "::error::cannot resolve ${release_ref}" >&2; exit 2; }
echo "main:    ${main_ref} = ${main_sha}"
echo "release: ${release_ref} = ${release_sha}"

ahead="$(git log --oneline "${main_sha}..${release_sha}")"
if [[ -n "${ahead}" && "${strict}" == "1" ]]; then
  echo "::error::${release_ref} carries commits that are not on ${main_ref} (a feature branch is never released: merge it into main and release the tip of main):"
  echo "${ahead}"
elif [[ -n "${ahead}" ]]; then
  echo "::warning::commits on ${release_ref} that are not on ${main_ref} (merge them into main next; a cherry-pick is not a release from main):"
  echo "${ahead}"
fi

if git merge-base --is-ancestor "${main_sha}" "${release_sha}"; then
  if [[ -n "${ahead}" && "${strict}" == "1" ]]; then exit 1; fi
  echo "ok: ${main_ref} is an ancestor of ${release_ref} (a fast-forward release)."
  exit 0
fi

echo "::error::${release_ref} does not contain ${main_ref}: commits of main missing on the release:"
git log --oneline "${release_sha}..${main_sha}"
echo "Fix: merge any release-only commits listed above into main, then fast-forward (never cherry-pick, never --force):"
echo "  git push origin <main sha>:refs/heads/release/mainnet   # ops/release-checklist.md"
exit 1
