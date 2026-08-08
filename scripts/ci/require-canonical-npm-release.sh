#!/usr/bin/env bash
# Refuse an npm publication request that does not come from the canonical repository at an exact release tag.
#
# `workflow_dispatch` accepts any ref the dispatcher can select, including a feature branch and including a
# fork that has the same workflow file. Neither the typed confirmation nor the protected environment
# constrains WHICH tree is about to become `cosyncing` on the public registry, so that is constrained here.
#
# This lives in a script rather than inline YAML so the workflow audit can execute it against synthetic
# repositories and refs and prove the refusals, instead of grepping for an assertion that is present but
# wrong.
set -euo pipefail

readonly CANONICAL_REPOSITORY='cosyncing/cosyncing'

repository="${GITHUB_REPOSITORY:-}"
ref_type="${GITHUB_REF_TYPE:-}"
ref_name="${GITHUB_REF_NAME:-}"
version="${REQUESTED_VERSION:-}"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

test -n "$version" || fail 'no version was requested, so no release tag can be required'

# A fork carries this workflow verbatim. Only the canonical repository holds the npm trusted-publisher
# binding, but failing here is clearer than failing later inside the OIDC exchange.
test "$repository" = "$CANONICAL_REPOSITORY" \
  || fail "npm publication runs only in ${CANONICAL_REPOSITORY}, not ${repository:-<unset>}"

# A branch moves after the fact; a tag is the reviewable, immutable thing a published version can be traced
# back to. `npm-v` rather than `broker-v` keeps this lane off the tag that triggers the compiled-broker
# release, which is separately gated by docs/legal/binary-distribution-readiness.md.
test "$ref_type" = tag \
  || fail "npm publication runs only from a release tag, not from ${ref_type:-<unset>} ${ref_name:-<unset>}"
test "$ref_name" = "npm-v${version}" \
  || fail "the release tag must be npm-v${version}, not ${ref_name:-<unset>}"

echo "canonical npm release ref accepted: ${repository}@${ref_name}"
