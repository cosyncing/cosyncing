# Flutter client

This directory is the complete production Flutter application. It owns the
platform runners, app source, unit tests, integration drivers, web sources, and
app-specific Dart tools. Shared reusable Dart packages remain under
`../../packages/dart/`.

Run supported commands from the monorepo root:

```bash
bun run client:pub-get
bun run client:format
bun run client:analyze
bun run client:test
bun run client:build:web
```

See [public build and test instructions](../../docs/development/build-test.md)
for package and platform gates.
