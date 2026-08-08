#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/client/voice_validation.sh [options]

Run focused V3 voice validation checks and emit a per-target evidence report.

Options:
  --targets <targets>      Target list (comma- or space-separated):
                           android,web,linux,windows,host
                           Default: android,web,linux,windows
  --mode <mode>            Build mode for target build checks: debug|release|profile
                           Default: debug.
  --skip-builds            Skip build checks (for quick evidence-only runs).
  --report-dir <path>      Report output directory.
                           Default: output/voice-validation.
  -h, --help               Show this help text.

Notes:
- This harness validates what host tooling can prove today; it never treats runtime
  voice proof as a build artifact.
- Runtime TTS/ASR permission and waveform checks remain NOT RUN here. Use
  scripts/client/voice_runtime_validation.sh (or its PowerShell wrapper) to collect
  explicit Android, HTTPS Chromium, or Windows runtime evidence.
EOF
}

ROOT_DIR="$PWD"
CLIENT_ROOT="${ROOT_DIR}/apps/client"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGETS_INPUT="${VOICE_VALIDATION_TARGETS:-android,web,linux,windows}"
BUILD_MODE="${VOICE_BUILD_MODE:-debug}"
SKIP_BUILDS=0
REPORT_DIR="${VOICE_VALIDATION_REPORT_DIR:-$ROOT_DIR/output/voice-validation}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"

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
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --targets."
        exit 2
      fi
      TARGETS_INPUT="${2:-}"
      shift 2
      ;;
    --mode=*)
      BUILD_MODE="${1#*=}"
      shift
      ;;
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --mode."
        exit 2
      fi
      BUILD_MODE="${2:-}"
      shift 2
      ;;
    --skip-builds)
      SKIP_BUILDS=1
      shift
      ;;
    --report-dir=*)
      REPORT_DIR="${1#*=}"
      shift
      ;;
    --report-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --report-dir."
        exit 2
      fi
      REPORT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [ -z "${BUILD_MODE}" ] || { [ "$BUILD_MODE" != "debug" ] && [ "$BUILD_MODE" != "release" ] && [ "$BUILD_MODE" != "profile" ]; }; then
  echo "Invalid --mode value: $BUILD_MODE (expected debug, release, or profile)."
  exit 2
fi

if [ ! -f "$CLIENT_ROOT/pubspec.yaml" ]; then
  echo "ERROR: run this script from the cosyncing monorepo root."
  exit 2
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "ERROR: flutter command not found in PATH."
  exit 2
fi

mkdir -p "$REPORT_DIR"

TARGETS=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  TARGETS+=("$line")
done < <(printf '%s' "$TARGETS_INPUT" | tr ', ' '\n' | awk '
  {
    gsub(/^[[:space:]]+/, "", $0)
    gsub(/[[:space:]]+$/, "", $0)
    if ($0 != "") print tolower($0)
  }
')

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No targets were selected."
  exit 2
fi

HOST_OS="unknown"
case "$OSTYPE" in
  linux-gnu*|linux*) HOST_OS="linux" ;;
  darwin*) HOST_OS="macos" ;;
  msys*|mingw*|cygwin*) HOST_OS="windows" ;;
  *) HOST_OS="other" ;;
esac

is_known_target() {
  case "$1" in
    web|android|linux|windows|host)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

for target in "${TARGETS[@]}"; do
  if ! is_known_target "$target"; then
    echo "Unknown target: $target"
    echo "Valid targets: web,android,linux,windows,host"
    exit 2
  fi
done

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

is_supported_on_host() {
  local target="$1"
  case "$target" in
    web|android)
      return 0
      ;;
    linux)
      [ "$HOST_OS" = "linux" ]
      ;;
    windows)
      [ "$HOST_OS" = "windows" ]
      ;;
    *)
      return 1
      ;;
  esac
}

check_android_tooling() {
  local reasons=()
  if ! command -v java >/dev/null 2>&1; then
    reasons+=("java")
  fi
  if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] &&
    ! command -v sdkmanager >/dev/null 2>&1 && ! command -v adb >/dev/null 2>&1; then
    reasons+=("android sdk")
  fi

  if [[ ${#reasons[@]} -ne 0 ]]; then
    local joined
    printf -v joined '%s, ' "${reasons[@]}"
    joined="${joined%, }"
    echo "missing ${joined}"
    return 1
  fi
  return 0
}

check_linux_tooling() {
  local reasons=()
  if ! command -v cmake >/dev/null 2>&1; then
    reasons+=("cmake")
  fi
  if ! command -v ninja >/dev/null 2>&1; then
    reasons+=("ninja")
  fi
  if ! command -v pkg-config >/dev/null 2>&1; then
    reasons+=("pkg-config")
  else
    if ! pkg-config --exists webkit2gtk-4.1 &&
      ! pkg-config --exists webkit2gtk-4.0; then
      reasons+=("webkit2gtk development package")
    fi
    if ! pkg-config --exists libsoup-3.0 &&
      ! pkg-config --exists libsoup-2.4; then
      reasons+=("libsoup development package")
    fi
    if ! pkg-config --exists 'libsecret-1 >= 0.18.4'; then
      reasons+=("libsecret development package")
    fi
  fi

  if [[ ${#reasons[@]} -ne 0 ]]; then
    local joined
    printf -v joined '%s, ' "${reasons[@]}"
    joined="${joined%, }"
    echo "missing ${joined}"
    return 1
  fi
  return 0
}

check_windows_tooling() {
  local reasons=()
  if ! command -v cmake >/dev/null 2>&1; then
    reasons+=("cmake")
  fi
  if ! command -v powershell >/dev/null 2>&1 && ! command -v powershell.exe >/dev/null 2>&1; then
    reasons+=("powershell")
  fi

  if [[ ${#reasons[@]} -ne 0 ]]; then
    local joined
    printf -v joined '%s, ' "${reasons[@]}"
    joined="${joined%, }"
    echo "missing ${joined}"
    return 1
  fi
  return 0
}

get_tooling_issue() {
  local target="$1"
  case "$target" in
    android)
      check_android_tooling
      ;;
    linux|macos)
      check_linux_tooling
      ;;
    windows)
      check_windows_tooling
      ;;
    web)
      return 0
      ;;
    *)
      echo "unsupported target"
      return 1
      ;;
  esac
}

run_client_flutter() {
  (cd "$CLIENT_ROOT" && flutter "$@")
}

run_build() {
  local target="$1"
  case "$target" in
    web)
      run_client_flutter build web --"$BUILD_MODE" --base-href /cosy/
      ;;
    android)
      run_client_flutter build apk --"$BUILD_MODE"
      ;;
    linux|windows)
      bun run "${SCRIPT_DIR}/build-desktop.ts" --target "$target" --mode "$BUILD_MODE"
      ;;
    *)
      echo "Unsupported build target: $target"
      return 2
      ;;
  esac
}

run_capture() {
  local log_file="$1"
  shift
  "$@" >"$log_file" 2>&1
}

COMPILE_STATUS="FAIL"
COMPILE_EVIDENCE="FAIL: flutter analyze failed"
compile_log="${REPORT_DIR}/voice_v3_${RUN_ID}_compile.log"

if run_capture "$compile_log" run_client_flutter analyze; then
  COMPILE_STATUS="PASS"
  COMPILE_EVIDENCE="PASS: flutter analyze succeeded"
else
  COMPILE_EVIDENCE="FAIL: flutter analyze failed; see $compile_log"
fi

FALLBACK_TEST_STATUS="FAIL"
FALLBACK_TEST_EVIDENCE="FAIL: speech factory tests failed"
fallback_log="${REPORT_DIR}/voice_v3_${RUN_ID}_fallback_tests.log"
if run_capture \
  "$fallback_log" \
  run_client_flutter test \
  test/src/platform/speech/speech_input_factory_test.dart \
  test/src/platform/speech/speech_output_factory_test.dart \
  --reporter=compact; then
  FALLBACK_TEST_STATUS="PASS"
  FALLBACK_TEST_EVIDENCE="PASS: speech input/output factory tests passed ($fallback_log)"
else
  FALLBACK_TEST_EVIDENCE="FAIL: speech input/output factory tests failed; see $fallback_log"
fi

declare -A BUILD_STATUS
declare -A BUILD_EVIDENCE
declare -A BUILD_LOG_PATH
declare -A FALLBACK_STATUS
declare -A FALLBACK_EVIDENCE

RUNTIME_TTS_STATUS="NOT RUN: use the V3 runtime evidence companion"
RUNTIME_ASR_STATUS="NOT RUN: use the V3 runtime evidence companion"
WAVEFORM_STATUS="NOT RUN: use the V3 runtime evidence companion"

for target in "${TARGETS[@]}"; do
  resolved_target="$(resolve_host_target "$target")"
  duplicate_host_alias=0
  if [ "$target" = "host" ]; then
    for selected_target in "${TARGETS[@]}"; do
      if [ "$selected_target" = "$resolved_target" ]; then
        duplicate_host_alias=1
        break
      fi
    done
  fi
  if [ "$resolved_target" = "unsupported" ]; then
    BUILD_STATUS["$target"]="NOT RUN"
    BUILD_EVIDENCE["$target"]="SKIP: host has no native desktop target for 'host'"
  elif [ "$duplicate_host_alias" -eq 1 ]; then
    BUILD_STATUS["$target"]="NOT RUN"
    BUILD_EVIDENCE["$target"]="SKIP: host aliases already-selected '$resolved_target' target"
  elif ! is_supported_on_host "$resolved_target"; then
    BUILD_STATUS["$target"]="NOT RUN"
    BUILD_EVIDENCE["$target"]="SKIP: target '$resolved_target' unsupported on host OS ($HOST_OS)"
  elif [ "$SKIP_BUILDS" -eq 1 ]; then
    BUILD_STATUS["$target"]="NOT RUN"
    BUILD_EVIDENCE["$target"]="SKIPPED by --skip-builds"
  else
    tooling_issue="$(get_tooling_issue "$resolved_target" || true)"
    if [ -n "${tooling_issue:-}" ]; then
      BUILD_STATUS["$target"]="NOT RUN"
      BUILD_EVIDENCE["$target"]="SKIP: ${tooling_issue}"
    else
      build_log="${REPORT_DIR}/voice_v3_${RUN_ID}_build_${resolved_target}.log"
      BUILD_LOG_PATH["$target"]="$build_log"
      if run_capture "$build_log" run_build "$resolved_target"; then
        if bash "${SCRIPT_DIR}/check_build_outputs.sh" --targets "$resolved_target" --mode "$BUILD_MODE" >/dev/null 2>&1; then
          BUILD_STATUS["$target"]="PASS"
          BUILD_EVIDENCE["$target"]="PASS: build + output verification succeeded ($build_log)"
        else
          BUILD_STATUS["$target"]="FAIL"
          BUILD_EVIDENCE["$target"]="FAIL: build output verification failed"
        fi
      else
        BUILD_STATUS["$target"]="FAIL"
        BUILD_EVIDENCE["$target"]="FAIL: flutter build $resolved_target --$BUILD_MODE failed"
      fi
    fi
  fi

  case "$resolved_target" in
    linux)
      FALLBACK_STATUS["$target"]="$FALLBACK_TEST_STATUS"
      FALLBACK_EVIDENCE["$target"]="$FALLBACK_TEST_EVIDENCE; Linux is outside the native adapter whitelist."
      ;;
    web)
      FALLBACK_STATUS["$target"]="$FALLBACK_TEST_STATUS"
      FALLBACK_EVIDENCE["$target"]="$FALLBACK_TEST_EVIDENCE; web override and ASR secure-context paths are covered."
      ;;
    android|windows)
      FALLBACK_STATUS["$target"]="$FALLBACK_TEST_STATUS"
      FALLBACK_EVIDENCE["$target"]="$FALLBACK_TEST_EVIDENCE; native adapter construction failures degrade to Unavailable* stubs."
      ;;
    *)
      FALLBACK_STATUS["$target"]="$FALLBACK_TEST_STATUS"
      FALLBACK_EVIDENCE["$target"]="$FALLBACK_TEST_EVIDENCE; unsupported native targets degrade to Unavailable* stubs."
      ;;
  esac
done

REPORT_FILE="$REPORT_DIR/voice-v3-validation-${RUN_ID}.txt"

{
  echo "# Voice V3 Validation Report"
  echo "Generated: $(date -u '+%Y-%m-%d %H:%M:%SZ')"
  echo "Targets: ${TARGETS_INPUT}"
  echo "Mode: $BUILD_MODE"
  echo "Repository: $ROOT_DIR"
  echo
  printf '%-16s | %-40s | %-24s | %-24s | %-28s | %-28s | %-48s\n' \
    "Target" \
    "Adapter/API compile" \
    "Target build" \
    "Runtime TTS" \
    "Runtime ASR/permission" \
    "Waveform callback" \
    "Unsupported/unavailable fallback"
  printf '%-16s | %-40s | %-24s | %-24s | %-28s | %-28s | %-48s\n' \
    "----------------" \
    "------------------------" \
    "----------------" \
    "----------------" \
    "--------------------------" \
    "--------------------------" \
    "-----------------------------------------------"
  echo
  for target in "${TARGETS[@]}"; do
    printf '%-16s | %-40s | %-24s | %-24s | %-28s | %-28s | %-48s\n' \
      "$target" \
      "$COMPILE_STATUS (${COMPILE_EVIDENCE})" \
      "${BUILD_STATUS[$target]} (${BUILD_EVIDENCE[$target]})" \
      "$RUNTIME_TTS_STATUS" \
      "$RUNTIME_ASR_STATUS" \
      "$WAVEFORM_STATUS" \
      "${FALLBACK_STATUS[$target]} (${FALLBACK_EVIDENCE[$target]})"
  done
  echo
  echo "Scope note: target build checks are host-aware and skip unavailable targets explicitly."
  echo "Runtime evidence for TTS/ASR/waveform is intentionally not claimed from build/compile outputs."
  echo "Collect runtime evidence with scripts/client/voice_runtime_validation.sh or scripts/client/voice_runtime_validation.ps1."
  echo
  echo "Evidence artifacts:"
  echo "- Compile log: $compile_log"
  echo "- Fallback factory test log: $fallback_log"
  for target in "${TARGETS[@]}"; do
    if [[ "${BUILD_STATUS[$target]-}" == PASS ]] || [[ "${BUILD_STATUS[$target]-}" == FAIL ]]; then
      echo "- ${target} build log: ${BUILD_LOG_PATH[$target]-}"
    else
      echo "- ${target} build was skipped: ${BUILD_EVIDENCE[$target]}"
    fi
  done
} | tee "$REPORT_FILE"

echo
echo "Voice validation report: $REPORT_FILE"

if [ "$COMPILE_STATUS" != "PASS" ]; then
  echo "Compile/analyze gate failed; status: $COMPILE_STATUS"
  echo "  log: $compile_log"
  exit 1
fi

if [ "$FALLBACK_TEST_STATUS" != "PASS" ]; then
  echo "Fallback factory test gate failed; status: $FALLBACK_TEST_STATUS"
  echo "  log: $fallback_log"
  exit 1
fi

build_fail_count=0
build_skip_count=0
for target in "${TARGETS[@]}"; do
  if [ "${BUILD_STATUS[$target]}" = "FAIL" ]; then
    ((build_fail_count += 1))
  elif [ "${BUILD_STATUS[$target]}" = "NOT RUN" ]; then
    ((build_skip_count += 1))
  fi
done

if [ "$build_fail_count" -gt 0 ]; then
  echo "Build summary: $build_fail_count failed target build check(s), $build_skip_count skipped target check(s)."
  exit 1
fi

echo "Build summary: $build_skip_count skipped target check(s), no build failures."
exit 0
