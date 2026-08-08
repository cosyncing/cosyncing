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
