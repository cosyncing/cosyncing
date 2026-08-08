#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/platform_build_smoke.sh [--targets <targets>] [--mode <debug|release|profile>]
  scripts/client/platform_build_smoke.sh [--check-build-outputs|--skip-build-output-check] [--targets ...] [--mode ...]

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

If no targets are provided, uses PLATFORM_BUILD_TARGETS when set; otherwise:
  web,android,linux,macos,windows,ios-simulator,host

Environment:
  PLATFORM_BUILD_TARGETS - optional target list
  PLATFORM_BUILD_MODE    - optional build mode (debug|release|profile), defaults to debug

Notes:
- Targets are validated and skipped when not supported on this host OS.
- "host" resolves to the local desktop platform target.
- Android/linux/macos/windows/web/host use non-signing Flutter build commands for the
  selected mode.
- Linux/macos/windows release builds stamp COSYNCING_CLIENT_VERSION from package.json.
- ios-simulator uses debug-only non-signing simulator build command.
- By default, after each successful target build, the new artifacts are verified with
  scripts/client/check_build_outputs.sh using the same target/mode selection.
- Set PLATFORM_VERIFY_BUILD_OUTPUTS=0 or pass --skip-build-output-check to skip
  artifact verification.
- This script does not build or validate real broker integration smoke scenarios.
EOF
}

TARGETS_INPUT="${PLATFORM_BUILD_TARGETS:-web,android,linux,macos,windows,ios-simulator,host}"
BUILD_MODE="${PLATFORM_BUILD_MODE:-debug}"
VERIFY_BUILD_OUTPUTS="${PLATFORM_VERIFY_BUILD_OUTPUTS:-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLIENT_ROOT="${REPOSITORY_ROOT}/apps/client"

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
      TARGETS_INPUT="${2:-}"
      shift 2
      ;;
    --mode=*)
      BUILD_MODE="${1#*=}"
      shift
      ;;
    --mode)
      BUILD_MODE="${2:-}"
      shift 2
      ;;
    --check-build-outputs)
      VERIFY_BUILD_OUTPUTS=1
      shift
      ;;
    --skip-build-output-check)
      VERIFY_BUILD_OUTPUTS=0
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [ -z "${BUILD_MODE}" ] || { [ "$BUILD_MODE" != "debug" ] && [ "$BUILD_MODE" != "release" ] && [ "$BUILD_MODE" != "profile" ]; }; then
  echo "Invalid or missing --mode value. Must be debug, release, or profile."
  usage
  exit 2
fi

if [ "$VERIFY_BUILD_OUTPUTS" != "0" ] && [ "$VERIFY_BUILD_OUTPUTS" != "1" ]; then
  echo "Invalid PLATFORM_VERIFY_BUILD_OUTPUTS value: $VERIFY_BUILD_OUTPUTS (expected 0 or 1)."
  exit 2
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter executable not found in PATH."
  exit 1
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

is_supported() {
  local target="$1"
  case "$target" in
    web|android)
      return 0
      ;;
    linux)
      [ "$HOST_OS" = "linux" ]
      ;;
    macos)
      [ "$HOST_OS" = "macos" ]
      ;;
    windows)
      [ "$HOST_OS" = "windows" ]
      ;;
    ios-simulator)
      [ "$HOST_OS" = "macos" ]
      ;;
    *)
      return 1
      ;;
  esac
}

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

run_build() {
  local target="$1"
  if [ "$target" = "linux" ] || [ "$target" = "macos" ] || [ "$target" = "windows" ]; then
    bun run "${SCRIPT_DIR}/build-desktop.ts" --target "$target" --mode "$BUILD_MODE"
    return $?
  fi
  (
    cd "$CLIENT_ROOT"
    case "$target" in
      web) flutter build web --"$BUILD_MODE" ;;
      android) flutter build apk --"$BUILD_MODE" ;;
      ios-simulator) flutter build ios --simulator --debug ;;
      *)
        echo "Unknown build target: $target"
        return 1
        ;;
    esac
  )
}

SUCCESS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
echo "Running flutter build smoke checks:"
echo "  mode: $BUILD_MODE"
echo "  host: $HOST_OS"

for target in "${TARGETS[@]}"; do
  if ! is_known_target "$target"; then
    echo "FAIL: $target (unknown target name)"
    ((FAIL_COUNT += 1))
    continue
  fi

  resolved_target="$(resolve_host_target "$target")"

  if [ "$resolved_target" = "unsupported" ]; then
    echo "SKIP: $target (host desktop target unavailable on this OS)"
    ((SKIP_COUNT += 1))
    continue
  fi

  if ! is_supported "$resolved_target"; then
    echo "SKIP: $target (not supported on $HOST_OS)"
    ((SKIP_COUNT += 1))
    continue
  fi

  echo "BUILD: $target"
  if run_build "$resolved_target"; then
    if [ "$VERIFY_BUILD_OUTPUTS" = "1" ]; then
      if bash "${SCRIPT_DIR}/check_build_outputs.sh" --targets "$target" --mode "$BUILD_MODE"; then
        echo "PASS: $target (build + outputs)"
        ((SUCCESS_COUNT += 1))
      else
        echo "FAIL: $target (build outputs missing)"
        ((FAIL_COUNT += 1))
      fi
    else
      echo "PASS: $target"
      ((SUCCESS_COUNT += 1))
    fi
  else
    echo "FAIL: $target"
    ((FAIL_COUNT += 1))
  fi
done

echo "Summary: $SUCCESS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped."
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
