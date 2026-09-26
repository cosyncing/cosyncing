import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/desktop/desktop_keep_running.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftDesktopKeepRunningStore', () {
    test('is on until the user turns it off', () async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final store = DriftDesktopKeepRunningStore(database);

      expect(await store.get(), isTrue);
      await store.set(enabled: false);
      expect(await store.get(), isFalse);
      await store.set(enabled: true);
      expect(await store.get(), isTrue);
    });
  });

  group('desktopKeepRunningRuntimeProvider', () {
    late _RecordingWindowChannel channel;
    late _MemoryKeepRunningStore store;

    setUp(() {
      channel = _RecordingWindowChannel();
      store = _MemoryKeepRunningStore();
    });

    tearDown(() => debugDefaultTargetPlatformOverride = null);

    ProviderContainer makeContainer({Locale? locale}) {
      final container = ProviderContainer(
        overrides: [
          desktopWindowChannelProvider.overrideWithValue(channel),
          desktopKeepRunningStoreProvider.overrideWithValue(store),
          localeControllerProvider.overrideWith(() => _FixedLocale(locale)),
        ],
      );
      addTearDown(container.dispose);
      container.listen(desktopKeepRunningRuntimeProvider, (_, _) {});
      return container;
    }

    Future<void> settle() async {
      for (var i = 0; i < 5; i += 1) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    test('tells Windows the choice and the menu labels', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      final container = makeContainer(locale: const Locale('zh'));
      await settle();

      expect(channel.calls, [(true, '打开 Cosyncing', '退出 Cosyncing')]);

      await container
          .read(desktopKeepRunningControllerProvider.notifier)
          .setEnabled(enabled: false);
      await settle();

      expect(channel.calls.last, (false, '打开 Cosyncing', '退出 Cosyncing'));
      expect(store.value, isFalse);
    });

    test('tells macOS too', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      makeContainer();
      await settle();

      expect(channel.calls.single.$1, isTrue);
    });

    test('stays silent where closing the window always quits', () async {
      for (final platform in [
        TargetPlatform.linux,
        TargetPlatform.android,
        TargetPlatform.iOS,
      ]) {
        debugDefaultTargetPlatformOverride = platform;
        makeContainer();
        await settle();
      }

      expect(channel.calls, isEmpty);
    });
  });
}

final class _RecordingWindowChannel extends DesktopWindowChannel {
  final List<(bool, String, String)> calls = [];

  @override
  Future<void> setKeepRunning({
    required bool enabled,
    required String openLabel,
    required String quitLabel,
  }) async {
    calls.add((enabled, openLabel, quitLabel));
  }
}

final class _MemoryKeepRunningStore implements DesktopKeepRunningStore {
  bool? value;

  @override
  Future<bool> get() async => value ?? true;

  @override
  Future<void> set({required bool enabled}) async => value = enabled;
}

final class _FixedLocale extends LocaleController {
  _FixedLocale(this.locale);

  final Locale? locale;

  @override
  Future<Locale?> build() async => locale;
}
