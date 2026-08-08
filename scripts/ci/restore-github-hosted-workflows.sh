#!/usr/bin/env bash
#
# DO NOT RUN THIS WHILE THE REPOSITORY IS PRIVATE.
#
# Self-hosted runners are the deliberate model for the private development
# repository; see `.github/workflow-mode`.
#
# If you arrived here because CI is queued forever, this script is NOT the fix.
# Runners are scoped to one repository. Register the intended private runner
# there instead of changing this profile. Restore this profile only in the
# public repository created by the release migration.
#
set -euo pipefail

active_dir='.github/workflows'
backup_dir='scripts/ci/github-hosted-workflows'
mode_file='.github/workflow-mode'

test "$(cat "$mode_file")" = 'private-self-hosted'
if ! git diff --quiet -- "$active_dir" || ! git diff --cached --quiet -- "$active_dir"; then
  echo 'ERROR: commit or discard active workflow edits before restoring the public profile.' >&2
  exit 1
fi

for source in "$backup_dir"/*.yml; do
  cp "$source" "$active_dir/${source##*/}"
done
printf '%s\n' 'public-hosted' > "$mode_file"

echo 'Restored the GitHub-hosted public workflow profile.'
echo 'Run bash scripts/ci/audit-workflows.sh, review the diff, and commit before changing visibility.'
