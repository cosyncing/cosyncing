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
    Future<void> choose(WidgetTester tester, Key select, String option) async {
      await tester.scrollUntilVisible(find.byKey(select), 200);
      await tester.tap(find.byKey(select));
      await tester.pumpAndSettle();
      // The open menu repeats the selected label; its entries come last.
      await tester.tap(find.text(option).last);
      await tester.pumpAndSettle();
    }

    testWidgets('offers one select per appearance choice', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      for (final key in const [
        'appearance-theme-mode',
        'appearance-theme',
        'appearance-text-scale',
        'appearance-density',
        'appearance-language',
      ]) {
        await tester.scrollUntilVisible(find.byKey(Key(key)), 200);
        expect(find.byKey(Key(key)), findsOneWidget);
      }
      // Chips, segmented buttons and radio lists all gave way to selects.
      expect(find.byType(ChoiceChip), findsNothing);
      expect(find.byType(SegmentedButton<UiDensity>), findsNothing);
    });

    // At phone width a select moves under its label at the row's full width
    // instead of squeezing the label; nothing may overflow.
    testWidgets('selects stack under their labels at phone width', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view
          ..resetPhysicalSize()
          ..resetDevicePixelRatio();
      });

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final density = find.byKey(const Key('appearance-density'));
      await tester.scrollUntilVisible(density, 200);
      expect(tester.getSize(density).width, greaterThan(300));
      expect(
        tester.getTopLeft(density).dy,
        greaterThan(tester.getTopLeft(find.text('Density')).dy + 8),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('selecting a text size persists it', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await choose(tester, const Key('appearance-text-scale'), 'Large');

      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);
    });

    testWidgets('selecting a density persists it', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await choose(tester, const Key('appearance-density'), 'Spacious');

      expect(store.values[uiDensitySettingKey], UiDensity.spacious.token);
    });

    testWidgets('selecting a theme and a mode persists both', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await choose(
        tester,
        const Key('appearance-theme'),
        'Graphite Minimalist',
      );
      await choose(tester, const Key('appearance-theme-mode'), 'Dark');

      expect(store.values[uiThemeIdSettingKey], 'graphite-minimalist');
      expect(store.values[uiThemeModeSettingKey], 'dark');
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
