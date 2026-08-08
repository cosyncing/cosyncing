#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/collect_build_outputs.sh [--targets <targets>] [--mode <debug|release|profile>] [--output-dir <dir>]

Collect broker-independent non-signing Flutter build artifacts from existing smoke outputs into
an output staging directory under output/build-smoke for CI upload.

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
  --mode <debug|release|profile> controls which mode-specific artifact paths are selected.
  Defaults to PLATFORM_BUILD_MODE when set; otherwise debug.

Environment:
  PLATFORM_BUILD_TARGETS - optional target list.
  PLATFORM_BUILD_MODE    - optional build mode (debug|release|profile).
  PLATFORM_BUILD_OUTPUT_DIR - optional output root; defaults to output/build-smoke.

Output dir:
  --output-dir <dir> selects the staging root for collected artifacts.
  Paths must resolve under the repository output/ directory.
  Relative paths are interpreted relative to repository root.
  If --output-dir is omitted, PLATFORM_BUILD_OUTPUT_DIR is used when set.
EOF
}

TARGETS_INPUT="${PLATFORM_BUILD_TARGETS:-web,android,linux,macos,windows,ios-simulator,host}"
BUILD_MODE="${PLATFORM_BUILD_MODE:-debug}"
OUTPUT_DIR_INPUT="${PLATFORM_BUILD_OUTPUT_DIR:-output/build-smoke}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLIENT_ROOT="${ROOT_DIR}/apps/client"

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
    --output-dir=*)
      OUTPUT_DIR_INPUT="${1#*=}"
      shift
      ;;
    --output-dir)
      OUTPUT_DIR_INPUT="${2:-}"
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

if [ -z "$OUTPUT_DIR_INPUT" ]; then
  OUTPUT_DIR_INPUT="output/build-smoke"
fi

case "$OUTPUT_DIR_INPUT" in
  output|output/*)
    ;;
  *)
    echo "Invalid --output-dir: $OUTPUT_DIR_INPUT"
    echo "Build smoke artifact staging must be a relative path under output/."
    exit 2
    ;;
esac

case "$OUTPUT_DIR_INPUT" in
  *"/.."*|*"../"*|..)
    echo "Invalid --output-dir: $OUTPUT_DIR_INPUT"
    echo "Build smoke artifact staging cannot contain parent-directory traversal."
    exit 2
    ;;
esac

STAGING_ROOT="$ROOT_DIR/$OUTPUT_DIR_INPUT"

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

mode_to_configuration() {
  local mode="$1"
  case "$mode" in
    debug) echo "Debug" ;;
    profile) echo "Profile" ;;
    release) echo "Release" ;;
    *) echo "" ;;
  esac
}

copy_directory() {
  local source="$1"
  local destination="$2"
  rm -rf "$destination"
  mkdir -p "$destination"
  cp -R "${source}/." "$destination/"
}

copy_file() {
  local source="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  rm -f "$destination"
  cp -p "$source" "$destination"
}

collect_web() {
  local staging_base="$1"
  local source_base="$CLIENT_ROOT/build/web"
  local index_path="$source_base/index.html"

  if [ ! -f "$index_path" ]; then
    echo "  FAIL: missing web index.html at $index_path"
    return 1
  fi

  if ! find "$source_base" -maxdepth 1 -type f \( -name 'main.dart.js' -o -name 'main.dart.mjs' -o -name 'flutter_service_worker.js' -o -name '*.mjs' -o -name '*.wasm' \) | grep -q .; then
    echo "  FAIL: missing compiled web js/wasm artifact under $source_base"
    return 1
  fi

  copy_directory "$source_base" "$staging_base/web"
  return 0
}

collect_android() {
  local staging_base="$1"
  local base="$CLIENT_ROOT/build/app/outputs/flutter-apk"
  local source="$base/app-${BUILD_MODE}.apk"

  if [ ! -f "$source" ]; then
    echo "  FAIL: missing Android APK at $source"
    return 1
  fi

  copy_file "$source" "$staging_base/android/app-${BUILD_MODE}.apk"
  return 0
}

collect_linux() {
  local staging_base="$1"
  local base="$CLIENT_ROOT/build/linux"
  local selected_arch=""
  local selected_bundle=""

  if [ ! -d "$base" ]; then
    echo "  FAIL: missing Linux output root $base"
    return 1
  fi

  for arch_dir in "$base"/*; do
    if [ ! -d "$arch_dir" ]; then
      continue
    fi
    local bundle_dir="${arch_dir}/${BUILD_MODE}/bundle"
    if [ ! -d "$bundle_dir" ]; then
      continue
    fi
    if [ -f "${bundle_dir}/cosyncing" ] || [ -x "${bundle_dir}/cosyncing" ] || [ -f "${bundle_dir}/cosyncing_client" ] || [ -x "${bundle_dir}/cosyncing_client" ] || [ -f "${bundle_dir}/Runner" ] || [ -x "${bundle_dir}/Runner" ]; then
      selected_arch="${arch_dir##*/}"
      selected_bundle="$bundle_dir"
      break
    fi
  done

  if [ -z "$selected_bundle" ]; then
    echo "  FAIL: missing Linux executable under $base/*/${BUILD_MODE}/bundle/"
    return 1
  fi

  copy_directory "$selected_bundle" "$staging_base/linux/$selected_arch/$BUILD_MODE/bundle"
  return 0
}

collect_macos() {
  local staging_base="$1"
  local configuration
  configuration="$(mode_to_configuration "$BUILD_MODE")"
  if [ -z "$configuration" ]; then
    echo "  FAIL: unsupported build mode '$BUILD_MODE' for macOS output copy"
    return 1
  fi

  local base="$CLIENT_ROOT/build/macos/Build/Products/$configuration"
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing macOS product dir $base"
    return 1
  fi

  local has_candidate=0
  local candidates=("${base}/Cosyncing.app" "${base}/Runner.app" "${base}/cosyncing_client.app")
  local file_candidate

  for file_candidate in "${candidates[@]}"; do
    if [ -d "$file_candidate" ]; then
      local app_name
      app_name="$(basename "$file_candidate")"
      copy_directory "$file_candidate" "$staging_base/macos/$configuration/$app_name"
      has_candidate=1
      break
    fi
  done

  if [ "$has_candidate" -eq 1 ]; then
    return 0
  fi

  for file_candidate in "$base"/*.app; do
    if [ -d "$file_candidate" ]; then
      local app_name
      app_name="$(basename "$file_candidate")"
      copy_directory "$file_candidate" "$staging_base/macos/$configuration/$app_name"
      return 0
    fi
  done

  echo "  FAIL: no .app bundle under $base"
  return 1
}

collect_windows() {
  local staging_base="$1"
  local configuration
  configuration="$(mode_to_configuration "$BUILD_MODE")"
  if [ -z "$configuration" ]; then
    echo "  FAIL: unsupported build mode '$BUILD_MODE' for Windows output copy"
    return 1
  fi

  local base="$CLIENT_ROOT/build/windows"
  if [ ! -d "$base" ]; then
    echo "  FAIL: missing Windows output root $base"
    return 1
  fi

  local selected_arch=""
  local selected_exe_dir=""

  for arch_dir in "$base"/*; do
    if [ ! -d "$arch_dir" ]; then
      continue
    fi
    local exe_dir="${arch_dir}/runner/${configuration}"
    local arch_name="${arch_dir##*/}"
    if [ ! -d "$exe_dir" ]; then
      continue
    fi
    if [ -f "${exe_dir}/cosyncing.exe" ] || [ -f "${exe_dir}/Runner.exe" ] || [ -f "${exe_dir}/cosyncing_client.exe" ]; then
      selected_arch="$arch_name"
      selected_exe_dir="$exe_dir"
      break
    fi
  done

  if [ -z "$selected_exe_dir" ]; then
    echo "  FAIL: missing Windows executable under $base/*/runner/${configuration}/"
    return 1
  fi

  copy_directory "$selected_exe_dir" "$staging_base/windows/$selected_arch/$configuration"
  return 0
}

collect_ios_simulator() {
  local staging_base="$1"
  local candidates=(
    "$CLIENT_ROOT/build/ios/iphonesimulator/Runner.app"
    "$CLIENT_ROOT/build/ios/iphonesimulator/Build/Products/Debug-iphonesimulator/Runner.app"
    "$CLIENT_ROOT/build/ios/Build/Products/Debug-iphonesimulator/Runner.app"
  )

  for app_path in "${candidates[@]}"; do
    if [ -d "$app_path" ]; then
      copy_directory "$app_path" "$staging_base/ios-simulator/$(basename "$app_path")"
      return 0
    fi
  done

  echo "  FAIL: missing iOS simulator app bundle (tried: build/ios/iphonesimulator/Runner.app and current Flutter simulator product paths)"
  return 1
}

run_collect() {
  local target="$1"
  local staging_root="$2"
  case "$target" in
    web)
      collect_web "$staging_root"
      ;;
    android)
      collect_android "$staging_root"
      ;;
    linux)
      collect_linux "$staging_root"
      ;;
    macos)
      collect_macos "$staging_root"
      ;;
    windows)
      collect_windows "$staging_root"
      ;;
    ios-simulator)
      collect_ios_simulator "$staging_root"
      ;;
    *)
      echo "  FAIL: unknown target '$target'"
      return 1
      ;;
  esac
}

mkdir -p "$STAGING_ROOT"
STAGING_ROOT="$(cd "$STAGING_ROOT" && pwd -P)"

case "$STAGING_ROOT/" in
  "$ROOT_DIR/output/"*)
    ;;
  *)
    echo "Invalid --output-dir: $OUTPUT_DIR_INPUT"
    echo "Build smoke artifact staging must resolve under $ROOT_DIR/output."
    exit 2
    ;;
esac

SUCCESS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
HAS_ARTIFACTS=0

echo "Collecting build smoke outputs for:"
echo "  mode: $BUILD_MODE"
echo "  output root: $STAGING_ROOT"

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

  echo "COLLECT: $target"
  if run_collect "$resolved_target" "$STAGING_ROOT"; then
    echo "PASS: $target"
    ((SUCCESS_COUNT += 1))
    HAS_ARTIFACTS=1
  else
    echo "FAIL: $target"
    ((FAIL_COUNT += 1))
  fi
done

echo "Summary: $SUCCESS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped."

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "has_artifacts=$HAS_ARTIFACTS" >> "$GITHUB_OUTPUT"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
