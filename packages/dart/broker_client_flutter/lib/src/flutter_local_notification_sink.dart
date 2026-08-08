import 'dart:convert';

import 'package:broker_client_flutter/src/broker_notification_hooks.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Platform/backend abstraction for notification delivery so tests can avoid
/// invoking OS APIs.
abstract interface class FlutterLocalNotificationBackend {
  /// Initializes the notification runtime.
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap});

  /// Returns payload for a launch that opened the app via notification.
  Future<String?> getLaunchPayload();

  /// Requests notification display permission for the current platform.
  Future<FlutterLocalNotificationPermissionRequestResult> requestPermission();

  /// Shows one notification.
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required FlutterLocalNotificationDisplayOptions options,
  });

  /// Clears one notification by platform id.
  Future<void> clear(int id);

  /// Clears all platform notifications known to the plugin.
  Future<void> clearAll();
}

/// Receives a serialized local-notification payload after an explicit tap.
typedef FlutterLocalNotificationTapHandler = void Function(String? payload);

/// Result of a display-permission request.
final class FlutterLocalNotificationPermissionRequestResult {
  /// Creates a permission request result.
  const FlutterLocalNotificationPermissionRequestResult({
    required this.outcome,
    this.message,
  });

  /// Stable permission outcomes.
  final FlutterLocalNotificationPermissionRequestOutcome outcome;

  /// Optional platform/transport detail for diagnostics.
  final String? message;
}

/// Supported permission request outcomes.
enum FlutterLocalNotificationPermissionRequestOutcome {
  /// Permission granted.
  granted,

  /// Permission denied.
  denied,

  /// Permission capability is not supported on this platform.
  unsupported,

  /// Permission request failed unexpectedly.
  failed,
}

/// Testable permission request function signature for explicit permission
/// prompts.
typedef FlutterLocalNotificationPermissionRequester =
    Future<FlutterLocalNotificationPermissionRequestResult> Function();

/// Display details resolved from broker-level importance/category.
final class FlutterLocalNotificationDisplayOptions {
  /// Creates resolved display settings.
  const FlutterLocalNotificationDisplayOptions({
    required this.androidImportance,
    required this.androidChannelId,
    required this.androidChannelName,
    required this.androidChannelDescription,
    required this.playSound,
    required this.enableVibration,
  });

  /// Android notification importance to feed plugin details.
  final Importance androidImportance;

  /// Android channel ID used for deterministic mapping.
  final String androidChannelId;

  /// Android channel name used for deterministic mapping.
  final String androidChannelName;

  /// Android channel description used for deterministic mapping.
  final String androidChannelDescription;

  /// Whether to play a sound.
  final bool playSound;

  /// Whether to enable vibration.
  final bool enableVibration;
}

/// Local notification sink backed by `flutter_local_notifications`.
///
/// This is intentionally conservative:
/// - initialization is lazy and idempotent;
/// - permission requests are not triggered from `show`;
/// - importance, sound, and persistence intent are mapped explicitly on every
///   platform supported by the plugin.
///
/// See
/// `docs/architecture/monorepo.md` for module
/// ownership and `docs/protocol/contract-sync.md`
/// for boundary expectations.
final class FlutterLocalNotificationSink implements BrokerNotificationSink {
  /// Creates a sink using the flutter_local_notifications backend.
  ///
  /// [androidDefaultIcon] is configurable because runner icon resources differ
  /// across packaging targets.
  FlutterLocalNotificationSink({
    FlutterLocalNotificationBackend? backend,
    String androidDefaultIcon = 'ic_launcher',
    this.onTap,
  }) : _backend =
           backend ??
           _FlutterLocalNotificationsBackend(
             androidDefaultIcon: androidDefaultIcon,
           );

  final FlutterLocalNotificationBackend _backend;

  /// Optional navigation callback for an explicit platform notification tap.
  final FlutterLocalNotificationTapHandler? onTap;
  Future<void>? _initializationFuture;

  /// Initializes tap handling and consumes any notification-launch payload.
  ///
  /// The app calls this during root startup so a terminated-app notification
  /// tap is recovered even when no new notification is shown afterward.
  Future<void> initialize() => _ensureInitialized();

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    await _ensureInitialized();
    final options = displayOptionsFor(
      importance: request.importance,
      category: request.category,
    );
    await _backend.show(
      id: derivePlatformNotificationId(request.id),
      title: request.title,
      body: request.body,
      payload: serializePayload(request.payload),
      options: options,
    );
  }

  /// Requests notification display permission for the current platform.
  Future<FlutterLocalNotificationPermissionRequestResult>
  requestPermission() async {
    await _ensureInitialized();
    return _backend.requestPermission();
  }

  @override
  Future<void> clear(String id) async {
    await _ensureInitialized();
    await _backend.clear(derivePlatformNotificationId(id));
  }

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    final uniqueIds = ids.toSet();
    if (uniqueIds.isEmpty) return;
    await _ensureInitialized();
    Object? firstError;
    StackTrace? firstStackTrace;
    for (final id in uniqueIds) {
      try {
        await _backend.clear(derivePlatformNotificationId(id));
      } on Object catch (error, stackTrace) {
        firstError ??= error;
        firstStackTrace ??= stackTrace;
      }
    }
    if (firstError != null) {
      Error.throwWithStackTrace(firstError, firstStackTrace!);
    }
  }

  @override
  Future<void> clearAll() async {
    await _ensureInitialized();
    await _backend.clearAll();
  }

  /// Resolves deterministic plugin details from broker importance and category.
  static FlutterLocalNotificationDisplayOptions displayOptionsFor({
    required BrokerNotificationImportance importance,
    required BrokerNotificationCategory category,
  }) {
    final importanceLevel = switch (importance) {
      BrokerNotificationImportance.low => Importance.low,
      BrokerNotificationImportance.normal => Importance.defaultImportance,
      BrokerNotificationImportance.high => Importance.high,
    };

    final (channelId, channelName, channelDescription, _) = switch (category) {
      BrokerNotificationCategory.actionRequired => (
        'cosyncing_session_action',
        'Session Action Requests',
        'Session events requiring direct user input',
        true,
      ),
      BrokerNotificationCategory.info => (
        'cosyncing_session_info',
        'Session Information',
        'Informational session updates from background sessions',
        false,
      ),
      BrokerNotificationCategory.maintenance => (
        'cosyncing_session_maintenance',
        'Session Maintenance',
        'Maintenance and health updates from background sessions',
        false,
      ),
      BrokerNotificationCategory.error => (
        'cosyncing_session_error',
        'Session Errors',
        'Session errors and terminal states',
        true,
      ),
    };

    final isUrgent = importance == BrokerNotificationImportance.high;
    final isError = category == BrokerNotificationCategory.error;

    return FlutterLocalNotificationDisplayOptions(
      androidImportance: importanceLevel,
      androidChannelId: channelId,
      androidChannelName: channelName,
      androidChannelDescription: channelDescription,
      playSound: isUrgent || isError,
      enableVibration: isUrgent || isError,
    );
  }

  /// Maps broker-level delivery intent to every plugin platform.
  @visibleForTesting
  static NotificationDetails notificationDetailsFor(
    FlutterLocalNotificationDisplayOptions options,
  ) {
    final linuxUrgency = switch (options.androidImportance) {
      Importance.high || Importance.max => LinuxNotificationUrgency.critical,
      Importance.min || Importance.low => LinuxNotificationUrgency.low,
      _ => LinuxNotificationUrgency.normal,
    };
    final highPriority =
        options.androidImportance == Importance.high ||
        options.androidImportance == Importance.max;
    final darwinDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBanner: true,
      presentList: true,
      presentSound: options.playSound,
      interruptionLevel: options.playSound
          ? InterruptionLevel.active
          : InterruptionLevel.passive,
    );

    return NotificationDetails(
      android: AndroidNotificationDetails(
        options.androidChannelId,
        options.androidChannelName,
        channelDescription: options.androidChannelDescription,
        importance: options.androidImportance,
        playSound: options.playSound,
        enableVibration: options.enableVibration,
      ),
      iOS: darwinDetails,
      macOS: darwinDetails,
      linux: LinuxNotificationDetails(
        urgency: linuxUrgency,
        suppressSound: !options.playSound,
        resident: highPriority,
        defaultActionName: 'Open',
      ),
      windows: WindowsNotificationDetails(
        audio: options.playSound
            ? WindowsNotificationAudio.preset(
                sound: WindowsNotificationSound.defaultSound,
              )
            : WindowsNotificationAudio.silent(),
        duration: highPriority
            ? WindowsNotificationDuration.long
            : WindowsNotificationDuration.short,
        scenario: highPriority ? WindowsNotificationScenario.urgent : null,
      ),
      web: WebNotificationDetails(
        isSilent: !options.playSound,
        requireInteraction: highPriority,
      ),
    );
  }

  Future<void> _ensureInitialized() async {
    final initializationFuture = _initializationFuture;
    if (initializationFuture != null) {
      return initializationFuture;
    }

    final init = _backend.initialize(onTap: onTap);
    _initializationFuture = init;
    try {
      await init;
      final launchPayload = await _backend.getLaunchPayload();
      if (onTap != null &&
          launchPayload != null &&
          launchPayload.trim().isNotEmpty) {
        onTap!(launchPayload);
      }
    } catch (_) {
      _initializationFuture = null;
      rethrow;
    }
  }

  /// Derives a deterministic positive platform id from a broker id.
  @visibleForTesting
  static int derivePlatformNotificationId(String requestId) {
    final normalized = requestId.trim();
    if (normalized.isEmpty) {
      return 0;
    }
    return _jenkins32(normalized).toUnsigned(31);
  }

  /// Serializes request payload into deterministic, key-sorted JSON.
  @visibleForTesting
  static String? serializePayload(Map<String, Object?> payload) {
    if (payload.isEmpty) {
      return null;
    }
    final entries = payload.entries.toList()
      ..sort((left, right) => left.key.compareTo(right.key));
    return jsonEncode(Map.fromEntries(entries));
  }

  static int _jenkins32(String value) {
    var hash = 0;
    for (final unit in value.codeUnits) {
      hash = 0xffffffff & (hash + unit);
      hash = 0xffffffff & (hash + (hash << 10));
      hash ^= hash >> 6;
    }
    hash = 0xffffffff & (hash + (hash << 3));
    hash ^= hash >> 11;
    hash = 0xffffffff & (hash + (hash << 15));
    return hash;
  }
}

/// Plugin-backed backend implementation.
final class _FlutterLocalNotificationsBackend
    implements FlutterLocalNotificationBackend {
  /// Creates a plugin-backed backend.
  _FlutterLocalNotificationsBackend({this._androidDefaultIcon = 'ic_launcher'})
    : _plugin = FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  final String _androidDefaultIcon;

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    await _plugin.initialize(
      settings: InitializationSettings(
        android: AndroidInitializationSettings(_androidDefaultIcon),
        iOS: const DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
        macOS: const DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
        linux: const LinuxInitializationSettings(
          defaultActionName: 'defaultAction',
        ),
        // Windows requires explicit values but does not support auto-discovery.
        // Keep conservative defaults here, with OS caveats documented in docs.
        windows: const WindowsInitializationSettings(
          appName: 'Cosyncing',
          appUserModelId: 'com.cosyncing.client',
          guid: '8f867039-cc96-4a81-9935-966ad6eb89ea',
        ),
        // iOS/macOS are intentionally left at conservative defaults to avoid
        // permission prompts during background rendering. A dedicated settings
        // flow can request permissions explicitly if/when local delivery is
        // user-opted-in.
      ),
      onDidReceiveNotificationResponse: (response) {
        onTap?.call(response.payload);
      },
    );
  }

  @override
  Future<String?> getLaunchPayload() async {
    final launchDetails = await _plugin.getNotificationAppLaunchDetails();
    return launchDetails?.notificationResponse?.payload;
  }

  @override
  Future<FlutterLocalNotificationPermissionRequestResult>
  requestPermission() async {
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >();
      if (android != null) {
        return _requestResultFromBoolean(
          await android.requestNotificationsPermission(),
          platform: 'android',
        );
      }

      final iOS = _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >();
      if (iOS != null) {
        return _requestResultFromBoolean(
          await iOS.requestPermissions(alert: true, badge: true, sound: true),
          platform: 'ios',
        );
      }

      final macOS = _plugin
          .resolvePlatformSpecificImplementation<
            MacOSFlutterLocalNotificationsPlugin
          >();
      if (macOS != null) {
        return _requestResultFromBoolean(
          await macOS.requestPermissions(alert: true, badge: true, sound: true),
          platform: 'macos',
        );
      }

      final web = _plugin
          .resolvePlatformSpecificImplementation<
            WebFlutterLocalNotificationsPlugin
          >();
      if (web != null) {
        return _requestResultFromBoolean(
          await web.requestNotificationsPermission(),
          platform: 'web',
        );
      }

      return const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.unsupported,
      );
    } on Object catch (error) {
      return FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.failed,
        message: error.toString(),
      );
    }
  }

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required FlutterLocalNotificationDisplayOptions options,
  }) async {
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: _detailsFromOptions(options),
      payload: payload,
    );
  }

  @override
  Future<void> clear(int id) async {
    await _plugin.cancel(id: id);
  }

  @override
  Future<void> clearAll() async {
    await _plugin.cancelAll();
  }

  NotificationDetails _detailsFromOptions(
    FlutterLocalNotificationDisplayOptions options,
  ) => FlutterLocalNotificationSink.notificationDetailsFor(options);

  FlutterLocalNotificationPermissionRequestResult _requestResultFromBoolean(
    bool? granted, {
    required String platform,
  }) {
    final grantedAsBool = granted ?? false;
    if (grantedAsBool) {
      return const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
      );
    }

    if (granted == false) {
      return const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.denied,
      );
    }

    return FlutterLocalNotificationPermissionRequestResult(
      outcome: FlutterLocalNotificationPermissionRequestOutcome.failed,
      message: 'Received null permission response on $platform.',
    );
  }
}
