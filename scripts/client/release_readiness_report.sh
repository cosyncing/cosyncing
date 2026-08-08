#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/release_readiness_report.sh [--targets <targets>] [--format <text|json>]

Reports whether repo/tooling prerequisites are present for release-oriented packaging
targets without running builds.

Targets:
  web
  android
  linux
  macos
  windows
  ios-simulator
  host

Targets are comma- or space-separated, for example:
  --targets web,android,linux
  --targets "web linux"

If no targets are provided, uses RELEASE_READINESS_TARGETS when set; otherwise:
  web,android,linux,macos,windows,ios-simulator,host

Format:
  --format text   (default)
  --format json

Notes:
- "host" resolves to the local desktop target.
- Unknown targets fail usage with exit code 2.
- Skipped entries are OS-host incompatibilities.
- Exit code 0: all selected known targets are ready or skipped.
- Exit code 1: at least one selected supported target is not-ready.
- Exit code 2: usage, root, or unknown-target errors.
EOF
}

TARGETS_INPUT="${RELEASE_READINESS_TARGETS:-web,android,linux,macos,windows,ios-simulator,host}"
REPORT_FORMAT="text"

ROOT_DIR="$PWD"
CLIENT_ROOT="${ROOT_DIR}/apps/client"
SCRIPT_PATH="${ROOT_DIR}/scripts/client/release_readiness_report.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --targets=*)
      TARGETS_INPUT="${1#*=}"
      shift
      ;;
    --targets)
      if [ $# -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "Missing value for --targets."
        usage
        exit 2
      fi
      TARGETS_INPUT="${2:-}"
      shift 2
      ;;
    --format=*)
      REPORT_FORMAT="${1#*=}"
      shift
      ;;
    --format)
      if [ $# -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "Missing value for --format."
        usage
        exit 2
      fi
      REPORT_FORMAT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [ "$REPORT_FORMAT" != "text" ] && [ "$REPORT_FORMAT" != "json" ]; then
  echo "Invalid --format value: $REPORT_FORMAT (expected text or json)."
  usage
  exit 2
fi

if [ ! -f "${SCRIPT_PATH}" ]; then
  echo "ERROR: run this script from the cosyncing monorepo root."
  exit 2
fi

if [ ! -f "${CLIENT_ROOT}/pubspec.yaml" ]; then
  echo "ERROR: missing pubspec.yaml at ${CLIENT_ROOT}/pubspec.yaml."
  echo "Run this script from the cosyncing monorepo root."
  exit 2
fi

if [ ! -f "${ROOT_DIR}/.fvmrc" ]; then
  echo "ERROR: missing .fvmrc at ${ROOT_DIR}/.fvmrc."
  echo "Run this script from the cosyncing monorepo root."
  exit 2
fi

TARGETS=()
NORMALIZED_TARGETS="$(printf '%s' "$TARGETS_INPUT" | tr ', ' '\n' | awk '
  {
    gsub(/^[[:space:]]+/, "", $0)
    gsub(/[[:space:]]+$/, "", $0)
    if ($0 != "") print tolower($0)
  }
')"

for target in $NORMALIZED_TARGETS; do
  TARGETS+=("$target")
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No targets were selected."
  exit 2
fi

HOST_OS="unknown"
case "$OSTYPE" in
  linux-gnu* | linux*) HOST_OS="linux" ;;
  darwin*) HOST_OS="macos" ;;
  msys* | mingw* | cygwin*) HOST_OS="windows" ;;
  *) HOST_OS="other" ;;
esac

is_known_target() {
  case "$1" in
    web|android|linux|macos|windows|ios-simulator|host)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_host_target() {
  local target="$1"
  if [ "$target" != "host" ]; then
    echo "$target"
    return 0
  fi

  case "$HOST_OS" in
    linux|macos|windows)
      echo "$HOST_OS"
      return 0
      ;;
    *)
      echo "unsupported"
      return 1
      ;;
  esac
}

is_supported() {
  local target="$1"
  case "$target" in
    web|android)
      return 0
      ;;
    linux)
      [ "$HOST_OS" = "linux" ]
      ;;
    macos|ios-simulator)
      [ "$HOST_OS" = "macos" ]
      ;;
    windows)
      [ "$HOST_OS" = "windows" ]
      ;;
    *)
      return 1
      ;;
  esac
}

LAST_REASON=""

append_reason() {
  local reason="$1"
  if [ -z "$LAST_REASON" ]; then
    LAST_REASON="$reason"
  else
    LAST_REASON="${LAST_REASON}; ${reason}"
  fi
}

check_file_prereqs() {
  local -a files=("$@")
  LAST_REASON=""
  for file in "${files[@]}"; do
    if [ ! -f "${CLIENT_ROOT}/${file}" ]; then
      append_reason "missing required file: ${file}"
    fi
  done
  if [ -n "$LAST_REASON" ]; then
    return 1
  fi
  return 0
}

check_host_tooling() {
  local target="$1"
  LAST_REASON=""
  if ! command -v flutter >/dev/null 2>&1; then
    append_reason "missing flutter command"
  fi
  if ! command -v dart >/dev/null 2>&1; then
    append_reason "missing dart command"
  fi

  case "$target" in
    android)
      if ! command -v java >/dev/null 2>&1; then
        append_reason "missing java command"
      fi
      if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] && ! command -v sdkmanager >/dev/null 2>&1 && ! command -v adb >/dev/null 2>&1; then
        append_reason "android sdk not configured (ANDROID_HOME/ANDROID_SDK_ROOT unset and sdkmanager/adb missing)"
      fi
      ;;
    linux)
      if ! command -v cmake >/dev/null 2>&1; then
        append_reason "missing cmake command"
      fi
      if ! command -v ninja >/dev/null 2>&1; then
        append_reason "missing ninja command"
      fi
      if ! command -v pkg-config >/dev/null 2>&1; then
        append_reason "missing pkg-config command"
      fi
      ;;
    macos|ios-simulator)
      if ! command -v xcodebuild >/dev/null 2>&1; then
        append_reason "missing xcodebuild command"
      fi
      ;;
    windows)
      if ! command -v cmake >/dev/null 2>&1; then
        append_reason "missing cmake command"
      fi
      if ! command -v powershell >/dev/null 2>&1 && ! command -v powershell.exe >/dev/null 2>&1; then
        append_reason "missing powershell command"
      fi
      ;;
  esac

  if [ -n "$LAST_REASON" ]; then
    return 1
  fi
  return 0
}

check_web() {
  if ! check_host_tooling "web"; then
    return 1
  fi
  if ! check_file_prereqs \
    "web/index.html" \
    "web/manifest.json"; then
    return 1
  fi
  LAST_REASON="ready: flutter and dart present and required web manifest files are present"
  return 0
}

check_android() {
  if ! check_host_tooling "android"; then
    return 1
  fi
  if ! check_file_prereqs \
    "android/app/build.gradle.kts" \
    "android/app/src/main/AndroidManifest.xml" \
    "android/app/src/main/kotlin/com/cosyncing/client/MainActivity.kt"; then
    return 1
  fi
  LAST_REASON="ready: flutter/dart and Java are present, Android manifest files exist, and Android SDK appears configured"
  return 0
}

check_linux() {
  if ! check_host_tooling "linux"; then
    return 1
  fi
  if ! check_file_prereqs \
    "linux/CMakeLists.txt" \
    "linux/runner/my_application.cc"; then
    return 1
  fi
  LAST_REASON="ready: linux desktop toolchain present and required Linux manifests are present"
  return 0
}

check_macos() {
  if ! check_host_tooling "macos"; then
    return 1
  fi
  if ! check_file_prereqs \
    "macos/Runner/Configs/AppInfo.xcconfig" \
    "macos/Runner/Info.plist" \
    "macos/Runner.xcodeproj/project.pbxproj"; then
    return 1
  fi
  LAST_REASON="ready: macOS tooling and required macOS manifest files are present"
  return 0
}

check_windows() {
  if ! check_host_tooling "windows"; then
    return 1
  fi
  if ! check_file_prereqs \
    "windows/CMakeLists.txt" \
    "windows/runner/Runner.rc"; then
    return 1
  fi
  LAST_REASON="ready: windows tooling and required Windows manifest files are present"
  return 0
}

check_ios_simulator() {
  if ! check_host_tooling "ios-simulator"; then
    return 1
  fi
  if ! check_file_prereqs \
    "ios/Runner.xcodeproj/project.pbxproj" \
    "ios/Runner/Info.plist" \
    "ios/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme"; then
    return 1
  fi
  LAST_REASON="ready: iOS simulator tooling and required iOS manifest files are present"
  return 0
}

run_target_check() {
  local target="$1"
  LAST_REASON=""
  case "$target" in
    web)
      check_web
      ;;
    android)
      check_android
      ;;
    linux)
      check_linux
      ;;
    macos)
      check_macos
      ;;
    windows)
      check_windows
      ;;
    ios-simulator)
      check_ios_simulator
      ;;
    *)
      append_reason "unknown target check function"
      return 1
      ;;
  esac
}

JSON_ESCAPE() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e 's/\n/\\n/g' \
    -e 's/\r/\\r/g'
}

REPORTED_TARGETS=()
REPORTED_STATUS=()
REPORTED_REASON=()
READY_COUNT=0
NOT_READY_COUNT=0
SKIP_COUNT=0
UNKNOWN_TARGET_COUNT=0

for target in "${TARGETS[@]}"; do
  TARGET_STATUS=""
  TARGET_REASON=""

  if ! is_known_target "$target"; then
    TARGET_STATUS="not-ready"
    TARGET_REASON="unknown target"
    ((NOT_READY_COUNT += 1))
    ((UNKNOWN_TARGET_COUNT += 1))
    REPORTED_TARGETS+=("$target")
    REPORTED_STATUS+=("$TARGET_STATUS")
    REPORTED_REASON+=("$TARGET_REASON")
    continue
  fi

  resolved_target="$(resolve_host_target "$target")"
  if [ "$resolved_target" = "unsupported" ]; then
    TARGET_STATUS="skipped"
    TARGET_REASON="host target unavailable on this operating system"
    ((SKIP_COUNT += 1))
    REPORTED_TARGETS+=("$target")
    REPORTED_STATUS+=("$TARGET_STATUS")
    REPORTED_REASON+=("$TARGET_REASON")
    continue
  fi

  if ! is_supported "$resolved_target"; then
    TARGET_STATUS="skipped"
    TARGET_REASON="target not supported on $HOST_OS"
    ((SKIP_COUNT += 1))
    REPORTED_TARGETS+=("$target")
    REPORTED_STATUS+=("$TARGET_STATUS")
    REPORTED_REASON+=("$TARGET_REASON")
    continue
  fi

  if run_target_check "$resolved_target"; then
    TARGET_STATUS="ready"
    TARGET_REASON="$LAST_REASON"
    if [ -z "$TARGET_REASON" ]; then
      TARGET_REASON="all readiness checks passed"
    fi
    if [ "$target" = "host" ] && [ "$resolved_target" != "$target" ]; then
      TARGET_REASON="${TARGET_REASON} (host resolved to ${resolved_target})"
    fi
    ((READY_COUNT += 1))
  else
    TARGET_STATUS="not-ready"
    TARGET_REASON="$LAST_REASON"
    if [ -z "$TARGET_REASON" ]; then
      TARGET_REASON="readiness check failed"
    fi
    ((NOT_READY_COUNT += 1))
  fi

  REPORTED_TARGETS+=("$target")
  REPORTED_STATUS+=("$TARGET_STATUS")
  REPORTED_REASON+=("$TARGET_REASON")
done

OVERALL="ready"
EXIT_CODE=0
if [ "$UNKNOWN_TARGET_COUNT" -gt 0 ]; then
  OVERALL="unknown-targets"
  EXIT_CODE=2
fi
if [ "$EXIT_CODE" -eq 0 ] && [ "$NOT_READY_COUNT" -gt 0 ]; then
  OVERALL="not-ready"
  EXIT_CODE=1
fi

if [ "$REPORT_FORMAT" = "json" ]; then
  echo "{"
  echo "  \"host_os\": \"$(JSON_ESCAPE "$HOST_OS")\","
  echo "  \"overall\": \"$(JSON_ESCAPE "$OVERALL")\","
  echo "  \"targets\": ["
  for idx in "${!REPORTED_TARGETS[@]}"; do
    separator=","
    if [ "$idx" -eq "$((${#REPORTED_TARGETS[@]} - 1))" ]; then
      separator=""
    fi
    echo "    {\"target\":\"$(JSON_ESCAPE "${REPORTED_TARGETS[$idx]}")\",\"status\":\"$(JSON_ESCAPE "${REPORTED_STATUS[$idx]}")\",\"reason\":\"$(JSON_ESCAPE "${REPORTED_REASON[$idx]}")\"}${separator}"
  done
  echo "  ],"
  echo "  \"counts\": {"
  echo "    \"ready\": ${READY_COUNT},"
  echo "    \"not_ready\": ${NOT_READY_COUNT},"
  echo "    \"skipped\": ${SKIP_COUNT}"
  echo "  }"
  echo "}"
else
  echo "Release readiness report:"
  echo "  host_os: ${HOST_OS}"
  printf '  %-16s %-11s %s\n' "target" "status" "reason"
  for idx in "${!REPORTED_TARGETS[@]}"; do
    printf '  %-16s %-11s %s\n' \
      "${REPORTED_TARGETS[$idx]}" \
      "${REPORTED_STATUS[$idx]}" \
      "${REPORTED_REASON[$idx]}"
  done
  echo "Summary: ${READY_COUNT} ready, ${NOT_READY_COUNT} not-ready, ${SKIP_COUNT} skipped."
fi

exit "$EXIT_CODE"
