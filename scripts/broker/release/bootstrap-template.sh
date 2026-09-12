#!/bin/sh
set -eu

umask 077

VERSION='@VERSION@'
BASE_URL='@BASE_URL@'
KEY_ID='@KEY_ID@'
PUBLIC_KEY_B64='@PUBLIC_KEY_B64@'
P256_PUBLIC_KEY_B64='@P256_PUBLIC_KEY_B64@'
# The JavaScript application bundle and the web client sidecar this release publishes.
APP_ASSET='@APP_ASSET@'
WEB_ASSET='@WEB_ASSET@'
# The oldest Bun this release's bundle was built and tested against.
MINIMUM_BUN='@MINIMUM_BUN@'
# One row per artifact this installer places: "<name> <sha256> <size>".
ARTIFACT_TABLE='@ARTIFACT_TABLE@'
# Official Bun builds for MINIMUM_BUN, most likely first: "<host> <asset> <sha256>".
BUN_TABLE='@BUN_TABLE@'
BUN_RELEASE_BASE='@BUN_RELEASE_BASE@'
# What this installer installs. `all` places the desktop GUI client too, runs setup, and hands the client
# a pairing; `server` stops after the broker's own files, which is what this installer did before the
# client joined the release. Both are rendered from THIS file, so the server installer is the all-in-one
# with one branch not taken rather than a second script that can drift from it.
INSTALL_MODE='@INSTALL_MODE@'
# One row per desktop client this release publishes: "<host> <asset> <sha256> <size>". Rows for hosts this
# script cannot resolve are inert, exactly like the Bun table's.
CLIENT_TABLE='@CLIENT_TABLE@'

fail() {
  # Mirrors install.ps1: a red marker in front of a plain sentence, and only when stderr is a terminal,
  # so a redirected log never collects escape sequences.
  if [ -t 2 ]; then
    printf '\033[31mFAILED\033[0m  cosyncing install: %s\n' "$1" >&2
  else
    printf 'FAILED  cosyncing install: %s\n' "$1" >&2
  fi
  exit 1
}

# A copied command must survive spaces and apostrophes and must not depend on Bun being on PATH.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

print_setup_command() {
  printf '  '
  shell_quote "$BUN_BIN"
  printf ' '
  shell_quote "$APPLICATION"
  printf ' setup\n'
}

[ "$(id -u)" -ne 0 ] || fail 'refusing a root install; run this as the target user'

for command in curl openssl base64 uname stat mktemp awk sed tar; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done

# Linux ships sha256sum; macOS ships `shasum -a 256`. Both print "<hex>  <path>".
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'required command is missing: sha256sum (or shasum)'
fi

# The application bundle is one universal JavaScript file, so nothing here selects a machine-code artifact.
# The host is still resolved, because it decides which hosts this installer supports at all and which Bun
# build a bootstrap would fetch.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64|Linux/amd64) TARGET='linux-x64' ;;
  Linux/aarch64|Linux/arm64) TARGET='linux-arm64' ;;
  Darwin/arm64) TARGET='darwin-arm64' ;;
  Darwin/x86_64) fail 'only Apple Silicon macOS is supported; Intel Macs are out of scope' ;;
  MINGW*/*|MSYS*/*|CYGWIN*/*) fail 'this shell installer supports Linux and macOS only; on Windows x64, run install.ps1 from PowerShell instead' ;;
  *) fail "unsupported host: $OS/$ARCH (Linux x64/arm64 or Apple Silicon macOS is required)" ;;
esac

# GNU stat uses -c; BSD/macOS stat uses -f. Probe once rather than branching on uname at each call site.
if stat -c '%u' . >/dev/null 2>&1; then
  stat_owner() { stat -c '%u' "$1"; }
  stat_mode() { stat -c '%a' "$1"; }
else
  stat_owner() { stat -f '%u' "$1"; }
  stat_mode() { stat -f '%Lp' "$1"; }
fi

[ -n "${HOME:-}" ] || fail 'HOME is required'
STATE_HOME="${COSYNCING_HOME:-$HOME/.cosyncing}"
case "$STATE_HOME" in
  /*) ;;
  *) fail 'COSYNCING_HOME must be absolute when set' ;;
esac
# Built with printf rather than $'\n', which is a bashism: this script is run as `sh`, and on Debian and
# Ubuntu that is dash.
LINE_FEED='
'
CARRIAGE_RETURN="$(printf '\r')"
case "$STATE_HOME" in
  *"$LINE_FEED"*|*"$CARRIAGE_RETURN"*) fail 'state path contains a line break' ;;
esac

INSTALL_DIR="$STATE_HOME/bin"
APPLICATION="$INSTALL_DIR/cosyncing"
ALIAS="$INSTALL_DIR/cosy"
# A packaged broker resolves its web client as `<directory of the application>/cosyncing-web-<version>`, so
# the sidecar has exactly one correct destination and the installer must not invent another.
WEB_ROOT="$INSTALL_DIR/cosyncing-web-$VERSION"
RECEIPT="$STATE_HOME/bootstrap-receipt"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cosyncing-install.XXXXXXXX")"
STAGED_APPLICATION=''
STAGED_RECEIPT=''
# Set when this run took over an npm install, so the tail can offer to remove the package it came from.
ADOPTED_NPM_INSTALL=''
STAGED_WEB=''
RETIRED_WEB=''
# Assigned by the all-in-one client section below, declared here because `cleanup` reads them and `set -u`
# is on from the first line.
CLIENT_ROOT=''
CLIENT_RUNNING=''
# Set on macOS when the placed client declares the App Sandbox, which moves the home it reads.
CLIENT_CONTAINER=''
STAGED_CLIENT=''
RETIRED_CLIENT=''
STAGED_DESKTOP=''
STAGED_PAIRING=''
cleanup() {
  rm -rf "$WORK"
  [ -z "$STAGED_APPLICATION" ] || rm -f "$STAGED_APPLICATION"
  [ -z "$STAGED_RECEIPT" ] || rm -f "$STAGED_RECEIPT"
  [ -z "$STAGED_WEB" ] || rm -rf "$STAGED_WEB"
  [ -z "$STAGED_CLIENT" ] || rm -rf "$STAGED_CLIENT"
  [ -z "$STAGED_DESKTOP" ] || rm -f "$STAGED_DESKTOP"
  [ -z "$STAGED_PAIRING" ] || rm -f "$STAGED_PAIRING"
  # A retired web root is the operator's previous client, held only for the instant between two renames.
  # On any failure it is put BACK, never discarded — losing it would leave a host with no web client at all.
  if [ -n "$RETIRED_WEB" ] && [ -d "$RETIRED_WEB" ]; then
    if [ -e "$WEB_ROOT" ] || [ -L "$WEB_ROOT" ]; then
      rm -rf "$RETIRED_WEB"
    else
      mv "$RETIRED_WEB" "$WEB_ROOT" 2>/dev/null || true
    fi
  fi
  # The same rule for the desktop client the all-in-one places: a retired install goes back unless its
  # replacement is already in position.
  if [ -n "$RETIRED_CLIENT" ] && [ -n "$CLIENT_ROOT" ] && [ -d "$RETIRED_CLIENT" ]; then
    if [ -e "$CLIENT_ROOT" ] || [ -L "$CLIENT_ROOT" ]; then
      rm -rf "$RETIRED_CLIENT"
    else
      mv "$RETIRED_CLIENT" "$CLIENT_ROOT" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT HUP INT TERM

download() {
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --output "$2" "$BASE_URL/$1"
}

# The per-artifact digest table is baked into THIS script at assembly time, alongside the release key. It
# is an artifact pin anchored in the TLS-delivered installer, not an independent trust root: a party who
# can replace this script can replace the digest with it. The script arrives over TLS exactly like every
# other SHA-pinned curl installer, the pinned digest is checked before anything is installed, and every
# later upgrade is Ed25519-verified by the broker itself regardless of what this bootstrap could check.
ARTIFACT_SHA256=''
ARTIFACT_SIZE=''
lookup_artifact() {
  row="$(printf '%s\n' "$ARTIFACT_TABLE" | awk -v n="$1" '$1 == n { if (seen++) exit 2; print }')" \
    || fail 'embedded artifact table contains duplicate rows'
  [ -n "$row" ] || fail "this installer carries no artifact named $1"
  ARTIFACT_SHA256="$(printf '%s\n' "$row" | awk '{print $2}')"
  ARTIFACT_SIZE="$(printf '%s\n' "$row" | awk '{print $3}')"
  [ "${#ARTIFACT_SHA256}" -eq 64 ] || fail "embedded checksum for $1 is malformed"
  case "$ARTIFACT_SHA256" in *[!0-9a-f]*) fail "embedded checksum for $1 is malformed" ;; esac
  case "$ARTIFACT_SIZE" in ''|*[!0-9]*) fail "embedded size for $1 is malformed" ;; esac
}

lookup_artifact "$APP_ASSET"
APP_EXPECTED="$ARTIFACT_SHA256"
APP_EXPECTED_SIZE="$ARTIFACT_SIZE"
lookup_artifact "$WEB_ASSET"
WEB_EXPECTED="$ARTIFACT_SHA256"
WEB_EXPECTED_SIZE="$ARTIFACT_SIZE"

printf '%s' "$PUBLIC_KEY_B64" | base64 --decode > "$WORK/release-key.pem" \
  || fail 'embedded release key is invalid'
printf '%s' "$P256_PUBLIC_KEY_B64" | base64 --decode > "$WORK/release-key-p256.pem" \
  || fail 'embedded P-256 release key is invalid'

# The digest the signed manifest states FOR THIS ASSET.
#
# Scanning for the digest anywhere in the manifest would be a weaker claim than it looks: it would pass for a
# manifest that named this asset in one object and carried the digest in another. The scan starts at the
# object whose `name` is this asset and stops at the next `name`, so the two are read from one object or not
# at all. A manifest whose shape changed would find nothing and fail closed rather than pass loosely.
#
# A second object naming the same asset is refused rather than resolved by taking the first, matching how the
# checksum list treats a repeated row. Neither is reachable without the signing key; a rule that silently
# picked one of two answers would still be the wrong rule to have written down.
manifest_digest_for() {
  awk -v want="\"name\": \"$1\"" '
    index($0, want) { named++; inside = 1; next }
    inside && index($0, "\"name\": \"") { inside = 0 }
    inside && !found && (at = index($0, "\"sha256\": \"")) { digest = substr($0, at + 11, 64); found = 1 }
    END { if (named > 1) exit 2; if (found) print digest }
  ' "$WORK/release-manifest.json"
}

# The two statements about ONE artifact that hold for everything this installer places: the signed checksum
# list, and the digest baked into this script. Both bind the NAME to the digest, so agreement is about this
# artifact rather than about a digest appearing somewhere. Run in the current shell, never a substitution,
# so a `fail` here stops the install instead of returning an empty string to a caller.
assert_checksum_pin() {
  signed="$(awk -v asset="$1" '$2 == asset { if (seen++) exit 2; print $1 }' "$WORK/SHA256SUMS")" \
    || fail 'checksum list contains duplicate artifact rows'
  [ "${#signed}" -eq 64 ] || fail "artifact checksum is missing or malformed: $1"
  [ "$signed" = "$2" ] \
    || fail "signed checksum list disagrees with the digest embedded in this installer for $1"
}

# The broker's own artifacts add a THIRD statement: the signed manifest, which names them because a running
# broker upgrades ITSELF to them. A desktop client is not a broker upgrade and the manifest deliberately
# does not name one, so the client path calls `assert_checksum_pin` directly and this wrapper is what the
# broker artifacts use.
assert_signed_artifact() {
  assert_checksum_pin "$1" "$2"
  stated="$(manifest_digest_for "$1")" \
    || fail "signed manifest names $1 more than once"
  [ -n "$stated" ] || fail "signed manifest does not name $1"
  [ "$stated" = "$2" ] \
    || fail "signed manifest and checksum list disagree about $1"
}

# Signature verification is REQUIRED wherever the local openssl can do it, and the release is signed twice
# over the same bytes so that "can do it" covers every supported host.
#
# Stock macOS ships LibreSSL, which cannot load an Ed25519 SPKI key at all — no flag changes that. It has no
# trouble with ECDSA P-256, so a Mac verifies the P-256 signature instead of falling back to bytes delivered
# by TLS alone. Probe the capability, never the platform: a Mac with real OpenSSL on PATH takes the Ed25519
# branch, and a Linux box somehow lacking it takes the same P-256 branch a Mac does.
#
# Signature FAILURE is always fatal, in either branch. Only genuine inability to verify — neither algorithm
# loadable — degrades, and it says so.
SIGNATURE_ALGORITHM=''
if openssl pkey -pubin -in "$WORK/release-key.pem" -noout >/dev/null 2>&1; then
  SIGNATURE_ALGORITHM='ed25519'
elif openssl pkey -pubin -in "$WORK/release-key-p256.pem" -noout >/dev/null 2>&1; then
  SIGNATURE_ALGORITHM='p256'
fi

SIGNATURE_STATE='skipped (this openssl can verify neither Ed25519 nor ECDSA P-256)'
if [ -n "$SIGNATURE_ALGORITHM" ]; then
  download 'release-manifest.json' "$WORK/release-manifest.json"
  download 'SHA256SUMS' "$WORK/SHA256SUMS"

  if [ "$SIGNATURE_ALGORITHM" = ed25519 ]; then
    download 'release-manifest.json.sig' "$WORK/release-manifest.json.sig"
    download 'SHA256SUMS.sig' "$WORK/SHA256SUMS.sig"
    openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
      -in "$WORK/release-manifest.json" -sigfile "$WORK/release-manifest.json.sig" >/dev/null 2>&1 \
      || fail 'release manifest signature verification failed'
    openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
      -in "$WORK/SHA256SUMS" -sigfile "$WORK/SHA256SUMS.sig" >/dev/null 2>&1 \
      || fail 'checksum-list signature verification failed'
    SIGNATURE_STATE='verified (Ed25519 over the signed release manifest and checksum list)'
  else
    # `dgst -verify` rather than `pkeyutl`: it is the spelling LibreSSL has always had, and the DER sibling
    # is published precisely because openssl cannot read the raw r||s form the Windows consumer needs.
    download 'release-manifest.json.p256.der.sig' "$WORK/release-manifest.json.p256.der.sig"
    download 'SHA256SUMS.p256.der.sig' "$WORK/SHA256SUMS.p256.der.sig"
    openssl dgst -sha256 -verify "$WORK/release-key-p256.pem" \
      -signature "$WORK/release-manifest.json.p256.der.sig" "$WORK/release-manifest.json" >/dev/null 2>&1 \
      || fail 'release manifest signature verification failed'
    openssl dgst -sha256 -verify "$WORK/release-key-p256.pem" \
      -signature "$WORK/SHA256SUMS.p256.der.sig" "$WORK/SHA256SUMS" >/dev/null 2>&1 \
      || fail 'checksum-list signature verification failed'
    SIGNATURE_STATE='verified (ECDSA P-256 over the signed release manifest and checksum list)'
  fi

  grep -Fq "\"version\": \"$VERSION\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest version does not match this pinned installer'
  # One key id covers both signatures, because the Ed25519 and P-256 keys are one release identity rather
  # than two independent trust anchors: a release is signed by the pair, and this installer carries the pair.
  # So the P-256 path verifies with the P-256 key and still asserts the manifest's single identity — they
  # cannot be rotated apart without also changing this id. See docs/release/broker-release-signing.md.
  grep -Fq "\"keyId\": \"$KEY_ID\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest key id does not match this pinned installer'

  # The signed chain and the baked-in table must name the same bytes, or one of the two was tampered with.
  assert_signed_artifact "$APP_ASSET" "$APP_EXPECTED"
  assert_signed_artifact "$WEB_ASSET" "$WEB_EXPECTED"
fi

fetch_verified() {
  download "$1" "$4"
  actual_size="$(wc -c < "$4" | tr -d ' ')"
  [ "$actual_size" = "$3" ] || fail "$1 size does not match this installer"
  [ "$(sha256_of "$4")" = "$2" ] || fail "$1 checksum verification failed"
}

fetch_verified "$APP_ASSET" "$APP_EXPECTED" "$APP_EXPECTED_SIZE" "$WORK/$APP_ASSET"
fetch_verified "$WEB_ASSET" "$WEB_EXPECTED" "$WEB_EXPECTED_SIZE" "$WORK/$WEB_ASSET"

# The bundle carries no interpreter, so a Bun that can run it is a hard prerequisite rather than a nicety.
# COSYNCING_BUN_BIN is honoured first because it is the same override the broker itself reads.
bun_version_of() {
  "$1" --revision 2>/dev/null | sed -n '1s/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p'
}
bun_meets_floor() {
  reported="$(bun_version_of "$1")"
  [ -n "$reported" ] || return 1
  printf '%s\n%s\n' "$MINIMUM_BUN" "$reported" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1 | grep -Fxq "$MINIMUM_BUN"
}
# Bun's own installer puts its prefix at $BUN_INSTALL, defaulting to ~/.bun. Honour an existing setting so
# a host that already directs Bun elsewhere is not given a second copy in a directory it never reads.
BUN_PREFIX="${BUN_INSTALL:-$HOME/.bun}"
case "$BUN_PREFIX" in
  /*) ;;
  *) fail 'BUN_INSTALL must be absolute when set' ;;
esac

resolve_bun() {
  for candidate in "${COSYNCING_BUN_BIN:-}" "$(command -v bun 2>/dev/null || true)" "$BUN_PREFIX/bin/bun"; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    if bun_meets_floor "$candidate"; then
      BUN_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

# Bun's archives are zips. `unzip` is the usual tool and bsdtar reads zip too, which is what macOS installs
# as `tar`. Probed lazily rather than required up front: a host that already has a new-enough Bun never
# needs to unpack one, and must not be turned away for missing a tool this install will not use.
if command -v unzip >/dev/null 2>&1; then
  unpack_zip() { unzip -q -o "$1" -d "$2"; }
elif command -v bsdtar >/dev/null 2>&1; then
  unpack_zip() { bsdtar -xf "$1" -C "$2"; }
elif tar --version 2>/dev/null | grep -q bsdtar; then
  unpack_zip() { tar -xf "$1" -C "$2"; }
else
  unpack_zip() { fail 'installing Bun needs unzip (or bsdtar); install one and rerun this installer'; }
fi

# The Bun builds this installer may place on this host, most likely first.
#
# One host target is not one binary: glibc and musl need different builds, and a pre-AVX2 x64 needs the
# baseline one. The rows are reordered on what can be detected cheaply, but detection never decides — the
# extracted binary has to answer `--revision` at or above the floor before it is installed, so a wrong
# guess costs one download and moves to the next pinned build.
bun_candidates() {
  rows="$(printf '%s\n' "$BUN_TABLE" | awk -v host="$1" '$1 == host { print $2, $3 }')"
  [ -n "$rows" ] || fail "this installer carries no pinned Bun build for $1"
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    rows="$(printf '%s\n' "$rows" | awk '/-musl/')
$(printf '%s\n' "$rows" | awk '!/-musl/')"
  fi
  if [ "$OS" = Linux ] && [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then
    rows="$(printf '%s\n' "$rows" | awk '/-baseline/')
$(printf '%s\n' "$rows" | awk '!/-baseline/')"
  fi
  printf '%s\n' "$rows" | awk 'NF'
}

# Bun is DOWNLOADED, never bundled. A Bun inside this release would put a JavaScriptCore build back into
# the artifact set — the one thing this distribution exists to avoid — and would make every cosyncing
# release responsible for shipping a runtime it does not build.
#
# Downloaded is not the same as unverified. Every cosyncing artifact above is checked against a digest baked
# into this script; the runtime that EXECUTES those artifacts is held to exactly the same rule. Bun's own
# `bun.sh/install` script is deliberately not in this path: piping an unpinned third-party script to a shell
# would make the one component nothing here checks the one component that runs everything else. The archives
# come straight from Bun's tagged release and their checksums are Bun's own published ones.
install_bun() {
  [ "${COSYNCING_SKIP_BUN_INSTALL:-}" != 1 ] || fail \
    "Bun $MINIMUM_BUN or newer is required to run cosyncing and COSYNCING_SKIP_BUN_INSTALL=1 forbids installing it; install it from https://bun.sh and rerun this installer"
  printf 'Bun %s or newer is required and was not found. Installing the pinned Bun %s.\n' \
    "$MINIMUM_BUN" "$MINIMUM_BUN"
  bun_candidates "$TARGET" > "$WORK/bun-candidates"
  while read -r bun_asset bun_digest; do
    [ -n "$bun_asset" ] || continue
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output "$WORK/$bun_asset" "$BUN_RELEASE_BASE/bun-v$MINIMUM_BUN/$bun_asset" \
      || fail "could not download $bun_asset from $BUN_RELEASE_BASE"
    # A mismatch is fatal, never "try the next one": these are the bytes Bun published for this tag, so
    # different bytes mean the download was substituted, not that this build is wrong for this host.
    [ "$(sha256_of "$WORK/$bun_asset")" = "$bun_digest" ] \
      || fail "$bun_asset does not match the checksum embedded in this installer"
    rm -rf "$WORK/bun-unpack"
    mkdir "$WORK/bun-unpack"
    unpack_zip "$WORK/$bun_asset" "$WORK/bun-unpack" || fail "$bun_asset could not be extracted"
    # Bun packs one directory named after the asset, holding the binary.
    unpacked="$WORK/bun-unpack/${bun_asset%.zip}/bun"
    [ -f "$unpacked" ] || fail "$bun_asset did not contain a bun binary"
    chmod 755 "$unpacked"
    if bun_meets_floor "$unpacked"; then
      mkdir -p "$BUN_PREFIX/bin" || fail "could not create the Bun prefix: $BUN_PREFIX"
      mv "$unpacked" "$BUN_PREFIX/bin/bun" || fail "could not install Bun into $BUN_PREFIX/bin"
      chmod 755 "$BUN_PREFIX/bin/bun"
      return 0
    fi
    printf '  %s does not run on this host; trying the next pinned build\n' "$bun_asset"
  done < "$WORK/bun-candidates"
  fail "no pinned Bun $MINIMUM_BUN build runs on this host ($TARGET); install Bun from https://bun.sh and rerun this installer"
}

BUN_BIN=''
BUN_STATE=''
if resolve_bun; then
  BUN_STATE="already installed ($(bun_version_of "$BUN_BIN") at $BUN_BIN)"
else
  install_bun
  # Re-probe rather than trusting the installer's exit status: it reports success for an install this script
  # would still refuse, and a Bun below the floor must never reach the receipt.
  resolve_bun || fail \
    "Bun $MINIMUM_BUN or newer is still not runnable after installing it into $BUN_PREFIX; install it from https://bun.sh and rerun this installer"
  BUN_STATE="installed by this script ($(bun_version_of "$BUN_BIN") at $BUN_BIN)"
fi

# Run the verified bundle through the resolved Bun and make it identify itself, exactly as the compiled
# artifact used to be asked directly. A bundle cannot be exec'd on its own here: its shebang would resolve
# `bun` through PATH, which may name a different runtime from the one this install is about to record.
VERSION_JSON="$("$BUN_BIN" "$WORK/$APP_ASSET" version --json)" \
  || fail 'verified application did not run its offline version check'
printf '%s\n' "$VERSION_JSON" | grep -Fq "\"version\": \"$VERSION\"" \
  || fail 'verified application reports the wrong version'
printf '%s\n' "$VERSION_JSON" | grep -Fq "\"target\": \"universal\"" \
  || fail 'verified application reports the wrong target'
printf '%s\n' "$VERSION_JSON" | grep -Fq '"packaged": true' \
  || fail 'verified application is not a packaged build'
# The kind is checked exactly. `packaged` is true for the npm build too, and an npm-owned bundle installed
# here would tell the operator to run `npm update` on files npm never placed.
printf '%s\n' "$VERSION_JSON" | grep -Fq '"distribution": "bootstrap-js"' \
  || fail 'verified application is not the installer-owned distribution'

# Takes over the copy `cosyncing setup` made from the npm package, after asking.
#
# Consent comes from the terminal and nowhere else. Every environment variable these installers read makes
# them MORE restrictive, never less, and an unattended run must not take over another package manager's
# install on an operator's behalf — so there is deliberately no variable that answers this question.
#
# On agreement this returns and the ordinary placement below runs: one file is replaced and one receipt is
# written. Nothing reads or writes anything else under the state home, so settings, credentials, paired
# devices, drafts and sessions survive untouched, and the service keeps running the same path it already
# names. That is why this can be offered at all.
adopt_npm_application() {
  EXISTING_JSON="$("$BUN_BIN" "$APPLICATION" version --json 2>/dev/null)" || EXISTING_JSON=''
  printf '%s\n' "$EXISTING_JSON" | grep -Fq '"product": "cosyncing"' \
    && printf '%s\n' "$EXISTING_JSON" | grep -Fq '"packaged": true' \
    && printf '%s\n' "$EXISTING_JSON" | grep -Fq '"distribution": "bun-js"' \
    || fail 'existing application has no safe bootstrap ownership receipt'
  EXISTING_VERSION="$(printf '%s\n' "$EXISTING_JSON" | sed -n 's/^ *"version": "\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$EXISTING_VERSION" ] || EXISTING_VERSION='an unknown version'

  printf '\ncosyncing %s is installed at\n  %s\n' "$EXISTING_VERSION" "$APPLICATION"
  printf 'from the npm package, by `cosyncing setup`. This installer did not place it.\n\n'
  printf 'Taking it over replaces that one file and records ownership of it. Everything else in\n'
  printf '  %s\n' "$STATE_HOME"
  printf 'is left exactly as it is — settings, credentials, paired devices, drafts and sessions —\n'
  printf 'and the service keeps running the same path.\n\n'

  if [ ! -r /dev/tty ] || ! ( : < /dev/tty ) 2>/dev/null; then
    printf 'cosyncing install: replacing an npm install needs your answer and no terminal is attached.\n' >&2
    printf 'Rerun this installer from a terminal, or stay on npm with:\n  npm update -g cosyncing\n' >&2
    print_setup_command >&2
    exit 1
  fi

  printf 'Replace it with cosyncing %s? [y/N] ' "$VERSION"
  REPLY=''
  read -r REPLY < /dev/tty || REPLY=''
  case "$REPLY" in
    y|Y|yes|YES|Yes) ;;
    *) fail 'left the npm install in place; nothing was changed' ;;
  esac
  ADOPTED_NPM_INSTALL=1
}

ensure_owned_directory() {
  path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] || fail "unsafe directory: $path"
    [ "$(stat_owner "$path")" = "$(id -u)" ] || fail "directory is not owned by the current user: $path"
    mode="$(stat_mode "$path")"
    # POSIX arithmetic; the leading 0 forces octal in $(( )) without bash's 8#nn syntax.
    [ $(( 0$mode & 077 )) -eq 0 ] || fail "directory is accessible to another user: $path"
  else
    mkdir "$path" || fail "could not create directory: $path"
  fi
}

ensure_owned_directory "$STATE_HOME"
ensure_owned_directory "$INSTALL_DIR"

if [ -e "$APPLICATION" ] || [ -L "$APPLICATION" ]; then
  [ -f "$APPLICATION" ] && [ ! -L "$APPLICATION" ] || fail 'existing cosyncing application is not a safe regular file'
  [ "$(stat_owner "$APPLICATION")" = "$(id -u)" ] || fail 'existing cosyncing application is not owned by this user'
  # A missing receipt is the ORDINARY state of an npm install, not evidence of tampering: the npm package
  # is an acquisition artifact, and `cosyncing setup` copies its bundle to exactly this path and writes no
  # receipt. Refusing every unreceipted application therefore refused the entire installed base — npm is
  # the only other channel this product ships through — and did it before the desktop-client step, so
  # neither half was updated. Ask the file what it is instead, and take it over only if it answers as a
  # packaged npm-distribution cosyncing. Running it is not a new exposure: it is a user-owned file in the
  # user's own home that this installer is about to overwrite, executed as that same user.
  if [ ! -f "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
    # No receipt to check against, by design on the npm path: this either wins consent to take the install
    # over, or exits. There is deliberately no third outcome where an unreceipted application is replaced.
    adopt_npm_application
  else
    [ "$(stat_owner "$RECEIPT")" = "$(id -u)" ] || fail 'existing bootstrap receipt is not owned by this user'
    # Receipt 1 recorded a compiled per-host executable. This installer places a JavaScript bundle a Bun
    # runtime executes, so overwriting one with the other would leave a service unit that can never start.
    grep -Fxq 'schemaVersion=1' "$RECEIPT" \
      && fail 'this path holds a compiled cosyncing install; remove it and its service before installing the JavaScript build'
    grep -Fxq 'schemaVersion=2' "$RECEIPT" || fail 'existing bootstrap receipt is invalid'
    grep -Fxq 'product=cosyncing' "$RECEIPT" || fail 'existing bootstrap receipt is for another product'
    grep -Fxq "application=$APPLICATION" "$RECEIPT" || fail 'existing bootstrap receipt names another application'
    PRIOR="$(sed -n 's/^sha256=//p' "$RECEIPT")"
    [ "${#PRIOR}" -eq 64 ] || fail 'existing bootstrap receipt checksum is invalid'
    [ "$(sha256_of "$APPLICATION")" = "$PRIOR" ] \
      || fail 'existing application differs from its bootstrap ownership receipt'
  fi
fi

if [ -e "$ALIAS" ] || [ -L "$ALIAS" ]; then
  [ -L "$ALIAS" ] && [ "$(readlink "$ALIAS")" = 'cosyncing' ] \
    || fail 'refusing to replace an unowned cosy path'
fi

if [ -e "$WEB_ROOT" ] || [ -L "$WEB_ROOT" ]; then
  [ -d "$WEB_ROOT" ] && [ ! -L "$WEB_ROOT" ] || fail "unsafe web client path: $WEB_ROOT"
  [ "$(stat_owner "$WEB_ROOT")" = "$(id -u)" ] || fail "web client directory is not owned by the current user: $WEB_ROOT"
fi

# The sidecar archive holds a single `app/` tree. Extract it into the install directory rather than a temp
# filesystem so the final move is a rename, not a cross-device copy that could half-complete.
STAGED_WEB="$(mktemp -d "$INSTALL_DIR/.cosyncing-web.staging.XXXXXXXX")"
tar -xzf "$WORK/$WEB_ASSET" -C "$STAGED_WEB" || fail 'web client archive could not be extracted'
[ -f "$STAGED_WEB/app/index.html" ] || fail 'web client archive does not contain a web build'
chmod 700 "$STAGED_WEB/app"

STAGED_APPLICATION="$(mktemp "$INSTALL_DIR/.cosyncing.install.XXXXXXXX")"
STAGED_RECEIPT="$(mktemp "$STATE_HOME/.bootstrap-receipt.XXXXXXXX")"
cp "$WORK/$APP_ASSET" "$STAGED_APPLICATION"
chmod 755 "$STAGED_APPLICATION"
{
  printf 'schemaVersion=2\n'
  printf 'product=cosyncing\n'
  printf 'version=%s\n' "$VERSION"
  printf 'target=universal\n'
  printf 'distribution=bootstrap-js\n'
  printf 'host=%s\n' "$TARGET"
  printf 'application=%s\n' "$APPLICATION"
  printf 'webRoot=%s\n' "$WEB_ROOT"
  printf 'runtime=%s\n' "$BUN_BIN"
  printf 'sha256=%s\n' "$APP_EXPECTED"
} > "$STAGED_RECEIPT"
chmod 600 "$STAGED_RECEIPT"
mv "$STAGED_APPLICATION" "$APPLICATION"
STAGED_APPLICATION=''
mv "$STAGED_RECEIPT" "$RECEIPT"
STAGED_RECEIPT=''
if [ -d "$WEB_ROOT" ]; then
  RETIRED_WEB="$(mktemp -d "$INSTALL_DIR/.cosyncing-web.retired.XXXXXXXX")"
  rmdir "$RETIRED_WEB"
  mv "$WEB_ROOT" "$RETIRED_WEB" || fail 'could not retire the previous web client'
fi
mv "$STAGED_WEB/app" "$WEB_ROOT" || fail 'could not install the web client'
rmdir "$STAGED_WEB" 2>/dev/null || rm -rf "$STAGED_WEB"
STAGED_WEB=''
if [ -n "$RETIRED_WEB" ]; then
  rm -rf "$RETIRED_WEB"
  RETIRED_WEB=''
fi
[ -L "$ALIAS" ] || ln -s 'cosyncing' "$ALIAS"

printf 'Installed cosyncing %s at %s\n' "$VERSION" "$APPLICATION"
printf 'Web client: %s\n' "$WEB_ROOT"
printf 'Bun runtime: %s\n' "$BUN_STATE"
printf 'Artifact digests: matched the sha256 values embedded in this installer.\n'
printf 'Release signature: %s\n' "$SIGNATURE_STATE"

case "$SIGNATURE_STATE" in
  skipped*)
    printf 'This installer was itself delivered over TLS and carries the expected digests; the broker\n'
    printf 'still verifies every future upgrade with its own built-in Ed25519 check.\n' ;;
esac

# The npm package is preserved by design — `uninstall` says the same thing — but after a takeover it is a
# loaded gun: its own `setup` copies itself back over the application just placed, and the next run of this
# installer would then refuse again. Offer to remove it, and never fail the install over the answer.
if [ -n "$ADOPTED_NPM_INSTALL" ]; then
  NPM_ROOT=''
  command -v npm >/dev/null 2>&1 && NPM_ROOT="$(npm root -g 2>/dev/null)" || NPM_ROOT=''
  if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/cosyncing" ]; then
    printf '\nThe npm package it came from is still installed at %s/cosyncing.\n' "$NPM_ROOT"
    printf 'Its own `setup` would copy itself back over the install just made.\n'
    printf 'Remove it now? [y/N] '
    REPLY=''
    read -r REPLY < /dev/tty || REPLY=''
    case "$REPLY" in
      y|Y|yes|YES|Yes)
        if npm uninstall -g cosyncing >/dev/null 2>&1; then
          printf 'Removed the npm package.\n'
        else
          printf 'Could not remove the npm package; remove it by hand:\n  npm uninstall -g cosyncing\n' >&2
        fi ;;
      *) printf 'Left it in place. Remove it later with:\n  npm uninstall -g cosyncing\n' ;;
    esac
  fi
fi

if [ "$INSTALL_MODE" != all ]; then
  # Named, not removed. This installer does not run setup, so the service is still the previous broker
  # and still serving out of one of these; setup is what moves it to the new root.
  for SUPERSEDED in "$INSTALL_DIR"/cosyncing-web-*; do
    [ -d "$SUPERSEDED" ] && [ ! -L "$SUPERSEDED" ] && [ "$SUPERSEDED" != "$WEB_ROOT" ] || continue
    printf 'A previous web client is still at %s. setup moves the service to the new one,\nafter which that directory can be removed.\n' "$SUPERSEDED"
  done
  printf 'PATH was not changed. Run setup with the absolute command:\n'
  print_setup_command
  exit 0
fi

# ---------------------------------------------------------------------------------------------------
# The all-in-one tail: the desktop client, setup, and the pairing handoff.
#
# Everything above is what `install-server.sh` also does, and it has already finished. Nothing below undoes
# it. A host this release publishes no client for, and a headless one, are reported and skipped — those are
# supported outcomes, not failures. Everything else here is fatal, including any disagreement about the
# client's bytes: this run exits non-zero with a correctly installed broker and a printed next command,
# which is the honest report of what happened.
# ---------------------------------------------------------------------------------------------------

# The client's macOS build is named for the platform Apple ships, not for the kernel `uname` reports, and
# no Linux arm64 client is built at all.
case "$TARGET" in
  linux-x64) CLIENT_HOST='linux-x64' ;;
  darwin-arm64) CLIENT_HOST='macos-arm64' ;;
  *) CLIENT_HOST='' ;;
esac

CLIENT_ASSET=''
CLIENT_SHA256=''
CLIENT_SIZE=''
lookup_client() {
  row="$(printf '%s\n' "$CLIENT_TABLE" | awk -v h="$1" '$1 == h { if (seen++) exit 2; print }')" \
    || fail 'embedded client table contains duplicate rows'
  [ -n "$row" ] || return 1
  CLIENT_ASSET="$(printf '%s\n' "$row" | awk '{print $2}')"
  CLIENT_SHA256="$(printf '%s\n' "$row" | awk '{print $3}')"
  CLIENT_SIZE="$(printf '%s\n' "$row" | awk '{print $4}')"
  [ "${#CLIENT_SHA256}" -eq 64 ] || fail "embedded checksum for $CLIENT_ASSET is malformed"
  case "$CLIENT_SHA256" in *[!0-9a-f]*) fail "embedded checksum for $CLIENT_ASSET is malformed" ;; esac
  case "$CLIENT_SIZE" in ''|*[!0-9]*) fail "embedded size for $CLIENT_ASSET is malformed" ;; esac
}

CLIENT_SKIP=''
if [ -z "$CLIENT_HOST" ] || ! lookup_client "$CLIENT_HOST"; then
  CLIENT_SKIP="this release publishes no desktop client for $TARGET"
elif [ "$OS" = Linux ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  # A desktop client on a machine with no display server is a package nothing can start. The broker is the
  # part that belongs on a headless host, and it is already installed; say so rather than placing a GUI.
  CLIENT_SKIP='this host has no display server (DISPLAY and WAYLAND_DISPLAY are both unset)'
fi

if [ -n "$CLIENT_SKIP" ]; then
  printf 'Desktop client: skipped — %s.\n' "$CLIENT_SKIP"
else
  # Verified by exactly the rule the broker's own artifacts are verified by, minus the manifest — which
  # names broker upgrades and deliberately does not name a client. See `assert_signed_artifact`.
  if [ -n "$SIGNATURE_ALGORITHM" ]; then
    assert_checksum_pin "$CLIENT_ASSET" "$CLIENT_SHA256"
  fi
  fetch_verified "$CLIENT_ASSET" "$CLIENT_SHA256" "$CLIENT_SIZE" "$WORK/$CLIENT_ASSET"

  if [ "$OS" = Darwin ]; then
    command -v ditto >/dev/null 2>&1 || fail 'required command is missing: ditto'
    # ~/Applications, never /Applications: the whole install is per-user and unelevated, and Finder treats
    # a per-user Applications folder as a first-class location. Created 755 because it is a place the
    # user's own Finder and Launchpad read, not owner-only state.
    CLIENT_PARENT="$HOME/Applications"
    ( umask 022; mkdir -p "$CLIENT_PARENT" ) || fail "could not create $CLIENT_PARENT"
    CLIENT_ROOT="$CLIENT_PARENT/Cosyncing.app"
    # Staged beside the destination so the final move is a rename on one volume.
    STAGED_CLIENT="$(mktemp -d "$CLIENT_PARENT/.cosyncing-client.staging.XXXXXXXX")"
    ditto -x -k "$WORK/$CLIENT_ASSET" "$STAGED_CLIENT" \
      || fail 'desktop client archive could not be extracted'
    [ -d "$STAGED_CLIENT/Cosyncing.app" ] \
      || fail 'desktop client archive does not contain Cosyncing.app'
    EXTRACTED_CLIENT="$STAGED_CLIENT/Cosyncing.app"
    CLIENT_LAUNCH="$CLIENT_ROOT"
  else
    CLIENT_PARENT="$STATE_HOME"
    CLIENT_ROOT="$STATE_HOME/client"
    STAGED_CLIENT="$(mktemp -d "$STATE_HOME/.cosyncing-client.staging.XXXXXXXX")"
    tar -xzf "$WORK/$CLIENT_ASSET" -C "$STAGED_CLIENT" \
      || fail 'desktop client archive could not be extracted'
    # The archive holds one top-level directory whose name carries the release version, so the tree is
    # found rather than named: a version-shaped path written down here would be a second place to keep in
    # step with the client release.
    set -- "$STAGED_CLIENT"/*
    [ "$#" -eq 1 ] && [ -d "$1" ] \
      || fail 'desktop client archive does not contain a single application directory'
    EXTRACTED_CLIENT="$1"
    [ -x "$EXTRACTED_CLIENT/cosyncing" ] \
      || fail 'desktop client archive contains no cosyncing executable'
    CLIENT_LAUNCH="$CLIENT_ROOT/cosyncing"
  fi

  # An app that is already open keeps running the bytes it started with. macOS `open -a` ACTIVATES a
  # running application rather than restarting it, and a second copy of the Linux binary is a second
  # window, not an upgrade. Replacing the tree below is still right — the next start gets the new version —
  # but the handoff and the launch line must not pretend the update took effect in the window on screen.
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "$CLIENT_LAUNCH" >/dev/null 2>&1; then
    CLIENT_RUNNING=1
  fi

  if [ -e "$CLIENT_ROOT" ] || [ -L "$CLIENT_ROOT" ]; then
    [ -d "$CLIENT_ROOT" ] && [ ! -L "$CLIENT_ROOT" ] \
      || fail "unsafe desktop client path: $CLIENT_ROOT"
    [ "$(stat_owner "$CLIENT_ROOT")" = "$(id -u)" ] \
      || fail "desktop client directory is not owned by the current user: $CLIENT_ROOT"
    RETIRED_CLIENT="$(mktemp -d "$CLIENT_PARENT/.cosyncing-client.retired.XXXXXXXX")"
    rmdir "$RETIRED_CLIENT"
    mv "$CLIENT_ROOT" "$RETIRED_CLIENT" || fail 'could not retire the previous desktop client'
  fi
  mv "$EXTRACTED_CLIENT" "$CLIENT_ROOT" || fail 'could not install the desktop client'
  rmdir "$STAGED_CLIENT" 2>/dev/null || rm -rf "$STAGED_CLIENT"
  STAGED_CLIENT=''
  if [ -n "$RETIRED_CLIENT" ]; then
    rm -rf "$RETIRED_CLIENT"
    RETIRED_CLIENT=''
  fi

  if [ "$OS" = Linux ]; then
    # A launcher entry, so the client is startable from the desktop rather than only by absolute path.
    # 755/644 rather than the script's owner-only umask: the desktop environment reads these.
    DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    ( umask 022; mkdir -p "$DESKTOP_DIR" ) || fail "could not create $DESKTOP_DIR"
    DESKTOP_ENTRY="$DESKTOP_DIR/cosyncing.desktop"
    STAGED_DESKTOP="$(mktemp "$DESKTOP_DIR/.cosyncing.desktop.XXXXXXXX")"
    {
      printf '[Desktop Entry]\n'
      printf 'Type=Application\n'
      printf 'Name=cosyncing\n'
      printf 'Comment=Drive your coding agents from anywhere\n'
      # The desktop menu starts the client with its own environment, not this script's, so a relocated
      # home has to travel in the launcher or the client reads ~/.cosyncing and finds no handoff. The
      # default home needs no such argument, and leaving it off keeps the common entry as it was.
      if [ "$STATE_HOME" = "$HOME/.cosyncing" ]; then
        printf 'Exec=%s\n' "$CLIENT_LAUNCH"
      else
        printf 'Exec=env COSYNCING_HOME=%s %s\n' "$STATE_HOME" "$CLIENT_LAUNCH"
      fi
      printf 'Terminal=false\n'
      printf 'Categories=Development;Network;\n'
    } > "$STAGED_DESKTOP"
    chmod 644 "$STAGED_DESKTOP"
    mv "$STAGED_DESKTOP" "$DESKTOP_ENTRY"
    STAGED_DESKTOP=''
    printf 'Desktop client: %s (launcher entry: %s)\n' "$CLIENT_ROOT" "$DESKTOP_ENTRY"
  else
    printf 'Desktop client: %s\n' "$CLIENT_ROOT"
    # A sandboxed macOS application does not have the home this script has. The kernel rewrites $HOME to
    # its container, so the offer written below into the broker's state home is a file the client is
    # denied — it is not that the client looks in the wrong place, it is that `~` means something else
    # inside the cage. Verified on a real Mac: two identical copies, one in the state home and one in the
    # container, and only the container copy was ever read.
    #
    # So the offer goes where the client's OWN home resolves to. The bundle identifier is read from the
    # application just placed rather than written down here, and the entitlement is read from its
    # signature, so an unsandboxed build of the same client keeps the ordinary path with no second rule to
    # maintain. Both commands ship with macOS.
    if BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
        "$CLIENT_ROOT/Contents/Info.plist" 2>/dev/null)" && [ -n "$BUNDLE_ID" ] \
      && codesign -d --entitlements - --xml "$CLIENT_ROOT" 2>/dev/null \
        | grep -A1 'com\.apple\.security\.app-sandbox' | grep -q '<true/>'
    then
      CLIENT_CONTAINER="$HOME/Library/Containers/$BUNDLE_ID/Data"
    fi
  fi
fi

# `setup` shows the whole plan and asks before it changes anything, and that consent is the point of the
# command. Under `curl … | sh` this script's stdin IS the pipe, so setup would read the rest of the script
# as answers — or see EOF and decline. Reading from the terminal restores the question. A run with no
# terminal at all (CI, a container, a remote command) prints the command and stops rather than taking the
# operator's consent as given: --yes and --accept-managed-runtime-ownership are never passed here.
#
# The open is probed inside a SUBSHELL. `:` is a POSIX special built-in, and a redirection error on a
# special built-in makes the shell itself exit: dash does, with status 2 and no message, so `… || ! :
# < /dev/tty` killed this script instead of taking the branch. In a subshell that exit is contained and
# becomes an ordinary non-zero status. `2>/dev/null` wraps the subshell so the open failure is quiet on
# the one path built to stop quietly.
#
# WHICH terminal descriptor matters, and only on macOS. A reopened `/dev/tty` there delivers nothing to a
# reader that has put the terminal in raw mode — `isTTY` is true, the mode change succeeds, and no keypress
# ever arrives. setup is exactly that reader, so `setup < /dev/tty` drew its first question and could never
# be answered: a macOS operator got a wizard frozen at the language prompt, and had to interrupt it and run
# setup by hand. Reproduced from three independent pseudo-terminals (an sshd pty, `expect`, a bare
# `pty.fork`), and only on macOS; Linux takes input either way.
#
# The descriptors this script INHERITED are unaffected, and `curl … | sh` only ever replaces stdin: stdout
# and stderr still carry the operator's terminal. So setup takes its stdin from whichever of those is one,
# and `/dev/tty` stays as the last resort for the case where both were redirected — which is where it still
# works, because a shell reading a here-string is not in raw mode.
setup_with_terminal() { "$BUN_BIN" "$APPLICATION" setup; }

if [ ! -t 1 ] && [ ! -t 2 ] && { [ ! -r /dev/tty ] || ! ( : < /dev/tty ) 2>/dev/null; }; then
  printf '\nNo terminal is attached, so setup was not run. Finish with:\n'
  print_setup_command
  exit 0
fi

printf '\nRunning setup. It shows its plan and asks before changing anything.\n'
SETUP_STATUS=0
if [ -t 1 ]; then
  setup_with_terminal 0<&1 || SETUP_STATUS=$?
elif [ -t 2 ]; then
  setup_with_terminal 0<&2 || SETUP_STATUS=$?
else
  setup_with_terminal < /dev/tty || SETUP_STATUS=$?
fi
if [ "$SETUP_STATUS" -ne 0 ]; then
  printf 'cosyncing install: setup did not complete; the broker files are installed. Rerun:\n' >&2
  print_setup_command >&2
  exit 1
fi

# The web client is version-stamped, so an upgrade does not replace the previous root — it lands beside
# it and, until this existed, abandoned it: two 38 MB trees on a real Mac after one upgrade, referenced
# by nothing. Every sibling but the current one goes, so a host that has already leaked several is healed
# rather than merely stopped from leaking more. The install directory is one this installer owns
# outright — it refuses an unowned application, alias or web root above — so a `cosyncing-web-*` in it is
# either this release's or a superseded one.
#
# AFTER setup, never before. Until setup returns, one of these can still be the tree the running broker is
# serving; setup is what rewrites the service definition and restarts it against the new root. A failed
# setup exits above and leaves them all alone. A symlink is skipped rather than followed, and so is
# anything this user does not own.
for SUPERSEDED in "$INSTALL_DIR"/cosyncing-web-*; do
  [ -d "$SUPERSEDED" ] && [ ! -L "$SUPERSEDED" ] && [ "$SUPERSEDED" != "$WEB_ROOT" ] || continue
  [ "$(stat_owner "$SUPERSEDED")" = "$(id -u)" ] || continue
  if rm -rf "$SUPERSEDED"; then
    printf 'Removed the superseded web client: %s\n' "$SUPERSEDED"
  else
    printf 'Could not remove the superseded web client; remove it by hand:\n  %s\n' "$SUPERSEDED" >&2
  fi
done

# ---------------------------------------------------------------------------------------------------
# The pairing handoff.
#
# The client reads $COSYNCING_HOME/client-pairing.json once at startup, imports it, and deletes it — so
# the first launch after an all-in-one install is already paired with the broker beside it instead of
# asking a user to retype a QR payload from one window into another. The offer is one-use and expires in
# five minutes, exactly as `pair` prints it, so a file left behind by a client that never started is a
# dead offer rather than a standing credential.
#
# Parsed with the Bun this install just resolved rather than with awk: it is already a hard dependency of
# the thing being installed, and a JSON reader assembled from line matching would be the least trustworthy
# part of an installer whose whole posture is exact agreement.
# ---------------------------------------------------------------------------------------------------

# Where the client will look, which is not always where the broker keeps its state. On a sandboxed macOS
# client that is the container; everywhere else it is the state home the installer and broker share.
HANDOFF_HOME="$STATE_HOME"
if [ -n "$CLIENT_CONTAINER" ]; then
  HANDOFF_HOME="$CLIENT_CONTAINER/.cosyncing"
fi
PAIRING_FILE="$HANDOFF_HOME/client-pairing.json"
handoff_failed() {
  printf 'Pairing handoff: skipped — %s. Pair by hand with:\n  %s pair\n' "$1" "$APPLICATION"
}

# The state home always exists by here. A container may not: macOS creates one at the application's first
# launch, and on a first install that has not happened yet. Creating it ourselves is enough — verified on a
# real Mac, where containermanagerd ADOPTED the hand-made directory, wrote its own metadata into it, and
# the application launched and read the offer out of it. Owner-only, because that is what macOS makes it,
# and because `mkdir -p` would otherwise leave it at whatever umask this script inherited.
#
# Returns non-zero rather than failing the install: if a future macOS refuses to adopt a directory it did
# not create, this ends as every other handoff failure does — no offer written, pair by hand.
ensure_handoff_home() {
  [ -d "$HANDOFF_HOME" ] && return 0
  mkdir -p "$HANDOFF_HOME" 2>/dev/null || return 1
  [ -z "$CLIENT_CONTAINER" ] \
    || chmod 700 "$(dirname "$CLIENT_CONTAINER")" "$CLIENT_CONTAINER" 2>/dev/null \
    || true
  chmod 700 "$HANDOFF_HOME" 2>/dev/null || true
  return 0
}

if [ -n "$CLIENT_SKIP" ]; then
  # No client on this host, so no offer is created. Writing one would burn a one-use pairing that expires
  # in five minutes and that nothing here can redeem, and leave it on disk looking like a credential.
  printf 'Pairing handoff: not needed, no desktop client was installed. Pair another device with:\n  %s pair\n' \
    "$APPLICATION"
elif [ -n "$CLIENT_RUNNING" ]; then
  # The same rule as the no-client case: an offer only a startup reads, written for a client that is not
  # going to start, is a one-use credential on disk that nothing can redeem and that expires unattended.
  printf 'Pairing handoff: not written — the desktop client is already running and reads an offer only at\nstartup. Quit and reopen it, then pair with:\n  %s pair\n' \
    "$APPLICATION"
elif ! ensure_handoff_home; then
  handoff_failed "the client's own home could not be created at $HANDOFF_HOME"
elif "$BUN_BIN" "$APPLICATION" status --json > "$WORK/status.json" 2>/dev/null \
  && LISTENER_URL="$("$BUN_BIN" -e '
    const status = JSON.parse(await Bun.file(process.argv[1]).text());
    const url = status?.listener?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) process.exit(1);
    console.log(url);
  ' "$WORK/status.json" 2>/dev/null)" \
  && [ -n "$LISTENER_URL" ]
then
  if "$BUN_BIN" "$APPLICATION" pair --json --broker-url "$LISTENER_URL" > "$WORK/pairing.json" 2>/dev/null
  then
    STAGED_PAIRING="$(mktemp "$HANDOFF_HOME/.client-pairing.XXXXXXXX")"
    if "$BUN_BIN" -e '
      const offer = JSON.parse(await Bun.file(process.argv[1]).text());
      const { qr, brokerUrl, expiresAt } = offer ?? {};
      if (typeof qr !== "string" || typeof brokerUrl !== "string" || typeof expiresAt !== "string") {
        process.exit(1);
      }
      await Bun.write(process.argv[2], `${JSON.stringify({ schemaVersion: 1, qr, brokerUrl, expiresAt }, null, 2)}\n`);
    ' "$WORK/pairing.json" "$STAGED_PAIRING" 2>/dev/null
    then
      chmod 600 "$STAGED_PAIRING"
      mv "$STAGED_PAIRING" "$PAIRING_FILE"
      STAGED_PAIRING=''
      printf 'Pairing handoff: %s (one-use, expires in five minutes)\n' "$PAIRING_FILE"
    else
      rm -f "$STAGED_PAIRING"
      STAGED_PAIRING=''
      handoff_failed 'the pairing offer could not be read'
    fi
  else
    handoff_failed 'the broker did not issue a pairing offer'
  fi
else
  handoff_failed 'the broker did not report a listener URL'
fi

if [ -z "$CLIENT_SKIP" ]; then
  if [ -n "$CLIENT_RUNNING" ]; then
    printf 'Desktop client: it was already running, so the window on screen is still the previous version.\nQuit and reopen %s to use %s.\n' \
      "$CLIENT_LAUNCH" "$VERSION"
  elif [ -n "$CLIENT_CONTAINER" ]; then
    # Deliberately WITHOUT --env. COSYNCING_HOME is the only thing this client reads that variable for,
    # and pointing a sandboxed process at an absolute path outside its container just makes the read fail:
    # it would look at the state home, be denied, and report no handoff. Left alone it resolves $HOME to
    # its container, which is exactly where the offer above was written.
    if open -a "$CLIENT_LAUNCH" >/dev/null 2>&1; then
      printf 'Launched %s\n' "$CLIENT_LAUNCH"
    else
      printf 'Could not launch %s; open it from Finder.\n' "$CLIENT_LAUNCH"
    fi
  elif [ "$OS" = Darwin ]; then
    # LaunchServices starts the app with its own environment and drops the caller's, so a relocated home
    # must be handed over explicitly or the client reads ~/.cosyncing and silently finds no handoff.
    # `--env` is not on every macOS this installer supports, hence the plain retry.
    if open --env "COSYNCING_HOME=$STATE_HOME" -a "$CLIENT_LAUNCH" >/dev/null 2>&1; then
      printf 'Launched %s\n' "$CLIENT_LAUNCH"
    elif open -a "$CLIENT_LAUNCH" >/dev/null 2>&1; then
      printf 'Launched %s (without COSYNCING_HOME: this open(1) has no --env)\n' "$CLIENT_LAUNCH"
    else
      printf 'Could not launch %s; open it from Finder.\n' "$CLIENT_LAUNCH"
    fi
  else
    # Detached from every pipe: this script is usually the tail of a `curl … | sh` pipeline, and a GUI
    # holding one open would leave the operator's terminal blocked behind a window they just opened.
    #
    # This reports what it did, not that it worked. There is no success to test for: the placement step
    # above already failed closed unless the executable is there, a GUI that dies after exec does so in
    # its own process well after this script has gone, and the previous `( … & ) && printf 'Launched'`
    # claimed success unconditionally, because a subshell that backgrounds a job exits 0 whatever the job
    # does. macOS keeps a real three-way answer below because `open` asks LaunchServices and gets one.
    "$CLIENT_LAUNCH" >/dev/null 2>&1 </dev/null &
    printf 'Started %s\nIf no window appears, start it from your applications menu.\n' "$CLIENT_LAUNCH"
  fi
fi
