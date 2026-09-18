import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/view/general_settings_page.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
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
    TargetPlatform platform = TargetPlatform.linux,
    bool isWeb = true,
    List<Override> overrides = const [],
  }) => ProviderScope(
    overrides: [
      uiPreferencesStoreProvider.overrideWithValue(store),
      readAloudPreferencesStoreProvider.overrideWithValue(readAloudStore),
      clientTargetPlatformProvider.overrideWithValue(platform),
      clientIsWebProvider.overrideWithValue(isWeb),
      ...overrides,
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

  testWidgets('app update controls stay hidden on web and render on Android', (
    tester,
  ) async {
    await tester.pumpWidget(subject());
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('settings-native-client-update-section')),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox.shrink());

    final android = _FakeAndroidPlatform(versionCode: 14);
    await tester.pumpWidget(
      subject(
        platform: TargetPlatform.android,
        isWeb: false,
        overrides: _androidUpdateOverrides(
          android,
          releaseVersion: '0.5.8',
          releaseVersionCode: 14,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('settings-native-client-update-section')),
      findsOneWidget,
    );
    expect(find.text('Cosyncing 0.5.8'), findsOneWidget);
    expect(find.text('You have the latest version.'), findsOneWidget);

    await tester.tap(
      find.byKey(const Key('settings-native-client-update-check')),
    );
    await tester.pumpAndSettle();
    expect(android.identityCalls, 2);
  });

  testWidgets('Android settings offers an available verified update', (
    tester,
  ) async {
    await tester.pumpWidget(
      subject(
        platform: TargetPlatform.android,
        isWeb: false,
        overrides: _androidUpdateOverrides(
          _FakeAndroidPlatform(versionCode: 14),
          releaseVersion: '0.5.9',
          releaseVersionCode: 15,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Version 0.5.9 is ready to download.'), findsOneWidget);
    expect(
      find.byKey(const Key('settings-native-client-update-install')),
      findsOneWidget,
    );
  });

  testWidgets('desktop update check opens the matching platform download', (
    tester,
  ) async {
    final launched = <Uri>[];
    await tester.pumpWidget(
      subject(
        isWeb: false,
        overrides: [
          desktopClientVersionProvider.overrideWithValue('0.5.8'),
          stableReleaseManifestFetcherProvider.overrideWithValue(
            () async => _releaseManifest('0.5.9'),
          ),
          desktopDownloadLauncherProvider.overrideWithValue((url) async {
            launched.add(url);
            return true;
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Version 0.5.9 is ready to download.'), findsOneWidget);
    await tester.tap(
      find.byKey(const Key('settings-native-client-update-download')),
    );
    await tester.pumpAndSettle();
    expect(
      launched.single.toString(),
      'https://github.com/cosyncing/cosyncing/releases/download/'
      'client-v0.5.9/cosyncing-client-0.5.9-linux-x64.tar.gz',
    );
  });

  testWidgets('desktop update controls fit compact 2.0 text', (tester) async {
    tester.view
      ..physicalSize = const Size(360, 640)
      ..devicePixelRatio = 1;
    addTearDown(() {
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });

    for (final locale in const [Locale('en'), Locale('es')]) {
      await tester.pumpWidget(
        subject(
          locale: locale,
          textScale: 2,
          isWeb: false,
          overrides: [
            desktopClientVersionProvider.overrideWithValue('0.5.8'),
            stableReleaseManifestFetcherProvider.overrideWithValue(
              () async => _releaseManifest('0.5.9'),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      final section = find.byKey(
        const Key('settings-native-client-update-section'),
      );
      await tester.ensureVisible(section);
      await tester.pumpAndSettle();

      expect(section, findsOneWidget);
      expect(
        find.byKey(const Key('settings-native-client-update-download')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
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

const _androidSigner =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

List<Override> _androidUpdateOverrides(
  _FakeAndroidPlatform platform, {
  required String releaseVersion,
  required int releaseVersionCode,
}) => [
  androidUpdatePlatformProvider.overrideWithValue(platform),
  androidClientVersionProvider.overrideWithValue('0.5.8'),
  androidManifestFetcherProvider.overrideWithValue(
    () async => <String, Object?>{
      'schemaVersion': 1,
      'product': 'cosyncing',
      'channel': 'stable',
      'version': releaseVersion,
      'androidApp': <String, Object?>{
        'name': 'cosyncing-client-$releaseVersion-android.apk',
        'applicationId': 'com.cosyncing.client',
        'versionCode': releaseVersionCode,
        'size': 1024,
        'sha256': _androidSigner,
        'url':
            'https://github.com/cosyncing/cosyncing/releases/download/'
            'broker-v$releaseVersion/'
            'cosyncing-client-$releaseVersion-android.apk',
        'signerSha256': _androidSigner,
      },
    },
  ),
];

Map<String, Object?> _releaseManifest(String version) => {
  'schemaVersion': 1,
  'product': 'cosyncing',
  'channel': 'stable',
  'version': version,
};

final class _FakeAndroidPlatform implements AndroidUpdatePlatform {
  _FakeAndroidPlatform({required this.versionCode});

  final int versionCode;
  int identityCalls = 0;

  @override
  bool get supported => true;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() async {
    identityCalls += 1;
    return AndroidInstalledAppIdentity(
      applicationId: 'com.cosyncing.client',
      versionCode: versionCode,
      signerSha256: _androidSigner,
    );
  }

  @override
  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  }) async => AndroidInstallLaunchResult.launched;
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
