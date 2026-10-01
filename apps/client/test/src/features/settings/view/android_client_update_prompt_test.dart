import 'dart:async';
import 'dart:io';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/view/android_client_update_prompt.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update_prompt_store.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const digest =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  Map<String, Object?> manifest(String version, int versionCode) => {
    'schemaVersion': 1,
    'product': 'cosyncing',
    'channel': 'stable',
    'version': version,
    'androidApp': <String, Object?>{
      'name': 'cosyncing-client-$version-android.apk',
      'applicationId': 'com.cosyncing.client',
      'versionCode': versionCode,
      'size': 1024,
      'sha256': digest,
      'url':
          'https://github.com/cosyncing/cosyncing/releases/download/'
          'broker-v$version/cosyncing-client-$version-android.apk',
      'signerSha256': digest,
    },
  };

  Widget subject(
    _MemoryPromptStore store, {
    String version = '1.2.0',
    int versionCode = 12,
    AndroidApkDownloader? downloader,
    _FakeAndroidPlatform? platform,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    return ProviderScope(
      overrides: [
        androidUpdatePlatformProvider.overrideWithValue(
          platform ?? _FakeAndroidPlatform(signer: digest),
        ),
        androidClientVersionProvider.overrideWithValue('1.1.0'),
        androidManifestFetcherProvider.overrideWithValue(
          () async => manifest(version, versionCode),
        ),
        if (downloader != null)
          androidApkDownloaderProvider.overrideWithValue(downloader),
        androidUpdatePromptStoreProvider.overrideWithValue(store),
        androidUpdateNoticeLocalizationsProvider.overrideWithValue(
          lookupAppLocalizations(const Locale('en')),
        ),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(spec.light, Brightness.light),
        home: const AndroidClientUpdatePrompt(
          child: Scaffold(body: Text('app')),
        ),
      ),
    );
  }

  final dialog = find.byKey(const Key('android-client-update-dialog'));

  testWidgets('an update is offered as a dialog that Later closes for good', (
    tester,
  ) async {
    final store = _MemoryPromptStore();
    await tester.pumpWidget(subject(store));
    await tester.pumpAndSettle();

    expect(dialog, findsOneWidget);
    expect(find.text('Version 1.2.0 is ready to download.'), findsOneWidget);
    expect(find.text('This update stays in Settings → General.'), findsOne);

    await tester.tap(find.byKey(const Key('android-client-update-later')));
    await tester.pumpAndSettle();
    expect(dialog, findsNothing);
    expect(find.text('app'), findsOneWidget);
    expect(store.value, '1.2.0');

    // A fresh launch with the same record does not ask again.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(subject(store));
    await tester.pumpAndSettle();
    expect(dialog, findsNothing);
  });

  testWidgets('Android back closes the dialog like any other', (tester) async {
    final store = _MemoryPromptStore();
    await tester.pumpWidget(subject(store));
    await tester.pumpAndSettle();
    expect(dialog, findsOneWidget);

    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    await navigator.maybePop();
    await tester.pumpAndSettle();
    expect(dialog, findsNothing);
    expect(store.value, '1.2.0');
  });

  testWidgets('a newer release is offered even after an older one closed', (
    tester,
  ) async {
    final store = _MemoryPromptStore()..value = '1.2.0';
    await tester.pumpWidget(subject(store, version: '1.3.0', versionCode: 13));
    await tester.pumpAndSettle();
    expect(find.text('Version 1.3.0 is ready to download.'), findsOneWidget);
  });

  testWidgets('no dialog while the installed build is current', (
    tester,
  ) async {
    final store = _MemoryPromptStore();
    await tester.pumpWidget(subject(store, version: '1.1.0', versionCode: 11));
    await tester.pumpAndSettle();
    expect(dialog, findsNothing);
    expect(store.value, isNull);
  });

  testWidgets('Update follows the download and closes for the installer', (
    tester,
  ) async {
    final store = _MemoryPromptStore();
    final download = Completer<File>();
    final platform = _FakeAndroidPlatform(signer: digest);
    await tester.pumpWidget(
      subject(
        store,
        platform: platform,
        downloader: (candidate, onProgress) {
          onProgress(0.4);
          return download.future;
        },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('android-client-update-action')));
    await tester.pump();
    expect(find.text('Downloading version 1.2.0…'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(
            find.byKey(const Key('android-client-update-progress')),
          )
          .value,
      0.4,
    );
    // Mid-download the only action is a way out; the download keeps going.
    expect(find.byKey(const Key('android-client-update-action')), findsNothing);
    expect(find.text('Close'), findsOneWidget);

    download.complete(File('nonexistent-test-apk'));
    await tester.pumpAndSettle();
    expect(platform.installCalls, 1);
    expect(dialog, findsNothing);
    expect(store.value, '1.2.0');
  });
}

final class _MemoryPromptStore implements AndroidUpdatePromptStore {
  String? value;

  @override
  Future<String?> dismissedVersion() async => value;

  @override
  Future<void> setDismissedVersion(String version) async => value = version;
}

final class _FakeAndroidPlatform implements AndroidUpdatePlatform {
  _FakeAndroidPlatform({required this.signer});

  final String signer;
  int installCalls = 0;

  @override
  bool get supported => true;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() async =>
      AndroidInstalledAppIdentity(
        applicationId: 'com.cosyncing.client',
        versionCode: 11,
        signerSha256: signer,
      );

  @override
  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  }) async {
    installCalls += 1;
    return AndroidInstallLaunchResult.launched;
  }

  @override
  Future<bool> startDownloadService(AndroidUpdateDownloadNotice notice) async =>
      true;

  @override
  Future<void> showDownloadProgress(int percent) async {}

  @override
  Future<void> stopDownloadService({AndroidUpdateReadyNotice? ready}) async {}
}
