# Public build and test instructions

Use Flutter 3.44.3 from `.fvmrc`, Dart supplied by that SDK, and Bun 1.3.14 from
`package.json`. No sibling checkout, private service, or locally preinstalled
agent CLI is required for deterministic gates.

During implementation, select the affected feature or suite. For the final
implementation candidate, run the complete check once:

```bash
bun run check
```

See [Tests and CI](testing.md) for functional coverage rules, runtime targets,
selection, sharding, and flake handling. Documentation-only edits use its
lightweight validation path. Individual tools below remain available for
diagnosis; do not run them all again after the shared runner has already
covered them:

```bash
bun install --frozen-lockfile
bun run client:pub-get
bun run client:format
bun run typecheck
bun run ci:audit-workflows
bun run ci:check-boundaries
bun run contract:check
bun run client:analyze
bun run client:test
```

The four reusable Dart packages have independent analysis and test gates. Run
these commands from each directory under `packages/dart/`: `broker_contract`,
`broker_client`, `broker_client_flutter`, and `broker_crypto`.

```bash
flutter pub get
flutter analyze
flutter test
```

Platform smoke builds mirror CI:

```bash
bun run scripts/client/run-client-command.ts flutter build web --release
bun run scripts/client/run-client-command.ts flutter build linux --debug
bun run scripts/client/run-client-command.ts flutter build apk --debug
bun run scripts/client/run-client-command.ts flutter build macos --debug
bun run scripts/client/run-client-command.ts flutter build ios --simulator --debug
bun run scripts/client/run-client-command.ts flutter build windows --debug
```

Run only commands supported by the current host. GitHub-hosted jobs provide the
authoritative cross-platform result. Tests may create ignored files under
`output/`; they are ephemeral and must not be committed.

Linux desktop builds also require the standard GTK, WebKitGTK 4.1, and libsoup
3 development packages installed by `ci.yml`.
