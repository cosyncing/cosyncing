import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/notification_test_support.dart';

void main() {
  late FakeNotificationBackend backend;
  late ControllableLifecycleMonitor lifecycle;
  late _CountingRunner runner;
  late ProviderContainer container;

  setUp(() async {
    backend = FakeNotificationBackend();
    lifecycle = ControllableLifecycleMonitor();
    runner = _CountingRunner();
    final coordinator = AttentionFeedCoordinator(
      settingsStore: _NoDisabledProfiles(),
      createRunner: (_) async => runner,
    );
    await coordinator.reconcile(
      notificationsEnabled: true,
      profiles: [
        BrokerProfile(
          id: 'one',
          displayName: 'one',
          baseUri: Uri.parse('http://127.0.0.1:7734/one'),
          createdAt: DateTime(2026),
        ),
      ],
      activeProfileId: 'one',
    );
    container = ProviderContainer(
      overrides: [
        sessionLocalNotificationAdapterProvider.overrideWithValue(
          FlutterLocalNotificationSink(backend: backend),
        ),
        sessionNotificationSettingsStoreProvider.overrideWithValue(
          InMemoryNotificationPreferenceStore(),
        ),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          lifecycle,
        ),
        attentionFeedCoordinatorProvider.overrideWithValue(coordinator),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(coordinator.stop);
    container.listen(attentionPermissionGrantRuntimeProvider, (_, _) {});
  });

  Future<void> settle() async {
    for (var i = 0; i < 5; i += 1) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<void> resumeWith(NotificationPermissionState state) async {
    backend.permission = NotificationPermissionStatus(state);
    lifecycle.emit(BrokerAppLifecycleState.resumed);
    await settle();
  }

  test('a grant from system settings re-presents refused requests', () async {
    await container.read(notificationPermissionControllerProvider.future);
    await settle();
    expect(runner.grants, 0, reason: 'reading the state at start is no grant');

    await resumeWith(NotificationPermissionState.granted);
    expect(runner.grants, 1);

    await resumeWith(NotificationPermissionState.granted);
    expect(runner.grants, 1, reason: 'an unchanged grant is not a new one');

    await resumeWith(NotificationPermissionState.denied);
    await resumeWith(NotificationPermissionState.granted);
    expect(runner.grants, 2);
  });

  test('a grant from the in-app prompt re-presents refused requests', () async {
    await container.read(notificationPermissionControllerProvider.future);

    await container
        .read(notificationPermissionControllerProvider.notifier)
        .request();
    await settle();

    expect(runner.grants, 1);
  });

  test('an app that starts already allowed presents nothing extra', () async {
    backend.permission = NotificationPermissionStatus.granted;
    await container.read(notificationPermissionControllerProvider.future);
    await settle();

    expect(runner.grants, 0);
  });
}

final class _CountingRunner implements AttentionFeedRunner {
  int grants = 0;

  @override
  void start() {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> presentPermissionBlockedRequests() async => grants += 1;
}

final class _NoDisabledProfiles implements AttentionFeedSettingsStore {
  @override
  Future<bool> isFeedEnabled(String brokerProfileId) async => true;

  @override
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) async {}

  @override
  Future<List<String>> listDisabledProfileIds() async => const [];
}
