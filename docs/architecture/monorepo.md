# Monorepo architecture

The complete Flutter application lives under `apps/client/`. Its platform
runners, unit tests, integration drivers, test driver, web sources, and
developer-only Dart validation helpers stay together under that app root. Pure
Dart packages live under `packages/dart/`. TypeScript semantic contracts,
provider adapters, broker, transport, encrypted wire framing, and crypto
packages live under `packages/typescript/`. Root commands delegate Flutter work
to `apps/client` so contributors and CI use one monorepo entry point. The app's
`integration_test/`, `test_driver/`, and `tool/` directories are public source;
their generated output is excluded.

Broker production code is grouped by owned domain under
`packages/typescript/broker/src/`: artifacts, attention, CLI, installation,
roster, runtime, scheduling, security, sessions, transport, and updates.
Ordinary broker package tests and support fixtures live beside it under
`packages/typescript/broker/test/`. Adapter-unit tests live with their provider
under `packages/typescript/adapters/<provider>/test/`; cross-provider and
broker-lifecycle tests remain broker-owned. Browser, release, physical-host,
and operational harnesses remain under `scripts/broker/`; client scripts live
under `scripts/client/`, and cross-product contract tooling under
`scripts/contracts/`.

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
provider-neutral diagnosis policy helpers. Broker-owned journal parsing and
storage knowledge stay in the broker. Each concrete provider has an independent
package under `packages/typescript/adapters/`, depends on `adapter-api`, and is
registered only by broker composition.

`transport` moves opaque envelopes and deliberately has no crypto dependency.
`transport-wire` is the crypto-aware bridge that owns encrypted framing,
identity authentication, and replay protection. Keeping those packages
separate lets transport implementations remain payload-agnostic; neither is the
semantic client contract.

Flutter sessions code is organized by user capability under `artifacts`,
`attachments`, `detail`, `list`, `renderers`, `requests`, `roster`,
`transcript`, and `workspace`, with `sessions.dart` as the explicit facade.
Conditional platform implementations and coherent Dart part libraries remain
separate where the compiler boundary is useful.

Files have no line-count ceiling. Module boundaries follow ownership, cohesion,
and dependency direction. `bun run ci:check-boundaries` enforces package and
platform directions, including a dependency allowlist for `adapter-api` and
broker/sibling-adapter rejection across every concrete adapter. It applies the
client platform boundary to every Sessions capability file as well as the
remaining feature `view/` directories, evaluates raw WebSocket use per file,
and rejects any inward import or export whose URI ends in `sessions.dart`.
