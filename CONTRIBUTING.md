# Contributing

Thank you for improving cosyncing. Contributions use a fork-and-pull-request
workflow and the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign each commit with `git commit -s`.

## Setup

Install Flutter 3.44.3 and Bun 1.3.8, then run from the repository root:

```bash
bun install --frozen-lockfile
bun run client:pub-get
bun run typecheck
bun run contract:check
bun run client:analyze
bun run client:test
```

The broker owns wire shapes. A contract change and its client adaptation must
land in the same pull request. Run `bun run contract:generate`, commit both the
broker change and generated snapshot, then rerun the checks above. Do not edit
the generated snapshot or Dart identity file by hand.

Pull requests from forks receive no secrets and run only on GitHub-hosted
runners. Maintainers may request platform-specific evidence. Do not add
credentials, private URLs, machine paths, generated logs, screenshots, or agent
workspace files to a pull request.

See [public build and test instructions](docs/development/build-test.md), the
[fork workflow](docs/development/fork-workflow.md), and the
[compatibility policy](SUPPORT.md).
