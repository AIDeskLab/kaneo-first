#!/usr/bin/env bash
set -euo pipefail

# GitHub's releases/latest is the newest non-prerelease, which can be a package
# release such as mcp-v0.1.14 or cli-v0.1.1. Those tags are not app images.
# Walk published releases newest-first and keep the first vX.Y.Z or X.Y.Z tag.
# A repository with no such release skips the upgrade check. Any other gh
# failure still fails the job. Do not publish a release or pull an image to
# paper over the missing tag.
stderr=$(mktemp)
trap 'rm -f "$stderr"' EXIT
set +e
releases=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq '.[] | {tag_name,draft,prerelease}' 2>"$stderr")
status=$?
set -e
if [[ $status -ne 0 ]]; then
  if grep -Eq 'HTTP 404|Not Found' "$stderr"; then
    echo "No stable app release matching vX.Y.Z for ${GITHUB_REPOSITORY} (releases returned 404). Skipping the upgrade check."
    exit 0
  fi
  cat "$stderr" >&2
  exit "$status"
fi
set +e
tag=$(printf '%s\n' "$releases" | node scripts/ci/app-release-tag.mjs)
select_status=$?
set -e
if [[ $select_status -eq 2 ]]; then
  echo "No stable app release matching vX.Y.Z for ${GITHUB_REPOSITORY}. Skipping the upgrade check."
  exit 0
fi
if [[ $select_status -ne 0 ]]; then
  exit "$select_status"
fi
version=${tag#v}
node scripts/security/validate-release-version.mjs "$version" --new-version
if [[ "$tag" != "v$version" && "$tag" != "$version" ]]; then
  echo "Expected a stable Kaneo release tag vX.Y.Z or X.Y.Z, got $tag" >&2
  exit 1
fi
owner=$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
image="ghcr.io/$owner/kaneo:$version"
# GHCR can time out before returning headers even when the image is available.
# Retry only acquisition; the upgrade and its assertions still run once.
for attempt in 1 2 3; do
  if docker pull "$image"; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    echo "Unable to pull the stable upgrade image after $attempt attempts" >&2
    exit 1
  fi
  echo "Retrying stable image pull (attempt $((attempt + 1))/3)" >&2
  sleep "$((attempt * 5))"
done
# Record and use the pulled digest so a mutable tag cannot change the baseline mid-test.
export KANEO_UPGRADE_IMAGE
authoritative_ref=$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')
KANEO_UPGRADE_IMAGE=$authoritative_ref
mkdir -p .cache/ci-results
printf 'Upgrade baseline: %s\n' "$KANEO_UPGRADE_IMAGE" | tee .cache/ci-results/upgrade-baseline.txt
compose=(docker compose --env-file /dev/null -p kaneo-ci -f scripts/ci/compose.yml --profile upgrade)
"${compose[@]}" up -d --wait --wait-timeout 120 upgrade
node scripts/ci/upgrade.mjs seed "$KANEO_CI_UPGRADE_ORIGIN" .cache/ci-results/upgrade-state.json
"${compose[@]}" stop upgrade
export KANEO_UPGRADE_IMAGE=kaneo:ci
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 --force-recreate upgrade
node scripts/ci/upgrade.mjs verify "$KANEO_CI_UPGRADE_ORIGIN" .cache/ci-results/upgrade-state.json
