import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/view/appearance_settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _InMemoryUiPreferencesStore store;

  setUp(() => store = _InMemoryUiPreferencesStore());

  Widget buildSubject() {
    return ProviderScope(
      overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        home: const AppearanceSettingsPage(),
      ),
    );
  }

  group('AppearanceSettingsPage', () {
    testWidgets('renders the text-size and density controls', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('appearance-text-scale-system')),
        200,
      );
      for (final scale in UiTextScale.values) {
        expect(
          find.byKey(Key('appearance-text-scale-${scale.name}')),
          findsOneWidget,
        );
      }

      await tester.scrollUntilVisible(find.text('Spacious'), 200);
      expect(find.text('Spacious'), findsOneWidget);
    });

    // Regression: at phone width the selected segment's leading checkmark stole
    // enough of the third column that "Comfortable" wrapped mid-word
    // ("Comfortabl / e"). Compare against a label that has always fit, so this
    // measures wrapping rather than pinning an exact pixel height.
    testWidgets('density labels stay on one line at 420px width', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(420, 850)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view
          ..resetPhysicalSize()
          ..resetDevicePixelRatio();
      });

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Comfortable'), 200);

      final comfortable = tester.getSize(find.text('Comfortable'));
      final compact = tester.getSize(find.text('Compact'));

      expect(
        comfortable.height,
        compact.height,
        reason:
            '"Comfortable" wrapped to a second line while "Compact" did not',
      );
    });

    testWidgets('selecting a text size persists it', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.byKey(const Key('appearance-text-scale-large')),
        200,
      );
      await tester.tap(find.byKey(const Key('appearance-text-scale-large')));
      await tester.pumpAndSettle();

      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);
    });

    testWidgets('selecting a density persists it', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Spacious'), 200);
      await tester.tap(find.text('Spacious'));
      await tester.pumpAndSettle();

      expect(store.values[uiDensitySettingKey], UiDensity.spacious.token);
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
