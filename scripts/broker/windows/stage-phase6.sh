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
  phase6-pi-probe.ts|phase6-opencode-probe.ts) exclusivity_reason='' ;;
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
windows_candidate_root="${windows_run_root}\\candidate"
windows_probe_root="${windows_run_root}\\probe-state"
linux_run_root="$(wslpath -u "$windows_run_root")"
archive_path="${linux_run_root}/candidate.tar"
if [ -e "$linux_run_root" ]; then echo "Phase 6 run ID already exists." >&2; exit 2; fi
mkdir -p "$linux_run_root" "$(wslpath -u "$windows_candidate_root")"
git archive --format=tar --output="$archive_path" HEAD
"$windows_tar_executable" -xf "$(wslpath -w "$archive_path")" -C "$windows_candidate_root"
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
trap 'stop_windows_runner; exit 130' INT TERM

# Run the runner in the BACKGROUND and wait on it. A foreground command defers every trap until it
# returns, so the INT/TERM handler above could not fire while the probe was running — which is the
# whole window it exists for. Observed: a TERM left the PowerShell tree and its opencode serve alive.
"$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "${windows_candidate_root}\\scripts\\broker\\windows\\phase6-runner.ps1" \
  -CandidateRoot "$windows_candidate_root" \
  -ProbePath "${windows_candidate_root}\\scripts\\broker\\windows\\${probe_name}" \
  -ProbeRoot "$windows_probe_root" -RunId "$run_id" -SourceCommit "$revision" -SourceDirty "$dirty" \
  -ExclusiveAgent "$([ "$exclusive_agent" = 1 ] && echo true || echo false)" \
  > "$report_path" 2> "${report_path%.json}.stderr" &
runner_interop_pid=$!
set +e
wait "$runner_interop_pid"
runner_status=$?
set -e
# A failed run keeps its staging: that tree is the only place left to diagnose from.
if [ "$runner_status" -ne 0 ]; then
  echo "The Phase 6 runner failed (exit $runner_status); see ${report_path%.json}.stderr" >&2
  exit "$runner_status"
fi
# Remove the staged candidate, the downloaded Bun runtimes, and the probe state on SUCCESS only; a
# failed run's tree is the only place left to diagnose it from. Six Phase 6 runs had accumulated
# two gigabytes under LocalApplicationData before this existed. The guard is deliberate: this
# deletes a computed path, so it must be the run root this invocation created and nothing else.
if [ "${COSYNCING_WINDOWS_PHASE6_KEEP_STAGING:-0}" != 1 ]; then
  case "$linux_run_root" in
    */CosyncingPhase6/"$run_id")
      rm -rf -- "$linux_run_root"
      ;;
    *)
      echo "Refusing to remove an unexpected Phase 6 run root: $linux_run_root" >&2
      ;;
  esac
fi
echo "Phase 6 probe complete: ${report_path#"$repository_root/"}"
