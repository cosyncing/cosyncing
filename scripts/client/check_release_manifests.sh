#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/check_release_manifests.sh

Checks broker-independent release-relevant metadata that must stay in sync with
the generated platform manifest state for the current repository identity.

Checks include:
  - pubspec metadata (name, description, publish_to, version pattern)
  - required platform manifest files for Android, iOS, macOS, Linux, Windows, web
  - Android namespace/applicationId/package values
  - iOS/macOS bundle identifiers and display/name identity values
  - Linux/Windows/Web application identity strings

Exit code:
  0 when all checks pass
  1 when any required file is missing or values drift
EOF
}

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

ROOT_DIR="$PWD"
CLIENT_ROOT="${ROOT_DIR}/apps/client"
SCRIPT_PATH="${ROOT_DIR}/scripts/client/check_release_manifests.sh"
PUBSPEC_FILE="${CLIENT_ROOT}/pubspec.yaml"

if [ ! -f "${SCRIPT_PATH}" ]; then
  echo "ERROR: run this script from the repository root."
  exit 1
fi

if [ ! -f "${PUBSPEC_FILE}" ]; then
  echo "ERROR: missing pubspec.yaml at ${PUBSPEC_FILE}."
  exit 1
fi

pass() {
  local message="$1"
  echo "PASS: ${message}"
  ((PASS_COUNT += 1))
}

fail() {
  local message="$1"
  echo "FAIL: ${message}"
  ((FAIL_COUNT += 1))
}

extract_yaml_value() {
  local key="$1"
  local file="$2"
  awk -F ':' -v key="$key" '
    $1 == key {
      value = $2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\''"]|["'\''"]$/, "", value)
      print value
      exit
    }
  ' "$file"
}

check_file_exists() {
  local path="$1"
  if [ -f "${CLIENT_ROOT}/${path}" ]; then
    pass "Required manifest file exists: ${path}"
  else
    fail "Missing required manifest file: ${path}"
  fi
}

FAIL_COUNT=0
PASS_COUNT=0

REQUIRED_MANIFEST_FILES=(
  "android/app/build.gradle.kts"
  "android/app/src/main/AndroidManifest.xml"
  "android/app/src/main/kotlin/com/cosyncing/client/MainActivity.kt"
  "ios/Runner.xcodeproj/project.pbxproj"
  "ios/Runner/Info.plist"
  "ios/Runner.xcodeproj/xcshareddata/xcschemes/Runner.xcscheme"
  "macos/Runner/Configs/AppInfo.xcconfig"
  "macos/Runner/Info.plist"
  "linux/CMakeLists.txt"
  "linux/runner/my_application.cc"
  "windows/CMakeLists.txt"
  "windows/runner/Runner.rc"
  "web/manifest.json"
  "web/index.html"
)

echo "Checking required manifest files..."
for file in "${REQUIRED_MANIFEST_FILES[@]}"; do
  check_file_exists "$file"
done

if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "Manifest validation failed before value checks."
  echo "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."
  exit 1
fi

echo "Checking pubspec metadata..."
PUBSPEC_NAME="$(extract_yaml_value "name" "$PUBSPEC_FILE")"
PUBSPEC_DESCRIPTION="$(extract_yaml_value "description" "$PUBSPEC_FILE")"
PUBSPEC_PUBLISH_TO="$(extract_yaml_value "publish_to" "$PUBSPEC_FILE")"
PUBSPEC_VERSION="$(extract_yaml_value "version" "$PUBSPEC_FILE")"

if [ "${PUBSPEC_NAME}" = "cosyncing_client" ]; then
  pass "pubspec name is cosyncing_client"
else
  fail "pubspec name mismatch: expected cosyncing_client, got '${PUBSPEC_NAME}'"
fi

if echo "${PUBSPEC_DESCRIPTION}" | grep -q "cosyncing"; then
  pass "pubspec description references cosyncing"
else
  fail "pubspec description does not reference cosyncing: '${PUBSPEC_DESCRIPTION}'"
fi

if [ "${PUBSPEC_PUBLISH_TO}" = "none" ] || [ "${PUBSPEC_PUBLISH_TO}" = "'none'" ] || [ "${PUBSPEC_PUBLISH_TO}" = "\"none\"" ]; then
  pass "pubspec publish_to is none"
else
  fail "pubspec publish_to must be none for current release workflow: got '${PUBSPEC_PUBLISH_TO}'"
fi

if echo "${PUBSPEC_VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$'; then
  pass "pubspec version matches semver+build pattern (${PUBSPEC_VERSION})"
else
  fail "pubspec version pattern mismatch: expected semver+build (x.y.z+N), got '${PUBSPEC_VERSION}'"
fi

echo "Checking Android manifests..."
ANDROID_GRADLE="${CLIENT_ROOT}/android/app/build.gradle.kts"
if grep -Eq '^[[:space:]]*namespace[[:space:]]*=[[:space:]]*"com\.cosyncing\.client"' "$ANDROID_GRADLE"; then
  pass "Android Gradle namespace is com.cosyncing.client"
else
  fail "Android Gradle namespace drift (expected com.cosyncing.client)"
fi

if grep -Eq '^[[:space:]]*applicationId[[:space:]]*=[[:space:]]*"com\.cosyncing\.client"' "$ANDROID_GRADLE"; then
  pass "Android Gradle applicationId is com.cosyncing.client"
else
  fail "Android Gradle applicationId drift (expected com.cosyncing.client)"
fi

ANDROID_MAIN_ACTIVITY="${CLIENT_ROOT}/android/app/src/main/kotlin/com/cosyncing/client/MainActivity.kt"
if grep -q 'package com.cosyncing.client' "$ANDROID_MAIN_ACTIVITY"; then
  pass "Android MainActivity package is com.cosyncing.client"
else
  fail "Android MainActivity package drift (expected com.cosyncing.client)"
fi

ANDROID_MANIFEST="${CLIENT_ROOT}/android/app/src/main/AndroidManifest.xml"
if grep -q 'android:label="Cosyncing"' "$ANDROID_MANIFEST"; then
  pass "Android manifest application label is Cosyncing"
else
  fail "Android manifest application label drift (expected Cosyncing)"
fi

echo "Checking iOS manifests..."
IOS_PBX="${CLIENT_ROOT}/ios/Runner.xcodeproj/project.pbxproj"
if grep -q 'PRODUCT_BUNDLE_IDENTIFIER = com.cosyncing.client;' "$IOS_PBX"; then
  pass "iOS Runner bundle identifier is com.cosyncing.client"
else
  fail "iOS Runner bundle identifier drift (expected com.cosyncing.client)"
fi

IOS_INFO="${CLIENT_ROOT}/ios/Runner/Info.plist"
if grep -q '<key>CFBundleDisplayName</key>' "$IOS_INFO" && grep -q '<string>Cosyncing</string>' "$IOS_INFO"; then
  pass "iOS CFBundleDisplayName is Cosyncing"
else
  fail "iOS CFBundleDisplayName drift (expected Cosyncing)"
fi

if grep -q '<key>CFBundleName</key>' "$IOS_INFO" && grep -q '<string>Cosyncing</string>' "$IOS_INFO"; then
  pass "iOS CFBundleName is Cosyncing"
else
  fail "iOS CFBundleName drift (expected Cosyncing)"
fi

echo "Checking macOS manifests..."
MACOS_APPINFO="${CLIENT_ROOT}/macos/Runner/Configs/AppInfo.xcconfig"
if grep -q '^PRODUCT_NAME = Cosyncing$' "$MACOS_APPINFO"; then
  pass "macOS PRODUCT_NAME is Cosyncing"
else
  fail "macOS PRODUCT_NAME drift (expected Cosyncing)"
fi

if grep -q '^PRODUCT_BUNDLE_IDENTIFIER = com.cosyncing.client$' "$MACOS_APPINFO"; then
  pass "macOS PRODUCT_BUNDLE_IDENTIFIER is com.cosyncing.client"
else
  fail "macOS PRODUCT_BUNDLE_IDENTIFIER drift (expected com.cosyncing.client)"
fi

MACOS_INFO="${CLIENT_ROOT}/macos/Runner/Info.plist"
if grep -q '<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>' "$MACOS_INFO"; then
  pass "macOS Info.plist still uses PRODUCT_BUNDLE_IDENTIFIER substitution"
else
  fail "macOS Info.plist should reference \$(PRODUCT_BUNDLE_IDENTIFIER) for current debug identity"
fi

if grep -q '<key>CFBundleDisplayName</key>' "$MACOS_INFO" && grep -q '<string>Cosyncing</string>' "$MACOS_INFO"; then
  pass "macOS Info.plist CFBundleName/CFBundleDisplayName display name is Cosyncing"
else
  fail "macOS Info.plist display name drift (expected CFBundleDisplayName/CFBundleName = Cosyncing)"
fi

echo "Checking Linux manifests..."
LINUX_CMAKE="${CLIENT_ROOT}/linux/CMakeLists.txt"
if grep -Fq 'set(BINARY_NAME "cosyncing")' "$LINUX_CMAKE"; then
  pass "Linux BINARY_NAME is cosyncing"
else
  fail "Linux BINARY_NAME drift (expected cosyncing)"
fi

if grep -Fq 'set(APPLICATION_ID "com.cosyncing.client")' "$LINUX_CMAKE"; then
  pass "Linux APPLICATION_ID is com.cosyncing.client"
else
  fail "Linux APPLICATION_ID drift (expected com.cosyncing.client)"
fi

LINUX_APP="${CLIENT_ROOT}/linux/runner/my_application.cc"
if grep -q 'gtk_header_bar_set_title(header_bar, "Cosyncing")' "$LINUX_APP"; then
  pass "Linux UI title includes Cosyncing"
else
  fail "Linux UI title drift (expected Cosyncing)"
fi

echo "Checking Windows manifests..."
WINDOWS_CMAKE="${CLIENT_ROOT}/windows/CMakeLists.txt"
if grep -q 'project(cosyncing' "$WINDOWS_CMAKE"; then
  pass "Windows project name is cosyncing"
else
  fail "Windows project name drift (expected cosyncing)"
fi

WINDOWS_RC="${CLIENT_ROOT}/windows/runner/Runner.rc"
if grep -q 'VALUE "FileDescription", "Cosyncing"' "$WINDOWS_RC"; then
  pass "Windows file description is Cosyncing"
else
  fail "Windows file description drift (expected Cosyncing)"
fi

if grep -q 'VALUE "InternalName", "cosyncing"' "$WINDOWS_RC"; then
  pass "Windows internal name is cosyncing"
else
  fail "Windows internal name drift (expected cosyncing)"
fi

if grep -q 'VALUE "ProductName", "Cosyncing"' "$WINDOWS_RC"; then
  pass "Windows product name is Cosyncing"
else
  fail "Windows product name drift (expected Cosyncing)"
fi

echo "Checking web manifests..."
WEB_MANIFEST="${CLIENT_ROOT}/web/manifest.json"
if grep -q '"name"[[:space:]]*:[[:space:]]*"Cosyncing"' "$WEB_MANIFEST"; then
  pass "web manifest name is Cosyncing"
else
  fail "web manifest name drift (expected Cosyncing)"
fi

if grep -q '"short_name"[[:space:]]*:[[:space:]]*"cosy"' "$WEB_MANIFEST"; then
  pass "web short_name is cosy"
else
  fail "web short_name drift (expected cosy)"
fi

if grep -q '"description"[[:space:]]*:[[:space:]]*"Cross-platform client for Cosyncing brokers"' "$WEB_MANIFEST"; then
  pass "web manifest description is current identity text"
else
  fail "web manifest description drift (expected Cross-platform client for Cosyncing brokers)"
fi

WEB_INDEX="${CLIENT_ROOT}/web/index.html"
if grep -q '<title>Cosyncing</title>' "$WEB_INDEX"; then
  pass "web index title is Cosyncing"
else
  fail "web index title drift (expected Cosyncing)"
fi

if grep -q '<meta name="apple-mobile-web-app-title" content="Cosyncing">' "$WEB_INDEX"; then
  pass "web iOS app title is Cosyncing"
else
  fail "web iOS app title drift (expected Cosyncing)"
fi

echo "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "Release manifest validation failed."
  exit 1
fi

echo "Release manifest checks passed."
exit 0
