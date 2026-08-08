/// Package-internal validator for broker "short policy tokens" — plan keys,
/// plan revisions, and artifact interaction refs.
///
/// Deliberately not exported from `broker_contract.dart`: it is shared only
/// between the models in this package (`agent_message.dart` decoding and
/// `outbound_frame.dart` frame construction) so the accepted character set and
/// length bound stay defined once. Keep this off the barrel to avoid changing
/// the package's exported API surface.
library;

final _shortPolicyTokenPattern = RegExp(r'^[A-Za-z0-9._:-]+$');

/// Whether [value] is a non-empty short policy token within [maxLength].
bool isShortPolicyToken(String value, {int maxLength = 200}) =>
    value.isNotEmpty &&
    value.length <= maxLength &&
    _shortPolicyTokenPattern.hasMatch(value);
