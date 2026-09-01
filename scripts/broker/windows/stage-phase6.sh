#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
if [ "$(pwd -P)" != "$(realpath "$repository_root")" ]; then
  echo "Run scripts/broker/windows/stage-phase6.sh from the repository root." >&2
  exit 2
fi
if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath is required to stage the candidate on NTFS." >&2
  exit 2
fi
powershell_executable="${COSYNCING_WINDOWS_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
windows_tar_executable=/mnt/c/Windows/System32/tar.exe
windows_taskkill_executable=/mnt/c/Windows/System32/taskkill.exe
windows_cmd_executable=/mnt/c/Windows/System32/cmd.exe
dirty=false
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then dirty=true; fi
if [ "${COSYNCING_WINDOWS_PHASE6_REQUIRE_CLEAN:-1}" = 1 ] && [ "$dirty" = true ]; then
  echo "The Phase 6 freeze probe requires an exact clean commit." >&2
  exit 2
fi
# One staging path for every Phase 6 probe, whatever agent it qualifies: the slices differ only in
# which probe runs and which evidence identity it writes under, and a second copy of this script
# would be a second place to fix the NTFS/PATH/clean-commit rules.
probe_name="${COSYNCING_WINDOWS_PHASE6_PROBE:-phase6-pi-probe.ts}"
report_prefix="${COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX:-pi}"
if [[ ! "$probe_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.ts$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE6_PROBE must name a probe file in scripts/broker/windows." >&2
  exit 2
fi
if [ ! -f "$repository_root/scripts/broker/windows/$probe_name" ]; then
  echo "No such Phase 6 probe: scripts/broker/windows/$probe_name" >&2
  exit 2
fi
if [[ ! "$report_prefix" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX must be a safe 1-32 character identifier." >&2
  exit 2
fi
exclusive_agent="${COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT:-0}"
# The drive trace writes captured bytes back into the operator's own Pi agent directory. Nothing
# this harness can observe distinguishes the operator's `pi` from any other `node.exe`, so the
# guarantee that nothing else is writing there is the operator's to make, and it is made here
# rather than assumed. Refused before staging, so a missing declaration costs no round trip.
# A DENYLIST of probes that need no declaration, not an allowlist of those that do: a probe added
# later then defaults to needing one rather than silently skipping the question.
case "$probe_name" in
  # The OpenCode probes run against a disposable OPENCODE_DATA, OPENCODE_CONFIG_DIR, and
  # workspace, on a port they bound themselves, so they never read or write the operator's own
  # OpenCode state and need no declaration.
  phase6-pi-probe.ts|phase6-opencode-probe.ts|phase6-opencode-drive-probe.ts|phase6-opencode-terminal-probe.ts|phase6-claude-probe.ts|phase6-codex-probe.ts|phase6-kimi-probe.ts|phase6-dsh-probe.ts|phase6-dsh-managed-probe.ts) exclusivity_reason='' ;;
  # Every entry above rests on a claim its author could actually make about what that probe touches.
  # No such claim is available for the survey: it runs whichever `test:broker*` scripts the manifest
  # happens to contain, so what it touches is whatever those suites touch, including suites added
  # after this line was written. It gives each one a disposable COSYNCING_HOME and cache, which is
  # not the same as knowing none of them reaches an agent directory.
  phase7-lane-probe.ts|phase7-smoke-probe.ts|phase7-suite-survey.ts) exclusivity_reason='runs every broker suite in the manifest, so what it touches is whatever those suites touch' ;;
  *) exclusivity_reason='restores files in your Pi agent directory and must not run while Pi is in use elsewhere' ;;
esac
if [ -n "$exclusivity_reason" ] && [ "$exclusive_agent" != 1 ]; then
  echo "This probe $exclusivity_reason." >&2
  echo "Re-run with COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT=1 to declare that." >&2
  exit 2
fi
run_id="${COSYNCING_WINDOWS_PHASE6_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE6_RUN_ID must be a safe 1-64 character identifier." >&2
  exit 2
fi
revision="$(git rev-parse HEAD)"
windows_local_app_data="$($powershell_executable -NoProfile -NonInteractive -Command \
  '[Console]::Out.Write([Environment]::GetFolderPath("LocalApplicationData"))')"
windows_local_app_data="${windows_local_app_data//$'\r'/}"
windows_run_root="${windows_local_app_data}\\CosyncingPhase6\\${run_id}"
# Shared across runs: the pinned Bun runtimes are ~90MB each and identical every time, and
# re-downloading them was the single largest cost of a run.
windows_bun_cache="${windows_local_app_data}\\CosyncingPhase6\\bun-cache"

# One Phase 6 run at a time, host-wide. Two overlapping runs are not merely untidy: each probe
# treats every agent process that appeared since ITS opening snapshot as its own, so the second run
# kills the first run's serve and then fails the assertion that nothing outlived it. That is exactly
# how `teardown.noSurvivingServeProcess` went red at 08953182 with no product change behind it.
# The lock is taken on the shared Phase 6 root, so it also covers a run staged from another
# worktree of this repository.
phase6_root="$(wslpath -u "${windows_local_app_data}\\CosyncingPhase6")"
mkdir -p "$phase6_root"
lock_holder="${phase6_root}/run.holder"
exec 9>"${phase6_root}/run.lock"
if ! flock -n 9; then
  echo "Another Phase 6 run is in progress; runs must not overlap." >&2
  if [ -f "$lock_holder" ]; then echo "Holder: $(cat "$lock_holder")" >&2; fi
  exit 2
fi
printf 'run %s pid %s probe %s started %s\n' "$run_id" "$$" "$probe_name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock_holder"
# Probe options, as `NAME=value` pairs separated by `;`. The runner restricts the names it will set.
probe_env="${COSYNCING_WINDOWS_PHASE6_PROBE_ENV:-}"
probe_env_pattern='^[A-Za-z0-9_=,.:;/-]+$'
if [ -n "$probe_env" ] && [[ ! "$probe_env" =~ $probe_env_pattern ]]; then
  echo "COSYNCING_WINDOWS_PHASE6_PROBE_ENV accepts only NAME=value pairs separated by ';'." >&2
  exit 2
fi
lanes="${COSYNCING_WINDOWS_PHASE6_LANES:-1.3.8,1.4.0}"
if [[ ! "$lanes" =~ ^[0-9.]+(,[0-9.]+)*$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE6_LANES must be a comma-separated list of Bun versions." >&2
  exit 2
fi
windows_candidate_root="${windows_run_root}\\candidate"
windows_probe_root="${windows_run_root}\\probe-state"
linux_run_root="$(wslpath -u "$windows_run_root")"
archive_path="${linux_run_root}/candidate.tar"
# Initialised BEFORE the run root exists, so an early failure cannot send the cleanup below at a
# half-computed path, and set once it does. Order matters: this initializer used to sit AFTER the
# assignment below, so it ran second and left the flag at 0 for the rest of the script — the cleanup
# trap then returned early every time, on success as well as failure. Forty-four run roots and 6.6GB
# accumulated under LocalApplicationData before anyone looked.
staging_ready=0
if [ -e "$linux_run_root" ]; then echo "Phase 6 run ID already exists." >&2; exit 2; fi
mkdir -p "$linux_run_root" "$(wslpath -u "$windows_candidate_root")"
staging_ready=1
git archive --format=tar --output="$archive_path" HEAD
"$windows_tar_executable" -xf "$(wslpath -w "$archive_path")" -C "$windows_candidate_root"
# `git archive` carries tracked files only, which is right for the candidate SOURCE but cannot carry a
# built artifact. A probe that installs a packaged candidate needs the actual tarball, so one repository
# file may be copied in beside it, under a fixed name the probe can find without being told a path.
artifact="${COSYNCING_WINDOWS_PHASE6_ARTIFACT:-}"
if [ -n "$artifact" ]; then
  if [[ ! "$artifact" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$artifact" == *..* ]]; then
    echo "COSYNCING_WINDOWS_PHASE6_ARTIFACT must be a repository-relative path." >&2
    exit 2
  fi
  if [ ! -f "$repository_root/$artifact" ]; then
    echo "No such artifact: $artifact" >&2
    exit 2
  fi
  # Beside the extracted candidate, NOT at the run root: the probe is handed the candidate root, while
  # its own COSYNCING_WINDOWS_PHASE6_ROOT is a per-Bun-version subdirectory of probe-state, so a copy at
  # the run root is one level above anything the probe can name without guessing at the layout.
  linux_candidate_root="$(wslpath -u "$windows_candidate_root")"
  mkdir -p "${linux_candidate_root}/.staged-artifact"
  cp "$repository_root/$artifact" "${linux_candidate_root}/.staged-artifact/$(basename "$artifact")"
fi
report_path="$repository_root/output/windows-broker/phase6/${report_prefix}-${run_id}.json"
mkdir -p "$(dirname "$report_path")"
# Interrupting this script must stop the Windows side too. Killing the interop process does not:
# the runner is a separate Win32 process tree that keeps going, and a later run then races it for
# the operator's agent directory — which is exactly how two probes once ran at once.
stop_windows_runner() {
  local pid_file="${linux_run_root}/runner.pid"
  [ -f "$pid_file" ] || return 0
  local runner_pid
  runner_pid="$(tr -d '\r\n' < "$pid_file")"
  case "$runner_pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  "$windows_taskkill_executable" /PID "$runner_pid" /T /F >/dev/null 2>&1 || true
}
# Cleanup is UNCONDITIONAL in CI and on success, and that is a Phase 7
# requirement rather than a preference: the CI lane has nobody to read a failed
# tree, and every leaked run accumulates on the runner until it fills. An
# INTERACTIVE failure still keeps the tree, because then a person is standing
# there and it is the only place left to diagnose from. Six Phase 6 runs had
# accumulated two gigabytes under LocalApplicationData before any of this
# existed, and the phases before this one still hold several more.
cleanup_staging() {
  local status=$?
  [ "$staging_ready" = 1 ] || return 0
  if [ "${COSYNCING_WINDOWS_PHASE6_KEEP_STAGING:-0}" = 1 ]; then
    echo "Phase 6 staging kept by request: $windows_run_root" >&2
    return 0
  fi
  # The probe writes a retention receipt the moment it can have installed a durable object, and removes
  # it only once it has PROVEN the removal. A receipt still on disk means a scheduled task, a listener or
  # a process may survive — and deleting the tree then destroys the receipts, the state and the staged
  # binary that recovery needs, while leaving the scheduler object behind with nothing pointing at it.
  # This outranks the unconditional CI cleanup below deliberately: an orphaned task on a CI runner with
  # no evidence is worse than a retained directory, and only one of the two can be cleaned up later.
  local retained_receipts
  retained_receipts="$(find "$linux_run_root" -maxdepth 3 -name 'phase7-retention-receipt.json' -type f 2>/dev/null | wc -l)"
  if [ "$retained_receipts" -gt 0 ]; then
    echo "Phase 6 staging RETAINED: the probe could not prove it removed everything it installed." >&2
    echo "  $retained_receipts retention receipt(s) under $windows_run_root" >&2
    echo "  Recover the scheduler objects, listeners and processes named there before deleting it." >&2
    return 0
  fi
  if [ "$status" -ne 0 ] && [ "${CI:-}" != "true" ]; then
    echo "Phase 6 staging kept for diagnosis (exit $status): $windows_run_root" >&2
    echo "Set CI=true, or COSYNCING_WINDOWS_PHASE6_KEEP_STAGING=0 and rerun, to remove it." >&2
    return 0
  fi
  # This deletes a COMPUTED path, so it must be the run root this invocation
  # created and nothing else.
  case "$linux_run_root" in
    */CosyncingPhase6/"$run_id")
      # Delete through Windows. `rm -rf` over /mnt/c walks every file across the interop boundary and
      # took longer than the run it was cleaning up after; a native delete is the same work done once.
      #
      # Through a script parameter, NOT `cmd /c "rd /s /q \"$path\""`. That form cannot survive the WSL
      # boundary: WSL rebuilds a command line from argv and escapes the inner quotes as \", cmd does not
      # unescape them, and `rd` rejects the path while exiting 0 — so the fallback below never fired and
      # this cleanup deleted nothing for as long as it existed. The helper verifies and exits non-zero.
      #
      # Run the REPOSITORY's copy of the helper, not the staged one: the staged copy lives inside the
      # tree being deleted, and a run that failed before staging finished may not have one at all.
      "$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
        -File "$(wslpath -w "$repository_root/scripts/broker/windows/remove-staging-tree.ps1")" \
        -Path "$windows_run_root" >/dev/null 2>&1 \
        || rm -rf -- "$linux_run_root"
      ;;
    *)
      echo "Refusing to remove an unexpected Phase 6 run root: $linux_run_root" >&2
      ;;
  esac
}
trap cleanup_staging EXIT
trap 'stop_windows_runner; exit 130' INT TERM

# The runner runs in the FOREGROUND. Backgrounding it and waiting was tried, to make the INT/TERM
# trap reachable during the probe, and it cost every run: the job did not survive, `wait` never
# returned a status, and the script died leaving a zero-byte report. An interrupt is handled instead
# by `runner.pid` below, which is what actually stopped a stale runner in practice.
"$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "${windows_candidate_root}\\scripts\\broker\\windows\\phase6-runner.ps1" \
  -CandidateRoot "$windows_candidate_root" \
  -ProbePath "${windows_candidate_root}\\scripts\\broker\\windows\\${probe_name}" \
  -ProbeRoot "$windows_probe_root" -RunId "$run_id" -SourceCommit "$revision" -SourceDirty "$dirty" \
  -ExclusiveAgent "$([ "$exclusive_agent" = 1 ] && echo true || echo false)" \
  -BunCache "$windows_bun_cache" -Lanes "$lanes" \
  -ProbeEnv "$probe_env" \
  > "$report_path" 2> "${report_path%.json}.stderr"
echo "Phase 6 probe complete: ${report_path#"$repository_root/"}"
