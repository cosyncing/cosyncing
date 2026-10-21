#!/usr/bin/env bash
# Optional reliability campaign over existing Flutter feature journeys.
# Usage: scripts/client/repeat-focused-tests.sh --repeat 10 --out output/review/run -- <flutter test arguments>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

rounds="${REPEAT:-10}"
review_out="${REVIEW_OUTPUT:-output/review/flutter-repeat}"
while (($#)); do
  case "$1" in
    --repeat) rounds="$2"; shift 2 ;;
    --out) review_out="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [[ ! "$rounds" =~ ^[0-9]+$ ]] || ((rounds < 1 || rounds > 50)) || (($# == 0)); then
  echo 'Use --repeat 1..50, --out <new directory>, -- <flutter test arguments>.' >&2
  exit 2
fi
if [[ -e "$review_out" ]]; then
  echo "Refusing to overwrite review evidence: $review_out" >&2
  exit 2
fi
mkdir -p "$review_out"
printf 'round\texit\tseconds\n' > "$review_out/results.tsv"
printf '%q ' "$@" > "$review_out/arguments.txt"
printf '\n' >> "$review_out/arguments.txt"
for ((round = 1; round <= rounds; round++)); do
  began=$SECONDS
  code=0
  bun run scripts/client/run-client-command.ts flutter test --no-pub "$@" --reporter expanded \
    > "$review_out/round-$round.log" 2>&1 || code=$?
  printf '%s\t%s\t%s\n' "$round" "$code" "$((SECONDS - began))" >> "$review_out/results.tsv"
  printf 'Round %s/%s: exit %s (%ss)\n' "$round" "$rounds" "$code" "$((SECONDS - began))"
  if ((code != 0)); then
    echo "Failure retained in $review_out/round-$round.log; no retry." >&2
    exit "$code"
  fi
done
