#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
if [ "$(pwd -P)" != "$(realpath "$repository_root")" ]; then
  echo "Run scripts/broker/windows/stage-phase4-service.sh from the repository root." >&2
  exit 2
fi
if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath is required to stage the candidate on NTFS." >&2
  exit 2
fi
powershell_executable="${COSYNCING_WINDOWS_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
windows_tar_executable=/mnt/c/Windows/System32/tar.exe
dirty=false
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then dirty=true; fi
if [ "${COSYNCING_WINDOWS_PHASE4_REQUIRE_CLEAN:-1}" = 1 ] && [ "$dirty" = true ]; then
  echo "The Phase 4 freeze probe requires an exact clean commit." >&2
  exit 2
fi
run_id="${COSYNCING_WINDOWS_PHASE4_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE4_RUN_ID must be a safe 1-64 character identifier." >&2
  exit 2
fi
revision="$(git rev-parse HEAD)"
windows_local_app_data="$($powershell_executable -NoProfile -NonInteractive -Command \
  '[Console]::Out.Write([Environment]::GetFolderPath("LocalApplicationData"))')"
windows_local_app_data="${windows_local_app_data//$'\r'/}"
windows_run_root="${windows_local_app_data}\\CosyncingPhase4\\${run_id}"
windows_candidate_root="${windows_run_root}\\candidate"
windows_probe_root="${windows_run_root}\\probe-state"
linux_run_root="$(wslpath -u "$windows_run_root")"
archive_path="${linux_run_root}/candidate.tar"
if [ -e "$linux_run_root" ]; then echo "Phase 4 run ID already exists." >&2; exit 2; fi

# Staging cleanup. UNCONDITIONAL in CI and on success; an INTERACTIVE failure keeps the tree,
# because then a person is standing there and it is the only place left to diagnose from.
#
# Phase 7's CI lane requires an unconditional final cleanup step. Without one these roots simply
# accumulate: 84 run directories across the six phase roots had built up on the qualification host
# before this existed, none of them referenced by any recorded evidence — that lives under
# `output/windows-broker/`.
staging_ready=0
cleanup_staging() {
  local status=$?
  [ "$staging_ready" = 1 ] || return 0
  if [ "${COSYNCING_WINDOWS_KEEP_STAGING:-0}" = 1 ]; then
    echo "Staging kept by request: $linux_run_root" >&2
    return 0
  fi
  if [ "$status" -ne 0 ] && [ "${CI:-}" != "true" ]; then
    echo "Staging kept for diagnosis (exit $status): $linux_run_root" >&2
    return 0
  fi
  # A COMPUTED path is being deleted, so it must be the run root this invocation created.
  case "$linux_run_root" in
    */CosyncingPhase4/"$run_id")
      rm -rf -- "$linux_run_root"
      ;;
    *)
      echo "Refusing to remove an unexpected run root: $linux_run_root" >&2
      ;;
  esac
}
trap cleanup_staging EXIT
mkdir -p "$linux_run_root" "$(wslpath -u "$windows_candidate_root")"
staging_ready=1
git archive --format=tar --output="$archive_path" HEAD
"$windows_tar_executable" -xf "$(wslpath -w "$archive_path")" -C "$windows_candidate_root"
report_path="$repository_root/output/windows-broker/phase4/service-${run_id}.json"
mkdir -p "$(dirname "$report_path")"
"$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "${windows_candidate_root}\\scripts\\broker\\windows\\phase4-service-runner.ps1" \
  -CandidateRoot "$windows_candidate_root" \
  -ProbePath "${windows_candidate_root}\\scripts\\broker\\windows\\phase4-service-probe.ts" \
  -ProbeRoot "$windows_probe_root" -RunId "$run_id" -SourceCommit "$revision" -SourceDirty "$dirty" \
  > "$report_path" 2> "${report_path%.json}.stderr"
echo "Phase 4 service probe complete: ${report_path#"$repository_root/"}"
