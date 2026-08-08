# Attention feed architecture

The broker owns notification meaning. It records typed attention events in a
durable feed; clients fetch that feed after authentication and decide how to
present it. Push transports, when configured, carry only an opaque wake signal
and never contain prompts, paths, session text, or credentials.

## Durable state

- Events use stable deduplication keys, monotonic cursors, revisions, explicit
  active/resolved state, severity, presentation revision, and typed actions.
- The store writes a complete versioned snapshot through staged, synchronized,
  atomic replacement. Corrupt startup state is quarantined and reported through
  broker health instead of being silently discarded.
- Read and dismiss state is scoped by client id. One device cannot acknowledge
  or dismiss another device's view.
- Resolved events and delivery records are bounded by explicit retention and
  count limits. Policy changes must preserve deterministic pruning and recovery.
- Broker-health episodes are reconciled from durable observations after restart.
  The store, not process memory, is authoritative. If the attention store itself
  fails, health reporting must not recursively write through it.

## API and client behavior

Authenticated clients page `/api/attention-events` by cursor and post read or
dismiss mutations to the corresponding event routes. The Flutter client commits
feed pages and cursors together, persists local read/dismiss intent before the
network mutation, and retries pending mutations. Local notification delivery is
policy-controlled and must not duplicate a feed event already owned by the
durable path.

Remote wake is deployment-dependent. The default build provides no production
push provider and must not advertise terminated-app wake. If a provider is
later enabled, registration, rotation, revocation, consent, and end-to-end
opaque-payload evidence are required before the capability is claimed.

## Verification

The deterministic broker suites cover persistence, deduplication, per-client
state, corruption recovery, pruning, reminder delivery, health episodes, API
authentication, and route registration. Client suites cover durable paging,
mutation retry, source exclusivity, notification policy, inbox actions, and
opaque-wake catch-up. Packaged platform notification behavior remains an
explicit roadmap evidence gate.
