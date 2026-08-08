# Tests

Flutter unit and widget tests belong here.

Expected first tests:

- broker URL/host/port normalization;
- connection form validation;
- broker health probe states;
- protocol contract coverage once broker models are copied/generated.

## Contract Tests

- `test/contract/contract_conformance_test.dart` — focused smoke-conservative
  conformance tests for protocol shape parity.
- Verifies that:
  - the protocol audit still documents the current canonical `WireEvent.kind`
    values,
  - `WireEvent.fromJson` decodes each canonical kind,
  - checked-in broker core snapshot exposes all canonical `AgentMessage.type`
    values through `CANONICAL_MESSAGE_TYPES`,
  - each non-unknown `AgentMessageType` has a renderer/fallback policy, and
  - client-to-broker frame kinds/fields stay aligned with outbound frame
    builders and semantic broker core methods.
- `flutter test test/contract/` is the dedicated contract-gate entrypoint.
