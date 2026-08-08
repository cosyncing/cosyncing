#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/check_build_outputs.sh [--targets <targets>] [--mode <debug|release|profile>]

Checks whether non-signing Flutter build commands produced the expected output artifacts
for selected targets in the current working tree.

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

Mode:
  --mode <debug|release|profile> controls mode-aware artifacts.
  Defaults to PLATFORM_BUILD_MODE when set; otherwise debug.

Environment:
  PLATFORM_BUILD_TARGETS - optional target list.
  PLATFORM_BUILD_MODE    - optional build mode (debug|release|profile), defaults to debug.

Notes:
- "host" resolves to the local desktop platform target.
- Unknown targets fail the verification.
- Unsupported OS targets are skipped cleanly.
EOF
}

TARGETS_INPUT="${PLATFORM_BUILD_TARGETS:-web,android,linux,macos,windows,ios-simulator,host}"
BUILD_MODE="${PLATFORM_BUILD_MODE:-debug}"

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/../.."
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
CLIENT_ROOT="${ROOT_DIR}/apps/client"

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

mode_to_configuration() {
  local mode="$1"
  case "$mode" in
    debug) echo "Debug" ;;
    profile) echo "Profile" ;;
    release) echo "Release" ;;
    *) echo "" ;;
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

has_mode_config() {
  if [ -z "$1" ]; then
    return 1
  fi
  return 0
}

check_web() {
  local base="${CLIENT_ROOT}/build/web"
  local index_path="${base}/index.html"
  if [ ! -f "$index_path" ]; then
    echo "  FAIL: missing web index.html at $index_path"
    return 1
  fi

  if find "$base" -maxdepth 1 -type f \( -name 'main.dart.js' -o -name 'main.dart.mjs' -o -name 'flutter_service_worker.js' -o -name '*.mjs' -o -name '*.wasm' \) | grep -q .; then
    echo "  PASS: found web build artifacts in $base"
    return 0
  fi

  echo "  FAIL: missing compiled web js/wasm artifact under $base"
  return 1
}

check_android() {
  local mode="$1"
  local base="${CLIENT_ROOT}/build/app/outputs/flutter-apk"
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing Flutter APK output dir $base"
    return 1
  fi

  local apk_path="${base}/app-${mode}.apk"
  if [ -f "$apk_path" ]; then
    echo "  PASS: found Android APK ${apk_path}"
    return 0
  fi

  echo "  FAIL: missing Android APK at ${apk_path}"
  return 1
}

check_linux() {
  local mode="$1"
  local base="${CLIENT_ROOT}/build/linux"
  local found=1
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing Linux output root $base"
    return 1
  fi

  for arch_dir in "$base"/*; do
    if [ ! -d "$arch_dir" ]; then
      continue
    fi
    local bundle_dir="${arch_dir}/${mode}/bundle"
    if [ ! -d "$bundle_dir" ]; then
      continue
    fi
    if [ -f "${bundle_dir}/cosyncing" ] || [ -x "${bundle_dir}/cosyncing" ] || [ -f "${bundle_dir}/cosyncing_client" ] || [ -x "${bundle_dir}/cosyncing_client" ] || [ -f "${bundle_dir}/Runner" ] || [ -x "${bundle_dir}/Runner" ]; then
      echo "  PASS: found Linux bundle at $bundle_dir"
      found=0
      break
    fi
  done

  if [ "$found" -eq 0 ]; then
    return 0
  fi
  echo "  FAIL: missing Linux executable under $base/*/${mode}/bundle/"
  return 1
}

check_macos() {
  local mode="$1"
  local configuration
  configuration="$(mode_to_configuration "$mode")"
  if ! has_mode_config "$configuration"; then
    echo "  FAIL: unsupported build mode '$mode' for macOS output checks"
    return 1
  fi

  local base="${CLIENT_ROOT}/build/macos/Build/Products/${configuration}"
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing macOS product dir $base"
    return 1
  fi

  if [ -d "${base}/Cosyncing.app" ] || [ -d "${base}/Runner.app" ] || [ -d "${base}/cosyncing_client.app" ] || [ -d "${base}/build/Products/${configuration}/Runner.app" ]; then
    echo "  PASS: found macOS bundle in $base"
    return 0
  fi

  local app_count
  app_count="$(find "$base" -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')"
  if [ "$app_count" -gt 0 ]; then
    echo "  PASS: found an app bundle in $base"
    return 0
  fi

  echo "  FAIL: no .app bundle under $base"
  return 1
}

check_windows() {
  local mode="$1"
  local configuration
  configuration="$(mode_to_configuration "$mode")"
  if ! has_mode_config "$configuration"; then
    echo "  FAIL: unsupported build mode '$mode' for Windows output checks"
    return 1
  fi

  local base="${CLIENT_ROOT}/build/windows"
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing Windows output root $base"
    return 1
  fi

  for arch_dir in "$base"/*; do
    if [ ! -d "$arch_dir" ]; then
      continue
    fi
    local exe_dir="${arch_dir}/runner/${configuration}"
    if [ ! -d "$exe_dir" ]; then
      continue
    fi
    if [ -f "${exe_dir}/cosyncing.exe" ] || [ -f "${exe_dir}/Runner.exe" ] || [ -f "${exe_dir}/cosyncing_client.exe" ]; then
      echo "  PASS: found Windows executable in $exe_dir"
      return 0
    fi
  done

  echo "  FAIL: missing Windows executable under $base/*/runner/${configuration}/"
  return 1
}

check_ios_simulator() {
  local candidates=(
    "${CLIENT_ROOT}/build/ios/iphonesimulator/Runner.app"
    "${CLIENT_ROOT}/build/ios/iphonesimulator/Build/Products/Debug-iphonesimulator/Runner.app"
    "${CLIENT_ROOT}/build/ios/Build/Products/Debug-iphonesimulator/Runner.app"
  )

  for candidate in "${candidates[@]}"; do
    if [ -d "$candidate" ]; then
      echo "  PASS: found iOS simulator app at $candidate"
      return 0
    fi
  done

  echo "  FAIL: missing iOS simulator app bundle (tried: build/ios/iphonesimulator/Runner.app and current Flutter simulator product paths)"
  return 1
}

run_check() {
  local target="$1"
  local mode="$2"
  case "$target" in
    web)
      check_web
      ;;
    android)
      check_android "$mode"
      ;;
    linux)
      check_linux "$mode"
      ;;
    macos)
      check_macos "$mode"
      ;;
    windows)
      check_windows "$mode"
      ;;
    ios-simulator)
      check_ios_simulator
      ;;
    *)
      echo "  FAIL: unknown target '$target'"
      return 1
      ;;
  esac
}

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
echo "Checking build artifacts for targets:"
echo "  mode: $BUILD_MODE"

for target in "${TARGETS[@]}"; do
  if [ "$target" != "web" ] && [ "$target" != "android" ] && [ "$target" != "linux" ] && [ "$target" != "macos" ] && [ "$target" != "windows" ] && [ "$target" != "ios-simulator" ] && [ "$target" != "host" ]; then
    echo "  FAIL: $target (unknown target name)"
    ((FAIL_COUNT += 1))
    continue
  fi

  resolved_target="$(resolve_host_target "$target")"
  if [ "$resolved_target" = "unsupported" ]; then
    echo "  SKIP: $target (host desktop target unavailable on this OS)"
    ((SKIP_COUNT += 1))
    continue
  fi

  if ! is_supported "$resolved_target"; then
    echo "  SKIP: $target (not supported on $HOST_OS)"
    ((SKIP_COUNT += 1))
    continue
  fi

  if run_check "$resolved_target" "$BUILD_MODE"; then
    echo "  PASS: $target"
    ((PASS_COUNT += 1))
  else
    echo "  FAIL: $target"
    ((FAIL_COUNT += 1))
  fi
done

echo "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped."
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
