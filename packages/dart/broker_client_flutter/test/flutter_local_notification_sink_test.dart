import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const quietChannel = BrokerNotificationChannel(
    id: 'cosy.v2.turnFinished',
    name: 'Turn finished',
    description: 'An agent finished its turn.',
    groupId: 'cosy.v2.sessions',
    defaultEnabled: true,
    defaultSound: false,
    urgent: false,
  );
  const urgentChannel = BrokerNotificationChannel(
    id: 'cosy.v2.permissionRequest',
    name: 'Permission request',
    description: 'An agent is waiting for approval.',
    groupId: 'cosy.v2.sessions',
    defaultEnabled: true,
    defaultSound: true,
    urgent: true,
  );
  const offByDefaultChannel = BrokerNotificationChannel(
    id: 'cosy.v2.usageQuota',
    name: 'Usage quota',
    description: 'A usage limit is close.',
    groupId: 'cosy.v2.server',
    defaultEnabled: false,
    defaultSound: false,
    urgent: false,
  );

  BrokerNotificationRequest requestFor(
    BrokerNotificationChannel channel, {
    String id = 'attention-dedupe:00000001',
    bool? playSound,
    String? threadKey,
  }) => BrokerNotificationRequest(
    id: id,
    title: 'Turn finished',
    body: 'Fix the login bug',
    channel: channel,
    playSound: playSound ?? channel.defaultSound,
    threadKey: threadKey,
    payload: const {'tool': 'claude', 'sessionId': 'session-1'},
    createdAt: DateTime(2026, 9, 23, 12),
  );

  final request = requestFor(quietChannel);

  group('FlutterLocalNotificationSink lifecycle', () {
    test('initializes lazily and idempotently', () async {
      final backend = _FakeBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      expect(backend.initializeCalls, 0);

      await sink.show(request);
      await sink.show(request);
      await sink.permissionStatus();
      await sink.requestPermission();
      expect(backend.initializeCalls, 1);

      await sink.clear('attention-dedupe:00000001');
      await sink.clearAll();
      expect(backend.initializeCalls, 1);
    });

    test('forwards cold-launch payload from app-launch details once', () async {
      final backend = _FakeBackend(
        launchPayload: '{"kind":"attention-event","eventId":"event-1"}',
      );
      final tapped = <String?>[];
      final sink = FlutterLocalNotificationSink(
        backend: backend,
        onTap: tapped.add,
      );

      await sink.show(request);
      await sink.show(request);

      expect(backend.getLaunchPayloadCalls, 1);
      expect(tapped, ['{"kind":"attention-event","eventId":"event-1"}']);
    });

    test(
      'recovers cold-launch payload without showing a notification',
      () async {
        final backend = _FakeBackend(
          launchPayload: '{"kind":"attention-event","eventId":"cold"}',
        );
        final tapped = <String?>[];
        final sink = FlutterLocalNotificationSink(
          backend: backend,
          onTap: tapped.add,
        );

        await sink.initialize();

        expect(tapped, ['{"kind":"attention-event","eventId":"cold"}']);
        expect(backend.shown, isEmpty);
      },
    );

    test(
      'forwards explicit platform taps without interpreting payload',
      () async {
        final backend = _FakeBackend();
        final tapped = <String?>[];
        final sink = FlutterLocalNotificationSink(
          backend: backend,
          onTap: tapped.add,
        );

        await sink.show(request);
        backend.tapHandler?.call('{"kind":"attention-event"}');

        expect(tapped, ['{"kind":"attention-event"}']);
      },
    );

    test(
      'retries initialization after a failure instead of caching it',
      () async {
        final backend = _FakeBackend()..initializeError = StateError('icon');
        final sink = FlutterLocalNotificationSink(backend: backend);

        final first = await sink.show(request);
        backend.initializeError = null;
        final second = await sink.show(request);

        expect(first.outcome, BrokerNotificationDeliveryOutcome.failed);
        expect(first.reason, startsWith('initialization-failed'));
        expect(second.outcome, BrokerNotificationDeliveryOutcome.shown);
        expect(backend.initializeCalls, 2);
      },
    );
  });

  group('FlutterLocalNotificationSink permission', () {
    test('reads permission without prompting', () async {
      final backend = _FakeBackend(
        permission: const NotificationPermissionStatus(
          NotificationPermissionState.notGranted,
        ),
      );
      final sink = FlutterLocalNotificationSink(backend: backend);

      final status = await sink.permissionStatus();

      expect(status.state, NotificationPermissionState.notGranted);
      expect(backend.requestPermissionCalls, 0);
    });

    test('returns the prompt result', () async {
      final backend = _FakeBackend(
        requestResult: const NotificationPermissionStatus(
          NotificationPermissionState.denied,
        ),
      );
      final sink = FlutterLocalNotificationSink(backend: backend);

      final status = await sink.requestPermission();

      expect(status.state, NotificationPermissionState.denied);
      expect(backend.requestPermissionCalls, 1);
    });

    test('a throwing backend reads as an error, never throws', () async {
      final backend = _FakeBackend()..permissionError = StateError('boom');
      final sink = FlutterLocalNotificationSink(backend: backend);

      final read = await sink.permissionStatus();
      final requested = await sink.requestPermission();

      expect(read.state, NotificationPermissionState.error);
      expect(read.reason, contains('boom'));
      expect(requested.state, NotificationPermissionState.error);
    });

    test(
      'an initialization failure reads as an error with its reason',
      () async {
        final backend = _FakeBackend()
          ..initializeError = PlatformExceptionLike('invalid_icon');
        final sink = FlutterLocalNotificationSink(backend: backend);

        final status = await sink.permissionStatus();

        expect(status.state, NotificationPermissionState.error);
        expect(status.reason, 'initialization-failed: invalid_icon');
      },
    );
  });

  group('FlutterLocalNotificationSink show', () {
    test('never prompts for permission', () async {
      final backend = _FakeBackend(
        permission: const NotificationPermissionStatus(
          NotificationPermissionState.notGranted,
        ),
      );
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.show(request);

      expect(backend.requestPermissionCalls, 0);
    });

    test('reports each permission state as its own outcome', () async {
      Future<BrokerNotificationDeliveryResult> showWith(
        NotificationPermissionStatus permission,
      ) => FlutterLocalNotificationSink(
        backend: _FakeBackend(permission: permission),
      ).show(request);

      final granted = await showWith(NotificationPermissionStatus.granted);
      final notGranted = await showWith(
        const NotificationPermissionStatus(
          NotificationPermissionState.notGranted,
        ),
      );
      final denied = await showWith(
        const NotificationPermissionStatus(NotificationPermissionState.denied),
      );
      final unsupported = await showWith(
        const NotificationPermissionStatus(
          NotificationPermissionState.unsupported,
          reason: 'insecure-context',
        ),
      );
      final error = await showWith(
        const NotificationPermissionStatus(
          NotificationPermissionState.error,
          reason: 'bad',
        ),
      );

      expect(granted.outcome, BrokerNotificationDeliveryOutcome.shown);
      expect(notGranted.outcome, BrokerNotificationDeliveryOutcome.blocked);
      expect(notGranted.reason, 'permission-not-granted');
      expect(denied.outcome, BrokerNotificationDeliveryOutcome.blocked);
      expect(
        unsupported.outcome,
        BrokerNotificationDeliveryOutcome.unavailable,
      );
      expect(unsupported.reason, 'insecure-context');
      expect(error.outcome, BrokerNotificationDeliveryOutcome.failed);
      expect(error.reason, 'bad');
    });

    test('an Android channel the user turned off reports blocked', () async {
      final backend = _FakeBackend(managesChannels: true)
        ..channels = {
          quietChannel.id: const NotificationChannelState(
            enabled: false,
            sound: false,
          ),
        };
      final sink = FlutterLocalNotificationSink(backend: backend);

      final result = await sink.show(request);

      expect(result.outcome, BrokerNotificationDeliveryOutcome.blocked);
      expect(result.reason, 'channel-off');
      expect(backend.shown, isEmpty);
    });

    test(
      'channel state is ignored where the app owns per-type settings',
      () async {
        final backend = _FakeBackend()
          ..channels = {
            quietChannel.id: const NotificationChannelState(
              enabled: false,
              sound: false,
            ),
          };
        final sink = FlutterLocalNotificationSink(backend: backend);

        final result = await sink.show(request);

        expect(result.outcome, BrokerNotificationDeliveryOutcome.shown);
      },
    );

    test('a platform failure reports failed instead of throwing', () async {
      final backend = _FakeBackend()..showError = StateError('toast failed');
      final sink = FlutterLocalNotificationSink(backend: backend);

      final result = await sink.show(request);

      expect(result.outcome, BrokerNotificationDeliveryOutcome.failed);
      expect(result.reason, contains('toast failed'));
      expect(result.isRetryable, isTrue);
    });

    test('forwards the stable id, text, and sorted payload', () async {
      final backend = _FakeBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.show(request);

      final call = backend.shown.single;
      expect(
        call.id,
        FlutterLocalNotificationSink.derivePlatformNotificationId(request.id),
      );
      expect(call.title, 'Turn finished');
      expect(call.body, 'Fix the login bug');
      expect(call.payload, '{"sessionId":"session-1","tool":"claude"}');
      expect(call.request, same(request));
    });
  });

  group('FlutterLocalNotificationSink channels', () {
    test(
      'forwards groups, channels, and obsolete ids once initialized',
      () async {
        final backend = _FakeBackend(managesChannels: true);
        final sink = FlutterLocalNotificationSink(backend: backend);
        const group = BrokerNotificationChannelGroup(
          id: 'cosy.v2.sessions',
          name: 'Sessions',
        );

        await sink.configureChannels(
          groups: const [group],
          channels: const [quietChannel, urgentChannel],
          obsoleteChannelIds: const {'cosyncing_session_info'},
        );

        expect(backend.initializeCalls, 1);
        expect(backend.configuredGroups, [group]);
        expect(backend.configuredChannels, [quietChannel, urgentChannel]);
        expect(backend.deletedChannelIds, {'cosyncing_session_info'});
        expect(sink.systemManagesChannels, isTrue);
      },
    );

    test('channel configuration failures are swallowed', () async {
      final backend = _FakeBackend(managesChannels: true)
        ..configureError = StateError('no channel api');
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.configureChannels(groups: const [], channels: const []);

      expect(await sink.channelStates(), isEmpty);
    });

    test('channel reads wait for pending configuration', () async {
      final backend = _FakeBackend(managesChannels: true);
      final sink = FlutterLocalNotificationSink(backend: backend);

      final configured = sink.configureChannels(
        groups: const [],
        channels: const [quietChannel],
      );
      final states = await sink.channelStates();
      await configured;

      expect(states.keys, [quietChannel.id]);
    });
  });

  group('FlutterLocalNotificationSink clearing', () {
    test('maps deterministic ids to stable positive platform ids', () {
      final first = FlutterLocalNotificationSink.derivePlatformNotificationId(
        'attention-dedupe:1',
      );
      final same = FlutterLocalNotificationSink.derivePlatformNotificationId(
        'attention-dedupe:1',
      );
      final different =
          FlutterLocalNotificationSink.derivePlatformNotificationId(
            'attention-dedupe:2',
          );

      expect(first, same);
      expect(first, isNot(different));
      expect(first, isPositive);
      expect(first, lessThanOrEqualTo(0x7fffffff));
    });

    test('serializes payload deterministically', () {
      expect(
        FlutterLocalNotificationSink.serializePayload({
          'z': 9,
          'a': '1',
          'm': true,
        }),
        '{"a":"1","m":true,"z":9}',
      );
      expect(FlutterLocalNotificationSink.serializePayload(const {}), isNull);
    });

    test('forwards selective clear, clearMany, and clearAll', () async {
      final backend = _FakeBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.clear('id-1');
      await sink.clearMany(['id-2', 'id-3', 'id-2']);
      await sink.clearAll();

      expect(backend.clearCalls.toSet(), {
        for (final id in ['id-1', 'id-2', 'id-3'])
          FlutterLocalNotificationSink.derivePlatformNotificationId(id),
      });
      expect(backend.clearAllCalls, 1);
    });

    test(
      'clearMany attempts later ids before rethrowing the first error',
      () async {
        const ids = ['notification-a', 'notification-b', 'notification-c'];
        final platformIds = [
          for (final id in ids)
            FlutterLocalNotificationSink.derivePlatformNotificationId(id),
        ];
        final backend = _FakeBackend(failingClearIds: {platformIds[1]});
        final sink = FlutterLocalNotificationSink(backend: backend);

        await expectLater(sink.clearMany(ids), throwsA(isA<StateError>()));

        expect(backend.clearCalls, platformIds);
      },
    );
  });

  group('FlutterLocalNotificationSink platform mapping', () {
    test('an urgent type interrupts on every platform', () {
      final details = FlutterLocalNotificationSink.notificationDetailsFor(
        requestFor(urgentChannel, threadKey: 'claude:session-1'),
      );

      expect(details.android?.channelId, urgentChannel.id);
      expect(details.android?.importance, Importance.high);
      expect(details.android?.priority, Priority.high);
      expect(details.android?.groupKey, 'claude:session-1');
      expect(details.android?.visibility, NotificationVisibility.private);
      expect(details.iOS?.presentBanner, isTrue);
      expect(details.iOS?.presentSound, isTrue);
      expect(details.macOS?.interruptionLevel, InterruptionLevel.active);
      expect(details.macOS?.threadIdentifier, 'claude:session-1');
      expect(details.linux?.urgency, LinuxNotificationUrgency.critical);
      expect(details.windows?.duration, WindowsNotificationDuration.long);
      expect(details.windows?.audio?.isSilent, isFalse);
      expect(details.web?.requireInteraction, isTrue);
      expect(details.web?.isSilent, isFalse);
    });

    test('a quiet type still shows a banner, silently', () {
      final details = FlutterLocalNotificationSink.notificationDetailsFor(
        request,
      );

      // `passive` would file it into Notification Center with no banner.
      expect(details.macOS?.interruptionLevel, InterruptionLevel.active);
      expect(details.macOS?.presentBanner, isTrue);
      expect(details.macOS?.presentSound, isFalse);
      // Heads-up needs HIGH; quiet is the channel's sound, not importance.
      expect(details.android?.importance, Importance.high);
      expect(details.android?.playSound, isFalse);
      expect(details.linux?.urgency, LinuxNotificationUrgency.normal);
      expect(details.linux?.suppressSound, isTrue);
      expect(details.windows?.audio?.isSilent, isTrue);
      expect(details.windows?.duration, WindowsNotificationDuration.short);
      expect(details.web?.isSilent, isTrue);
      expect(details.web?.requireInteraction, isFalse);
    });

    test('the per-presentation sound choice overrides the type default', () {
      final details = FlutterLocalNotificationSink.notificationDetailsFor(
        requestFor(urgentChannel, playSound: false),
      );

      expect(details.macOS?.presentSound, isFalse);
      expect(details.windows?.audio?.isSilent, isTrue);
      expect(details.web?.isSilent, isTrue);
    });

    test('maps the Windows per-app toast setting', () {
      NotificationPermissionStatus read(WindowsNotificationSetting? setting) =>
          FlutterLocalNotificationSink.windowsPermissionFor(setting);

      expect(
        read(WindowsNotificationSetting.enabled).state,
        NotificationPermissionState.granted,
      );
      expect(read(null).state, NotificationPermissionState.granted);
      for (final off in [
        WindowsNotificationSetting.disabledForApplication,
        WindowsNotificationSetting.disabledForUser,
      ]) {
        expect(read(off).state, NotificationPermissionState.denied);
      }
      expect(
        read(WindowsNotificationSetting.disabledByGroupPolicy).reason,
        'group-policy',
      );
      expect(
        read(WindowsNotificationSetting.disabledByManifest).state,
        NotificationPermissionState.unsupported,
      );
    });

    test('an off-by-default Android channel is created blocked', () {
      expect(
        FlutterLocalNotificationSink.androidImportanceFor(offByDefaultChannel),
        Importance.none,
      );
      expect(
        FlutterLocalNotificationSink.androidImportanceFor(quietChannel),
        Importance.high,
      );
    });
  });
}

/// Stands in for a platform exception whose `toString` is its code.
final class PlatformExceptionLike implements Exception {
  PlatformExceptionLike(this.code);

  final String code;

  @override
  String toString() => code;
}

final class _FakeBackend implements FlutterLocalNotificationBackend {
  _FakeBackend({
    this.permission = NotificationPermissionStatus.granted,
    this.requestResult = NotificationPermissionStatus.granted,
    this.managesChannels = false,
    this.launchPayload,
    this.failingClearIds = const {},
  });

  NotificationPermissionStatus permission;
  final NotificationPermissionStatus requestResult;
  final bool managesChannels;
  final String? launchPayload;
  final Set<int> failingClearIds;

  Object? initializeError;
  Object? permissionError;
  Object? showError;
  Object? configureError;
  Map<String, NotificationChannelState> channels = {};

  int initializeCalls = 0;
  int requestPermissionCalls = 0;
  int getLaunchPayloadCalls = 0;
  FlutterLocalNotificationTapHandler? tapHandler;
  final List<_ShowCall> shown = [];
  final List<int> clearCalls = [];
  int clearAllCalls = 0;
  List<BrokerNotificationChannelGroup> configuredGroups = const [];
  List<BrokerNotificationChannel> configuredChannels = const [];
  Set<String> deletedChannelIds = const {};

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    initializeCalls += 1;
    tapHandler = onTap;
    final error = initializeError;
    if (error != null) throw error;
  }

  @override
  Future<String?> getLaunchPayload() async {
    getLaunchPayloadCalls += 1;
    return launchPayload;
  }

  @override
  Future<NotificationPermissionStatus> permissionStatus() async {
    final error = permissionError;
    if (error != null) throw error;
    return permission;
  }

  @override
  Future<NotificationPermissionStatus> requestPermission() async {
    requestPermissionCalls += 1;
    final error = permissionError;
    if (error != null) throw error;
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
    final error = configureError;
    if (error != null) throw error;
    configuredGroups = groups;
    configuredChannels = channels;
    deletedChannelIds = obsoleteChannelIds;
    for (final channel in channels) {
      this.channels[channel.id] = NotificationChannelState(
        enabled: channel.defaultEnabled,
        sound: channel.defaultSound,
      );
    }
  }

  @override
  Future<Map<String, NotificationChannelState>> channelStates() async {
    final error = configureError;
    if (error != null) throw error;
    return managesChannels ? Map.of(channels) : const {};
  }

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
    shown.add(
      _ShowCall(
        id: id,
        title: title,
        body: body,
        payload: payload,
        request: request,
      ),
    );
  }

  @override
  Future<void> clear(int id) async {
    clearCalls.add(id);
    if (failingClearIds.contains(id)) {
      throw StateError('clear failed for $id');
    }
  }

  @override
  Future<void> clearAll() async {
    clearAllCalls += 1;
  }
}

final class _ShowCall {
  const _ShowCall({
    required this.id,
    required this.title,
    required this.body,
    required this.payload,
    required this.request,
  });

  final int id;
  final String title;
  final String body;
  final String? payload;
  final BrokerNotificationRequest request;
}
