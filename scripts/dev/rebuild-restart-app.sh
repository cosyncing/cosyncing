#!/usr/bin/env bash
#
# Build the review artifacts, replace this checkout's local broker, and verify
# that the newly served client and broker carry one contract identity.
#
# Default:
#   bun run app:rebuild-restart
#
# Restart and verify the existing artifacts without rebuilding:
#   bun run app:rebuild-restart --restart-only
#
# Review-specific overrides deliberately do not reuse PORT, HOST, or
# COSYNCING_HOME. Codex/test processes can export fixture values for those
# generic names, and inheriting them previously launched the review broker on a
# temporary port and state directory.

set -Eeuo pipefail

readonly SCRIPT_NAME="${0##*/}"
readonly REPO_ROOT="$(pwd -P)"
readonly REVIEW_PORT="${COSYNCING_REVIEW_PORT:-17734}"
readonly INSTALLED_BROKER_PORT=7734
readonly REVIEW_HOST="${COSYNCING_REVIEW_HOST:-127.0.0.1}"
readonly REVIEW_STATE_HOME="${COSYNCING_REVIEW_STATE_HOME:-${REPO_ROOT}/output/review/state}"
readonly REVIEW_CACHE_DIR="${COSYNCING_REVIEW_CACHE_DIR:-${REPO_ROOT}/output/review/cache}"
readonly WEB_ROOT="${REPO_ROOT}/apps/client/build/web"
readonly LOG_DIR="${REPO_ROOT}/output/broker"
readonly LOG_FILE="${LOG_DIR}/broker.log"
readonly PID_FILE="${LOG_DIR}/review-broker.pid"
readonly HEALTH_URL="http://${REVIEW_HOST}:${REVIEW_PORT}/api/health"
readonly APP_URL="http://${REVIEW_HOST}:${REVIEW_PORT}/cosy/"

build_artifacts=true
started_pid=""
startup_complete=false
app_probe=""
health_probe=""

usage() {
  echo "Usage: bash scripts/dev/${SCRIPT_NAME} [--restart-only]"
  echo
  echo "Builds the broker and release web client, restarts this checkout's"
  echo "local review broker, and verifies health, contract identity, and /cosy/."
  echo
  echo "Options:"
  echo "  --restart-only  Restart and verify existing artifacts without rebuilding."
  echo "  -h, --help      Show this help."
  echo
  echo "Optional review overrides:"
  echo "  COSYNCING_REVIEW_HOST       Default: 127.0.0.1"
  echo "  COSYNCING_REVIEW_PORT       Default: 17734"
  echo "  COSYNCING_REVIEW_STATE_HOME Default: <repo>/output/review/state"
  echo "  COSYNCING_REVIEW_CACHE_DIR  Default: <repo>/output/review/cache"
}

die() {
  echo "${SCRIPT_NAME}: $*" >&2
  exit 1
}

step() {
  echo
  echo "==> $*"
}

cleanup() {
  local exit_code=$?
  if [[ -n "${app_probe}" ]]; then
    rm -f -- "${app_probe}"
  fi
  if [[ -n "${health_probe}" ]]; then
    rm -f -- "${health_probe}"
  fi
  if [[ ${exit_code} -ne 0 && -n "${started_pid}" && "${startup_complete}" != true ]]; then
    kill -TERM -- "-${started_pid}" 2>/dev/null || true
    rm -f -- "${PID_FILE}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

for arg in "$@"; do
  case "${arg}" in
    --restart-only)
      build_artifacts=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: ${arg}"
      ;;
  esac
done

[[ -f "${REPO_ROOT}/package.json" ]] ||
  die "run this command from the cosyncing repository root"
[[ -f "${REPO_ROOT}/scripts/dev/${SCRIPT_NAME}" ]] ||
  die "run this command from the cosyncing repository root"
[[ "${REVIEW_PORT}" =~ ^[0-9]+$ ]] ||
  die "COSYNCING_REVIEW_PORT must be an integer"
(( REVIEW_PORT >= 1 && REVIEW_PORT <= 65535 )) ||
  die "COSYNCING_REVIEW_PORT must be between 1 and 65535"
(( REVIEW_PORT != INSTALLED_BROKER_PORT )) ||
  die "COSYNCING_REVIEW_PORT cannot use installed broker port ${INSTALLED_BROKER_PORT}; managed Codex and OpenCode runtimes are not isolated"
[[ "${REVIEW_STATE_HOME}" = /* ]] ||
  die "COSYNCING_REVIEW_STATE_HOME must be absolute"
[[ "${REVIEW_CACHE_DIR}" = /* ]] ||
  die "COSYNCING_REVIEW_CACHE_DIR must be absolute"

for command in bun curl jq ps readlink setsid ss; do
  command -v "${command}" >/dev/null 2>&1 ||
    die "required command not found: ${command}"
done

listener_pids_for_port() {
  local port="$1"
  ss -H -ltnp "sport = :${port}" 2>/dev/null |
    sed -nE 's/.*pid=([0-9]+).*/\1/p' |
    sort -u
}

listener_pids() {
  listener_pids_for_port "${REVIEW_PORT}"
}

assert_no_installed_broker_collision() {
  if [[ -n "$(ss -H -ltn "sport = :${INSTALLED_BROKER_PORT}" 2>/dev/null)" ]]; then
    die "refusing review startup while port ${INSTALLED_BROKER_PORT} has an active listener; stop the installed cosyncing broker first because review and installed brokers share managed Codex and OpenCode runtimes"
  fi
}

process_belongs_to_checkout() {
  local pid="$1"
  local cwd
  local command_line
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" || return 1
  command_line="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  [[ "${cwd}" == "${REPO_ROOT}" ]] || return 1
  [[ "${command_line}" == *"packages/typescript/broker/src/cli/cli.ts broker"* ||
    "${command_line}" == *"bun run broker"* ]]
}

process_group_for() {
  local pid="$1"
  ps -o pgid= -p "${pid}" | tr -d ' '
}

wait_for_port_to_close() {
  local attempt
  for attempt in $(seq 1 50); do
    if [[ -z "$(listener_pids)" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

assert_no_active_opencode_turns() {
  local roster
  local active
  local active_count
  roster="$(curl -fsS --max-time 30 \
    "http://${REVIEW_HOST}:${REVIEW_PORT}/api/sessions?window=all&refresh=1")" ||
    die "could not verify whether the broker owns an active OpenCode turn; refusing restart"
  active="$(jq -ce '
    if (.sessions | type) != "array" then
      error("broker roster response has no sessions array")
    else
      [.sessions[] | select(
        .tool == "opencode" and
        (.status == "working" or .status == "needs-input")
      ) | {title, cwd, status, nativeId}]
    end
  ' <<<"${roster}")" ||
    die "could not validate the broker roster before restart; refusing restart"
  active_count="$(jq -r 'length' <<<"${active}")"
  if (( active_count == 0 )); then
    return 0
  fi

  echo "Active broker-owned OpenCode sessions:" >&2
  jq -r '.[] | "  - \(.title // .nativeId // "unnamed") [\(.status)] \(.cwd // "")"' \
    <<<"${active}" >&2
  die "refusing to restart while ${active_count} OpenCode session(s) are active; finish or cancel them first"
}

stop_review_broker() {
  local candidates=()
  local pid
  local pgid
  local pid_file_value=""

  mapfile -t candidates < <(listener_pids)
  if [[ ${#candidates[@]} -eq 0 && -f "${PID_FILE}" ]]; then
    pid_file_value="$(tr -d '[:space:]' <"${PID_FILE}")"
    if [[ "${pid_file_value}" =~ ^[0-9]+$ ]] && kill -0 "${pid_file_value}" 2>/dev/null; then
      candidates=("${pid_file_value}")
    else
      rm -f -- "${PID_FILE}"
    fi
  fi
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No broker is listening on ${REVIEW_HOST}:${REVIEW_PORT}."
    return 0
  fi

  local groups=()
  for pid in "${candidates[@]}"; do
    process_belongs_to_checkout "${pid}" ||
      die "refusing to stop PID ${pid} on port ${REVIEW_PORT}; it is not this checkout's source broker"
    pgid="$(process_group_for "${pid}")"
    [[ "${pgid}" =~ ^[0-9]+$ ]] ||
      die "could not resolve the process group for broker PID ${pid}"
    if [[ ! " ${groups[*]} " =~ [[:space:]]${pgid}[[:space:]] ]]; then
      groups+=("${pgid}")
    fi
  done
  [[ ${#groups[@]} -eq 1 ]] ||
    die "refusing to stop multiple broker process groups on port ${REVIEW_PORT}"

  # The broker owns its managed `opencode serve`. Stopping the broker also stops that server, so an
  # attached terminal can survive while its in-flight model turn is silently destroyed. Verify the
  # live roster immediately before SIGTERM and fail closed on probe/shape errors.
  assert_no_active_opencode_turns

  echo "Stopping broker process group ${groups[0]}..."
  kill -TERM -- "-${groups[0]}"
  wait_for_port_to_close ||
    die "broker did not release port ${REVIEW_PORT} after SIGTERM"
  rm -f -- "${PID_FILE}"
}

start_review_broker() {
  mkdir -p -- "${LOG_DIR}" "${REVIEW_STATE_HOME}" "${REVIEW_CACHE_DIR}"
  printf '\n[%s] review rebuild/restart\n' "$(date --iso-8601=seconds)" >>"${LOG_FILE}"

  # The broker may be launched from a Codex app-server whose environment came
  # from an isolated acceptance fixture. Remove every fixture-sensitive
  # override, then set only the explicit review values below.
  setsid env \
    -u PORT \
    -u HOST \
    -u COSYNCING_TOKEN \
    -u COSYNCING_BROKER \
    -u COSYNCING_ADVERTISED_BROKER \
    -u COSYNCING_WEB_DIR \
    -u COSYNCING_CODEX_REMOTE_ADDR \
    -u COSYNCING_CODEX_APP_SERVER_SOCK \
    -u COSYNCING_CODEX_SYNC_SERVER \
    -u COSYNCING_OPENCODE_NO_AUTOSERVE \
    -u COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE \
    -u OPENCODE_URL \
    -u COSYNCING_BROKER_BUILD_VERSION \
    PORT="${REVIEW_PORT}" \
    COSYNCING_HOME="${REVIEW_STATE_HOME}" \
    COSYNCING_CACHE_DIR="${REVIEW_CACHE_DIR}" \
    COSYNCING_WEB_DIR="${WEB_ROOT}" \
    bun run broker >>"${LOG_FILE}" 2>&1 </dev/null &
  started_pid="$!"
  printf '%s\n' "${started_pid}" >"${PID_FILE}"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 1 "${HEALTH_URL}" >"${health_probe}" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "${started_pid}" 2>/dev/null; then
      echo "Broker exited before becoming healthy. Recent log:" >&2
      tail -n 100 "${LOG_FILE}" >&2
      return 1
    fi
    sleep 0.25
  done
  echo "Broker did not become healthy. Recent log:" >&2
  tail -n 100 "${LOG_FILE}" >&2
  return 1
}

verify_contract_identity() {
  local expected_revision
  local expected_hash
  expected_revision="$(
    sed -nE \
      's/^const int cosyncingClientContractRevision = ([0-9]+);$/\1/p' \
      packages/dart/broker_contract/lib/src/models/generated_contract_identity.dart
  )"
  expected_hash="$(
    sed -nE \
      "s/^const String cosyncingClientContractSurfaceHash = '([^']+)';$/\\1/p" \
      packages/dart/broker_contract/lib/src/models/generated_contract_identity.dart
  )"
  [[ -n "${expected_revision}" && -n "${expected_hash}" ]] ||
    die "could not read the generated client contract identity"

  jq -e \
    --argjson revision "${expected_revision}" \
    --arg hash "${expected_hash}" \
    '.ok == true and .healthStatus == "healthy" and
     .contract.revision == $revision and .contract.surfaceHash == $hash' \
    "${health_probe}" >/dev/null ||
    die "served broker contract does not match the generated client identity"
}

verify_served_app() {
  curl -fsS --max-time 10 "${APP_URL}" >"${app_probe}" ||
    die "the broker did not serve ${APP_URL}"
  grep -F '<base href="/cosy/">' "${app_probe}" >/dev/null ||
    die "served index.html does not use the /cosy/ base href"
  grep -F 'flutter_bootstrap.js' "${app_probe}" >/dev/null ||
    die "served index.html does not load flutter_bootstrap.js"
  for asset in version.json flutter_service_worker.js main.dart.js; do
    curl -fsS --max-time 10 -o /dev/null "${APP_URL}${asset}" ||
      die "served client asset is missing: ${asset}"
  done
}

# State/cache/port isolation is insufficient while both brokers can still own the same managed agent
# runtimes. Refuse before builds, process stops, directory creation, or any other review mutation.
assert_no_installed_broker_collision

if "${build_artifacts}"; then
  step "Build broker"
  bun run build:broker

  step "Build release web client"
  bun run client:build:web
else
  step "Use existing build artifacts"
  [[ -f "${WEB_ROOT}/index.html" && -f "${WEB_ROOT}/main.dart.js" ]] ||
    die "web build is missing; rerun without --restart-only"
  [[ -x "${REPO_ROOT}/output/cosyncing/cosyncing" ]] ||
    die "broker build is missing; rerun without --restart-only"
fi

app_probe="$(mktemp)"
health_probe="$(mktemp)"

step "Restart local review broker"
stop_review_broker
start_review_broker
wait_for_health
verify_contract_identity
verify_served_app
startup_complete=true

step "Ready for physical review"
jq '{ok, version, contract, machine, healthStatus, controlMode, codexSyncServer}' \
  "${health_probe}"
echo "App: ${APP_URL}"
echo "Broker PID: ${started_pid}"
echo "Log: ${LOG_FILE}"
echo "If an existing tab is open, hard-refresh it once with Ctrl+Shift+R."
