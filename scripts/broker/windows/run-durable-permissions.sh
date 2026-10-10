#!/usr/bin/env bash
# Stage the current source on NTFS and qualify durable permission behavior with native Windows Bun.
# Run from the repository root through flock ~/.cache/cosyncing-windows.lock.
set -euo pipefail
repository_root="$(git rev-parse --show-toplevel)"
[ "$(pwd -P)" = "$(realpath "$repository_root")" ] || { echo 'Run from the repository root.' >&2; exit 2; }
windows_bun="${COSYNCING_WINDOWS_BUN:?Set COSYNCING_WINDOWS_BUN to native Windows bun.exe.}"
if [[ "$windows_bun" =~ ^[A-Za-z]:\\ ]]; then windows_bun="$(wslpath -u "$windows_bun")"; fi
powershell="${COSYNCING_WINDOWS_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
windows_temp="$($powershell -NoProfile -NonInteractive -Command '[Console]::Out.Write([IO.Path]::GetTempPath())')"
windows_temp="${windows_temp//$'\r'/}"
stage_root="$(mktemp -d "$(wslpath -u "$windows_temp")/cosyncing-durable-permissions-XXXXXX")"
run_id="${COSYNCING_PERMISSIONS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Unsafe run ID.' >&2; exit 2; }
output_root="$repository_root/output/windows-permissions/$run_id"
mkdir -p "$output_root" "$stage_root/candidate"
cleanup() {
  if [ "${COSYNCING_WINDOWS_KEEP_STAGING:-0}" = 1 ]; then
    echo "Staged source retained: $stage_root"
  else
    rm -rf -- "$stage_root"
  fi
}
trap cleanup EXIT
# git archive excludes uncommitted fixes. The explicit file inventory includes this run's new tests.
git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf "$stage_root/candidate.tar"
/mnt/c/Windows/System32/tar.exe -xf "$(wslpath -w "$stage_root/candidate.tar")" -C "$(wslpath -w "$stage_root/candidate")"
printf '%s\n' "$stage_root/candidate" > "$output_root/staged-source.txt"
cd "$stage_root/candidate"
"$windows_bun" install > "$output_root/install.log" 2>&1
suites=(
  packages/typescript/broker/test/helpers/durable-permission-checks.ts
  test:broker-windows-dacl test:broker-pairing test:broker-state test:broker-doctor test:broker-lifecycle
)
for suite in "${suites[@]}"; do
  log_name="${suite//\//_}"
  log_name="${log_name//:/_}"
  "$windows_bun" run "$suite" > "$output_root/$log_name.log" 2>&1
  echo "PASS $suite"
done
printf '%s\n' "$stage_root/candidate" > "$output_root/staged-source.txt"
echo "Windows durable permission suites passed: $output_root"
