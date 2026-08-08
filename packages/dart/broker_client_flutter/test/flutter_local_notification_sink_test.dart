import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FlutterLocalNotificationSink', () {
    final request = BrokerNotificationRequest(
      id: 'session-notification:example-1',
      title: 'Session requires input',
      body: 'A permission prompt is waiting.',
      category: BrokerNotificationCategory.actionRequired,
      importance: BrokerNotificationImportance.normal,
      payload: {'tool': 'claude', 'sessionId': 'session-1'},
      createdAt: DateTime(2026, 7, 2, 12, 0),
    );

    test('initializes lazily and idempotently', () async {
      final backend = _FakeLocalNotificationBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      expect(backend.initializeCalls, 0);

      await sink.show(request);
      await sink.show(request);
      expect(backend.initializeCalls, 1);

      await sink.clear('session-notification:example-1');
      await sink.clearAll();
      expect(backend.initializeCalls, 1);
    });

    test('forwards cold-launch payload from app-launch details once', () async {
      final backend = _FakeLocalNotificationBackend(
        launchPayload: '{"kind":"attention-event","eventId":"event-1"}',
      );
      final tapped = <String?>[];
      final sink = FlutterLocalNotificationSink(
        backend: backend,
        onTap: tapped.add,
      );

      await sink.show(request);
      await sink.show(request);

      expect(backend.initializeCalls, 1);
      expect(backend.getLaunchPayloadCalls, 1);
      expect(tapped, ['{"kind":"attention-event","eventId":"event-1"}']);
    });

    test(
      'recovers cold-launch payload without showing a notification',
      () async {
        final backend = _FakeLocalNotificationBackend(
          launchPayload: '{"kind":"attention-event","eventId":"cold"}',
        );
        final tapped = <String?>[];
        final sink = FlutterLocalNotificationSink(
          backend: backend,
          onTap: tapped.add,
        );

        await sink.initialize();

        expect(backend.initializeCalls, 1);
        expect(backend.getLaunchPayloadCalls, 1);
        expect(tapped, ['{"kind":"attention-event","eventId":"cold"}']);
        expect(backend.showCalls, isEmpty);
      },
    );

    test(
      'forwards explicit platform taps without interpreting payload',
      () async {
        final backend = _FakeLocalNotificationBackend();
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

    test('maps deterministic IDs to stable platform ids', () async {
      final first = FlutterLocalNotificationSink.derivePlatformNotificationId(
        'session-notification:example-1',
      );
      final same = FlutterLocalNotificationSink.derivePlatformNotificationId(
        'session-notification:example-1',
      );
      final different =
          FlutterLocalNotificationSink.derivePlatformNotificationId(
            'session-notification:example-2',
          );

      expect(first, same);
      expect(first, isNot(different));
      expect(first, isPositive);
      expect(first, lessThanOrEqualTo(0x7fffffff));
    });

    test(
      'serializes payload deterministically before plugin dispatch',
      () async {
        final payloadString = FlutterLocalNotificationSink.serializePayload({
          'z': 9,
          'a': '1',
          'm': true,
        });
        expect(payloadString, '{"a":"1","m":true,"z":9}');
      },
    );

    test(
      'forwards selective clear, clearMany, and clearAll to backend',
      () async {
        final backend = _FakeLocalNotificationBackend();
        final sink = FlutterLocalNotificationSink(backend: backend);

        await sink.clear('session-notification:example-1');
        await sink.clearMany([
          'session-notification:example-2',
          'session-notification:example-3',
          'session-notification:example-2',
        ]);
        await sink.clearAll();

        expect(backend.clearCalls.toSet(), {
          for (final id in [
            'session-notification:example-1',
            'session-notification:example-2',
            'session-notification:example-3',
          ])
            FlutterLocalNotificationSink.derivePlatformNotificationId(id),
        });
        expect(backend.clearAllCalls, 1);
        expect(backend.initializeCalls, 1);
      },
    );

    test(
      'clearMany attempts later ids before rethrowing the first error',
      () async {
        const ids = ['notification-a', 'notification-b', 'notification-c'];
        final platformIds = [
          for (final id in ids)
            FlutterLocalNotificationSink.derivePlatformNotificationId(id),
        ];
        final backend = _FakeLocalNotificationBackend(
          failingClearIds: {platformIds[1]},
        );
        final sink = FlutterLocalNotificationSink(backend: backend);

        await expectLater(sink.clearMany(ids), throwsA(isA<StateError>()));

        expect(backend.clearCalls, platformIds);
        expect(backend.clearAllCalls, 0);
      },
    );

    test('forwards mapped display options and payload to backend', () async {
      final backend = _FakeLocalNotificationBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.show(request);

      final call = backend.showCalls.single;
      expect(call.options.androidChannelId, 'cosyncing_session_action');
      expect(call.options.androidChannelName, 'Session Action Requests');
      expect(call.options.androidImportance, Importance.defaultImportance);
      expect(call.options.playSound, isFalse);
      expect(call.options.enableVibration, isFalse);
      expect(call.payload, '{"sessionId":"session-1","tool":"claude"}');
    });

    test(
      'requests permission via backend and returns backend outcome',
      () async {
        final backend = _FakeLocalNotificationBackend(
          permissionRequestResult:
              const FlutterLocalNotificationPermissionRequestResult(
                outcome:
                    FlutterLocalNotificationPermissionRequestOutcome.denied,
              ),
        );
        final sink = FlutterLocalNotificationSink(backend: backend);

        final result = await sink.requestPermission();

        expect(
          result.outcome,
          FlutterLocalNotificationPermissionRequestOutcome.denied,
        );
        expect(backend.requestPermissionCalls, 1);
        expect(backend.initializeCalls, 1);
      },
    );

    test(
      'permission request shares lazy initialization with show path',
      () async {
        final backend = _FakeLocalNotificationBackend();
        final sink = FlutterLocalNotificationSink(backend: backend);

        await sink.requestPermission();
        await sink.show(request);

        expect(backend.initializeCalls, 1);
        expect(backend.requestPermissionCalls, 1);
        expect(backend.showCalls, hasLength(1));
      },
    );

    test('exposes explicit request outcomes from backend mapping', () async {
      final outcomes = <FlutterLocalNotificationPermissionRequestOutcome>[
        FlutterLocalNotificationPermissionRequestOutcome.granted,
        FlutterLocalNotificationPermissionRequestOutcome.unsupported,
        FlutterLocalNotificationPermissionRequestOutcome.failed,
      ];

      for (final outcome in outcomes) {
        final backend = _FakeLocalNotificationBackend(
          permissionRequestResult:
              FlutterLocalNotificationPermissionRequestResult(
                outcome: outcome,
                message:
                    outcome ==
                        FlutterLocalNotificationPermissionRequestOutcome.failed
                    ? 'failure'
                    : null,
              ),
        );
        final sink = FlutterLocalNotificationSink(backend: backend);

        final result = await sink.requestPermission();

        expect(result.outcome, outcome);
      }
    });

    test('does not request permissions from show path', () async {
      final backend = _FakeLocalNotificationBackend();
      final sink = FlutterLocalNotificationSink(backend: backend);

      await sink.show(request);

      expect(backend.requestPermissionCalls, 0);
    });

    test(
      'maps broker importance/category into deterministic delivery options',
      () {
        final options = FlutterLocalNotificationSink.displayOptionsFor(
          importance: BrokerNotificationImportance.high,
          category: BrokerNotificationCategory.error,
        );

        expect(options.androidChannelId, 'cosyncing_session_error');
        expect(options.androidImportance, Importance.high);
        expect(options.playSound, isTrue);
        expect(options.enableVibration, isTrue);
      },
    );

    test('maps delivery intent on every supported notification platform', () {
      final options = FlutterLocalNotificationSink.displayOptionsFor(
        importance: BrokerNotificationImportance.high,
        category: BrokerNotificationCategory.actionRequired,
      );

      final details = FlutterLocalNotificationSink.notificationDetailsFor(
        options,
      );

      expect(details.android?.importance, Importance.high);
      expect(details.iOS?.presentBanner, isTrue);
      expect(details.iOS?.presentList, isTrue);
      expect(details.iOS?.presentSound, isTrue);
      expect(details.macOS?.presentSound, isTrue);
      expect(details.linux?.urgency, LinuxNotificationUrgency.critical);
      expect(details.linux?.resident, isTrue);
      expect(details.windows?.duration, WindowsNotificationDuration.long);
      expect(details.windows?.audio?.isSilent, isFalse);
      expect(details.web?.requireInteraction, isTrue);
      expect(details.web?.isSilent, isFalse);
    });

    test(
      'maps quiet informational notifications without platform defaults',
      () {
        final options = FlutterLocalNotificationSink.displayOptionsFor(
          importance: BrokerNotificationImportance.low,
          category: BrokerNotificationCategory.info,
        );

        final details = FlutterLocalNotificationSink.notificationDetailsFor(
          options,
        );

        expect(details.iOS?.presentSound, isFalse);
        expect(details.linux?.urgency, LinuxNotificationUrgency.low);
        expect(details.linux?.suppressSound, isTrue);
        expect(details.windows?.audio?.isSilent, isTrue);
        expect(details.web?.isSilent, isTrue);
        expect(details.web?.requireInteraction, isFalse);
      },
    );
  });
}

final class _FakeLocalNotificationBackend
    implements FlutterLocalNotificationBackend {
  int initializeCalls = 0;
  int requestPermissionCalls = 0;
  int getLaunchPayloadCalls = 0;
  final FlutterLocalNotificationPermissionRequestResult permissionRequestResult;
  final String? launchPayload;
  final Set<int> failingClearIds;

  final List<_FakeShowCall> showCalls = [];
  final List<int> clearCalls = [];
  int clearAllCalls = 0;

  _FakeLocalNotificationBackend({
    FlutterLocalNotificationPermissionRequestResult? permissionRequestResult,
    this.launchPayload,
    this.failingClearIds = const {},
  }) : permissionRequestResult =
           permissionRequestResult ??
           const FlutterLocalNotificationPermissionRequestResult(
             outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
           );

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    initializeCalls += 1;
    tapHandler = onTap;
  }

  FlutterLocalNotificationTapHandler? tapHandler;

  @override
  Future<FlutterLocalNotificationPermissionRequestResult>
  requestPermission() async {
    requestPermissionCalls += 1;
    return permissionRequestResult;
  }

  @override
  Future<String?> getLaunchPayload() async {
    getLaunchPayloadCalls += 1;
    return launchPayload;
  }

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required FlutterLocalNotificationDisplayOptions options,
  }) async {
    showCalls.add(
      _FakeShowCall(
        id: id,
        title: title,
        body: body,
        payload: payload,
        options: options,
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

final class _FakeShowCall {
  const _FakeShowCall({
    required this.id,
    required this.title,
    required this.body,
    required this.payload,
    required this.options,
  });

  final int id;
  final String title;
  final String body;
  final String? payload;
  final FlutterLocalNotificationDisplayOptions options;
}
