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

  /// Reads the current display permission without prompting.
  Future<NotificationPermissionStatus> permissionStatus();

  /// Prompts for display permission where the platform has a prompt.
  Future<NotificationPermissionStatus> requestPermission();

  /// Whether the OS owns per-type settings (Android channels).
  bool get systemManagesChannels;

  /// Creates or renames platform channels and deletes obsolete ones.
  Future<void> configureChannels({
    required List<BrokerNotificationChannelGroup> groups,
    required List<BrokerNotificationChannel> channels,
    required Set<String> obsoleteChannelIds,
  });

  /// Current user-owned channel state by channel id. Empty where the OS has
  /// no channels.
  Future<Map<String, NotificationChannelState>> channelStates();

  /// Shows one notification.
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required BrokerNotificationRequest request,
  });

  /// Clears one notification by platform id.
  Future<void> clear(int id);

  /// Clears all platform notifications known to the plugin.
  Future<void> clearAll();
}

/// Receives a serialized local-notification payload after an explicit tap.
typedef FlutterLocalNotificationTapHandler = void Function(String? payload);

/// Display-permission states the app distinguishes.
enum NotificationPermissionState {
  /// Notifications may be shown.
  granted,

  /// Not granted, and the platform does not say whether a prompt would still
  /// appear (Android and Darwin report only enabled/disabled). Callers that
  /// remember having prompted can treat this as [denied].
  notGranted,

  /// The user or system refused, and prompting again shows nothing.
  denied,

  /// This platform or context cannot show notifications at all.
  unsupported,

  /// Reading or requesting permission failed.
  error,
}

/// A permission state with a machine-readable reason.
final class NotificationPermissionStatus {
  /// Creates a permission status.
  const NotificationPermissionStatus(this.state, {this.reason});

  /// Granted.
  static const granted = NotificationPermissionStatus(
    NotificationPermissionState.granted,
  );

  /// Stable state.
  final NotificationPermissionState state;

  /// Why, for [NotificationPermissionState.unsupported] and
  /// [NotificationPermissionState.error] (`insecure-context`, `no-api`,
  /// `initialization-failed: …`).
  final String? reason;

  /// Whether notifications may be shown now.
  bool get isGranted => state == NotificationPermissionState.granted;
}

/// User-owned state of one platform channel.
final class NotificationChannelState {
  /// Creates a channel state.
  const NotificationChannelState({required this.enabled, required this.sound});

  /// Whether the user left the channel on.
  final bool enabled;

  /// Whether the channel plays a sound.
  final bool sound;
}

/// Local notification sink backed by `flutter_local_notifications`.
///
/// - Initialization is lazy and idempotent, and never throws past a caller:
///   an initialization failure becomes a `failed` delivery or an `error`
///   permission status. (A release build whose small icon was stripped used to
///   fail here on every call while the Settings button reported only
///   "failed".)
/// - Permission is never requested from [show].
/// - [show] reports blocked/unavailable/failed instead of pretending success.
final class FlutterLocalNotificationSink implements BrokerNotificationSink {
  /// Creates a sink using the flutter_local_notifications backend.
  ///
  /// [androidDefaultIcon] is configurable because runner icon resources differ
  /// across packaging targets.
  FlutterLocalNotificationSink({
    FlutterLocalNotificationBackend? backend,
    String androidDefaultIcon = 'ic_launcher',
    String? windowsIconPath,
    this.onTap,
  }) : _backend =
           backend ??
           _FlutterLocalNotificationsBackend(
             androidDefaultIcon: androidDefaultIcon,
             windowsIconPath: windowsIconPath,
           );

  final FlutterLocalNotificationBackend _backend;

  /// Optional navigation callback for an explicit platform notification tap.
  final FlutterLocalNotificationTapHandler? onTap;
  Future<void>? _initializationFuture;
  _ChannelConfiguration? _channelConfiguration;
  Future<void>? _channelConfigurationFuture;

  /// Initializes tap handling and consumes any notification-launch payload.
  ///
  /// The app calls this during root startup so a terminated-app notification
  /// tap is recovered even when no new notification is shown afterward.
  Future<void> initialize() => _ensureInitialized();

  /// Whether the OS owns per-type settings on this platform.
  bool get systemManagesChannels => _backend.systemManagesChannels;

  /// Declares the notification types. On Android this creates the channel
  /// groups and channels (so they appear in system settings before the first
  /// notification) and deletes [obsoleteChannelIds].
  Future<void> configureChannels({
    required List<BrokerNotificationChannelGroup> groups,
    required List<BrokerNotificationChannel> channels,
    Set<String> obsoleteChannelIds = const {},
  }) {
    _channelConfiguration = _ChannelConfiguration(
      groups: groups,
      channels: channels,
      obsoleteChannelIds: obsoleteChannelIds,
    );
    return _channelConfigurationFuture = _applyChannelConfiguration();
  }

  /// Current user-owned channel state by channel id (Android only).
  Future<Map<String, NotificationChannelState>> channelStates() async {
    try {
      await _ensureInitialized();
      await _channelConfigurationFuture;
      return await _backend.channelStates();
    } on Object {
      return const {};
    }
  }

  /// Reads the current display permission without prompting.
  Future<NotificationPermissionStatus> permissionStatus() async {
    final initError = await _initializationError();
    if (initError != null) return initError;
    try {
      return await _backend.permissionStatus();
    } on Object catch (error) {
      return NotificationPermissionStatus(
        NotificationPermissionState.error,
        reason: error.toString(),
      );
    }
  }

  /// Requests notification display permission for the current platform.
  ///
  /// Call this directly from the user's tap: browsers and Safari only show the
  /// prompt inside a user gesture.
  Future<NotificationPermissionStatus> requestPermission() async {
    final initError = await _initializationError();
    if (initError != null) return initError;
    try {
      return await _backend.requestPermission();
    } on Object catch (error) {
      return NotificationPermissionStatus(
        NotificationPermissionState.error,
        reason: error.toString(),
      );
    }
  }

  @override
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  ) async {
    final initError = await _initializationError();
    if (initError != null) {
      return BrokerNotificationDeliveryResult(
        BrokerNotificationDeliveryOutcome.failed,
        reason: initError.reason,
      );
    }
    final permission = await permissionStatus();
    switch (permission.state) {
      case NotificationPermissionState.granted:
        break;
      case NotificationPermissionState.notGranted:
      case NotificationPermissionState.denied:
        return const BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.blocked,
          reason: BrokerNotificationDeliveryResult.permissionNotGrantedReason,
        );
      case NotificationPermissionState.unsupported:
        return BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.unavailable,
          reason: permission.reason ?? 'unsupported',
        );
      case NotificationPermissionState.error:
        return BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.failed,
          reason: permission.reason ?? 'permission-error',
        );
    }
    if (_backend.systemManagesChannels) {
      final state = (await channelStates())[request.channel.id];
      if (state != null && !state.enabled) {
        return const BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.blocked,
          reason: 'channel-off',
        );
      }
    }
    try {
      await _backend.show(
        id: derivePlatformNotificationId(request.id),
        title: request.title,
        body: request.body,
        payload: serializePayload(request.payload),
        request: request,
      );
      return BrokerNotificationDeliveryResult.shown;
    } on Object catch (error) {
      return BrokerNotificationDeliveryResult(
        BrokerNotificationDeliveryOutcome.failed,
        reason: error.toString(),
      );
    }
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

  /// Maps one request to every plugin platform.
  @visibleForTesting
  static NotificationDetails notificationDetailsFor(
    BrokerNotificationRequest request,
  ) {
    final channel = request.channel;
    final urgent = channel.urgent;
    final darwinDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBanner: true,
      presentList: true,
      presentSound: request.playSound,
      // `passive` files the notification silently into Notification Center
      // with no banner. Every presented type is meant to be seen.
      interruptionLevel: InterruptionLevel.active,
      threadIdentifier: request.threadKey,
    );

    return NotificationDetails(
      android: AndroidNotificationDetails(
        channel.id,
        channel.name,
        channelDescription: channel.description,
        importance: androidImportanceFor(channel),
        // Pre-channel Android (API < 26) needs HIGH priority for a heads-up.
        priority: Priority.high,
        playSound: channel.defaultSound,
        enableVibration: channel.defaultSound,
        // Android's per-channel lock-screen setting decides what shows while
        // locked ("Hide sensitive content" hides the body).
        visibility: NotificationVisibility.private,
        groupKey: request.threadKey,
      ),
      iOS: darwinDetails,
      macOS: darwinDetails,
      linux: LinuxNotificationDetails(
        urgency: urgent
            ? LinuxNotificationUrgency.critical
            : LinuxNotificationUrgency.normal,
        suppressSound: !request.playSound,
        resident: urgent,
        defaultActionName: 'Open',
      ),
      windows: WindowsNotificationDetails(
        audio: request.playSound
            ? WindowsNotificationAudio.preset(
                sound: WindowsNotificationSound.defaultSound,
              )
            : WindowsNotificationAudio.silent(),
        duration: urgent
            ? WindowsNotificationDuration.long
            : WindowsNotificationDuration.short,
        scenario: urgent ? WindowsNotificationScenario.urgent : null,
      ),
      web: WebNotificationDetails(
        isSilent: !request.playSound,
        requireInteraction: urgent,
      ),
    );
  }

  /// Windows' per-app toast setting as a permission. Windows has no prompt;
  /// the user turns toasts on or off in system settings.
  @visibleForTesting
  static NotificationPermissionStatus windowsPermissionFor(
    WindowsNotificationSetting? setting,
  ) => switch (setting) {
    // Unknown (the read failed): do not block delivery on a guess.
    null ||
    WindowsNotificationSetting.enabled => NotificationPermissionStatus.granted,
    WindowsNotificationSetting.disabledForApplication ||
    WindowsNotificationSetting.disabledForUser =>
      const NotificationPermissionStatus(NotificationPermissionState.denied),
    WindowsNotificationSetting.disabledByGroupPolicy =>
      const NotificationPermissionStatus(
        NotificationPermissionState.unsupported,
        reason: 'group-policy',
      ),
    WindowsNotificationSetting.disabledByManifest =>
      const NotificationPermissionStatus(
        NotificationPermissionState.unsupported,
        reason: 'manifest',
      ),
  };

  /// Android channel importance for a type's defaults. Heads-up needs HIGH;
  /// an off-by-default type is created blocked so the user turns it on.
  @visibleForTesting
  static Importance androidImportanceFor(BrokerNotificationChannel channel) {
    if (!channel.defaultEnabled) return Importance.none;
    // Every presented type pops up; a quiet type is a HIGH channel with its
    // sound off, not a lower importance.
    return Importance.high;
  }

  Future<NotificationPermissionStatus?> _initializationError() async {
    try {
      await _ensureInitialized();
      return null;
    } on Object catch (error) {
      return NotificationPermissionStatus(
        NotificationPermissionState.error,
        reason: 'initialization-failed: $error',
      );
    }
  }

  Future<void> _applyChannelConfiguration() async {
    final configuration = _channelConfiguration;
    if (configuration == null) return;
    try {
      await _ensureInitialized();
      await _backend.configureChannels(
        groups: configuration.groups,
        channels: configuration.channels,
        obsoleteChannelIds: configuration.obsoleteChannelIds,
      );
    } on Object {
      // Channels are created again on the next configuration or start; a
      // failure here also surfaces through show() and permissionStatus().
    }
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

final class _ChannelConfiguration {
  const _ChannelConfiguration({
    required this.groups,
    required this.channels,
    required this.obsoleteChannelIds,
  });

  final List<BrokerNotificationChannelGroup> groups;
  final List<BrokerNotificationChannel> channels;
  final Set<String> obsoleteChannelIds;
}

/// Plugin-backed backend implementation.
final class _FlutterLocalNotificationsBackend
    implements FlutterLocalNotificationBackend {
  /// Creates a plugin-backed backend.
  _FlutterLocalNotificationsBackend({
    this._androidDefaultIcon = 'ic_launcher',
    this._windowsIconPath,
  }) : _plugin = FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  final String _androidDefaultIcon;
  final String? _windowsIconPath;

  AndroidFlutterLocalNotificationsPlugin? get _android => _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();

  IOSFlutterLocalNotificationsPlugin? get _iOS => _plugin
      .resolvePlatformSpecificImplementation<
        IOSFlutterLocalNotificationsPlugin
      >();

  MacOSFlutterLocalNotificationsPlugin? get _macOS => _plugin
      .resolvePlatformSpecificImplementation<
        MacOSFlutterLocalNotificationsPlugin
      >();

  WebFlutterLocalNotificationsPlugin? get _web => _plugin
      .resolvePlatformSpecificImplementation<
        WebFlutterLocalNotificationsPlugin
      >();

  FlutterLocalNotificationsWindows? get _windows => _plugin
      .resolvePlatformSpecificImplementation<
        FlutterLocalNotificationsWindows
      >();

  @override
  bool get systemManagesChannels => _android != null;

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    await _plugin.initialize(
      settings: InitializationSettings(
        android: AndroidInitializationSettings(_androidDefaultIcon),
        // Never prompt during initialization; the app asks from a user tap.
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
        windows: WindowsInitializationSettings(
          appName: 'Cosyncing',
          appUserModelId: 'com.cosyncing.client',
          guid: '8f867039-cc96-4a81-9935-966ad6eb89ea',
          iconPath: _windowsIconPath,
        ),
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
  Future<NotificationPermissionStatus> permissionStatus() async {
    final android = _android;
    if (android != null) {
      return _fromEnabled(await android.areNotificationsEnabled());
    }
    final darwin = _iOS;
    if (darwin != null) {
      return _fromEnabled((await darwin.checkPermissions())?.isEnabled);
    }
    final macOS = _macOS;
    if (macOS != null) {
      return _fromEnabled((await macOS.checkPermissions())?.isEnabled);
    }
    final web = _web;
    if (web != null) return _fromWeb(web.permissionStatus);
    final windows = _windows;
    if (windows != null) {
      return FlutterLocalNotificationSink.windowsPermissionFor(
        windows.notificationSetting(),
      );
    }
    // Linux has no app-level prompt or readable per-app switch.
    return NotificationPermissionStatus.granted;
  }

  @override
  Future<NotificationPermissionStatus> requestPermission() async {
    final android = _android;
    if (android != null) {
      final granted = await android.requestNotificationsPermission();
      return granted == true
          ? NotificationPermissionStatus.granted
          : const NotificationPermissionStatus(
              NotificationPermissionState.denied,
            );
    }
    final iOS = _iOS;
    if (iOS != null) {
      final granted = await iOS.requestPermissions(
        alert: true,
        badge: true,
        sound: true,
      );
      return _fromPromptResult(granted);
    }
    final macOS = _macOS;
    if (macOS != null) {
      final granted = await macOS.requestPermissions(
        alert: true,
        badge: true,
        sound: true,
      );
      return _fromPromptResult(granted);
    }
    final web = _web;
    if (web != null) {
      await web.requestNotificationsPermission();
      return _fromWeb(web.permissionStatus);
    }
    // Windows has no prompt: the per-app switch lives in system settings.
    return permissionStatus();
  }

  @override
  Future<void> configureChannels({
    required List<BrokerNotificationChannelGroup> groups,
    required List<BrokerNotificationChannel> channels,
    required Set<String> obsoleteChannelIds,
  }) async {
    final android = _android;
    if (android == null) return;
    for (final id in obsoleteChannelIds) {
      await android.deleteNotificationChannel(channelId: id);
    }
    for (final group in groups) {
      await android.createNotificationChannelGroup(
        AndroidNotificationChannelGroup(group.id, group.name),
      );
    }
    for (final channel in channels) {
      // Re-creating an existing id only updates its name/description/group;
      // Android keeps the user's importance and sound.
      await android.createNotificationChannel(
        AndroidNotificationChannel(
          channel.id,
          channel.name,
          description: channel.description,
          groupId: channel.groupId,
          importance: FlutterLocalNotificationSink.androidImportanceFor(
            channel,
          ),
          playSound: channel.defaultSound,
          enableVibration: channel.defaultSound,
        ),
      );
    }
  }

  @override
  Future<Map<String, NotificationChannelState>> channelStates() async {
    final android = _android;
    if (android == null) return const {};
    final channels = await android.getNotificationChannels() ?? const [];
    return {
      for (final channel in channels)
        channel.id: NotificationChannelState(
          enabled: channel.importance != Importance.none,
          sound: channel.playSound,
        ),
    };
  }

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required BrokerNotificationRequest request,
  }) async {
    await _plugin.show(
      id: id,
      title: title,
      body: body.isEmpty ? null : body,
      notificationDetails: FlutterLocalNotificationSink.notificationDetailsFor(
        request,
      ),
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

  static NotificationPermissionStatus _fromEnabled(bool? enabled) =>
      enabled == true
      ? NotificationPermissionStatus.granted
      : const NotificationPermissionStatus(
          NotificationPermissionState.notGranted,
        );

  static NotificationPermissionStatus _fromPromptResult(bool? granted) =>
      granted == true
      ? NotificationPermissionStatus.granted
      : const NotificationPermissionStatus(NotificationPermissionState.denied);

  static NotificationPermissionStatus _fromWeb(
    WebNotificationPermission permission,
  ) => switch (permission) {
    WebNotificationPermission.granted => NotificationPermissionStatus.granted,
    WebNotificationPermission.denied => const NotificationPermissionStatus(
      NotificationPermissionState.denied,
    ),
    _ => const NotificationPermissionStatus(
      NotificationPermissionState.notGranted,
    ),
  };
}
