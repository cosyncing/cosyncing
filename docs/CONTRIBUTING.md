# Contributing

Thank you for improving cosyncing. Contributions use a fork-and-pull-request
workflow and the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign each commit with `git commit -s`.

## Setup

Install Flutter 3.44.3 and Bun 1.3.14, then run from the repository root:

```bash
bun install --frozen-lockfile
bun run check --list
bun run check
```

The broker owns wire shapes. A contract change and its client adaptation must
land in the same pull request. Run `bun run contract:generate`, commit both the
broker change and generated snapshot, then run `bun run check policy client`.
Do not edit the generated snapshot or Dart identity file by hand.

## Feature coverage and CI

Follow [Tests and CI](development/testing.md) before adding tests or CI work.
Extend functional scenarios through the product's public behavior; do not add
tests for each implementation function or file. Reuse the existing suites and
harnesses, retire replaced coverage, and justify any narrow-test exception.
Keep the shared runner and the two stable required aggregates.

Use selected tasks while iterating and a complete check for the final
implementation candidate. Documentation-only changes use the lightweight
checks described in the testing guide. In the PR, state the behavior covered,
commands/results, relevant duration changes, and remaining gaps. A pass on
retry must retain a tracked reliability follow-up; it is not a completed fix.

Pull requests from forks receive no secrets and run only on GitHub-hosted
runners. Maintainers may request platform-specific evidence. Do not add
credentials, private URLs, machine paths, generated logs, screenshots, or agent
workspace files to a pull request.

See [public build and test instructions](development/build-test.md), the
[fork workflow](development/fork-workflow.md), and the
[compatibility policy](SUPPORT.md).
