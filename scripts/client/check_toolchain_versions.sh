#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/check_toolchain_versions.sh

Checks pinned Flutter/Dart toolchain versions against repository policy:
  - Reads Flutter version from .fvmrc in repository root.
  - Verifies `flutter --version --machine` is available and readable.
  - Exits non-zero when Flutter is missing or does not match the pin.
  - Prints Dart version compatibility information against pubspec.yaml.
EOF
}

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

ROOT_DIR="$PWD"
FVMRC_FILE="${ROOT_DIR}/.fvmrc"
PUBSPEC_FILE="${ROOT_DIR}/apps/client/pubspec.yaml"

if [ ! -f "${ROOT_DIR}/scripts/client/check_toolchain_versions.sh" ]; then
  echo "ERROR: run this script from the repository root."
  exit 1
fi

if [ ! -f "$FVMRC_FILE" ]; then
  echo "ERROR: missing .fvmrc at ${FVMRC_FILE}."
  exit 1
fi

if [ ! -f "$PUBSPEC_FILE" ]; then
  echo "ERROR: missing pubspec.yaml at ${PUBSPEC_FILE}."
  exit 1
fi

# .fvmrc is JSON ({"flutter":"<version>"}) for FVM 4.x compatibility; older bare-string
# pins are still accepted so the guard keeps working across the format change.
FVMRC_RAW="$(tr -d '[:space:]' < "$FVMRC_FILE")"
case "$FVMRC_RAW" in
  \{*) PINNED_FLUTTER_VERSION="$(printf '%s' "$FVMRC_RAW" | sed -n 's/.*"flutter":"\([^"]*\)".*/\1/p')" ;;
  *)   PINNED_FLUTTER_VERSION="$FVMRC_RAW" ;;
esac
if [ -z "$PINNED_FLUTTER_VERSION" ]; then
  echo "ERROR: could not read Flutter version pin from .fvmrc."
  exit 1
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "ERROR: flutter executable not found in PATH."
  exit 1
fi

if ! FLUTTER_VERSION_JSON="$(flutter --version --machine)"; then
  echo "ERROR: flutter --version --machine failed. Install Flutter and retry."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for toolchain JSON parsing in this repo policy."
  exit 1
fi

FLUTTER_VERSION="$(python3 - "$FLUTTER_VERSION_JSON" <<'PY'
import json
import sys

raw = sys.argv[1]
payload = json.loads(raw)
print(payload.get("frameworkVersion", ""))
PY
)"

if [ -z "$FLUTTER_VERSION" ]; then
  echo "ERROR: could not parse frameworkVersion from flutter --version --machine."
  exit 1
fi

DART_VERSION="$(python3 - "$FLUTTER_VERSION_JSON" <<'PY'
import json
import sys

raw = sys.argv[1]
payload = json.loads(raw)
print(payload.get("dartSdkVersion", ""))
PY
)"

if [ -z "$DART_VERSION" ]; then
  echo "ERROR: could not parse dartSdkVersion from flutter --version --machine."
  exit 1
fi

if [ "$FLUTTER_VERSION" != "$PINNED_FLUTTER_VERSION" ]; then
  echo "ERROR: Flutter version mismatch."
  echo "  expected: $PINNED_FLUTTER_VERSION (from .fvmrc)"
  echo "  actual:   $FLUTTER_VERSION"
  exit 1
fi

PUBSPEC_DART_CONSTRAINT="$(awk '/^  sdk:/{print $0; exit}' "$PUBSPEC_FILE")"
if [ -z "$PUBSPEC_DART_CONSTRAINT" ]; then
  echo "WARN: unable to read sdk constraint from pubspec.yaml; skipping Dart compatibility check."
  echo "Current Flutter/framework: $FLUTTER_VERSION"
  echo "Current Dart SDK: $DART_VERSION"
  echo "Pinned Flutter version matches."
  exit 0
fi

if [[ "$PUBSPEC_DART_CONSTRAINT" =~ \^([0-9]+)\.([0-9]+) ]]; then
  DART_CONSTRAINT_MAJOR_MINOR="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
else
  DART_CONSTRAINT_MAJOR_MINOR=""
fi

if [[ "$DART_VERSION" =~ ^([0-9]+)\.([0-9]+) ]]; then
  DART_VERSION_MAJOR_MINOR="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
else
  DART_VERSION_MAJOR_MINOR=""
fi

if [ -z "$DART_CONSTRAINT_MAJOR_MINOR" ] || [ -z "$DART_VERSION_MAJOR_MINOR" ]; then
  echo "WARN: unable to parse Dart major/minor from one or both version strings; skipping compatibility check."
  echo "  pubspec constraint: $PUBSPEC_DART_CONSTRAINT"
  echo "  dart version: $DART_VERSION"
  echo "Pinned Flutter version matches."
  exit 0
fi

echo "Flutter version matches: $FLUTTER_VERSION"
echo "Dart SDK version: $DART_VERSION"
echo "pubspec dart constraint: $PUBSPEC_DART_CONSTRAINT"

if [ "$DART_CONSTRAINT_MAJOR_MINOR" != "$DART_VERSION_MAJOR_MINOR" ]; then
  echo "WARN: major/minor Dart version mismatch."
  echo "  constraint: $DART_CONSTRAINT_MAJOR_MINOR.x"
  echo "  actual:     $DART_VERSION_MAJOR_MINOR.x"
  echo "  This is informational and non-blocking for the guard script."
else
  echo "Dart SDK major/minor is compatible with pubspec."
fi

exit 0
