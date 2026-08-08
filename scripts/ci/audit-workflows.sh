#!/usr/bin/env bash
set -euo pipefail

workflow_dir='.github/workflows'
public_backup_dir='scripts/ci/github-hosted-workflows'
mode_file='.github/workflow-mode'
test -d "$workflow_dir"
test -d "$public_backup_dir"
test -f "$mode_file"

mode="$(cat "$mode_file")"
case "$mode" in
  private-self-hosted)
    if rg -n 'runs-on:\s*(ubuntu-|macos-|windows-)|runner:\s*(ubuntu-|macos-|windows-)' "$workflow_dir"; then
      echo 'ERROR: GitHub-hosted runner found in the active private workflow profile.' >&2
      exit 1
    fi
    for workflow in "$workflow_dir"/*.yml; do
      rg -q 'self-hosted' "$workflow"
    done
    ;;
  public-hosted)
    if rg -n 'self-hosted' "$workflow_dir"; then
      echo 'ERROR: self-hosted runner found in the active public workflow profile.' >&2
      exit 1
    fi
    for workflow in "$public_backup_dir"/*.yml; do
      cmp "$workflow" "$workflow_dir/${workflow##*/}"
    done
    ;;
  *)
    echo "ERROR: unsupported workflow mode: $mode" >&2
    exit 1
    ;;
esac

if rg -n 'Ubuntu3[0]90|mac-[d]ev|howard-[w]in|p[i]5|/hom[e]/|/User[s]/|BROKER[_]ROOT|pull_request_target' "$workflow_dir" "$public_backup_dir"; then
  echo 'ERROR: personal runner, personal path, sibling checkout, or unsafe PR trigger found.' >&2
  exit 1
fi

active_names="$(find "$workflow_dir" -maxdepth 1 -type f -name '*.yml' -printf '%f\n' | sort)"
backup_names="$(find "$public_backup_dir" -maxdepth 1 -type f -name '*.yml' -printf '%f\n' | sort)"
test "$active_names" = "$backup_names"

# Release-pipeline skew check. `restore-github-hosted-workflows.sh` OVERWRITES the active workflows with the
# saved copies, so a build target added to one profile and not the other silently disappears at exactly the
# moment the public migration runs — and release assembly REQUIRES every target, so publication would fail
# on the first public release. These three files must therefore be the same pipeline on different runners.
#
# Scoped to the release lane on purpose: workflows like platform-runtime.yml legitimately differ in body
# between profiles (pre-provisioned self-hosted tooling vs in-CI SDK installation).
normalize_runners() {
  sed -E "s/^( *)(runs-on:|- runner:).*/\\1\\2 RUNNER/" "$1"
}

# Declared list of sanctioned private-profile row removals. Each entry is the EXACT, whole-line,
# post-normalization block that the private profile is allowed to omit from the saved public profile.
# Exact matching only -- no wildcards, no patterns -- so every divergence that is not listed here
# still fails the skew diff below.
sanctioned_private_removals() {
  case "$1" in
    broker-release.yml|broker-release-gate.yml)
      # linux-arm64: no Linux ARM64 machine is registered in the private self-hosted fleet, and
      # scripts/broker/release/package-evidence.ts refuses to attest a target whose architecture
      # differs from the runner -- it EXECUTES the artifact to read `version --json`. So the row can
      # neither run as written (nothing picks up the job) nor be retargeted onto the x64 runner
      # (evidence rejects it before hashing). It is omitted from the private profile only; the public
      # profile keeps it on a hosted ARM runner where it builds and self-attests normally.
      # Owner blocker: register a Linux ARM64 runner, then delete this entry and restore the row.
      cat <<'SANCTIONED_ROW'
          - runner: RUNNER
            target: linux-arm64
            compile-target: bun-linux-arm64
SANCTIONED_ROW
      ;;
  esac
}

# Deletes the sanctioned block (in $block) from the normalized public profile on stdin. Exits non-zero
# when the block is absent, so an exclusion that no longer describes the public profile fails loudly
# instead of silently waiving nothing.
drop_sanctioned_block() {
  awk '
    BEGIN {
      n = split(ENVIRON["block"], want, "\n")
      while (n > 0 && want[n] == "") n--
    }
    { line[NR] = $0 }
    END {
      start = 0
      for (i = 1; i + n - 1 <= NR && start == 0; i++) {
        ok = 1
        for (j = 1; j <= n; j++) if (line[i + j - 1] != want[j]) { ok = 0; break }
        if (ok) start = i
      }
      if (start == 0) exit 3
      for (i = 1; i <= NR; i++) if (i < start || i >= start + n) print line[i]
    }'
}

for name in broker-release.yml broker-release-gate.yml broker-release-promote.yml; do
  removal=''
  if [ "$mode" = 'private-self-hosted' ]; then
    removal="$(sanctioned_private_removals "$name")"
  fi
  if [ -n "$removal" ]; then
    if ! expected="$(normalize_runners "$public_backup_dir/$name" | block="$removal" drop_sanctioned_block)"; then
      echo "ERROR: the sanctioned private-profile removal for $name no longer matches the saved public profile." >&2
      exit 1
    fi
  else
    expected="$(normalize_runners "$public_backup_dir/$name")"
  fi
  if ! diff -u <(normalize_runners "$workflow_dir/$name") <(printf '%s\n' "$expected"); then
    echo "ERROR: $name differs between the active and saved profiles beyond runner selection." >&2
    exit 1
  fi
done

# Release target/runner compatibility. The skew normalizer deliberately erases runner-selection lines,
# so on its own it cannot see a row aimed at an architecture that cannot attest it. Native package
# evidence EXECUTES the artifact, so a row's target and its runner must agree on platform and arch in
# BOTH profiles -- this is what makes retargeting linux-arm64 onto an x64 runner fail here rather than
# 30 minutes into a release.
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
    linux-x64)    allowed='["self-hosted","Linux","X64"] ubuntu-24.04 ubuntu-22.04 ubuntu-latest' ;;
    # GitHub publishes no `ubuntu-latest-arm` alias: the hosted ARM images are versioned labels only.
    linux-arm64)  allowed='["self-hosted","Linux","ARM64"] ubuntu-24.04-arm ubuntu-22.04-arm' ;;
    darwin-arm64) allowed='["self-hosted","macOS","ARM64"] macos-15 macos-14 macos-latest' ;;
    *) return 1 ;;
  esac
  for candidate in $allowed; do
    [ "$candidate" = "$2" ] && return 0
  done
  return 1
}

for directory in "$workflow_dir" "$public_backup_dir"; do
  for name in broker-release.yml broker-release-gate.yml broker-release-promote.yml; do
    while IFS="$(printf '\t')" read -r target runner; do
      [ -n "$target" ] || continue
      if ! runner_is_compatible "$target" "$runner"; then
        echo "ERROR: $directory/$name builds release target $target on incompatible runner $runner." >&2
        echo '       Native package evidence executes the artifact, so the runner must match the target.' >&2
        exit 1
      fi
    done < <(matrix_rows "$directory/$name")
  done
done

if rg -n '^\s*uses:\s*[^#[:space:]]+@(v[0-9]+|main|master)\b' "$workflow_dir" "$public_backup_dir"; then
  echo 'ERROR: GitHub Action is not pinned to a full commit SHA.' >&2
  exit 1
fi

for directory in "$workflow_dir" "$public_backup_dir"; do
  for workflow in "$directory"/*.yml; do
    rg -q '^permissions:' "$workflow"
  done
done

for directory in "$workflow_dir" "$public_backup_dir"; do
  for workflow in broker-release.yml broker-release-promote.yml; do
    rg -q 'COSYNCING_BINARY_RELEASE_LEGAL_APPROVED' "$directory/$workflow"
    rg -q 'test "\$BINARY_RELEASE_LEGAL_APPROVED" = true' "$directory/$workflow"
  done
done

for directory in "$workflow_dir" "$public_backup_dir"; do
  for workflow in ci.yml nightly.yml broker-release.yml; do
    test "$(rg -c 'bun run check$' "$directory/$workflow")" = 1 || {
      echo "ERROR: $directory/$workflow must consume exactly one canonical repository check." >&2
      exit 1
    }
  done
  if rg -n \
    'acceptance:broker-deterministic|rg[0-9]+:check|test:broker-release|bun run (client:check|contract:check|test:contract-revision-history|test:web-static-cache|test:web-startup-shell)' \
    "$directory"; then
    echo "ERROR: workflow bypasses or duplicates the canonical verification graph." >&2
    exit 1
  fi
done

# The hosted canonical check consumes tools that GitHub's Ubuntu image does not
# promise. CI and Nightly must provision the same pinned browser runtime and
# text-search dependency; otherwise Nightly can report fake policy/boundary
# failures and skip its built-browser evidence even when CI is green.
for workflow in ci.yml nightly.yml; do
  hosted="$public_backup_dir/$workflow"
  rg -q 'sudo apt-get install -y ripgrep' "$hosted" || {
    echo "ERROR: $hosted must install ripgrep before bun run check." >&2
    exit 1
  }
  rg -q 'npx --yes playwright@1\.61\.1 install --with-deps chromium-headless-shell' "$hosted" || {
    echo "ERROR: $hosted must install the pinned Playwright browser before bun run check." >&2
    exit 1
  }
done

echo "PASS: $mode workflow profile and saved public profile satisfy runner, path, permission, and action-pin policy."
