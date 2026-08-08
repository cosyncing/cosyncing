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
    test('defaults to system text size and comfortable density', () async {
      final settings = await container.read(uiScaleControllerProvider.future);
      expect(settings.textScale, UiTextScale.system);
      expect(settings.density, UiDensity.comfortable);
    });

    test('persists and exposes the chosen text size', () async {
      await container
          .read(uiScaleControllerProvider.notifier)
          .setTextScale(UiTextScale.large);

      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.large,
      );
    });

    test('persists and exposes the chosen density', () async {
      await container
          .read(uiScaleControllerProvider.notifier)
          .setDensity(UiDensity.spacious);

      expect(store.values[uiDensitySettingKey], UiDensity.spacious.token);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.density,
        UiDensity.spacious,
      );
    });

    test('steps up and down one rung along the concrete ladder', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.setTextScale(UiTextScale.standard);
      await notifier.stepTextScale(1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.large,
      );

      await notifier.stepTextScale(-1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.standard,
      );
    });

    test('clamps at both ends of the ladder', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.setTextScale(UiTextScale.extraLarge);
      await notifier.stepTextScale(1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.extraLarge,
      );

      await notifier.setTextScale(UiTextScale.small);
      await notifier.stepTextScale(-1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.small,
      );
    });

    test('treats a zero direction as a no-op', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.stepTextScale(0);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.system,
      );
    });

    test('resolves system to the nearest rung before stepping', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.system,
      );

      // system is enum index 0 but is not the smallest size; stepping down from
      // an OS scale of 1.0 must land on small, not stay pinned at the bottom.
      await notifier.stepTextScale(-1, ambientFactor: 1);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.small,
      );
    });

    test('honours the ambient OS factor when leaving system', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      // An OS already near 1.15 resolves to large, so growing lands extraLarge.
      await notifier.stepTextScale(1, ambientFactor: 1.14);
      expect(
        container.read(uiScaleControllerProvider).valueOrNull?.textScale,
        UiTextScale.extraLarge,
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

    test('persists a stepped text size', () async {
      final notifier = container.read(uiScaleControllerProvider.notifier);
      await container.read(uiScaleControllerProvider.future);

      await notifier.stepTextScale(1);
      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);
    });

    test('hydrates previously persisted choices', () async {
      store.values[uiTextScaleSettingKey] = UiTextScale.small.token;
      store.values[uiDensitySettingKey] = UiDensity.compact.token;

      final settings = await container.read(uiScaleControllerProvider.future);
      expect(settings.textScale, UiTextScale.small);
      expect(settings.density, UiDensity.compact);
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
