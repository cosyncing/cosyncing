import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/view/general_settings_page.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';

void main() {
  late _InMemoryUiPreferencesStore store;
  late InMemoryReadAloudPreferencesStore readAloudStore;

  setUp(() {
    store = _InMemoryUiPreferencesStore();
    readAloudStore = InMemoryReadAloudPreferencesStore();
  });

  Widget subject({
    Brightness brightness = Brightness.light,
    Locale locale = const Locale('en'),
    double textScale = 1,
  }) => ProviderScope(
    overrides: [
      uiPreferencesStoreProvider.overrideWithValue(store),
      readAloudPreferencesStoreProvider.overrideWithValue(readAloudStore),
    ],
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      locale: locale,
      theme: ThemeData(
        brightness: brightness,
        extensions: [
          if (brightness == Brightness.dark)
            themeSpecById(kDefaultThemeId).dark
          else
            themeSpecById(kDefaultThemeId).light,
        ],
      ),
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
        child: const GeneralSettingsPage(),
      ),
    ),
  );

  testWidgets('Show debug views defaults off and persists when enabled', (
    tester,
  ) async {
    await tester.pumpWidget(subject());
    await tester.pumpAndSettle();

    final switchFinder = find.byKey(const Key('settings-show-debug-views'));
    await tester.scrollUntilVisible(switchFinder, 200);
    await tester.ensureVisible(switchFinder);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(switchFinder).value, isFalse);

    await tester.tap(switchFinder);
    await tester.pumpAndSettle();

    expect(store.values[uiShowDebugViewsSettingKey], 'true');
    expect(tester.widget<SwitchListTile>(switchFinder).value, isTrue);
  });

  testWidgets('renders in light and dark without overflow', (tester) async {
    for (final brightness in Brightness.values) {
      await tester.pumpWidget(subject(brightness: brightness));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        find.byKey(const Key('settings-show-debug-views')),
        findsOneWidget,
      );
    }
  });

  testWidgets('read-aloud speed offers exact rates and persists selection', (
    tester,
  ) async {
    await tester.pumpWidget(subject());
    await tester.pumpAndSettle();

    final menu = find.byKey(const Key('settings-read-aloud-rate-menu'));
    await tester.scrollUntilVisible(menu, 200);
    await tester.ensureVisible(menu);
    await tester.pumpAndSettle();
    expect(find.text('Read-aloud speed'), findsOneWidget);
    expect(find.text('1.0×'), findsOneWidget);

    await tester.tap(menu);
    await tester.pumpAndSettle();
    for (final label in const ['0.75×', '1.0×', '1.25×', '1.5×']) {
      expect(find.text(label), findsWidgets);
    }
    await tester.tap(find.text('1.5×').last);
    await tester.pumpAndSettle();

    expect(readAloudStore.value, '1.5');
    expect(find.text('1.5×'), findsOneWidget);
  });

  testWidgets('read-aloud speed survives compact 2.0 text in EN/ZH', (
    tester,
  ) async {
    tester.view
      ..physicalSize = const Size(360, 640)
      ..devicePixelRatio = 1;
    addTearDown(() {
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });

    for (final locale in const [Locale('en'), Locale('zh')]) {
      for (final brightness in Brightness.values) {
        await tester.pumpWidget(
          subject(
            locale: locale,
            brightness: brightness,
            textScale: 2,
          ),
        );
        await tester.pumpAndSettle();
        final section = find.byKey(const Key('settings-read-aloud-section'));
        await tester.scrollUntilVisible(section, 200);
        await tester.ensureVisible(section);
        await tester.pumpAndSettle();
        expect(section, findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    }
  });

  group('read-aloud speed golden evidence', () {
    for (final locale in const [Locale('en'), Locale('zh')]) {
      for (final brightness in Brightness.values) {
        testWidgets('${locale.languageCode} ${brightness.name}', (
          tester,
        ) async {
          tester.view
            ..physicalSize = const Size(720, 520)
            ..devicePixelRatio = 1;
          addTearDown(() {
            tester.view
              ..resetPhysicalSize()
              ..resetDevicePixelRatio();
          });
          readAloudStore.value = '1.25';
          await tester.pumpWidget(
            subject(locale: locale, brightness: brightness),
          );
          await tester.pumpAndSettle();
          final section = find.byKey(
            const Key('settings-read-aloud-section'),
          );
          await tester.scrollUntilVisible(section, 200);
          await tester.ensureVisible(section);
          await tester.pumpAndSettle();

          await expectLater(
            section,
            matchesGoldenFile(
              'goldens/read_aloud_rate_${brightness.name}_'
              '${locale.languageCode}.png',
            ),
          );
        });
      }
    }
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
