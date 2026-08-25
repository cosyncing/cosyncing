#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
if [ "$(pwd -P)" != "$(realpath "$repository_root")" ]; then
  echo "Run scripts/broker/windows/stage-phase0.sh from the repository root." >&2
  exit 2
fi

powershell_executable="${COSYNCING_WINDOWS_POWERSHELL:-}"
if [ -z "$powershell_executable" ]; then
  powershell_executable="$(command -v powershell.exe || true)"
fi
if [ -z "$powershell_executable" ] \
  && [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  powershell_executable=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
fi
if [ ! -x "$powershell_executable" ]; then
  echo "Windows PowerShell 5.1 was not found. Set COSYNCING_WINDOWS_POWERSHELL." >&2
  exit 2
fi
if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath is required to stage the candidate on the Windows filesystem." >&2
  exit 2
fi

run_id="${COSYNCING_WINDOWS_PHASE0_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "COSYNCING_WINDOWS_PHASE0_RUN_ID must be a safe 1-64 character identifier." >&2
  exit 2
fi

candidate_revision="$(git rev-parse HEAD)"
candidate_dirty=false
candidate_status="$(git status --porcelain --untracked-files=all)"
if [ -n "$candidate_status" ]; then
  candidate_dirty=true
fi
if [ "${COSYNCING_WINDOWS_PHASE0_REQUIRE_CLEAN:-0}" = 1 ] && [ "$candidate_dirty" = true ]; then
  echo "The Phase 0 freeze pass requires an exact clean commit." >&2
  exit 2
fi

windows_local_app_data="$("$powershell_executable" -NoProfile -Command \
  '[Console]::Out.Write([Environment]::GetFolderPath("LocalApplicationData"))')"
windows_local_app_data="${windows_local_app_data//$'\r'/}"
if [ -z "$windows_local_app_data" ]; then
  echo "Windows did not return a LOCALAPPDATA path." >&2
  exit 1
fi

windows_run_root="${windows_local_app_data}\\CosyncingPhase0\\${run_id}"
windows_candidate_root="${windows_run_root}\\candidate"
windows_archive_path="${windows_run_root}\\candidate.tar"
windows_result_path="${windows_run_root}\\host-probe.json"
windows_runtime_result_path="${windows_run_root}\\runtime-probe.json"
windows_behavior_result_path="${windows_run_root}\\behavior-probe.json"
windows_scheduler_result_path="${windows_run_root}\\scheduler-probe.json"
linux_run_root="$(wslpath -u "$windows_run_root")"
linux_candidate_root="$(wslpath -u "$windows_candidate_root")"
linux_archive_path="$(wslpath -u "$windows_archive_path")"
linux_result_path="$(wslpath -u "$windows_result_path")"
linux_runtime_result_path="$(wslpath -u "$windows_runtime_result_path")"
linux_behavior_result_path="$(wslpath -u "$windows_behavior_result_path")"
linux_scheduler_result_path="$(wslpath -u "$windows_scheduler_result_path")"

if [ -e "$linux_run_root" ]; then
  echo "Phase 0 run ID already exists; choose a new COSYNCING_WINDOWS_PHASE0_RUN_ID." >&2
  exit 2
fi
mkdir -p "$linux_run_root"

if [ "$candidate_dirty" = false ]; then
  candidate_archive_mode=clean-commit
  git archive --format=tar --output="$linux_archive_path" HEAD
else
  candidate_archive_mode=dirty-working-tree
  git ls-files --cached --others --exclude-standard -z \
    | tar --null --files-from=- --create --file="$linux_archive_path"
fi

application_path="${COSYNCING_WINDOWS_PHASE0_APPLICATION:-$repository_root/output/windows-broker/candidate/cosyncing}"
runtime_probe=false
if [ -f "$application_path" ]; then
  application_directory="$(dirname "$(realpath "$application_path")")"
  application_name="$(basename "$application_path")"
  tar --append --file="$linux_archive_path" \
    --directory="$application_directory" \
    --transform="s|^${application_name}$|phase0-inputs/cosyncing|" \
    "$application_name"
  runtime_probe=true
fi

windows_tar_executable=/mnt/c/Windows/System32/tar.exe
if [ ! -x "$windows_tar_executable" ]; then
  echo "Windows tar.exe was not found." >&2
  exit 2
fi
mkdir -p "$linux_candidate_root"
"$windows_tar_executable" -xf "$windows_archive_path" -C "$windows_candidate_root"

windows_probe_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase0-host-probe.ps1"
"$powershell_executable" -NoProfile \
  -File "$windows_probe_path" \
  -OutputPath "$windows_result_path" \
  -WorkingTree "$windows_candidate_root" \
  -CandidateRevision "$candidate_revision" \
  -CandidateDirty "$candidate_dirty" \
  -CandidateArchiveMode "$candidate_archive_mode"

if [ "$runtime_probe" = true ]; then
  windows_runtime_probe_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase0-runtime-probe.ps1"
  "$powershell_executable" -NoProfile \
    -File "$windows_runtime_probe_path" \
    -OutputPath "$windows_runtime_result_path" \
    -WorkingTree "$windows_candidate_root"

  windows_behavior_probe_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase0-behavior-probe.ps1"
  "$powershell_executable" -NoProfile \
    -File "$windows_behavior_probe_path" \
    -OutputPath "$windows_behavior_result_path" \
    -WorkingTree "$windows_candidate_root"

  if [ "${COSYNCING_WINDOWS_PHASE0_MUTATE_SCHEDULER:-0}" = 1 ]; then
    windows_scheduler_probe_path="${windows_candidate_root}\\scripts\\broker\\windows\\phase0-scheduler-probe.ps1"
    "$powershell_executable" -NoProfile \
      -File "$windows_scheduler_probe_path" \
      -OutputPath "$windows_scheduler_result_path" \
      -WorkingTree "$windows_candidate_root" \
      -RunId "$run_id"
  fi
fi

output_root="$repository_root/output/windows-broker"
mkdir -p "$output_root"
cp "$linux_result_path" "$output_root/host-probe-${run_id}.json"
if [ "$runtime_probe" = true ]; then
  cp "$linux_runtime_result_path" "$output_root/runtime-probe-${run_id}.json"
  cp "$linux_behavior_result_path" "$output_root/behavior-probe-${run_id}.json"
  if [ "${COSYNCING_WINDOWS_PHASE0_MUTATE_SCHEDULER:-0}" = 1 ]; then
    cp "$linux_scheduler_result_path" "$output_root/scheduler-probe-${run_id}.json"
  fi
fi

echo "Phase 0 host probe complete."
echo "Result: output/windows-broker/host-probe-${run_id}.json"
if [ "$runtime_probe" = true ]; then
  echo "Result: output/windows-broker/runtime-probe-${run_id}.json"
  echo "Result: output/windows-broker/behavior-probe-${run_id}.json"
  if [ "${COSYNCING_WINDOWS_PHASE0_MUTATE_SCHEDULER:-0}" = 1 ]; then
    echo "Result: output/windows-broker/scheduler-probe-${run_id}.json"
  fi
else
  echo "Runtime probe skipped: no candidate application bundle was provided."
fi
echo "The NTFS staging directory was preserved for review."
