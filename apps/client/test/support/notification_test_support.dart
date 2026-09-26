import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';

/// Scriptable plugin backend behind a real [FlutterLocalNotificationSink], so
/// app tests exercise the sink's permission, channel, and outcome logic.
final class FakeNotificationBackend implements FlutterLocalNotificationBackend {
  FakeNotificationBackend({
    this.permission = const NotificationPermissionStatus(
      NotificationPermissionState.notGranted,
    ),
    this.requestResult = NotificationPermissionStatus.granted,
    this.managesChannels = false,
  });

  /// What [permissionStatus] reports.
  NotificationPermissionStatus permission;

  /// What the OS prompt answers; it also becomes [permission].
  NotificationPermissionStatus requestResult;

  /// Whether this backend behaves like Android (channels in system settings).
  bool managesChannels;

  /// User-owned channel state by id.
  Map<String, NotificationChannelState> channels = {};

  /// Error thrown by [initialize], when set.
  Error? initializeError;

  /// Error thrown by [show], when set.
  Error? showError;

  int initializeCount = 0;
  int permissionRequestCount = 0;
  bool initializedWithTapHandler = false;
  final List<BrokerNotificationRequest> shown = [];
  final List<int> cleared = [];
  int clearAllCount = 0;
  List<BrokerNotificationChannelGroup> configuredGroups = const [];
  List<BrokerNotificationChannel> configuredChannels = const [];
  Set<String> deletedChannelIds = const {};

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    initializeCount += 1;
    initializedWithTapHandler = onTap != null;
    final error = initializeError;
    if (error != null) throw error;
  }

  @override
  Future<String?> getLaunchPayload() async => null;

  @override
  Future<NotificationPermissionStatus> permissionStatus() async => permission;

  @override
  Future<NotificationPermissionStatus> requestPermission() async {
    permissionRequestCount += 1;
    permission = requestResult;
    return requestResult;
  }

  @override
  bool get systemManagesChannels => managesChannels;

  @override
  Future<void> configureChannels({
    required List<BrokerNotificationChannelGroup> groups,
    required List<BrokerNotificationChannel> channels,
    required Set<String> obsoleteChannelIds,
  }) async {
    configuredGroups = groups;
    configuredChannels = channels;
    deletedChannelIds = obsoleteChannelIds;
    if (!managesChannels) return;
    for (final channel in channels) {
      this.channels.putIfAbsent(
        channel.id,
        () => NotificationChannelState(
          enabled: channel.defaultEnabled,
          sound: channel.defaultSound,
        ),
      );
    }
  }

  @override
  Future<Map<String, NotificationChannelState>> channelStates() async =>
      managesChannels ? Map.of(channels) : const {};

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required BrokerNotificationRequest request,
  }) async {
    final error = showError;
    if (error != null) throw error;
    shown.add(request);
  }

  @override
  Future<void> clear(int id) async {
    cleared.add(id);
  }

  @override
  Future<void> clearAll() async {
    clearAllCount += 1;
  }
}

/// Lifecycle monitor a test drives explicitly.
final class ControllableLifecycleMonitor implements BrokerAppLifecycleMonitor {
  ControllableLifecycleMonitor({
    this.currentState = BrokerAppLifecycleState.resumed,
  });

  final StreamController<BrokerAppLifecycleState> _changes =
      StreamController<BrokerAppLifecycleState>.broadcast(sync: true);

  @override
  BrokerAppLifecycleState currentState;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges => _changes.stream;

  /// Moves to [state] and notifies listeners.
  void emit(BrokerAppLifecycleState state) {
    currentState = state;
    _changes.add(state);
  }

  @override
  void dispose() {
    unawaited(_changes.close());
  }
}

/// Master-switch store that distinguishes "never chosen" from "off".
final class InMemoryNotificationPreferenceStore
    implements SessionNotificationSettingsStore {
  InMemoryNotificationPreferenceStore({this.preference});

  bool? preference;
  bool permissionPrompted = false;

  @override
  Future<bool> getLocalNotificationEnabled() async => preference ?? false;

  @override
  Future<bool?> getLocalNotificationPreference() async => preference;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    preference = enabled;
  }

  @override
  Future<bool> getPermissionPrompted() async => permissionPrompted;

  @override
  Future<void> setPermissionPrompted() async {
    permissionPrompted = true;
  }
}

/// Per-type settings store kept in memory.
final class InMemoryNotificationTypeSettingsStore
    implements AttentionNotificationTypeSettingsStore {
  final Map<AttentionNotificationType, AttentionNotificationTypeSetting>
  values = {};

  @override
  Future<AttentionNotificationTypeSettings> load() async =>
      AttentionNotificationTypeSettings(values);

  @override
  Future<void> save(
    AttentionNotificationType type,
    AttentionNotificationTypeSetting setting,
  ) async {
    values[type] = setting;
  }
}
