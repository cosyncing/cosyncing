#!/usr/bin/env bash
#
# One reproducible run of the release screenshot campaign.
#
#   bash scripts/dev/run-store-capture.sh
#
# Seed a fictitious world, let a broker settle it, prove the broker can see nothing else, capture
# the real app in each listing locale, compose the store frames, prove the product pixels survived,
# and publish the whole set — see the publish note below for what "publish" means here.
#
# Nothing here needs a privileged directory, a shared path, or a pre-existing fixture. The world it
# invents — HOME, agent state, broker state, and the working directories the sessions refer to —
# lives under one unique root that this script creates and removes. A campaign that only reproduces
# on the machine somebody ran `sudo` on is not reproducible.
#
# The fixture broker is credentialed, like a real one, and the capture enters that credential
# through the app's own enrolment gate. Not decoration: the broker refuses a Drive attach to a
# client that cannot prove a credential, so on a token-less broker the app can only ever observe —
# and the approval frame would have nothing to approve.
#
# The fixture broker starts from an EMPTY environment (`env -i`) plus an explicit whitelist and the
# fixture's own variables, and the first start proves it out of a deliberately poisoned shell. The
# broker and its adapters read far more variables than the fixture sets, so anything inherited would
# outrank it — a stray COSYNCING_PI_SESSIONS_ROOT or COSYNCING_MACHINE_PEERS is a roster from
# somewhere real, appearing in a published screenshot.
#
# The publish is transactional on purpose — not a single atomic rename, but two renames with a
# rollback: the accepted campaign is moved aside, the new one is moved in, and only then is the old
# one deleted. If either step fails or the run is interrupted, the previous campaign is restored.
# Writing frames into the live directory as they succeed is how a stale image from an earlier run
# survives a later partial one, wearing a current timestamp; every frame must succeed before
# anything is visible.
#
# The fixture broker deliberately does NOT reuse the port, state home, or cache directory that
# `bun run app:rebuild-restart` owns. It is a throwaway broker over throwaway state, and it must
# never be mistaken for, or collide with, a review broker.
#
# Expect roughly an hour with --skip-build. Each frame runs in its own browser context, which is
# what stops one frame inheriting the previous frame's open session tabs, and costs a cold load of
# the CanvasKit bundle every time. It is not hung; frames print as they land.
#
# Options:
#   --port N        fixture broker port (default 7745)
#   --skip-build    reuse the existing apps/client/build/web
#   --keep-fixture  leave the fixture root on disk for inspection (the broker is always stopped)

set -Eeuo pipefail

# Resolved, not entered: this script never changes the working directory, so every path it uses is
# spelled out from here.
readonly REPO_ROOT="$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/../..")"

PORT=7745
SKIP_BUILD=false
KEEP_FIXTURE=false
readonly LOCALES=(en zh-CN)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --keep-fixture) KEEP_FIXTURE=true; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

readonly LIVE="${REPO_ROOT}/output/brand/store"
readonly LOG_DIR="${REPO_ROOT}/output/brand/logs"
mkdir -p "${LOG_DIR}"
# mktemp rather than a PID-derived name: PIDs are reused, and a staging directory that already has
# files in it publishes somebody else's leftovers as this run's campaign.
STAGE="$(mktemp -d "${REPO_ROOT}/output/brand/.store-staging-XXXXXX")"
RETIRED=""

FIXTURE_ROOT=""
FIXTURE_ROOT_OWNED=false
# Written by seed-brand-fixture.ts into every root it seeds. Keep the two in step.
readonly FIXTURE_SENTINEL=".brand-fixture-root"
BROKER_PGID=""
BROKER_PID=""
HOLDER_PID=""
PORT_FILE=""

# Everything the fixture broker is allowed to have that the fixture itself does not set.
#
# The broker and its adapters read dozens of COSYNCING_*, PI_*, OPENCODE_* and XDG_* variables; the
# fixture sets seventeen. Anything else present in this shell used to reach the broker untouched —
# COSYNCING_PI_SESSIONS_ROOT would outrank the fixture's Pi directory, COSYNCING_MACHINE_PEERS would
# add whole rosters from other machines — so the broker is started from an EMPTY environment and
# given only this list plus the fixture's own. A capture is a published artifact; "the maintainer's
# shell happened to be clean" is not a property of the pipeline.
readonly ENV_PASSTHROUGH=(PATH LANG LC_ALL TZ)
# Set by the launcher itself, or by bash and bun on the way in.
readonly ENV_LAUNCHER=(PORT HOST COSYNCING_WEB_DIR PWD SHLVL _ OLDPWD)

# Describe whatever is holding the port, so a human can decide. Deliberately does NOT kill it.
report_port_holder() {
  local pid
  echo "port ${PORT} is still in use after the fixture broker was asked to stop:" >&2
  for pid in $(ss -H -ltnp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do
    echo "  pid ${pid}  cwd=$(readlink "/proc/${pid}/cwd" 2>/dev/null || echo '?')" >&2
    echo "    cmd=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || echo '?')" >&2
  done
  echo "This script only stops the broker it started; nothing else is signalled." >&2
}

# The broker runs in its own process group, and that group is the only thing this script ever
# terminates. Killing "whatever holds the port" would be a kill without ownership: between the
# broker exiting and the check, an unrelated process can bind the same number.
stop_broker() {
  [[ -n "${BROKER_PGID}" ]] || return 0
  local pgid="${BROKER_PGID}"
  BROKER_PGID=""
  kill -TERM -- "-${pgid}" 2>/dev/null || true
  # Wait for the PROCESS to be gone, not for the port to be free. A broker that has closed its
  # listener is still flushing state, and it recreates its home directory on the way out — which is
  # how a fixture root deleted by this trap came back a second later.
  local waited
  for waited in $(seq 1 30); do
    kill -0 -- "-${pgid}" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 -- "-${pgid}" 2>/dev/null; then
    kill -KILL -- "-${pgid}" 2>/dev/null || true
    for waited in $(seq 1 20); do
      kill -0 -- "-${pgid}" 2>/dev/null || break
      sleep 0.5
    done
  fi
  ss -H -ltn "sport = :${PORT}" 2>/dev/null | grep -q . || return 0
  report_port_holder
  return 1
}

# Remove the fixture root — and nothing else, ever.
#
# `rm -rf` is only as safe as the path it is given, and this one used to be whatever the seeder
# printed on stdout. Two conditions now have to hold: this run created the directory itself, and the
# seeder's sentinel is still in it. Neither is true of a home directory, a checkout, or a path
# inherited from an environment that outlived an earlier run, so all of those survive being wrong.
remove_fixture_root() {
  local root="${FIXTURE_ROOT}"
  [[ -n "${root}" && -d "${root}" ]] || return 0
  if [[ "${FIXTURE_ROOT_OWNED}" != true ]]; then
    echo "not removing ${root}: this run did not create it" >&2
    return 0
  fi
  if [[ ! -f "${root}/${FIXTURE_SENTINEL}" ]]; then
    # Created but never seeded — an empty directory is safe to drop, anything else is not ours to.
    rmdir -- "${root}" 2>/dev/null && return 0
    echo "not removing ${root}: no ${FIXTURE_SENTINEL} in it, so it is not a seeded fixture" >&2
    return 0
  fi
  rm -rf -- "${root}"
}

cleanup() {
  local code=$?
  stop_broker || code=1
  if [[ -n "${HOLDER_PID}" ]]; then kill "${HOLDER_PID}" 2>/dev/null || true; fi
  [[ -n "${PORT_FILE}" ]] && rm -f "${PORT_FILE}"
  # An interrupt between retiring the old campaign and moving the new one in must not leave the
  # tree with no campaign at all.
  if [[ -n "${RETIRED}" && -d "${RETIRED}" && ! -d "${LIVE}" ]]; then
    mv "${RETIRED}" "${LIVE}" && echo "restored the previous campaign at ${LIVE}" >&2
  fi
  rm -rf "${STAGE}" "${RETIRED}"
  if [[ "${KEEP_FIXTURE}" != true ]]; then remove_fixture_root; fi
  exit "${code}"
}
trap cleanup EXIT

step() { echo; echo "==> $*"; }

start_broker() {
  # The broker reports its OWN process group, rather than this shell inferring one from `$!`.
  # `setsid` sometimes execs in place and sometimes forks, so `$!` is the setsid pid in one case and
  # nothing to do with the broker's group in the other — and a stop that signals the wrong group is
  # a broker that keeps running while the script reports it stopped. Asking the process that becomes
  # the broker removes the guess. `exec` preserves the group, so the pid group it prints is the one
  # bun ends up in.
  #
  # `env -i` is the isolation, not `env.sh`. Sourcing overrides only the names the fixture happens to
  # set; everything else in this shell survived into the broker. See ENV_PASSTHROUGH above.
  local pgid_file
  pgid_file="$(mktemp)"
  local -a passthrough=()
  local name
  for name in "${ENV_PASSTHROUGH[@]}"; do
    [[ -n "${!name:-}" ]] && passthrough+=("${name}=${!name}")
  done
  setsid env -i "${passthrough[@]}" bash -c '
    printf "%s %s\n" "$(ps -o pgid= -p $$ | tr -d " ")" "$$" > "$4"
    set -a
    # shellcheck source=/dev/null
    source "$1/env.sh"
    set +a
    export PORT="$2" HOST=127.0.0.1 COSYNCING_WEB_DIR="$3/apps/client/build/web"
    exec bun run "$3/packages/typescript/broker/src/cli.ts" broker --dev-bypass-first-run
  ' _ "${FIXTURE_ROOT}" "${PORT}" "${REPO_ROOT}" "${pgid_file}" >>"${LOG_DIR}/fixture-broker.log" 2>&1 &
  BROKER_PGID=""
  BROKER_PID=""
  for _ in $(seq 1 40); do
    # `exec` keeps the pid, so the pid this prints is the broker's own.
    read -r BROKER_PGID BROKER_PID < "${pgid_file}" 2>/dev/null || true
    [[ -n "${BROKER_PGID}" ]] && break
    sleep 0.25
  done
  rm -f "${pgid_file}"
  [[ -n "${BROKER_PGID}" ]] || { echo "the fixture broker never reported its process group" >&2; exit 1; }
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      assert_broker_environment || exit 1
      return 0
    fi
    sleep 1
  done
  echo "fixture broker never became healthy; see ${LOG_DIR}/fixture-broker.log" >&2
  exit 1
}

# Prove the running broker has the fixture's environment and nothing else.
#
# Read from the process rather than reasoned about from the launcher: what matters is what the broker
# ended up with. Two ways to fail, and the hostile-parent check below exercises both — a name the
# fixture never set (the parent's), and a name it did set carrying the parent's value instead.
assert_broker_environment() {
  local environ="/proc/${BROKER_PID}/environ"
  [[ -r "${environ}" ]] || { echo "cannot read the fixture broker's environment at ${environ}" >&2; return 1; }
  local -a fixture_keys=()
  mapfile -t fixture_keys < <(grep -oP '^\s{2}"\K[A-Za-z_][A-Za-z0-9_]*(?=":)' "${FIXTURE_ROOT}/env.json")
  [[ ${#fixture_keys[@]} -gt 0 ]] || { echo "could not read the fixture's variable names" >&2; return 1; }
  local -a allowed=("${ENV_PASSTHROUGH[@]}" "${ENV_LAUNCHER[@]}" "${fixture_keys[@]}")

  local -a unexpected=() overridden=()
  local entry key
  while IFS= read -r -d '' entry; do
    key="${entry%%=*}"
    printf '%s\n' "${allowed[@]}" | grep -qxF -- "${key}" || unexpected+=("${key}")
  done < "${environ}"

  local live expected
  for key in "${fixture_keys[@]}"; do
    live="$(tr '\0' '\n' < "${environ}" | grep -m1 -- "^${key}=" | cut -d= -f2-)"
    expected="$(set -a; . "${FIXTURE_ROOT}/env.sh"; set +a; printf '%s' "${!key}")"
    [[ "${live}" == "${expected}" ]] || overridden+=("${key}")
  done

  if ((${#unexpected[@]} > 0 || ${#overridden[@]} > 0)); then
    echo "the fixture broker did not start from a clean environment:" >&2
    ((${#unexpected[@]} > 0)) && echo "  inherited from the parent: ${unexpected[*]}" >&2
    ((${#overridden[@]} > 0)) && echo "  fixture values overridden by the parent: ${overridden[*]}" >&2
    return 1
  fi
  return 0
}

# Refuse to touch a port that is already serving something. A review broker belongs to another
# workflow; taking it over would be both wrong and hard to notice.
if ss -H -ltn "sport = :${PORT}" 2>/dev/null | grep -q .; then
  echo "port ${PORT} is already in use; pass --port to pick another" >&2
  exit 1
fi

if [[ "${SKIP_BUILD}" != true ]]; then
  step "Building the release web client"
  # The script behind `bun run client:build:web`, invoked by path.
  bun run "${REPO_ROOT}/scripts/client/build-web.ts"
elif [[ ! -f "${REPO_ROOT}/apps/client/build/web/index.html" ]]; then
  echo "--skip-build was passed but apps/client/build/web/index.html does not exist" >&2
  exit 1
fi

# OpenCode discovers over HTTP, so the fixture aims $OPENCODE_URL somewhere that answers nothing.
# Hold that address for the whole run rather than testing it: a tested-dead port can be bound by a
# real OpenCode server before the next frame, and the roster fills with real projects.
step "Reserving the OpenCode isolation address"
PORT_FILE="$(mktemp)"
node "${REPO_ROOT}/scripts/dev/hold-opencode-port.mjs" "${PORT_FILE}" &
HOLDER_PID=$!
OPENCODE_PORT=""
for _ in $(seq 1 40); do
  OPENCODE_PORT="$(tr -d '[:space:]' < "${PORT_FILE}" 2>/dev/null || true)"
  [[ -n "${OPENCODE_PORT}" ]] && break
  sleep 0.25
done
[[ -n "${OPENCODE_PORT}" ]] || { echo "could not reserve an OpenCode isolation port" >&2; exit 1; }
echo "holding 127.0.0.1:${OPENCODE_PORT} for the whole run"

step "Seeding the fictitious fixture"
: >"${LOG_DIR}/fixture-broker.log"
# This script creates the root, rather than reading one back off the seeder's stdout, so the path it
# deletes at the end is one it made itself. `code-XXXXXX` because these paths are on camera: the
# roster prints each project's directory and the artifact card prints an absolute file path.
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/code-XXXXXX")"
FIXTURE_ROOT_OWNED=true
chmod 700 "${FIXTURE_ROOT}"
bun run "${REPO_ROOT}/scripts/dev/seed-brand-fixture.ts" --root "${FIXTURE_ROOT}" \
  --opencode-port "${OPENCODE_PORT}"
[[ -f "${FIXTURE_ROOT}/${FIXTURE_SENTINEL}" ]] || {
  echo "the seeder left no ${FIXTURE_SENTINEL} in ${FIXTURE_ROOT}" >&2; exit 1
}

# First start settles the notification feed: the broker advances presentation state the first time
# it publishes an event, which restamps every `updatedAt` and makes the whole inbox read "just now".
#
# It is also the hostile-parent-environment regression, at no extra cost. This shell is deliberately
# poisoned first with names a real machine carries — two the fixture never sets, and three it does —
# and `assert_broker_environment` has to find none of them in the broker. Every value below points at
# nothing, so a leak can only fail the assertion, never publish anything real; the names are the
# point. Without this the isolation is a claim about a launcher, not a property anyone has watched
# hold.
step "Settling the fixture (first broker start, from a hostile parent environment)"
readonly HOSTILE=/nonexistent/hostile-parent-environment-check
export COSYNCING_PI_SESSIONS_ROOT="${HOSTILE}"
export COSYNCING_MACHINE_PEERS=hostile.invalid
export COSYNCING_HOME="${HOSTILE}"
export CLAUDE_CONFIG_DIR="${HOSTILE}"
export CODEX_HOME="${HOSTILE}"
start_broker
unset COSYNCING_PI_SESSIONS_ROOT COSYNCING_MACHINE_PEERS COSYNCING_HOME CLAUDE_CONFIG_DIR CODEX_HOME
echo "the broker started clean out of a poisoned shell"
sleep 4
stop_broker
bun run "${REPO_ROOT}/scripts/dev/seed-brand-fixture.ts" --root "${FIXTURE_ROOT}" --settle-timestamps

# One broker per locale, started and stopped around that locale's frames.
#
# The approval frames take the session over and leave it driven, with a live turn open and a request
# pending. That is the state they are frames OF, and it must not be the state the NEXT locale starts
# from: the second locale would then photograph the first locale's live turn instead of raising its
# own. Restarting is the whole reset — the transcripts on disk are untouched by a drive, so a fresh
# broker sees exactly what the seeder wrote.
self_test=--self-test
for locale in "${LOCALES[@]}"; do
  step "Starting the capture broker for ${locale} on 127.0.0.1:${PORT}"
  start_broker

  # These images get published. Prove the broker cannot see anything real BEFORE capturing, not
  # after — a leak found afterwards means every file already written has to be thrown away. The
  # self-test proves the comparison rejects a plausible-looking intruder rather than merely passing;
  # it runs once, because it is a property of the comparison, not of this broker.
  step "Proving the fixture is clean (${locale})"
  bun run "${REPO_ROOT}/scripts/dev/verify-brand-fixture.ts" \
    --base "http://127.0.0.1:${PORT}" --root "${FIXTURE_ROOT}" ${self_test}
  self_test=

  step "Capturing the real app (${locale})"
  node "${REPO_ROOT}/scripts/dev/capture-store-screenshots.mjs" \
    --base "http://127.0.0.1:${PORT}/cosy/" --fixture-root "${FIXTURE_ROOT}" \
    --locale "${locale}" --out "${STAGE}/raw/${locale}"

  # Proven clean before the first frame; prove it again after the last one. The broker is long-lived
  # and OpenCode discovers over HTTP, so an adapter that reconnected mid-run would otherwise have
  # leaked into the late frames only. `--after-capture` tolerates the two notifications the capture
  # itself causes — a pending approval, and the pre-enrolment auth failures — and nothing else.
  step "Re-proving the fixture after the ${locale} capture"
  bun run "${REPO_ROOT}/scripts/dev/verify-brand-fixture.ts" \
    --base "http://127.0.0.1:${PORT}" --root "${FIXTURE_ROOT}" --after-capture

  stop_broker
  # With the broker down, put the inbox back to the feed this locale was captured against, so the
  # next one is captured against the same one.
  bun run "${REPO_ROOT}/scripts/dev/seed-brand-fixture.ts" --root "${FIXTURE_ROOT}" --reset-attention
done

for locale in "${LOCALES[@]}"; do
  step "Composing the ${locale} store frames"
  node "${REPO_ROOT}/scripts/dev/compose-store-frames.mjs" \
    --raw "${STAGE}/raw/${locale}" --out "${STAGE}/final/${locale}" --locale "${locale}"
done

# Retire the accepted campaign to one side, move the new one in, and only then delete the old. A
# `rm -rf` before the move means an interrupt, a full disk, or a cross-device rename leaves the tree
# with no campaign at all — the one state worse than an out-of-date one.
step "Publishing"
mkdir -p "$(dirname "${LIVE}")"
if [[ -d "${LIVE}" ]]; then
  RETIRED="$(mktemp -d "${REPO_ROOT}/output/brand/.store-retired-XXXXXX")"
  rmdir "${RETIRED}"
  mv "${LIVE}" "${RETIRED}"
fi
if ! mv "${STAGE}" "${LIVE}"; then
  echo "could not move the new campaign into place" >&2
  if [[ -n "${RETIRED}" && -d "${RETIRED}" ]]; then
    mv "${RETIRED}" "${LIVE}" && echo "rolled back to the previous campaign" >&2
    RETIRED=""
  fi
  exit 1
fi
rm -rf "${RETIRED}"
RETIRED=""
STAGE=""
find "${LIVE}" -name '*.png' | sort | sed "s|^${LIVE}/|  |"
echo
echo "submission sets: ${LIVE}/final/<locale>/   captures: ${LIVE}/raw/<locale>/"
