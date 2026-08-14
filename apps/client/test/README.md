# Flutter tests

The client test tree mirrors production ownership under `lib/src/`.

- `src/` contains unit and widget tests grouped by app, feature, local-state,
  and platform ownership.
- `contract/` locks the broker/client wire surface and generated-model use.
- `web/` and `web_only/` cover browser-specific startup and implementations.
- `brand/` validates tracked brand assets.
- `tool/` covers developer validation tools.
- `support/` contains shared fakes, stores, finders, and page/controller
  harnesses; it is not production code.

Run the complete client suite from the repository root:

```bash
bun run client:test
```

Run the focused contract gate from `apps/client/`:

```bash
flutter test test/contract/
```

The contract tests verify canonical event and message kinds, typed decoding,
renderer or fallback coverage, outbound frame fields, and alignment with the
broker's semantic surface. Real-browser and release harnesses remain under the
root `scripts/` tree rather than this unit/widget test directory.
