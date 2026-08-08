# Fork-based development

Fork the repository, create a topic branch, and open a pull request against
`main`. Fork pull requests receive a read-only `GITHUB_TOKEN`, no repository or
environment secrets, and no persistent runner. CI never uses
`pull_request_target` to execute contributor code.

Keep commits focused and sign them off for DCO. Update tests and public docs in
the same pull request. Contract changes must include generated output and typed
client adoption. Maintainers alone run release, signing, deployment, and stable
promotion workflows.

Do not attempt to make a fork PR publish artifacts or access protected
environments. A maintainer may approve a first-time contributor workflow run
through repository settings after inspecting the change.
