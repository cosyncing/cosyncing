#!/usr/bin/env bash
# Compare identical test files in isolated build trees. Run from the source root.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
test "$PWD" = "$repo_root"
source_commit="$(git rev-parse HEAD)"
output_dir="${OUTPUT_DIR:-output/flutter-check-benchmark}"
mkdir -p "$output_dir"
output_dir="$(realpath "$output_dir")"
case_root="$(mktemp -d "$output_dir/worktrees.XXXXXX")"
cpu_set="${CPU_SET:-$(python3 -c 'import os; print(",".join(map(str,sorted(os.sched_getaffinity(0))[:4])))')}"
check_concurrency="${CHECK_CONCURRENCY:-3}"
read -r -a layouts <<< "${LAYOUTS:-serial-shards combined}"
for layout in "${layouts[@]}"; do
  case "$layout" in serial-shards|combined) ;; *) echo 'Unsupported benchmark layout' >&2; exit 2 ;; esac
done
if test -n "${BASELINE_DIR:-}"; then
  for cache_case in cold warm; do
    test "$(cat "$BASELINE_DIR/serial-shards-$cache_case/exit-code.txt")" = 0
    test ! -e "$output_dir/serial-shards-$cache_case"
    cp -a "$BASELINE_DIR/serial-shards-$cache_case" "$output_dir/"
  done
fi
flutter --version --machine > "$output_dir/flutter-version.json"
bun --version > "$output_dir/bun-version.txt"
cleanup() {
  for layout in "${layouts[@]}"; do
    if test -f "$case_root/$layout/.git"; then
      git worktree remove --force "$case_root/$layout"
    fi
  done
  rmdir "$case_root" 2>/dev/null || true
}
trap cleanup EXIT
for layout in "${layouts[@]}"; do
  git worktree add --detach "$case_root/$layout" "$source_commit"
  # Both cases get the same pending runner implementation, not different app code.
  cp -a scripts/ci/. "$case_root/$layout/scripts/ci/"
  (
    cd "$case_root/$layout"
    bun install --frozen-lockfile
    bun run check client --only flutter-test --flutter-layout "$layout" --list --json
  ) > "$output_dir/$layout-setup.log" 2>&1
done
failures=0
for layout in "${layouts[@]}"; do
  for cache_case in cold warm; do
    result_dir="$output_dir/$layout-$cache_case"
    mkdir -p "$result_dir"
    set +e
    (
      cd "$case_root/$layout"
      /usr/bin/time -v -o "$result_dir/resources.txt" \
        taskset -c "$cpu_set" bun run check client --only flutter-test \
          --flutter-layout "$layout" --concurrency "$check_concurrency" --no-retry
    ) > "$result_dir/run.log" 2>&1
    status=$?
    set -e
    if test -d "$case_root/$layout/output/check"; then
      cp -a "$case_root/$layout/output/check" "$result_dir/check"
    fi
    printf '%s\n' "$status" > "$result_dir/exit-code.txt"
    if test "$status" != 0; then failures=$((failures + 1)); fi
    printf '%s %s finished with exit %s\n' "$layout" "$cache_case" "$status"
  done
done
python3 - "$output_dir" "$source_commit" "$cpu_set" "$check_concurrency" <<'PY'
import json, pathlib, re, sys
root=pathlib.Path(sys.argv[1]); rows=[]
for layout in ('serial-shards','combined'):
    for cache_case in ('cold','warm'):
        p=root/f'{layout}-{cache_case}'
        report=json.loads((p/'check/report.json').read_text()) if (p/'check/report.json').exists() else {}
        if report.get('commit') != sys.argv[2]: raise RuntimeError('benchmark source commit differs')
        resources=(p/'resources.txt').read_text()
        match=re.search(r'Maximum resident set size \(kbytes\): (\d+)',resources)
        files=sorted(file for task in report.get('tasks',[]) if re.fullmatch(r'flutter-test(?:-\d+-of-\d+)?',task['id']) for file in task['command'][3:])
        rows.append(dict(layout=layout,cache=cache_case,exit_code=int((p/'exit-code.txt').read_text()),
                         duration_ms=report.get('durationMs'),counts=report.get('counts'),
                         max_process_rss_kib=int(match[1]) if match else None,flutter_files=files))
sets=[r['flutter_files'] for r in rows]
same_files=bool(sets[0]) and all(s==sets[0] and len(s)==len(set(s)) for s in sets)
result=dict(source_commit=sys.argv[2],cpu_set=sys.argv[3],concurrency=int(sys.argv[4]),
            cache_scope='cold/warm checkout build output; shared SDK and package download caches',
            source_scope='same committed application code; pending runner overlay; reports may be dirty',
            same_files=same_files,results=rows)
(root/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({**result,'results':[{k:v for k,v in r.items() if k!='flutter_files'} for r in rows]},indent=2))
if not same_files:sys.exit(1)
PY
test "$failures" = 0
