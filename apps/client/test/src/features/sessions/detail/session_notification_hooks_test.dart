import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _InMemorySessionNotificationSettingsStore store;
  late ProviderContainer container;
  late _CollectingNotificationSink localSink;

  setUp(() {
    store = _InMemorySessionNotificationSettingsStore();
    localSink = _CollectingNotificationSink();
    container = ProviderContainer(
      overrides: [
        sessionNotificationSettingsStoreProvider.overrideWithValue(store),
        sessionLocalNotificationSinkProvider.overrideWithValue(localSink),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('sessionNotificationSinkProvider', () {
    test(
      'defaults to no-op delivery when notifications are disabled',
      () async {
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        );

        final sink = container.read(sessionNotificationSinkProvider);
        expect(sink, isA<NoopBrokerNotificationSink>());
      },
    );

    test('returns local sink when notifications are enabled', () async {
      await container
          .read(sessionNotificationSettingsControllerProvider.notifier)
          .setEnabled(enabled: true);
      final sink = container.read(sessionNotificationSinkProvider);

      expect(sink, same(localSink));
      expect(
        await container.read(
          sessionNotificationSettingsControllerProvider.future,
        ),
        isTrue,
      );
    });
  });
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

final class _CollectingNotificationSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> shown = <BrokerNotificationRequest>[];

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    shown.add(request);
  }

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
}
