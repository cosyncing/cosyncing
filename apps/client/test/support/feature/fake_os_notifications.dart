// The operating system's notification centre, for F07 feature tests.
//
// The app's real `FlutterLocalNotificationSink` (permission, channels and
// outcome logic) runs over this backend, in place of the platform plugin: a
// notification the app shows lands in [active], one it clears leaves, and a
// tap is delivered to the handler the app registered at start-up.
import 'dart:convert';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Override;

import '../notification_test_support.dart';

/// One notification the OS is showing.
class OsNotification {
  /// Creates an entry.
  OsNotification(this.id, this.request);

  /// Platform id the app derived from the request id.
  final int id;

  /// What the app asked the OS to show.
  final BrokerNotificationRequest request;

  /// Title on the notification.
  String get title => request.title;

  /// Body text on the notification.
  String get body => request.body;

  /// Whether it plays a sound.
  bool get sound => request.playSound;

  /// The payload the OS hands back on a tap.
  Map<String, Object?> get payload => request.payload;

  /// The attention event this notification is for, when it is for one.
  Object? get eventId => payload['eventId'];
}

/// The notification centre of one device.
class FakeOsNotifications implements FlutterLocalNotificationBackend {
  /// A centre whose permission starts as [permission].
  FakeOsNotifications({
    this.permission = const NotificationPermissionStatus(
      NotificationPermissionState.notGranted,
    ),
    this.requestResult = NotificationPermissionStatus.granted,
    this.managesChannels = false,
  });

  /// What the OS reports.
  NotificationPermissionStatus permission;

  /// What the OS permission prompt answers; it also becomes [permission].
  NotificationPermissionStatus requestResult;

  /// Whether the OS owns per-channel switches (Android).
  bool managesChannels;

  /// User-owned channel switches by id, filled from the app's declared
  /// channels when [managesChannels].
  final Map<String, NotificationChannelState> channels = {};

  /// Channels the app declared.
  List<BrokerNotificationChannel> declaredChannels = const [];

  /// Channel ids the app deleted.
  Set<String> deletedChannelIds = const {};

  /// Every notification the app ever showed, oldest first.
  final List<OsNotification> shown = [];

  /// What is on screen now, by platform id.
  final Map<int, OsNotification> _active = {};

  /// Times the app asked the OS for permission.
  int permissionPrompts = 0;

  /// Times the app cleared the whole centre.
  int clearAllCount = 0;

  FlutterLocalNotificationTapHandler? _onTap;

  /// Notifications on screen, oldest first.
  List<OsNotification> get active => _active.values.toList();

  /// Titles of what is on screen.
  List<String> get activeTitles => [for (final n in active) n.title];

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    _onTap = onTap;
  }

  @override
  Future<String?> getLaunchPayload() async => null;

  @override
  Future<NotificationPermissionStatus> permissionStatus() async => permission;

  @override
  Future<NotificationPermissionStatus> requestPermission() async {
    permissionPrompts += 1;
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
    declaredChannels = channels;
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
    final entry = OsNotification(id, request);
    shown.add(entry);
    _active[id] = entry;
  }

  @override
  Future<void> clear(int id) async {
    _active.remove(id);
  }

  @override
  Future<void> clearAll() async {
    clearAllCount += 1;
    _active.clear();
  }

  /// The user taps notification [entry]: the OS hands its payload to the
  /// handler the app registered.
  void tap(OsNotification entry) {
    final handler = _onTap;
    if (handler == null) throw StateError('the app registered no tap handler');
    handler(jsonEncode(entry.payload));
  }

  /// Providers that put this centre and [lifecycle] under the app.
  List<Override> overrides(ControllableLifecycleMonitor lifecycle) => [
    sessionLocalNotificationAdapterProvider.overrideWith(
      (ref) => FlutterLocalNotificationSink(
        backend: this,
        onTap: ref.watch(sessionNotificationTapHandlerProvider),
      ),
    ),
    sessionNotificationLifecycleMonitorProvider.overrideWithValue(lifecycle),
  ];
}
