# GitHub-hosted public workflow backup

The YAML files in this directory are the exact public-runner workflow profile
captured before private development switched to repository self-hosted runners.
GitHub does not execute files from this directory.

Before changing repository visibility, run these commands from the repository root:

    bash scripts/ci/restore-github-hosted-workflows.sh
    bash scripts/ci/audit-workflows.sh

Review and commit the resulting workflow and mode-file diff before enabling
public access. The restore script refuses to overwrite uncommitted active
workflow edits.
