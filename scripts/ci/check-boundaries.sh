#!/usr/bin/env bash
set -euo pipefail

failed=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failed=1
}

reject_match() {
  local pattern="$1"
  shift
  if rg -n "$pattern" "$@"; then
    fail "forbidden match: $pattern"
  fi
}

reject_fixed() {
  local pattern="$1"
  shift
  if rg -n -F "$pattern" "$@"; then
    fail "forbidden match: $pattern"
  fi
}

references_sessions_facade() {
  local file="$1"
  rg -U -q \
    "^[[:space:]]*(import|export)[^;]*['\"]([^'\"]*/)?sessions\\.dart['\"][^;]*;" \
    "$file"
}

uses_forbidden_flutter_transport() {
  local file="$1"
  if rg -q "(package:dio|web_socket_channel)" "$file"; then
    return 0
  fi
  if rg -U -q \
    "^[[:space:]]*import[^;]*['\"]dart:io['\"][^;]*;" "$file" \
    && rg -q "\\bWebSocket\\b" "$file"; then
    return 0
  fi
  return 1
}

check_flutter_transport_file() {
  local file="$1"
  uses_forbidden_flutter_transport "$file" \
    && fail "$file uses a raw Dio/WebSocket API across the Flutter platform boundary"
  return 0
}

boundary_probe_dir="$(mktemp -d /tmp/cosyncing-boundary-probe.XXXXXX)"
cleanup_boundary_probes() {
  rm -f -- \
    "$boundary_probe_dir/facade-import.dart" \
    "$boundary_probe_dir/facade-export.dart" \
    "$boundary_probe_dir/facade-conditional-import.dart" \
    "$boundary_probe_dir/unrelated.dart" \
    "$boundary_probe_dir/websocket.dart" \
    "$boundary_probe_dir/websocket-conditional-import.dart" \
    "$boundary_probe_dir/file.dart" \
    "$boundary_probe_dir/file-conditional-import.dart"
  rmdir -- "$boundary_probe_dir"
}
trap cleanup_boundary_probes EXIT
printf "import\n  '../../sessions.dart';\n" > "$boundary_probe_dir/facade-import.dart"
printf "export '../sessions.dart';\n" > "$boundary_probe_dir/facade-export.dart"
printf "import 'stub.dart'\n    if (dart.library.io) '../sessions.dart';\n" \
  > "$boundary_probe_dir/facade-conditional-import.dart"
printf "import '../session_state.dart';\n" > "$boundary_probe_dir/unrelated.dart"
printf "import 'dart:io';\nFuture<void> connect() => WebSocket.connect('ws://fixture');\n" \
  > "$boundary_probe_dir/websocket.dart"
printf "import 'stub.dart'\n    if (dart.library.io) 'dart:io';\nFuture<void> connect() => WebSocket.connect('ws://fixture');\n" \
  > "$boundary_probe_dir/websocket-conditional-import.dart"
printf "import 'dart:io';\nFile openFixture() => File('fixture');\n" \
  > "$boundary_probe_dir/file.dart"
printf "import 'stub.dart'\n    if (dart.library.io) 'dart:io';\nFile openFixture() => File('fixture');\n" \
  > "$boundary_probe_dir/file-conditional-import.dart"

if ! references_sessions_facade "$boundary_probe_dir/facade-import.dart"; then
  fail "Sessions facade rule does not reject a multiline relative import"
fi
if ! references_sessions_facade "$boundary_probe_dir/facade-export.dart"; then
  fail "Sessions facade rule does not reject a relative export"
fi
if ! references_sessions_facade "$boundary_probe_dir/facade-conditional-import.dart"; then
  fail "Sessions facade rule does not reject a conditional relative import"
fi
if references_sessions_facade "$boundary_probe_dir/unrelated.dart"; then
  fail "Sessions facade rule rejects an unrelated module"
fi
if ! uses_forbidden_flutter_transport "$boundary_probe_dir/websocket.dart"; then
  fail "Flutter transport rule does not reject multiline dart:io WebSocket use"
fi
if ! uses_forbidden_flutter_transport "$boundary_probe_dir/websocket-conditional-import.dart"; then
  fail "Flutter transport rule does not reject conditional dart:io WebSocket use"
fi
if uses_forbidden_flutter_transport "$boundary_probe_dir/file.dart"; then
  fail "Flutter transport rule rejects non-WebSocket dart:io use"
fi
if uses_forbidden_flutter_transport "$boundary_probe_dir/file-conditional-import.dart"; then
  fail "Flutter transport rule rejects conditional non-WebSocket dart:io use"
fi
cleanup_boundary_probes
trap - EXIT

for path in packages/typescript/core packages/typescript/wire; do
  [[ ! -e "$path" ]] || fail "legacy package remains: $path"
done

reject_match '@cosyncing/(core|wire)' \
  packages scripts apps/client/lib apps/client/test --glob '!contracts/generated/**' \
  --glob '!scripts/ci/check-boundaries.sh'
reject_match 'packages/typescript/(core|wire)' \
  packages scripts apps/client/lib apps/client/test --glob '!contracts/generated/**' \
  --glob '!scripts/ci/check-boundaries.sh'
reject_match "from ['\"]\.\./\.\./[^'\"]+/src" packages/typescript --glob '**/src/**'
reject_match "from ['\"](@cosyncing/adapter-api|bun|node:(fs|process|child_process))" \
  packages/typescript/protocol
reject_match '\b(Bun|process)\.' packages/typescript/protocol
reject_match "(from[[:space:]]+['\"]|import[[:space:]]*\(['\"])(@cosyncing/broker|[^'\"]*packages/typescript/broker|[^'\"]*/broker/src/)" \
  packages/typescript/adapter-api
reject_match "(from[[:space:]]+['\"]|import[[:space:]]*\(['\"])(@cosyncing/broker|[^'\"]*packages/typescript/broker|[^'\"]*/broker/src/)" \
  packages/typescript/adapters --glob '**/src/**'

while IFS= read -r file; do
  check_flutter_transport_file "$file"
done < <(rg --files apps/client/lib/src/features --glob '**/view/*.dart')

while IFS= read -r file; do
  check_flutter_transport_file "$file"
  if [[ "$file" != "apps/client/lib/src/features/sessions/sessions.dart" ]] \
    && references_sessions_facade "$file"; then
    fail "$file imports or exports the public Sessions facade from inside the feature"
  fi
done < <(rg --files apps/client/lib/src/features/sessions --glob '*.dart')

adapter_packages=(packages/typescript/adapters/*/package.json)
for package in "${adapter_packages[@]}"; do
  adapter_root="${package%/package.json}"
  rg -q '"@cosyncing/adapter-api": "workspace:\*"' "$package" \
    || fail "$package does not depend on adapter-api"
  adapter_name="$(bun -e "const value = await Bun.file('$package').json(); process.stdout.write(value.name ?? '')")"
  [[ -n "$adapter_name" ]] || fail "$package does not declare a package name"
  reject_fixed "$adapter_name" packages/typescript/adapter-api
  if bun -e "const value = await Bun.file('$package').json(); const dependencies = { ...value.dependencies, ...value.devDependencies, ...value.peerDependencies, ...value.optionalDependencies }; process.exit(dependencies['@cosyncing/broker'] ? 0 : 1)"; then
    fail "$package must not depend on @cosyncing/broker"
  fi
  for other_package in "${adapter_packages[@]}"; do
    [[ "$other_package" != "$package" ]] || continue
    other_root="${other_package%/package.json}"
    other_slug="${other_root##*/}"
    other_name="$(bun -e "const value = await Bun.file('$other_package').json(); process.stdout.write(value.name ?? '')")"
    [[ -n "$other_name" ]] || {
      fail "$other_package does not declare a package name"
      continue
    }
    if bun -e "const value = await Bun.file('$package').json(); const dependencies = { ...value.dependencies, ...value.devDependencies, ...value.peerDependencies, ...value.optionalDependencies }; process.exit(dependencies['$other_name'] ? 0 : 1)"; then
      fail "$package must not depend on sibling adapter $other_name"
    fi
    reject_fixed "$other_name" "$adapter_root" --glob '*.ts' --glob 'package.json'
    reject_fixed "/$other_slug/src/" "$adapter_root" --glob '*.ts'
    reject_fixed "adapters/$other_slug/" "$adapter_root" --glob '*.ts'
  done
done

unexpected_adapter_api_dependencies="$(bun -e "const value = await Bun.file('packages/typescript/adapter-api/package.json').json(); const dependencies = { ...value.dependencies, ...value.devDependencies, ...value.peerDependencies, ...value.optionalDependencies }; process.stdout.write(Object.keys(dependencies).filter((name) => name !== '@cosyncing/protocol').sort().join(' '))")"
[[ -z "$unexpected_adapter_api_dependencies" ]] \
  || fail "adapter-api has dependencies outside its allowlist: $unexpected_adapter_api_dependencies"

for dependency in crypto transport transport-wire; do
  rg -q "\"@cosyncing/$dependency\": \"workspace:\*\"" packages/typescript/broker/package.json \
    || fail "broker package does not declare @cosyncing/$dependency"
done

if (( failed != 0 )); then
  exit 1
fi

printf 'PASS: package dependency and platform boundaries hold.\n'
