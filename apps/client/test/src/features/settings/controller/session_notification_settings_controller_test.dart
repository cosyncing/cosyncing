import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _InMemorySessionNotificationSettingsStore store;
  late _FakePermissionRequester permissionRequester;
  late ProviderContainer container;

  setUp(() {
    store = _InMemorySessionNotificationSettingsStore();
    permissionRequester = _FakePermissionRequester();
    container = ProviderContainer(
      overrides: [
        sessionNotificationSettingsStoreProvider.overrideWithValue(store),
        sessionNotificationPermissionRequesterProvider.overrideWithValue(
          permissionRequester.call,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('SessionNotificationSettingsController', () {
    test(
      'permission request reuses the initialized tap-aware adapter',
      () async {
        final backend = _RecordingNotificationBackend();
        final adapter = FlutterLocalNotificationSink(
          backend: backend,
          onTap: (_) {},
        );
        final sharedContainer = ProviderContainer(
          overrides: [
            sessionLocalNotificationAdapterProvider.overrideWithValue(adapter),
          ],
        );
        addTearDown(sharedContainer.dispose);

        await sharedContainer.read(
          sessionNotificationLaunchBootstrapProvider.future,
        );
        await sharedContainer.read(
          sessionNotificationPermissionRequesterProvider,
        )();

        expect(backend.initializeCount, 1);
        expect(backend.permissionRequestCount, 1);
        expect(backend.initializedWithTapHandler, isTrue);
      },
    );

    test('loads disabled as the default when setting is missing', () async {
      expect(
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        ),
        false,
      );
    });

    test('persists enabled state and updates controller value', () async {
      await container
          .read(sessionNotificationSettingsControllerProvider.notifier)
          .setEnabled(enabled: true);

      expect(store.value, isTrue);
      expect(
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        ),
        isTrue,
      );
    });

    test('can persist disabled state', () async {
      store.value = true;
      await container
          .read(sessionNotificationSettingsControllerProvider.notifier)
          .setEnabled(enabled: false);

      expect(store.value, isFalse);
      expect(
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        ),
        isFalse,
      );
    });

    test(
      'requesting permission updates state to granted',
      () async {
        permissionRequester.nextResult =
            const FlutterLocalNotificationPermissionRequestResult(
              outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
            );

        await container
            .read(
              sessionNotificationPermissionRequestControllerProvider.notifier,
            )
            .requestPermission();

        final result = await container.read(
          sessionNotificationPermissionRequestControllerProvider.future,
        );
        expect(
          result?.outcome,
          FlutterLocalNotificationPermissionRequestOutcome.granted,
        );
        expect(permissionRequester.requests, 1);
      },
    );

    test(
      'surfaces denied permission outcome from request path',
      () async {
        permissionRequester.nextResult =
            const FlutterLocalNotificationPermissionRequestResult(
              outcome: FlutterLocalNotificationPermissionRequestOutcome.denied,
            );

        await container
            .read(
              sessionNotificationPermissionRequestControllerProvider.notifier,
            )
            .requestPermission();

        final result = await container.read(
          sessionNotificationPermissionRequestControllerProvider.future,
        );
        expect(
          result?.outcome,
          FlutterLocalNotificationPermissionRequestOutcome.denied,
        );
      },
    );

    test(
      'surfaces unsupported permission outcome from request path',
      () async {
        permissionRequester
            .nextResult = const FlutterLocalNotificationPermissionRequestResult(
          outcome: FlutterLocalNotificationPermissionRequestOutcome.unsupported,
        );

        await container
            .read(
              sessionNotificationPermissionRequestControllerProvider.notifier,
            )
            .requestPermission();

        final result = await container.read(
          sessionNotificationPermissionRequestControllerProvider.future,
        );
        expect(
          result?.outcome,
          FlutterLocalNotificationPermissionRequestOutcome.unsupported,
        );
      },
    );

    test('surfaces failed permission outcome when request throws', () async {
      permissionRequester.throwOnRequest = true;

      await container
          .read(sessionNotificationPermissionRequestControllerProvider.notifier)
          .requestPermission();

      final result = await container.read(
        sessionNotificationPermissionRequestControllerProvider.future,
      );
      expect(
        result?.outcome,
        FlutterLocalNotificationPermissionRequestOutcome.failed,
      );
      expect(result?.message, isNull);
    });
  });
}

final class _RecordingNotificationBackend
    implements FlutterLocalNotificationBackend {
  int initializeCount = 0;
  int permissionRequestCount = 0;
  bool initializedWithTapHandler = false;

  @override
  Future<void> initialize({FlutterLocalNotificationTapHandler? onTap}) async {
    initializeCount += 1;
    initializedWithTapHandler = onTap != null;
  }

  @override
  Future<String?> getLaunchPayload() async => null;

  @override
  Future<FlutterLocalNotificationPermissionRequestResult>
  requestPermission() async {
    permissionRequestCount += 1;
    return const FlutterLocalNotificationPermissionRequestResult(
      outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
    );
  }

  @override
  Future<void> show({
    required int id,
    required String title,
    required String body,
    required String? payload,
    required FlutterLocalNotificationDisplayOptions options,
  }) async {}

  @override
  Future<void> clear(int id) async {}

  @override
  Future<void> clearAll() async {}
}

final class _FakePermissionRequester {
  _FakePermissionRequester()
    : nextResult = const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
      );

  int requests = 0;
  bool throwOnRequest = false;
  FlutterLocalNotificationPermissionRequestResult nextResult;

  Future<FlutterLocalNotificationPermissionRequestResult> call() async {
    requests += 1;
    if (throwOnRequest) {
      throw Exception('permission request failed');
    }
    return nextResult;
  }
}

final class _InMemorySessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  _InMemorySessionNotificationSettingsStore() : value = false;

  bool value;

  @override
  Future<bool> getLocalNotificationEnabled() async => value;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    value = enabled;
  }
}
