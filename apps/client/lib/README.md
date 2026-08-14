# Flutter source

This directory contains the production Flutter application.

- `src/app/` owns application composition, routing, and the root view.
- `src/design/` owns shared themes and components.
- `src/features/` groups product behavior by capability. Sessions are further
  divided into list, detail, transcript, attachment, request, roster, artifact,
  renderer, and workspace capabilities.
- `src/platform/` contains platform adapters for startup, updates, speech, and
  artifact handling.
- `src/local/` owns client-local persistence shared across features.
- `l10n/` contains localization source and generated localization output.

Feature code must use the typed Dart contract and client packages rather than
decode broker transport payloads directly. Sessions code imports explicit
capabilities; `src/features/sessions/sessions.dart` is the outward-facing facade
and must not be imported inward by Sessions implementation files.

See the [monorepo architecture](../../../docs/architecture/monorepo.md) and
[client README](../README.md) for dependency rules and verification commands.
