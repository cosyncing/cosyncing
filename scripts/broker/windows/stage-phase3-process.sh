#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
if [ "$(pwd -P)" != "$(realpath "$repository_root")" ]; then
  echo "Run scripts/broker/windows/stage-phase3-process.sh from the repository root." >&2
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
if [ "${COSYNCING_WINDOWS_PHASE3_REQUIRE_CLEAN:-1}" = 1 ] && [ "$dirty" = true ]; then
  echo "The Phase 3 freeze probe requires an exact clean commit." >&2
  exit 2
fi
run_id="${COSYNCING_WINDOWS_PHASE3_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE3_RUN_ID must be a safe 1-64 character identifier." >&2
  exit 2
fi
revision="$(git rev-parse HEAD)"
windows_local_app_data="$($powershell_executable -NoProfile -NonInteractive -Command \
  '[Console]::Out.Write([Environment]::GetFolderPath("LocalApplicationData"))')"
windows_local_app_data="${windows_local_app_data//$'\r'/}"
windows_run_root="${windows_local_app_data}\\CosyncingPhase3\\${run_id}"
windows_candidate_root="${windows_run_root}\\candidate"
windows_probe_root="${windows_run_root}\\probe-state"
linux_run_root="$(wslpath -u "$windows_run_root")"
archive_path="${linux_run_root}/candidate.tar"
if [ -e "$linux_run_root" ]; then echo "Phase 3 run ID already exists." >&2; exit 2; fi
mkdir -p "$linux_run_root" "$(wslpath -u "$windows_candidate_root")"
if [ "$dirty" = false ]; then
  git archive --format=tar --output="$archive_path" HEAD
else
  tar -cf "$archive_path" scripts/broker/windows packages/typescript/adapter-api
fi
"$windows_tar_executable" -xf "$(wslpath -w "$archive_path")" -C "$windows_candidate_root"
report_path="$repository_root/output/windows-broker/phase3/process-${run_id}.json"
mkdir -p "$(dirname "$report_path")"
"$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "${windows_candidate_root}\\scripts\\broker\\windows\\phase3-process-runner.ps1" \
  -ProbePath "${windows_candidate_root}\\scripts\\broker\\windows\\phase3-process-probe.ts" \
  -ProbeRoot "$windows_probe_root" -RunId "$run_id" -SourceCommit "$revision" -SourceDirty "$dirty" \
  > "$report_path" 2> "${report_path%.json}.stderr"
echo "Phase 3 process probe complete: ${report_path#"$repository_root/"}"
