#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
if [ "$(pwd -P)" != "$(realpath "$repository_root")" ]; then
  echo "Run scripts/broker/windows/stage-phase1-invocation.sh from the repository root." >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "The Phase 1 native probe requires an exact clean commit." >&2
  exit 2
fi
if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath is required to stage the candidate on NTFS." >&2
  exit 2
fi

powershell_executable="${COSYNCING_WINDOWS_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
windows_tar_executable=/mnt/c/Windows/System32/tar.exe
windows_bun="${COSYNCING_WINDOWS_BUN:-}"
if [ ! -x "$powershell_executable" ] || [ ! -x "$windows_tar_executable" ]; then
  echo "Windows PowerShell 5.1 and tar.exe are required." >&2
  exit 2
fi
if [ -z "$windows_bun" ]; then
  echo "Set COSYNCING_WINDOWS_BUN to the native Windows bun.exe under qualification." >&2
  exit 2
fi
if [[ "$windows_bun" =~ ^[A-Za-z]:\\ ]]; then
  linux_bun="$(wslpath -u "$windows_bun")"
else
  linux_bun="$windows_bun"
  windows_bun="$(wslpath -w "$linux_bun")"
fi
if [ ! -x "$linux_bun" ]; then
  echo "COSYNCING_WINDOWS_BUN is not an executable file." >&2
  exit 2
fi

run_id="${COSYNCING_WINDOWS_PHASE1_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE1_RUN_ID must be a safe 1-64 character identifier." >&2
  exit 2
fi
revision="$(git rev-parse HEAD)"
windows_local_app_data="$("$powershell_executable" -NoProfile -NonInteractive -Command \
  '[Console]::Out.Write([Environment]::GetFolderPath("LocalApplicationData"))')"
windows_local_app_data="${windows_local_app_data//$'\r'/}"
windows_run_root="${windows_local_app_data}\\CosyncingPhase1\\${run_id}"
windows_candidate_root="${windows_run_root}\\candidate"
linux_run_root="$(wslpath -u "$windows_run_root")"
linux_archive_path="${linux_run_root}/candidate.tar"
linux_report_path="$(wslpath -u "${windows_candidate_root}\\scripts\\broker\\windows\\phase1-invocation-report.json")"
if [ -e "$linux_run_root" ]; then
  echo "Phase 1 run ID already exists." >&2
  exit 2
fi

mkdir -p "$linux_run_root" "$(wslpath -u "$windows_candidate_root")"
git archive --format=tar --output="$linux_archive_path" HEAD
"$windows_tar_executable" -xf "$(wslpath -w "$linux_archive_path")" -C "$windows_candidate_root"

windows_probe_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase1-invocation-probe.ts"
windows_runner_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase1-invocation-runner.ps1"
"$powershell_executable" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "$windows_runner_path" \
  -SourceCommit "$revision" \
  -RunId "$run_id" \
  -BunPath "$windows_bun" \
  -ProbePath "$windows_probe_path"

output_root="$repository_root/output/windows-broker/phase1"
mkdir -p "$output_root"
cp "$linux_report_path" "$output_root/invocation-${run_id}.json"
echo "Phase 1 invocation probe complete: output/windows-broker/phase1/invocation-${run_id}.json"
