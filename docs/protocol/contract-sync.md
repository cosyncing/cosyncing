# Contract synchronization

The broker is the wire-contract owner. The exporter reads broker source from
this checkout and writes a flattened, self-contained TypeScript snapshot plus
the Dart contract identity:

```bash
bun run contract:generate
bun run contract:check
bun run client:test:contract
```

`contract:check` exports to a temporary directory and compares byte-for-byte.
It never reads a sibling repository and never copies a TypeScript barrel.
Generated files must change in the same pull request as the broker contract and
typed client adaptation. The always-running CI contract job is intentionally
not path-filtered.

The client advertises its version, revision, minimum broker revision, and
surface hash on every stream connection. The broker's first `hello` frame
contains both identities and the negotiated status: compatible,
client-behind, broker-behind, unknown, or hard-incompatible. Hard incompatibility
forces read-only Observe on both sides.

The hash covers the enumerated route, frame-kind, message-kind, and error-code
registries. It is a drift signal, not a canonical schema hash of every DTO.
Any structural wire change must update the flattened snapshot and explicitly
raise the contract revision when compatibility semantics change.
