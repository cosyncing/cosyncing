#!/usr/bin/env bash
# Optional review campaign. Run from the repository root, with no other builds
# or benchmarks running. Baseline source and stamped web builds must exist.
set -euo pipefail

review_out=${REVIEW_OUT:-output/review/settings-storage-routes}
run_id=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
baseline_source=${BASELINE_SOURCE:-$review_out/performance/baseline-source}
baseline_web=${BASELINE_WEB:-$review_out/performance/baseline-web}
candidate_web=${CANDIDATE_WEB:-$review_out/performance/candidate-web-$run_id}
baseline_runtime=${BASELINE_RUNTIME:-$(command -v bun)}
candidate_runtime=${CANDIDATE_RUNTIME:-$(command -v bun)}
from_stage=${FROM_STAGE:-check}
started=false
mkdir -p "$review_out/performance"
review_absolute=$review_out
if [[ $review_absolute != /* ]]; then review_absolute="$PWD/$review_absolute"; fi

stage() {
  local name=$1
  shift
  if [[ $name == "$from_stage" ]]; then started=true; fi
  if [[ $started != true ]]; then return; fi
  local began=$SECONDS status=0
  "$@" >"$review_out/$name-$run_id.log" 2>&1 || status=$?
  printf '%s\t%s\t%s\n' "$name" "$status" "$((SECONDS - began))" >>"$review_out/campaign-$run_id.tsv"
  if [[ $name == check ]]; then
    cp -a output/check "$review_out/full-check-$run_id"
  elif [[ $name == browser-routes ]]; then
    cp -a output/check "$review_out/browser-routes-$run_id"
  fi
  return "$status"
}

capture_web() {
  test ! -e "$candidate_web"
  cp -a apps/client/build/web "$candidate_web"
}

stage check bun run check --no-retry
stage browser-routes bun run check web --only web-login --repeat 10
stage capture-web capture_web
stage screenshots bun scripts/client/review-settings-storage-routes.ts --full \
  --web "$candidate_web" --out "$review_out/screenshots-$run_id"
stage repeatability bun scripts/client/benchmark-settings-storage-routes.ts \
  --baseline-runtime "$baseline_runtime" --candidate-runtime "$baseline_runtime" \
  --baseline-web "$baseline_web" --candidate-web "$baseline_web" \
  --baseline-source "$baseline_source" --candidate-source "$baseline_source" \
  --rounds 20 --out "$review_out/performance/browser-repeatability-$run_id.json"
stage comparison bun scripts/client/benchmark-settings-storage-routes.ts \
  --baseline-runtime "$baseline_runtime" --candidate-runtime "$candidate_runtime" \
  --baseline-web "$baseline_web" --candidate-web "$candidate_web" \
  --baseline-source "$baseline_source" --rounds 20 \
  --out "$review_out/performance/browser-comparison-$run_id.json"
stage transfer-repeatability bun scripts/client/benchmark-storage-transfers.ts \
  --baseline-runtime "$baseline_runtime" --candidate-runtime "$baseline_runtime" \
  --baseline-source "$baseline_source" --candidate-source "$baseline_source" --rounds 20 \
  --out "$review_out/performance/transfer-repeatability-$run_id.json"
stage transfers bun scripts/client/benchmark-storage-transfers.ts \
  --baseline-runtime "$baseline_runtime" --candidate-runtime "$candidate_runtime" \
  --baseline-source "$baseline_source" --rounds 20 \
  --out "$review_out/performance/transfers-$run_id.json"
stage storage-scale bun scripts/client/benchmark-storage-scale.ts \
  --counts 1000,10000 --out "$review_out/performance/storage-scale-$run_id.json"
stage native-proxy env PROXY_BENCH_OUT="$review_absolute/performance/native-proxy-$run_id.json" \
  PROXY_BENCH_ROUNDS=20 bun scripts/client/run-client-command.ts flutter test --no-pub \
  ../../scripts/client/benchmark-native-proxy.dart --reporter expanded
if [[ $started != true ]]; then
  printf 'Unknown FROM_STAGE: %s\n' "$from_stage" >&2
  exit 2
fi
