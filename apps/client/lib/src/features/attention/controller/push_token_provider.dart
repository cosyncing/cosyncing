/// Provider-neutral abstractions for push-token sources.
library;

/// Supported push notification backends.
enum PushTokenPlatform {
  /// Apple Push Notification Service.
  apns('apns'),

  /// Firebase Cloud Messaging.
  fcm('fcm');

  /// Creates a token platform enum value.
  const PushTokenPlatform(this.wireValue);

  /// Route-level platform value for broker registration payloads.
  final String wireValue;
}

/// Abstraction that emits token updates for platform push systems.
abstract interface class PushTokenProvider {
  /// The backing push platform.
  PushTokenPlatform get platform;

  /// Returns the current token if known.
  Future<String?> currentToken();

  /// Emits token changes over time.
  Stream<String?> tokenChanges();

  /// Release provider resources.
  void dispose();
}

/// Emits content-free provider wake signals after platform delivery.
// ignore: one_member_abstracts
abstract interface class PushWakeSignalProvider {
  /// Emits once per opaque wake; payload content is intentionally unavailable.
  Stream<void> wakeSignals();
}

/// No-op provider used on unsupported platforms.
final class NoopPushTokenProvider
    implements PushTokenProvider, PushWakeSignalProvider {
  /// Creates a provider-neutral no-op implementation.
  const NoopPushTokenProvider({
    this.platform = PushTokenPlatform.fcm,
  });

  @override
  final PushTokenPlatform platform;

  @override
  Future<String?> currentToken() async => null;

  @override
  Stream<String?> tokenChanges() => const Stream<String?>.empty();

  @override
  Stream<void> wakeSignals() => const Stream<void>.empty();

  @override
  void dispose() {}
}
