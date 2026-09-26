/// Stable local-notification identity for one broker-owned notification slot.
///
/// [dedupeKey] is the collapse key the notification occupies (a request, a
/// session, or an event). [brokerProfileId] keeps identical keys from
/// colliding across saved profiles.
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

/// One user-configurable notification type, presented as a platform channel.
///
/// On Android this is a real `NotificationChannel` whose on/off, sound,
/// pop-up, and lock-screen behaviour the user owns in system settings. Other
/// platforms expose per-app controls only, so the app applies the type's
/// settings itself before posting.
final class BrokerNotificationChannel {
  /// Creates a channel description.
  const BrokerNotificationChannel({
    required this.id,
    required this.name,
    required this.description,
    required this.groupId,
    required this.defaultEnabled,
    required this.defaultSound,
    required this.urgent,
  });

  /// Stable platform channel id. Android channel settings are immutable once
  /// created, so a behaviour change needs a new id, never an edited one.
  final String id;

  /// Localized user-facing name.
  final String name;

  /// Localized user-facing description.
  final String description;

  /// Channel group (notification family) id.
  final String groupId;

  /// Whether the type is on before the user changes anything.
  final bool defaultEnabled;

  /// Whether the type plays a sound before the user changes anything.
  final bool defaultSound;

  /// Whether the type interrupts (heads-up, long toast duration).
  final bool urgent;
}

/// One notification family, presented as an Android channel group.
final class BrokerNotificationChannelGroup {
  /// Creates a channel group description.
  const BrokerNotificationChannelGroup({required this.id, required this.name});

  /// Stable platform group id.
  final String id;

  /// Localized user-facing name.
  final String name;
}

/// Immutable request model for broker notification sinks.
final class BrokerNotificationRequest {
  /// Creates an immutable notification request.
  BrokerNotificationRequest({
    required this.id,
    required this.title,
    required this.body,
    required this.channel,
    required this.playSound,
    required Map<String, Object?> payload,
    required this.createdAt,
    this.threadKey,
    this.alertKey,
  }) : payload = Map.unmodifiable(payload);

  /// Stable request identity used by sink implementations. Showing the same
  /// id again replaces the earlier notification.
  final String id;

  /// User-facing title.
  final String title;

  /// User-facing body. Empty when the type shows its event type only.
  final String body;

  /// Notification type this request belongs to.
  final BrokerNotificationChannel channel;

  /// Whether this presentation plays a sound where the app controls sound.
  final bool playSound;

  /// Visual grouping key (one conversation/session), when any.
  final String? threadKey;

  /// Which alert this presentation raises, when the platform can compare it
  /// with what is showing. Presenting the alert already in the notification's
  /// slot again replaces it without a second sound; a different alert (a new
  /// event, a reminder) alerts again. The browser's push service worker raises
  /// the same keys, so a push and the app's own presentation of one event
  /// alert once.
  final String? alertKey;

  /// Opaque metadata payload returned on tap.
  final Map<String, Object?> payload;

  /// Time of request creation.
  final DateTime createdAt;
}

/// What happened to one presentation attempt.
enum BrokerNotificationDeliveryOutcome {
  /// The platform accepted the notification.
  shown,

  /// The user or system has notifications off for this app or type.
  blocked,

  /// This build or platform cannot present notifications at all.
  unavailable,

  /// Presentation failed unexpectedly and may succeed on a retry.
  failed,
}

/// Outcome of one presentation attempt, with a diagnostic reason.
final class BrokerNotificationDeliveryResult {
  /// Creates a delivery result.
  const BrokerNotificationDeliveryResult(this.outcome, {this.reason});

  /// The platform accepted the notification.
  static const shown = BrokerNotificationDeliveryResult(
    BrokerNotificationDeliveryOutcome.shown,
  );

  /// The [reason] of a blocked result while OS permission is not granted.
  static const permissionNotGrantedReason = 'permission-not-granted';

  /// Stable outcome.
  final BrokerNotificationDeliveryOutcome outcome;

  /// Stable machine-readable reason for a non-shown outcome
  /// (`permission-not-granted`, `channel-off`, `type-off`, `disabled`, …) or
  /// a platform error message.
  final String? reason;

  /// Whether a retry could change the outcome without a user action.
  bool get isRetryable => outcome == BrokerNotificationDeliveryOutcome.failed;

  /// Whether the OS refused only because notifications are not allowed, so a
  /// permission grant would change the outcome.
  bool get isPermissionRefusal =>
      outcome == BrokerNotificationDeliveryOutcome.blocked &&
      reason == permissionNotGrantedReason;
}

/// Sink interface for local notifications.
abstract interface class BrokerNotificationSink {
  /// Presents one local notification request and reports what happened.
  ///
  /// Implementations report failure through the result instead of throwing,
  /// so a caller can tell "the OS refused" from "the OS showed it".
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  );

  /// Clears one local notification by id.
  Future<void> clear(String id);

  /// Clears only the supplied local-notification identities.
  Future<void> clearMany(Iterable<String> ids);

  /// Clears all local notifications known to the sink.
  Future<void> clearAll();
}

/// Sink used while system notifications are switched off in the app.
final class NoopBrokerNotificationSink implements BrokerNotificationSink {
  /// Default no-op constructor.
  const NoopBrokerNotificationSink();

  @override
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  ) async => const BrokerNotificationDeliveryResult(
    BrokerNotificationDeliveryOutcome.blocked,
    reason: 'disabled',
  );

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
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
