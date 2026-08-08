import 'package:cosyncing_client/src/features/settings/controller/debug_views_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _InMemoryUiPreferencesStore store;
  late ProviderContainer container;

  setUp(() {
    store = _InMemoryUiPreferencesStore();
    container = ProviderContainer(
      overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
    );
  });

  tearDown(() => container.dispose());

  group('DebugViewsController', () {
    test('defaults to off when unset', () async {
      expect(
        await container.read(debugViewsControllerProvider.future),
        isFalse,
      );
    });

    test('a malformed stored value resolves to off', () async {
      store.values[uiShowDebugViewsSettingKey] = 'not-a-bool';
      expect(
        await container.read(debugViewsControllerProvider.future),
        isFalse,
      );
    });

    test('hydrates a previously enabled value', () async {
      store.values[uiShowDebugViewsSettingKey] = 'true';
      expect(await container.read(debugViewsControllerProvider.future), isTrue);
    });

    test('enabling persists and exposes the new value', () async {
      await container.read(debugViewsControllerProvider.future);
      await container
          .read(debugViewsControllerProvider.notifier)
          .setShowDebugViews(value: true);

      expect(store.values[uiShowDebugViewsSettingKey], 'true');
      expect(container.read(debugViewsControllerProvider).value, isTrue);
    });
  });
}

class _InMemoryUiPreferencesStore implements UiPreferencesStore {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> getThemeId() async => values[uiThemeIdSettingKey];

  @override
  Future<void> setThemeId(String themeId) async {
    values[uiThemeIdSettingKey] = themeId;
  }

  @override
  Future<String?> getThemeMode() async => values[uiThemeModeSettingKey];

  @override
  Future<void> setThemeMode(String mode) async {
    values[uiThemeModeSettingKey] = mode;
  }

  @override
  Future<String?> getLocaleTag() async => values[uiLocaleSettingKey];

  @override
  Future<void> setLocaleTag(String tag) async {
    values[uiLocaleSettingKey] = tag;
  }

  @override
  Future<String?> getTextScale() async => values[uiTextScaleSettingKey];

  @override
  Future<void> setTextScale(String token) async {
    values[uiTextScaleSettingKey] = token;
  }

  @override
  Future<String?> getDensity() async => values[uiDensitySettingKey];

  @override
  Future<void> setDensity(String token) async {
    values[uiDensitySettingKey] = token;
  }

  @override
  Future<bool?> getShowDebugViews() async {
    final value = values[uiShowDebugViewsSettingKey];
    return value == null ? null : value == 'true';
  }

  @override
  Future<void> setShowDebugViews({required bool value}) async {
    values[uiShowDebugViewsSettingKey] = value.toString();
  }
}
