import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/notification_test_support.dart';

void main() {
  late InMemoryNotificationPreferenceStore store;
  late FakeNotificationBackend backend;
  late ControllableLifecycleMonitor lifecycle;
  late ProviderContainer container;

  setUp(() {
    store = InMemoryNotificationPreferenceStore();
    backend = FakeNotificationBackend();
    lifecycle = ControllableLifecycleMonitor();
    container = ProviderContainer(
      overrides: [
        sessionNotificationSettingsStoreProvider.overrideWithValue(store),
        sessionLocalNotificationAdapterProvider.overrideWithValue(
          FlutterLocalNotificationSink(backend: backend, onTap: (_) {}),
        ),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          lifecycle,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  Future<NotificationPermissionStatus> permission() =>
      container.read(notificationPermissionControllerProvider.future);

  group('SessionNotificationSettingsController', () {
    test('an unset switch reads off, with no recorded choice', () async {
      expect(
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        ),
        isFalse,
      );
      expect(
        await container.read(sessionNotificationPreferenceProvider.future),
        isNull,
      );
    });

    test(
      'turning on prompts for OS permission once, in the same call',
      () async {
        await container
            .read(sessionNotificationSettingsControllerProvider.notifier)
            .setEnabled(enabled: true);

        expect(store.preference, isTrue);
        expect(backend.permissionRequestCount, 1);
        expect(store.permissionPrompted, isTrue);
        expect((await permission()).state, NotificationPermissionState.granted);
        expect(
          await container.read(sessionNotificationPreferenceProvider.future),
          isTrue,
        );
      },
    );

    test('turning off records the choice and never prompts', () async {
      store.preference = true;
      await container
          .read(sessionNotificationSettingsControllerProvider.notifier)
          .setEnabled(enabled: false);

      expect(store.preference, isFalse);
      expect(backend.permissionRequestCount, 0);
      expect(
        await container.read(sessionNotificationPreferenceProvider.future),
        isFalse,
      );
    });

    test('the switch stays on when the OS refuses permission', () async {
      backend.requestResult = const NotificationPermissionStatus(
        NotificationPermissionState.denied,
      );
      await container
          .read(sessionNotificationSettingsControllerProvider.notifier)
          .setEnabled(enabled: true);

      expect(store.preference, isTrue);
      expect((await permission()).state, NotificationPermissionState.denied);
    });

    test(
      'the permission request reuses the one initialized tap-aware adapter',
      () async {
        await container.read(sessionNotificationLaunchBootstrapProvider.future);
        await container
            .read(notificationPermissionControllerProvider.notifier)
            .request();

        expect(backend.initializeCount, 1);
        expect(backend.permissionRequestCount, 1);
        expect(backend.initializedWithTapHandler, isTrue);
      },
    );
  });

  group('NotificationPermissionController', () {
    test('reads the OS state without prompting', () async {
      expect(
        (await permission()).state,
        NotificationPermissionState.notGranted,
      );
      expect(backend.permissionRequestCount, 0);
    });

    test(
      '"not enabled" after this device prompted reads as denied',
      () async {
        store.permissionPrompted = true;

        expect((await permission()).state, NotificationPermissionState.denied);
      },
    );

    test('a granted OS state wins over the prompted flag', () async {
      store.permissionPrompted = true;
      backend.permission = NotificationPermissionStatus.granted;

      expect((await permission()).state, NotificationPermissionState.granted);
    });

    test('re-reads the OS state when the app resumes', () async {
      expect(
        (await permission()).state,
        NotificationPermissionState.notGranted,
      );

      // The user allowed notifications in system settings meanwhile.
      backend.permission = NotificationPermissionStatus.granted;
      lifecycle.emit(BrokerAppLifecycleState.resumed);
      await pumpEventQueue();

      expect(
        container.read(notificationPermissionControllerProvider).value?.state,
        NotificationPermissionState.granted,
      );
    });

    test('an initialization failure is an error with its reason', () async {
      backend.initializeError = StateError('invalid_icon');

      final status = await permission();

      expect(status.state, NotificationPermissionState.error);
      expect(status.reason, contains('initialization-failed'));
      expect(status.reason, contains('invalid_icon'));
    });

    test('platforms without notifications report unsupported', () async {
      backend.permission = const NotificationPermissionStatus(
        NotificationPermissionState.unsupported,
        reason: 'insecure-context',
      );

      final status = await permission();

      expect(status.state, NotificationPermissionState.unsupported);
      expect(status.reason, 'insecure-context');
    });
  });
}
