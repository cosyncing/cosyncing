#!/usr/bin/env bash

usage() {
  cat <<'EOF'
Usage:
  scripts/client/client_validation_check.sh [options]

Runs a local client validation suite by composing existing repo checks.

Options:
  --full-tests                  Run the full Flutter test suite.
  --skip-full-tests             Skip the full Flutter test suite. Default.
  --live-smoke                  Run optional live broker smoke scripts. Default.
  --skip-live-smoke             Skip live broker smoke scripts.
  --readiness-targets <targets> Target list for release readiness report.
  --skip-readiness              Skip release readiness report.
  --build-smoke-targets <targets>
                                Run non-signing platform build smoke for targets.
  --build-mode <mode>           Build smoke mode: debug, release, or profile.
                                Default: debug.
  -h, --help                    Show this help text.

Environment:
  CLIENT_VALIDATION_FULL_TESTS       1 to run full tests by default.
  CLIENT_VALIDATION_LIVE_SMOKE       0 to skip live smoke by default.
  CLIENT_VALIDATION_READINESS_TARGETS
                                    Defaults to web,host.
  CLIENT_VALIDATION_BUILD_TARGETS    Optional platform build smoke targets.
  CLIENT_VALIDATION_BUILD_MODE       Defaults to debug.

Notes:
- Run from the cosyncing monorepo root.
- Live broker scripts skip cleanly when COSYNCING_BROKER_URL is not set.
- This script does not sign, notarize, upload, or publish any artifacts.
EOF
}

ROOT_DIR="$PWD"

FULL_TESTS="${CLIENT_VALIDATION_FULL_TESTS:-0}"
LIVE_SMOKE="${CLIENT_VALIDATION_LIVE_SMOKE:-1}"
READINESS_TARGETS="${CLIENT_VALIDATION_READINESS_TARGETS:-web,host}"
RUN_READINESS=1
BUILD_SMOKE_TARGETS="${CLIENT_VALIDATION_BUILD_TARGETS:-}"
BUILD_MODE="${CLIENT_VALIDATION_BUILD_MODE:-debug}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --full-tests)
      FULL_TESTS=1
      shift
      ;;
    --skip-full-tests)
      FULL_TESTS=0
      shift
      ;;
    --live-smoke)
      LIVE_SMOKE=1
      shift
      ;;
    --skip-live-smoke)
      LIVE_SMOKE=0
      shift
      ;;
    --readiness-targets=*)
      READINESS_TARGETS="${1#*=}"
      RUN_READINESS=1
      shift
      ;;
    --readiness-targets)
      if [ $# -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "Missing value for --readiness-targets."
        usage
        exit 2
      fi
      READINESS_TARGETS="${2:-}"
      RUN_READINESS=1
      shift 2
      ;;
    --skip-readiness)
      RUN_READINESS=0
      shift
      ;;
    --build-smoke-targets=*)
      BUILD_SMOKE_TARGETS="${1#*=}"
      shift
      ;;
    --build-smoke-targets)
      if [ $# -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "Missing value for --build-smoke-targets."
        usage
        exit 2
      fi
      BUILD_SMOKE_TARGETS="${2:-}"
      shift 2
      ;;
    --build-mode=*)
      BUILD_MODE="${1#*=}"
      shift
      ;;
    --build-mode)
      if [ $# -lt 2 ] || [[ "${2:-}" == --* ]]; then
        echo "Missing value for --build-mode."
        usage
        exit 2
      fi
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

if [ ! -f "${ROOT_DIR}/apps/client/pubspec.yaml" ] || [ ! -f "${ROOT_DIR}/scripts/client/client_validation_check.sh" ]; then
  echo "ERROR: run this script from the cosyncing monorepo root."
  exit 2
fi

if [ "$FULL_TESTS" != "0" ] && [ "$FULL_TESTS" != "1" ]; then
  echo "Invalid CLIENT_VALIDATION_FULL_TESTS value: $FULL_TESTS (expected 0 or 1)."
  exit 2
fi

if [ "$LIVE_SMOKE" != "0" ] && [ "$LIVE_SMOKE" != "1" ]; then
  echo "Invalid CLIENT_VALIDATION_LIVE_SMOKE value: $LIVE_SMOKE (expected 0 or 1)."
  exit 2
fi

if [ "$RUN_READINESS" != "0" ] && [ "$RUN_READINESS" != "1" ]; then
  echo "Invalid readiness selection state: $RUN_READINESS."
  exit 2
fi

if [ -z "$BUILD_MODE" ] || { [ "$BUILD_MODE" != "debug" ] && [ "$BUILD_MODE" != "release" ] && [ "$BUILD_MODE" != "profile" ]; }; then
  echo "Invalid --build-mode value: $BUILD_MODE (expected debug, release, or profile)."
  exit 2
fi

PASS_COUNT=0
FAIL_COUNT=0

run_step() {
  local label="$1"
  shift

  echo
  echo "==> ${label}"
  echo "+ $*"
  "$@"
  local status=$?
  if [ $status -eq 0 ]; then
    echo "PASS: ${label}"
    ((PASS_COUNT += 1))
  else
    echo "FAIL: ${label} (exit ${status})"
    ((FAIL_COUNT += 1))
  fi
}

echo "Running cosyncing Client local validation:"
echo "  full tests: ${FULL_TESTS}"
echo "  live smoke: ${LIVE_SMOKE}"
echo "  readiness targets: ${READINESS_TARGETS:-<skipped>}"
echo "  build smoke targets: ${BUILD_SMOKE_TARGETS:-<skipped>}"
echo "  build mode: ${BUILD_MODE}"

run_step "toolchain version guard" bash scripts/client/check_toolchain_versions.sh
run_step "release manifest guard" bash scripts/client/check_release_manifests.sh
run_step "Flutter dependency resolution" bun run client:pub-get
run_step "Flutter analyzer" bun run client:analyze
run_step "contract tests" bun run scripts/client/run-client-command.ts flutter test test/contract/ --reporter=compact
run_step "contract snapshot drift check" bun run contract:check

if [ "$FULL_TESTS" = "1" ]; then
  run_step "full Flutter test suite" bun run scripts/client/run-client-command.ts flutter test --reporter=compact
else
  echo
  echo "SKIP: full Flutter test suite (--full-tests not selected)"
fi

if [ "$LIVE_SMOKE" = "1" ]; then
  run_step "F0.1 live broker smoke" bash scripts/client/f0_live_broker_smoke.sh
  run_step "F1 live session attach smoke" bash scripts/client/f1_live_session_attach_smoke.sh
else
  echo
  echo "SKIP: live broker smoke (--skip-live-smoke selected)"
fi

if [ "$RUN_READINESS" = "1" ]; then
  run_step "release readiness report" bash scripts/client/release_readiness_report.sh --targets "$READINESS_TARGETS"
else
  echo
  echo "SKIP: release readiness report (--skip-readiness selected)"
fi

if [ -n "$BUILD_SMOKE_TARGETS" ]; then
  run_step "platform build smoke" bash scripts/client/platform_build_smoke.sh --targets "$BUILD_SMOKE_TARGETS" --mode "$BUILD_MODE"
else
  echo
  echo "SKIP: platform build smoke (--build-smoke-targets not selected)"
fi

echo
echo "Validation summary:"
echo "  passed: ${PASS_COUNT}"
echo "  failed: ${FAIL_COUNT}"

if [ $FAIL_COUNT -gt 0 ]; then
  exit 1
fi
exit 0
