# Monorepo architecture

The complete Flutter application lives under `apps/client/`. Its platform
runners, unit tests, integration drivers, test driver, web sources, and
developer-only Dart validation helpers stay together under that app root. Pure
Dart packages live under `packages/dart/`; TypeScript semantic contracts, adapter API, broker,
adapter, transport-wire, transport, and crypto packages live under
`packages/typescript/`. Broker scripts are under
`scripts/broker/`, client scripts under `scripts/client/`, and cross-product
contract tooling under `scripts/contracts/`. Root commands delegate Flutter
work to `apps/client` so contributors and CI use one monorepo entry point.
The app's `integration_test/`, `test_driver/`, and `tool/` directories are
public source; their generated output is excluded.

The broker owns the wire contract. `contracts/generated/` is produced from the
broker source in the same checkout. Flutter screens do not decode raw transport
payloads: `broker_contract` owns typed messages and `broker_client` owns REST and
WebSocket transport. Platform code stays behind adapters; controllers own
lifecycle; screens render state and dispatch intents.

`apps/poc-ui/` is retained only as a source fixture for capability and boundary
scans. The broker no longer embeds or serves it: its token prompt was a DOM
overlay over an already-rendered shell rather than an auth boundary, so R9 removed
it from the packaged asset set and every `/poc-ui` path is now a plain 404. Client
and broker component versions and tags remain independent even though contract
changes land atomically.

## Dependency direction

`protocol` owns client-facing semantic types and compatibility policy. It has
no Bun, filesystem, process, broker, or concrete-adapter dependency.
`adapter-api` depends on `protocol` and owns the provider SPI, registry, and
bounded setup diagnosis. Concrete adapters depend on `adapter-api` and are
registered only by broker composition. `transport-wire` owns encrypted framing
and replay protection; it is not the semantic client contract.

Session Detail keeps one controller facade while messaging, artifact, request,
and session actions live in separate coordinator parts. Page panels and message
renderers are split by responsibility. `bun run ci:check-boundaries` enforces
these directions and the pre-v1 hotspot ceilings.
