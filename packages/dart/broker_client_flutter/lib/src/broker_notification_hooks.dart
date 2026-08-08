import 'package:broker_client_flutter/src/app_lifecycle_monitor.dart';
import 'package:broker_contract/broker_contract.dart';

/// Importance levels for local notification requests.
enum BrokerNotificationImportance {
  /// Non-urgent notification payload.
  low,

  /// Normal notification payload.
  normal,

  /// Urgent notification payload requiring user action or attention.
  high,
}

/// Notification categories for local notification surfaces.
enum BrokerNotificationCategory {
  /// User input is required to continue.
  actionRequired,

  /// Informational alert.
  info,

  /// Non-actionable maintenance notice.
  maintenance,

  /// Error payload with non-recoverable or immediate attention.
  error,
}

/// Stable local-notification identity shared by durable attention delivery
/// and its attached-session fallback.
///
/// [dedupeKey] is broker-owned notification meaning. [brokerProfileId] keeps
/// identical broker keys from colliding across saved profiles.
String brokerAttentionNotificationId({
  required String brokerProfileId,
  required String dedupeKey,
}) {
  final profile = brokerProfileId.trim();
  final key = dedupeKey.trim();
  if (profile.isEmpty) {
    throw ArgumentError.value(
      brokerProfileId,
      'brokerProfileId',
      'must not be blank',
    );
  }
  if (key.isEmpty) {
    throw ArgumentError.value(dedupeKey, 'dedupeKey', 'must not be blank');
  }
  return 'attention-dedupe:${_jenkins32('profile=$profile\ndedupe=$key')}';
}

/// Immutable request model for broker notification sinks.
final class BrokerNotificationRequest {
  /// Creates an immutable notification request.
  BrokerNotificationRequest({
    required this.id,
    required this.title,
    required this.body,
    required this.category,
    required this.importance,
    required Map<String, Object?> payload,
    required this.createdAt,
  }) : payload = Map.unmodifiable(payload);

  /// Stable request identity used by sink implementations.
  final String id;

  /// User-facing title.
  final String title;

  /// User-facing body.
  final String body;

  /// Generic category used for routing decisions.
  final BrokerNotificationCategory category;

  /// Optional importance hint.
  final BrokerNotificationImportance importance;

  /// Opaque metadata payload.
  final Map<String, Object?> payload;

  /// Time of request creation.
  final DateTime createdAt;
}

/// Sink interface for local notifications.
abstract interface class BrokerNotificationSink {
  /// Shows one local notification request.
  Future<void> show(BrokerNotificationRequest request);

  /// Clears one local notification by id.
  Future<void> clear(String id);

  /// Clears only the supplied local-notification identities.
  Future<void> clearMany(Iterable<String> ids);

  /// Clears all local notifications known to the sink.
  Future<void> clearAll();
}

/// Default no-op sink used until OS/plugin integration is added.
final class NoopBrokerNotificationSink implements BrokerNotificationSink {
  /// Default no-op constructor.
  const NoopBrokerNotificationSink();

  @override
  Future<void> show(BrokerNotificationRequest request) async {}

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
}

/// Policy for deciding when a session event should surface a notification.
// ignore: one_member_abstracts
abstract interface class BrokerSessionNotificationPolicy {
  /// Evaluates a wire event and emits a notification when policy rules match.
  Future<void> maybeNotifyForSessionEvent({
    required String tool,
    required String sessionId,
    required WireEvent event,
    String? brokerProfileId,
  });
}

/// Default policy for session notifications.
final class DefaultBrokerSessionNotificationPolicy
    implements BrokerSessionNotificationPolicy {
  /// Evaluates a wire event and emits a notification when policy rules match.
  const DefaultBrokerSessionNotificationPolicy({
    required this.lifecycleMonitor,
    required this.sink,
    this.now,
  });

  /// Lifecycle monitor used to suppress foreground notifications.
  final BrokerAppLifecycleMonitor lifecycleMonitor;

  /// Sink that receives derived notification requests.
  final BrokerNotificationSink sink;

  /// Optional clock override for deterministic tests.
  final DateTime Function()? now;

  @override
  Future<void> maybeNotifyForSessionEvent({
    required String tool,
    required String sessionId,
    required WireEvent event,
    String? brokerProfileId,
  }) async {
    if (lifecycleMonitor.currentState == BrokerAppLifecycleState.resumed) {
      return;
    }

    final request = _requestFromEvent(
      tool: tool,
      sessionId: sessionId,
      event: event,
      brokerProfileId: brokerProfileId,
    );
    if (request == null) {
      return;
    }

    await sink.show(request);
  }

  BrokerNotificationRequest? _requestFromEvent({
    required String tool,
    required String sessionId,
    required WireEvent event,
    required String? brokerProfileId,
  }) {
    return switch (event) {
      MessageWireEvent(:final message, :final seq) => _requestFromMessageEvent(
        tool: tool,
        sessionId: sessionId,
        seq: seq,
        message: message,
        brokerProfileId: brokerProfileId,
      ),
      ErrorWireEvent(:final message) => _requestFromErrorEvent(
        tool: tool,
        sessionId: sessionId,
        message: message,
      ),
      _ => null,
    };
  }

  BrokerNotificationRequest? _requestFromMessageEvent({
    required String tool,
    required String sessionId,
    required int seq,
    required AgentMessage message,
    required String? brokerProfileId,
  }) {
    if (seq <= 0) {
      return null;
    }

    final requestId = _extractRequestId(message);
    final messageType = message.type;

    if (messageType == AgentMessageType.permissionRequest ||
        messageType == AgentMessageType.questionRequest) {
      final attentionDedupeKey = _attentionDedupeKey(
        tool: tool,
        sessionId: sessionId,
        messageType: messageType,
        requestId: requestId,
      );
      final normalizedProfileId = brokerProfileId?.trim();
      return BrokerNotificationRequest(
        id:
            normalizedProfileId != null &&
                normalizedProfileId.isNotEmpty &&
                attentionDedupeKey != null
            ? brokerAttentionNotificationId(
                brokerProfileId: normalizedProfileId,
                dedupeKey: attentionDedupeKey,
              )
            : _stableId(
                tool: tool,
                sessionId: sessionId,
                eventKind: 'message',
                message: message,
                seq: seq,
              ),
        title: 'Session requires your response',
        body:
            'A live session message requires user input'
            ' before the agent can continue.',
        category: BrokerNotificationCategory.actionRequired,
        importance: BrokerNotificationImportance.high,
        payload: {
          'tool': tool,
          'sessionId': sessionId,
          'messageType': messageType.wireValue,
          'seq': seq,
          'requestId': requestId,
          if (normalizedProfileId != null && normalizedProfileId.isNotEmpty)
            'brokerProfileId': normalizedProfileId,
          if (attentionDedupeKey != null &&
              normalizedProfileId != null &&
              normalizedProfileId.isNotEmpty)
            'attentionDedupeKey': attentionDedupeKey,
        },
        createdAt: now?.call() ?? DateTime.now(),
      );
    }

    if (messageType == AgentMessageType.error) {
      return BrokerNotificationRequest(
        id: _stableId(
          tool: tool,
          sessionId: sessionId,
          eventKind: 'message',
          message: message,
          seq: seq,
        ),
        title: 'Session error',
        body:
            'The session reported an error and may need attention. '
            'This could indicate a failed request.',
        category: BrokerNotificationCategory.error,
        importance: BrokerNotificationImportance.high,
        payload: {
          'tool': tool,
          'sessionId': sessionId,
          'messageType': messageType.wireValue,
          'seq': seq,
          'requestId': requestId,
        },
        createdAt: now?.call() ?? DateTime.now(),
      );
    }

    return null;
  }

  BrokerNotificationRequest? _requestFromErrorEvent({
    required String tool,
    required String sessionId,
    required String message,
  }) {
    final normalized = message.trim();
    if (normalized.isEmpty) {
      return null;
    }

    return BrokerNotificationRequest(
      id: _stableId(
        tool: tool,
        sessionId: sessionId,
        eventKind: 'error',
        messageText: normalized,
      ),
      title: 'Session error',
      body:
          'The broker reported a session error while app was in background '
          'or hidden.',
      category: BrokerNotificationCategory.error,
      importance: BrokerNotificationImportance.high,
      payload: {
        'tool': tool,
        'sessionId': sessionId,
        'errorMessage': normalized,
      },
      createdAt: now?.call() ?? DateTime.now(),
    );
  }

  static String _stableId({
    required String tool,
    required String sessionId,
    required String eventKind,
    AgentMessage? message,
    int? seq,
    String? messageText,
  }) {
    final components = <String, String>{
      'tool': tool,
      'session': sessionId,
      'kind': eventKind,
      'type': message?.type.wireValue ?? 'unknown',
      if (seq != null) 'seq': '$seq',
      if (message != null) 'request': _extractRequestId(message),
      if (message?.id != null) 'id': message!.id!,
      if (message == null && messageText != null) 'error': messageText,
    }..removeWhere((key, value) => value.trim().isEmpty);

    final canonical = components.entries
        .map((entry) => '${entry.key}=${entry.value}')
        .join('\n');
    return 'session-notification:${_jenkins32(canonical)}';
  }

  static String _extractRequestId(AgentMessage message) {
    const keys = ['requestId', 'id', 'permissionId', 'questionId'];

    for (final key in keys) {
      final value = message.raw[key];
      if (value is String) {
        final trimmed = value.trim();
        if (trimmed.isNotEmpty) {
          return trimmed;
        }
      }
    }

    if (message.id != null && message.id!.trim().isNotEmpty) {
      return message.id!.trim();
    }

    return '';
  }

  static String? _attentionDedupeKey({
    required String tool,
    required String sessionId,
    required AgentMessageType messageType,
    required String requestId,
  }) {
    if (requestId.isEmpty) return null;
    final kind = switch (messageType) {
      AgentMessageType.permissionRequest => 'permission-required',
      AgentMessageType.questionRequest => 'question-required',
      _ => null,
    };
    if (kind == null) return null;
    return '$kind:$tool:$sessionId:$requestId';
  }
}

String _jenkins32(String value) {
  // Jenkins one-at-a-time hash. Deterministic and dependency-free; not
  // cryptographic. Keep arithmetic 32-bit so web builds avoid rounded ints.
  var hash = 0;
  for (final unit in value.codeUnits) {
    hash = 0xffffffff & (hash + unit);
    hash = 0xffffffff & (hash + (hash << 10));
    hash ^= hash >> 6;
  }
  hash = 0xffffffff & (hash + (hash << 3));
  hash ^= hash >> 11;
  hash = 0xffffffff & (hash + (hash << 15));
  return hash.toUnsigned(32).toRadixString(16).padLeft(8, '0');
}
