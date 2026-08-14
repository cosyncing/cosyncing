import 'package:broker_contract/broker_contract.dart';

const _requestIdKeys = <String>[
  'requestId',
  'id',
  'permissionId',
  'questionId',
];

/// Extracts a request id from a message payload.
String? extractRequestIdFromMessage(AgentMessage message) {
  for (final key in _requestIdKeys) {
    final value = message.raw[key];
    if (value is String) {
      final trimmed = value.trim();
      if (trimmed.isNotEmpty) {
        return trimmed;
      }
    }
  }
  return null;
}
