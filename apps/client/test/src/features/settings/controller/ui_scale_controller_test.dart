import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/controller/ui_scale_controller.dart';
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

  group('UiScaleController', () {
    test('treats a zero direction as a no-op', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.stepTextScale(0);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.system,
      );
    });

    test('assumes standard when no ambient factor is supplied', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.stepTextScale(1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.large,
      );
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
