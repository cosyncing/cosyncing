#!/usr/bin/env bash
set -euo pipefail

workflow_dir='.github/workflows'
mode_file='.github/workflow-mode'
test -d "$workflow_dir"
test -f "$mode_file"
test "$(cat "$mode_file")" = 'public-hosted' || {
  echo 'ERROR: only the public-hosted workflow profile is supported.' >&2
  exit 1
}

if rg -n 'self-hosted' "$workflow_dir"; then
  echo 'ERROR: self-hosted runner found in the public workflow profile.' >&2
  exit 1
fi

if rg -n 'Ubuntu3[0]90|mac-[d]ev|howard-[w]in|p[i]5|/hom[e]/|/User[s]/|BROKER[_]ROOT|pull_request_target' "$workflow_dir"; then
  echo 'ERROR: personal runner, personal path, sibling checkout, or unsafe PR trigger found.' >&2
  exit 1
fi

expected_names='broker-release-gate.yml
broker-release-promote.yml
broker-release.yml
ci.yml
nightly.yml
npm-publish.yml
platform-runtime.yml'
active_names="$(find "$workflow_dir" -maxdepth 1 -type f -name '*.yml' -printf '%f\n' | sort)"
test "$active_names" = "$expected_names" || {
  echo 'ERROR: the active workflow set differs from the reviewed public profile.' >&2
  diff -u <(printf '%s\n' "$expected_names") <(printf '%s\n' "$active_names") || true
  exit 1
}

matrix_rows() {
  awk '
    match($0, /^[ \t]*- runner:[ \t]*/) {
      value = substr($0, RSTART + RLENGTH)
      sub(/[ \t]+#.*$/, "", value)
      gsub(/^\047|\047$/, "", value)
      runner = value
      pending = 1
      next
    }
    pending && match($0, /^[ \t]*target:[ \t]*/) {
      target = substr($0, RSTART + RLENGTH)
      sub(/[ \t]+#.*$/, "", target)
      print target "\t" runner
      pending = 0
    }' "$1"
}

runner_is_compatible() {
  local allowed candidate
  case "$1" in
    linux-x64)    allowed='ubuntu-24.04 ubuntu-22.04 ubuntu-latest' ;;
    linux-arm64)  allowed='ubuntu-24.04-arm ubuntu-22.04-arm' ;;
    darwin-arm64) allowed='macos-15 macos-14 macos-latest' ;;
    *) return 1 ;;
  esac
  for candidate in $allowed; do
    [ "$candidate" = "$2" ] && return 0
  done
  return 1
}

for name in broker-release.yml broker-release-gate.yml broker-release-promote.yml; do
  while IFS="$(printf '\t')" read -r target runner; do
    [ -n "$target" ] || continue
    if ! runner_is_compatible "$target" "$runner"; then
      echo "ERROR: $name builds release target $target on incompatible runner $runner." >&2
      echo '       Native package evidence executes the artifact, so the runner must match the target.' >&2
      exit 1
    fi
  done < <(matrix_rows "$workflow_dir/$name")
done

if rg -n '^\s*uses:\s*[^#[:space:]]+@(v[0-9]+|main|master)\b' "$workflow_dir"; then
  echo 'ERROR: GitHub Action is not pinned to a full commit SHA.' >&2
  exit 1
fi

for workflow in "$workflow_dir"/*.yml; do
  rg -q '^permissions:' "$workflow"
done

for workflow in broker-release.yml broker-release-promote.yml; do
  rg -q 'COSYNCING_BINARY_RELEASE_LEGAL_APPROVED' "$workflow_dir/$workflow"
  rg -q 'test "\$BINARY_RELEASE_LEGAL_APPROVED" = true' "$workflow_dir/$workflow"
done

# npm publication policy.
#
# This block previously asserted that NO publish command existed at all, because the workflow was a
# placeholder that only ever exited 1. The npm lane now stages a real JavaScript package, so "no publish
# command" is no longer the invariant worth holding — what replaces it is stricter and specific: the command
# may exist, but only as a STAGED publish, behind a typed confirmation, a protected environment, the
# canonical repository at an exact release tag, and OIDC with no long-lived credential anywhere near it.
npm_workflow="$workflow_dir/npm-publish.yml"
rg -q '^  workflow_dispatch:$' "$npm_workflow"
rg -q '^      id-token: write$' "$npm_workflow"
rg -q '^    environment: npm-production$' "$npm_workflow"
# The conditions publication must refuse. The previous form of this check matched a bare `exit 1` at one
# exact indentation, which proved only that the placeholder workflow failed; these name the actual failures.
for guard in \
  'does not match committed' \
  'refusing to publish from a dirty checkout' \
  'staged package name is' \
  'contains a compiled executable'; do
  rg -q "$guard" "$npm_workflow" || {
    echo "ERROR: npm-publish.yml does not fail closed on: $guard" >&2
    exit 1
  }
done
if rg -n '^  (push|pull_request|release|schedule):' "$npm_workflow"; then
  echo 'ERROR: npm publishing must remain manual-only.' >&2
  exit 1
fi
# Trusted publishing exchanges an OIDC token for publish rights. A long-lived npm credential in this
# workflow would mean publication no longer depends on the trusted-publisher binding at all.
if rg -n 'NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM' "$npm_workflow"; then
  echo 'ERROR: npm publishing must use trusted publishing, never a stored npm credential.' >&2
  exit 1
fi
# Dispatching the workflow must not be sufficient to publish.
rg -q "^    if: \\\$\{\{ inputs.confirm == 'PUBLISH' \}\}$" "$npm_workflow" || {
  echo 'ERROR: the npm publish job must require an explicit typed confirmation input.' >&2
  exit 1
}
# The npm package is JavaScript. Building or staging a compiled broker here would put a native artifact into
# a lane that the compiled-distribution legal gate does not cover.
if rg -n 'build-broker\.ts|--compile|--binary-dir' "$npm_workflow"; then
  echo 'ERROR: the npm lane must not build or stage compiled native broker artifacts.' >&2
  exit 1
fi
rg -q 'scripts/release/build-npm-package\.ts' "$npm_workflow" || {
  echo 'ERROR: the npm lane must stage through the reviewed release builder.' >&2
  exit 1
}

# Staged publishing only. A direct `npm publish` would make a version installable the moment CI turned
# green, skipping the human 2FA approval that is the entire point of the staging queue. The registry-side
# trusted publisher is configured to refuse it too, but a workflow that tries is a workflow to fix here.
#
# Comments and step-summary text are stripped first: this must judge what the workflow RUNS, and both the
# rationale above and the instructions printed for the maintainer legitimately name these commands.
npm_commands="$(rg -v '^\s*#' "$npm_workflow" | rg -v '^\s*echo ')"
if printf '%s\n' "$npm_commands" | rg -n '(^|[^a-z-])npm publish\b'; then
  echo 'ERROR: the npm lane must use `npm stage publish`, never a direct `npm publish`.' >&2
  exit 1
fi
rg -q 'npm stage publish "\./candidate/cosyncing-' "$npm_workflow" || {
  echo 'ERROR: the npm lane must stage the exact verified tarball with `npm stage publish`.' >&2
  exit 1
}
# `npm stage publish` exists only from npm 11.15.0; an older pin would resolve to a CLI that does not know
# the subcommand.
rg -q '^  NPM_VERSION: 11\.(1[5-9]|[2-9][0-9])\.' "$npm_workflow" || {
  echo 'ERROR: staged publishing requires an npm floor of 11.15.0 or newer.' >&2
  exit 1
}
# And that version must be installed EXACTLY. `npm@>=X` resolves to whatever npm is newest on the day the
# release runs, so the staging would be performed by a CLI nobody reviewed. The paired `npm --version`
# assertion turns a resolver surprise into a failed job instead of a silent substitution.
rg -q 'npm install --global "npm@\$\{NPM_VERSION\}"' "$npm_workflow" || {
  echo 'ERROR: the npm lane must install the exact pinned npm version, not a range.' >&2
  exit 1
}
if printf '%s\n' "$npm_commands" | rg -n 'npm install --global "npm@(>=|>|\^|~|\*)'; then
  echo 'ERROR: the npm CLI installation must not float above the reviewed version.' >&2
  exit 1
fi
rg -q 'test "\$\(npm --version\)" = "\$\{NPM_VERSION\}"' "$npm_workflow" || {
  echo 'ERROR: the npm lane must assert the installed npm is exactly the pinned version.' >&2
  exit 1
}
# Approval is a proof of presence. A workflow that could complete it would not be one.
if printf '%s\n' "$npm_commands" | rg -n 'npm stage (approve|reject)\b'; then
  echo 'ERROR: staged releases are approved by a human with 2FA, never by CI.' >&2
  exit 1
fi

# The canonical-ref guard, proven by execution rather than by its presence. An assertion that is present
# but wrong is exactly the failure a grep cannot see.
npm_ref_guard='scripts/ci/require-canonical-npm-release.sh'
test -x "$npm_ref_guard" || {
  echo 'ERROR: the canonical npm release guard is missing or not executable.' >&2
  exit 1
}
rg -q 'require-canonical-npm-release\.sh' "$npm_workflow" || {
  echo 'ERROR: npm-publish.yml must invoke the canonical release guard.' >&2
  exit 1
}
test "$(rg -c 'require-canonical-npm-release\.sh' "$npm_workflow")" -ge 2 || {
  echo 'ERROR: the canonical release guard must run in the staging job, not only in verify.' >&2
  exit 1
}

npm_ref_case() {
  local expectation="$1" repository="$2" ref_type="$3" ref_name="$4" version="$5"
  local status=0
  GITHUB_REPOSITORY="$repository" GITHUB_REF_TYPE="$ref_type" GITHUB_REF_NAME="$ref_name" \
    REQUESTED_VERSION="$version" "$npm_ref_guard" >/dev/null 2>&1 || status=$?
  if [ "$expectation" = accept ] && [ "$status" -ne 0 ]; then
    echo "ERROR: the canonical release guard refused a legitimate release: $repository $ref_type $ref_name $version" >&2
    exit 1
  fi
  if [ "$expectation" = refuse ] && [ "$status" -eq 0 ]; then
    echo "ERROR: the canonical release guard accepted $repository $ref_type $ref_name $version" >&2
    exit 1
  fi
}

npm_ref_case accept cosyncing/cosyncing tag npm-v1.2.3 1.2.3
npm_ref_case refuse attacker/cosyncing tag npm-v1.2.3 1.2.3          # a fork carrying this workflow
npm_ref_case refuse cosyncing/cosyncing-private tag npm-v1.2.3 1.2.3 # a private mirror of the same tree
npm_ref_case refuse cosyncing/cosyncing branch main 1.2.3            # the default branch is not a release
npm_ref_case refuse cosyncing/cosyncing branch feature/publish 1.2.3 # an arbitrary dispatched branch
npm_ref_case refuse cosyncing/cosyncing tag npm-v1.2.4 1.2.3         # a tag for a different version
npm_ref_case refuse cosyncing/cosyncing tag broker-v1.2.3 1.2.3      # the gated native release tag
npm_ref_case refuse cosyncing/cosyncing tag npm-v1.2.3 ''            # no version to bind the tag to

for workflow in ci.yml nightly.yml broker-release.yml; do
  test "$(rg -c 'bun run check$' "$workflow_dir/$workflow")" = 1 || {
    echo "ERROR: $workflow must consume exactly one canonical repository check." >&2
    exit 1
  }
done

if rg -n \
  'acceptance:broker-deterministic|rg[0-9]+:check|test:broker-release|bun run (client:check|contract:check|test:contract-revision-history|test:web-static-cache|test:web-startup-shell)' \
  "$workflow_dir"; then
  echo 'ERROR: workflow bypasses or duplicates the canonical verification graph.' >&2
  exit 1
fi

# Branch rulesets bind to check-run names, not the workflow/job display shown
# by the Actions UI. Keep the two aggregate jobs distinct so one passing
# workflow cannot satisfy both required checks and so the configured contexts
# actually exist.
test "$(rg -c '^    name: CI required$' "$workflow_dir/ci.yml")" = 1 || {
  echo 'ERROR: ci.yml must expose the unique check-run name CI required.' >&2
  exit 1
}
test "$(rg -c '^    name: Broker Release Gate required$' "$workflow_dir/broker-release-gate.yml")" = 1 || {
  echo 'ERROR: broker-release-gate.yml must expose the unique check-run name Broker Release Gate required.' >&2
  exit 1
}
if rg -n '^    name: required$' "$workflow_dir"; then
  echo 'ERROR: ambiguous required aggregate check-run name found.' >&2
  exit 1
fi

for workflow in ci.yml nightly.yml; do
  hosted="$workflow_dir/$workflow"
  rg -q 'sudo apt-get install -y ripgrep' "$hosted" || {
    echo "ERROR: $hosted must install ripgrep before bun run check." >&2
    exit 1
  }
  rg -q 'npx --yes playwright@1\.61\.1 install --with-deps chromium-headless-shell' "$hosted" || {
    echo "ERROR: $hosted must install the pinned Playwright browser before bun run check." >&2
    exit 1
  }
done

echo 'PASS: the canonical public-hosted workflows satisfy runner, path, permission, release, and action-pin policy.'
