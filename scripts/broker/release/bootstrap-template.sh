#!/usr/bin/env bash
set -eu

umask 077

VERSION='@VERSION@'
BASE_URL='@BASE_URL@'
KEY_ID='@KEY_ID@'
PUBLIC_KEY_B64='@PUBLIC_KEY_B64@'
# One row per published artifact: "<target> <sha256> <size>".
ARTIFACT_TABLE='@ARTIFACT_TABLE@'

fail() {
  printf 'cosyncing install: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -ne 0 ] || fail 'refusing a root install; run this as the target user'

for command in curl openssl base64 uname stat mktemp awk sed; do
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

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64|Linux/amd64) TARGET='linux-x64' ;;
  Linux/aarch64|Linux/arm64) TARGET='linux-arm64' ;;
  Darwin/arm64) TARGET='darwin-arm64' ;;
  Darwin/x86_64) fail 'only Apple Silicon macOS is supported; Intel Macs are out of scope' ;;
  MINGW*/*|MSYS*/*|CYGWIN*/*) fail 'native Windows is a named near-term follow-up; use the documented WSL subset for v1' ;;
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
case "$STATE_HOME" in
  *$'\n'*|*$'\r'*) fail 'state path contains a line break' ;;
esac

INSTALL_DIR="$STATE_HOME/bin"
BINARY="$INSTALL_DIR/cosyncing"
ALIAS="$INSTALL_DIR/cosy"
RECEIPT="$STATE_HOME/bootstrap-receipt"
ASSET="cosyncing-$TARGET"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cosyncing-install.XXXXXXXX")"
STAGED_BINARY=''
STAGED_RECEIPT=''
cleanup() {
  rm -rf "$WORK"
  [ -z "$STAGED_BINARY" ] || rm -f "$STAGED_BINARY"
  [ -z "$STAGED_RECEIPT" ] || rm -f "$STAGED_RECEIPT"
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
EXPECTED_ROW="$(printf '%s\n' "$ARTIFACT_TABLE" | awk -v t="$TARGET" '$1 == t { if (seen++) exit 2; print }')" \
  || fail 'embedded artifact table contains duplicate rows'
[ -n "$EXPECTED_ROW" ] || fail "this installer carries no artifact for $TARGET"
EXPECTED="$(printf '%s\n' "$EXPECTED_ROW" | awk '{print $2}')"
EXPECTED_SIZE="$(printf '%s\n' "$EXPECTED_ROW" | awk '{print $3}')"
[ "${#EXPECTED}" -eq 64 ] || fail 'embedded artifact checksum is malformed'
case "$EXPECTED" in *[!0-9a-f]*) fail 'embedded artifact checksum is malformed' ;; esac
case "$EXPECTED_SIZE" in ''|*[!0-9]*) fail 'embedded artifact size is malformed' ;; esac

printf '%s' "$PUBLIC_KEY_B64" | base64 --decode > "$WORK/release-key.pem" \
  || fail 'embedded release key is invalid'

# Ed25519 signature verification is attempted, and REQUIRED wherever the local openssl can do it. Stock
# macOS ships LibreSSL, which cannot load an Ed25519 SPKI key at all (no flag changes that), so requiring it
# unconditionally would make the installer impossible to run there. Probe the capability, never the platform:
# a Mac with real OpenSSL on PATH gets the full check, and a Linux box somehow lacking it degrades the same
# way. Signature FAILURE is always fatal; only genuine inability to verify degrades.
SIGNATURE_STATE='skipped (this openssl cannot verify Ed25519)'
if openssl pkey -pubin -in "$WORK/release-key.pem" -noout >/dev/null 2>&1; then
  download 'release-manifest.json' "$WORK/release-manifest.json"
  download 'release-manifest.json.sig' "$WORK/release-manifest.json.sig"
  download 'SHA256SUMS' "$WORK/SHA256SUMS"
  download 'SHA256SUMS.sig' "$WORK/SHA256SUMS.sig"

  openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
    -in "$WORK/release-manifest.json" -sigfile "$WORK/release-manifest.json.sig" >/dev/null 2>&1 \
    || fail 'release manifest signature verification failed'
  openssl pkeyutl -verify -pubin -inkey "$WORK/release-key.pem" -rawin \
    -in "$WORK/SHA256SUMS" -sigfile "$WORK/SHA256SUMS.sig" >/dev/null 2>&1 \
    || fail 'checksum-list signature verification failed'

  grep -Fq "\"version\": \"$VERSION\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest version does not match this pinned installer'
  grep -Fq "\"keyId\": \"$KEY_ID\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest key id does not match this pinned installer'
  grep -Fq "\"name\": \"$ASSET\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest does not contain this host artifact'

  SIGNED="$(awk -v asset="$ASSET" '$2 == asset { if (seen++) exit 2; print $1 }' "$WORK/SHA256SUMS")" \
    || fail 'checksum list contains duplicate artifact rows'
  [ "${#SIGNED}" -eq 64 ] || fail 'artifact checksum is missing or malformed'
  grep -Fq "\"sha256\": \"$SIGNED\"" "$WORK/release-manifest.json" \
    || fail 'signed manifest and checksum list disagree'
  # The signed chain and the baked-in table must name the same bytes, or one of the two was tampered with.
  [ "$SIGNED" = "$EXPECTED" ] \
    || fail 'signed checksum list disagrees with the digest embedded in this installer'
  SIGNATURE_STATE='verified (Ed25519 over the signed release manifest and checksum list)'
fi

download "$ASSET" "$WORK/$ASSET"
ACTUAL="$(sha256_of "$WORK/$ASSET")"
ACTUAL_SIZE="$(wc -c < "$WORK/$ASSET" | tr -d ' ')"
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || fail 'artifact size does not match this installer'
[ "$ACTUAL" = "$EXPECTED" ] || fail 'artifact checksum verification failed'
chmod 700 "$WORK/$ASSET"
VERSION_JSON="$("$WORK/$ASSET" version --json)" || fail 'verified artifact did not run its offline version check'
printf '%s\n' "$VERSION_JSON" | grep -Fq "\"version\": \"$VERSION\"" \
  || fail 'verified artifact reports the wrong version'
printf '%s\n' "$VERSION_JSON" | grep -Fq "\"target\": \"$TARGET\"" \
  || fail 'verified artifact reports the wrong target'
printf '%s\n' "$VERSION_JSON" | grep -Fq '"packaged": true' \
  || fail 'verified artifact is not a packaged build'

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

if [ -e "$BINARY" ] || [ -L "$BINARY" ]; then
  [ -f "$BINARY" ] && [ ! -L "$BINARY" ] || fail 'existing cosyncing binary is not a safe regular file'
  [ "$(stat_owner "$BINARY")" = "$(id -u)" ] || fail 'existing cosyncing binary is not owned by this user'
  [ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] || fail 'existing binary has no safe bootstrap ownership receipt'
  [ "$(stat_owner "$RECEIPT")" = "$(id -u)" ] || fail 'existing bootstrap receipt is not owned by this user'
  grep -Fxq 'schemaVersion=1' "$RECEIPT" || fail 'existing bootstrap receipt is invalid'
  grep -Fxq 'product=cosyncing' "$RECEIPT" || fail 'existing bootstrap receipt is for another product'
  grep -Fxq "binary=$BINARY" "$RECEIPT" || fail 'existing bootstrap receipt names another binary'
  PRIOR="$(sed -n 's/^sha256=//p' "$RECEIPT")"
  [ "${#PRIOR}" -eq 64 ] || fail 'existing bootstrap receipt checksum is invalid'
  [ "$(sha256_of "$BINARY")" = "$PRIOR" ] \
    || fail 'existing binary differs from its bootstrap ownership receipt'
fi

if [ -e "$ALIAS" ] || [ -L "$ALIAS" ]; then
  [ -L "$ALIAS" ] && [ "$(readlink "$ALIAS")" = 'cosyncing' ] \
    || fail 'refusing to replace an unowned cosy path'
fi

STAGED_BINARY="$(mktemp "$INSTALL_DIR/.cosyncing.install.XXXXXXXX")"
STAGED_RECEIPT="$(mktemp "$STATE_HOME/.bootstrap-receipt.XXXXXXXX")"
cp "$WORK/$ASSET" "$STAGED_BINARY"
chmod 755 "$STAGED_BINARY"
{
  printf 'schemaVersion=1\n'
  printf 'product=cosyncing\n'
  printf 'version=%s\n' "$VERSION"
  printf 'target=%s\n' "$TARGET"
  printf 'binary=%s\n' "$BINARY"
  printf 'sha256=%s\n' "$ACTUAL"
} > "$STAGED_RECEIPT"
chmod 600 "$STAGED_RECEIPT"
mv "$STAGED_BINARY" "$BINARY"
mv "$STAGED_RECEIPT" "$RECEIPT"
[ -L "$ALIAS" ] || ln -s 'cosyncing' "$ALIAS"

printf 'Installed cosyncing %s (%s) at %s\n' "$VERSION" "$TARGET" "$BINARY"
printf 'Artifact digest: matched the sha256 embedded in this installer.\n'
printf 'Release signature: %s\n' "$SIGNATURE_STATE"
case "$SIGNATURE_STATE" in
  skipped*)
    printf 'This installer was itself delivered over TLS and carries the expected digest; the broker\n'
    printf 'still verifies every future upgrade with its own built-in Ed25519 check.\n' ;;
esac
printf 'PATH was not changed. Run setup with the absolute command:\n  %s setup\n' "$BINARY"
