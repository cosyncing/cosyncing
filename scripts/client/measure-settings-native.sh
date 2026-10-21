#!/usr/bin/env bash
# Optional Linux profile evidence. Run from the candidate repository root with
# no other build, test, or benchmark running. Reuses the transcript harness.
set -euo pipefail

review_out=${REVIEW_OUT:-output/review/settings-storage-routes}
run_id=${RUN_ID:-$(date -u +%Y%m%d-%H%M%S)}
baseline_source=${BASELINE_SOURCE:-$review_out/performance/baseline-source}
candidate_source=${CANDIDATE_SOURCE:-.}
baseline_runtime=${BASELINE_RUNTIME:-$(command -v bun)}
candidate_runtime=${CANDIDATE_RUNTIME:-$(command -v bun)}
scenarios=${NATIVE_SCENARIOS:-flings,stream-at-tail}
review_absolute=$(realpath -m "$review_out")
baseline_absolute=$(realpath "$baseline_source")
candidate_absolute=$(realpath "$candidate_source")
mkdir -p "$review_absolute/performance"

run_profile() {
  local label=$1 source=$2 runtime=$3
  local began=$SECONDS status=0 native_load_before native_load_after
  read -r native_load_before _ </proc/loadavg
  (
    cd "$source"
    LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a -s '-screen 0 1440x1000x24' \
      "$runtime" run scripts/client/measure-transcript-scroll.ts \
      --target native --prefix settings-storage-routes --label "$run_id-$label" \
      --scenarios "$scenarios"
  ) >"$review_absolute/native-profile-$run_id-$label.log" 2>&1 || status=$?
  read -r native_load_after _ </proc/loadavg
  printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$status" "$((SECONDS - began))" \
    "$native_load_before" "$native_load_after" \
    >>"$review_absolute/native-profile-$run_id.tsv"
  if [[ "$status" != 0 ]]; then return "$status"; fi
  cp "$source/output/scroll-analysis/settings-storage-routes-native-$run_id-$label.json" \
    "$review_absolute/performance/native-profile-$run_id-$label.json"
}

# Establish baseline repeatability, then reverse baseline/candidate order.
# Each fling scenario retains 24 individual samples at each network latency.
# Whole profile runs are alternating blocks; they are not independent startup
# samples and do not establish Windows, macOS, mobile, GPU, or energy parity.
IFS=, read -r -a labels <<<"${NATIVE_RUN_LABELS:-control-a,control-b,candidate-a,baseline-a,baseline-b,candidate-b}"
for label in "${labels[@]}"; do
  case "$label" in
    control-a|control-b|baseline-a|baseline-b|candidate-a|candidate-b) ;;
    *) printf 'Unknown native profile label: %s\n' "$label" >&2; exit 2 ;;
  esac
done
for label in "${labels[@]}"; do
  case "$label" in
    candidate-*) run_profile "$label" "$candidate_absolute" "$candidate_runtime" ;;
    *) run_profile "$label" "$baseline_absolute" "$baseline_runtime" ;;
  esac
done
