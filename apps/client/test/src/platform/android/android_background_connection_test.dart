import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/platform/android/android_background_connection.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../support/notification_test_support.dart';

void main() {
  group('DriftAndroidBackgroundConnectionStore', () {
    test('is off until the user turns it on', () async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final store = DriftAndroidBackgroundConnectionStore(database);

      expect(await store.get(), isFalse);
      await store.set(enabled: true);
      expect(await store.get(), isTrue);
      await store.set(enabled: false);
      expect(await store.get(), isFalse);
    });
  });

  group('androidBackgroundConnectionRuntimeProvider', () {
    late _RecordingServiceChannel channel;
    late _MemoryBackgroundConnectionStore store;
    late ControllableLifecycleMonitor lifecycle;

    setUp(() {
      channel = _RecordingServiceChannel();
      store = _MemoryBackgroundConnectionStore();
      lifecycle = ControllableLifecycleMonitor();
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
    });

    tearDown(() => debugDefaultTargetPlatformOverride = null);

    ProviderContainer makeContainer({
      bool notifications = true,
      Locale? locale,
    }) {
      final container = ProviderContainer(
        overrides: [
          androidBackgroundConnectionChannelProvider.overrideWithValue(channel),
          androidBackgroundConnectionStoreProvider.overrideWithValue(store),
          localeControllerProvider.overrideWith(() => _FixedLocale(locale)),
          sessionNotificationSettingsControllerProvider.overrideWith(
            () => _FixedMasterSwitch(enabled: notifications),
          ),
          sessionNotificationLifecycleMonitorProvider.overrideWithValue(
            lifecycle,
          ),
        ],
      );
      addTearDown(container.dispose);
      container.listen(androidBackgroundConnectionRuntimeProvider, (_, _) {});
      return container;
    }

    Future<void> settle() async {
      for (var i = 0; i < 5; i += 1) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    test('does not start the service until the user turns it on', () async {
      final container = makeContainer();
      await settle();

      expect(channel.starts, isEmpty);
      expect(channel.stops, 1);

      await container
          .read(androidBackgroundConnectionControllerProvider.notifier)
          .setEnabled(enabled: true);
      await settle();

      expect(channel.starts, hasLength(1));
      expect(store.value, isTrue);
    });

    test('starts it with the notification in the app language', () async {
      store.value = true;
      makeContainer(locale: const Locale('zh'));
      await settle();

      expect(channel.starts.single, (
        channelName: '后台连接',
        groupName: '服务器',
        title: '正在保持连接以接收通知',
        text: '可在“设置 → 通知”中关闭。',
      ));
      expect(channel.stops, 0);
    });

    test('stops it when the user turns it off', () async {
      store.value = true;
      final container = makeContainer();
      await settle();
      expect(channel.starts, hasLength(1));

      await container
          .read(androidBackgroundConnectionControllerProvider.notifier)
          .setEnabled(enabled: false);
      await settle();

      expect(channel.stops, 1);
      expect(channel.starts, hasLength(1));
    });

    test('never runs while notifications are off', () async {
      store.value = true;
      makeContainer(notifications: false);
      await settle();
      lifecycle.emit(BrokerAppLifecycleState.resumed);
      await settle();

      expect(channel.starts, isEmpty);
      expect(channel.stops, 1);
    });

    test('starts it again each time the app returns to the front', () async {
      store.value = true;
      makeContainer();
      await settle();
      lifecycle
        ..emit(BrokerAppLifecycleState.paused)
        ..emit(BrokerAppLifecycleState.resumed);
      await settle();

      // Android refuses a start from the background, so the one at launch
      // may not have taken; the return to the front repeats it.
      expect(channel.starts, hasLength(2));
    });

    test('a refused or failing start is not an error', () async {
      store.value = true;
      channel.failStart = true;
      makeContainer();
      await settle();

      expect(channel.starts, hasLength(1));
    });

    test('stays silent off Android', () async {
      store.value = true;
      for (final platform in [
        TargetPlatform.iOS,
        TargetPlatform.macOS,
        TargetPlatform.windows,
        TargetPlatform.linux,
      ]) {
        debugDefaultTargetPlatformOverride = platform;
        makeContainer();
        await settle();
      }

      expect(channel.starts, isEmpty);
      expect(channel.stops, 0);
    });
  });
}

typedef _Start = ({
  String channelName,
  String groupName,
  String title,
  String text,
});

final class _RecordingServiceChannel
    extends AndroidBackgroundConnectionChannel {
  final List<_Start> starts = [];
  int stops = 0;
  bool failStart = false;

  @override
  Future<bool> start({
    required String channelName,
    required String groupName,
    required String title,
    required String text,
  }) async {
    starts.add((
      channelName: channelName,
      groupName: groupName,
      title: title,
      text: text,
    ));
    if (failStart) throw StateError('refused');
    return true;
  }

  @override
  Future<void> stop() async => stops += 1;
}

final class _MemoryBackgroundConnectionStore
    implements AndroidBackgroundConnectionStore {
  bool? value;

  @override
  Future<bool> get() async => value ?? false;

  @override
  Future<void> set({required bool enabled}) async => value = enabled;
}

final class _FixedLocale extends LocaleController {
  _FixedLocale(this.locale);

  final Locale? locale;

  @override
  Future<Locale?> build() async => locale;
}

final class _FixedMasterSwitch extends SessionNotificationSettingsController {
  _FixedMasterSwitch({required this.enabled});

  final bool enabled;

  @override
  Future<bool> build() async => enabled;
}
