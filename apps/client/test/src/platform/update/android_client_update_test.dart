import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const digest =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  Map<String, Object?> manifest({
    String version = '1.2.0',
    int versionCode = 12,
    String signer = digest,
  }) => {
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
      'signerSha256': signer,
    },
  };

  /// A container ready to download: an update is available, notices speak
  /// English, and [lifecycle] says whether the app is in front.
  ProviderContainer downloadContainer({
    required _FakeAndroidPlatform platform,
    required AndroidApkDownloader downloader,
    _FakeLifecycle? lifecycle,
  }) {
    final container = ProviderContainer(
      overrides: [
        androidUpdatePlatformProvider.overrideWithValue(platform),
        androidClientVersionProvider.overrideWithValue('1.1.0'),
        androidManifestFetcherProvider.overrideWithValue(
          () async => manifest(),
        ),
        androidApkDownloaderProvider.overrideWithValue(downloader),
        androidUpdateNoticeLocalizationsProvider.overrideWithValue(
          lookupAppLocalizations(const Locale('en')),
        ),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          lifecycle ?? _FakeLifecycle(),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('accepts the exact promoted GitHub APK identity', () {
    final candidate = parseAndroidUpdateCandidate(manifest());
    expect(candidate?.version, '1.2.0');
    expect(candidate?.versionCode, 12);
    expect(candidate?.signerSha256, digest);
  });

  test('authenticates manifest bytes before parsing them', () async {
    final keys = await PairingCrypto.generateIdentityKeyPair();
    final bytes = utf8.encode(jsonEncode(manifest()));
    final signature = await PairingCrypto.signIdentityMessage(
      privateKey: keys.privateKey,
      message: bytes,
    );
    final signatureBytes = base64UrlDecodeNoPadding(signature);

    expect(
      await verifyAndroidReleaseManifestSignature(
        manifestBytes: bytes,
        signatureBytes: signatureBytes,
        publicKey: keys.publicKey,
      ),
      isTrue,
    );
    expect(
      await verifyAndroidReleaseManifestSignature(
        manifestBytes: [...bytes, 0],
        signatureBytes: signatureBytes,
        publicKey: keys.publicKey,
      ),
      isFalse,
    );
  });

  test('rejects a release URL outside the exact broker tag', () {
    final value = manifest();
    final app = value['androidApp']! as Map<String, Object?>;
    app['url'] = 'https://example.com/cosyncing.apk';
    expect(parseAndroidUpdateCandidate(value), isNull);
  });

  test(
    'reports an available update only when name and code both advance',
    () async {
      final container = ProviderContainer(
        overrides: [
          androidUpdatePlatformProvider.overrideWithValue(
            _FakeAndroidPlatform(versionCode: 11, signer: digest),
          ),
          androidClientVersionProvider.overrideWithValue('1.1.0'),
          androidManifestFetcherProvider.overrideWithValue(
            () async => manifest(),
          ),
        ],
      );
      addTearDown(container.dispose);

      final state = await container.read(
        androidClientUpdateControllerProvider.future,
      );
      expect(state.status, AndroidClientUpdateStatus.available);
      expect(state.candidate?.version, '1.2.0');
    },
  );

  test(
    'fails closed when semantic version and Android code disagree',
    () async {
      final container = ProviderContainer(
        overrides: [
          androidUpdatePlatformProvider.overrideWithValue(
            _FakeAndroidPlatform(versionCode: 12, signer: digest),
          ),
          androidClientVersionProvider.overrideWithValue('1.1.0'),
          androidManifestFetcherProvider.overrideWithValue(
            () async => manifest(versionCode: 11),
          ),
        ],
      );
      addTearDown(container.dispose);

      final state = await container.read(
        androidClientUpdateControllerProvider.future,
      );
      expect(state.status, AndroidClientUpdateStatus.failed);
      expect(state.detailCode, 'release-version-incoherent');
    },
  );

  test('coalesces concurrent update actions into one download', () async {
    final download = Completer<File>();
    var downloadCalls = 0;
    final platform = _FakeAndroidPlatform(
      versionCode: 11,
      signer: digest,
    );
    final container = downloadContainer(
      platform: platform,
      downloader: (_, _) {
        downloadCalls += 1;
        return download.future;
      },
    );
    addTearDown(container.dispose);
    await container.read(androidClientUpdateControllerProvider.future);
    final controller = container.read(
      androidClientUpdateControllerProvider.notifier,
    );

    final first = controller.downloadAndInstall();
    final second = controller.downloadAndInstall();
    expect(downloadCalls, 1);
    download.complete(File('nonexistent-test-apk'));
    await Future.wait([first, second]);

    expect(platform.installCalls, 1);
    expect(
      container.read(androidClientUpdateControllerProvider).value?.status,
      AndroidClientUpdateStatus.installerLaunched,
    );
    await controller.checkIfStale();
    expect(platform.identityCalls, 2);
    expect(
      container.read(androidClientUpdateControllerProvider).value?.status,
      AndroidClientUpdateStatus.available,
    );
  });

  test(
    'the download runs under its service and shows each percent once',
    () async {
      final platform = _FakeAndroidPlatform(versionCode: 11, signer: digest);
      final seen = <double?>[];
      final container = downloadContainer(
        platform: platform,
        downloader: (_, onProgress) async {
          for (final value in [0.001, 0.004, 0.4, 0.401, 0.409, 1.0]) {
            onProgress(value);
          }
          return File('nonexistent-test-apk');
        },
      );
      await container.read(androidClientUpdateControllerProvider.future);
      // A ready notice from a process Android ended is cleared at launch.
      expect(platform.stops, [isNull]);
      container.listen(
        androidClientUpdateControllerProvider,
        (_, next) => seen.add(next.valueOrNull?.progress),
      );

      await container
          .read(androidClientUpdateControllerProvider.notifier)
          .downloadAndInstall();

      expect(platform.starts.single.title, 'Downloading Cosyncing 1.2.0');
      expect(platform.starts.single.channelName, 'App updates');
      // Six chunks, three percents: 0, 40 and 100.
      expect(platform.percents, [0, 40, 100]);
      expect(seen.whereType<double>(), [0, 0.001, 0.4, 1.0]);
      expect(platform.stops, [isNull, isNull]);
      expect(platform.installCalls, 1);
    },
  );

  test(
    'a download finished out of sight installs once the app is back',
    () async {
      final platform = _FakeAndroidPlatform(versionCode: 11, signer: digest);
      final lifecycle = _FakeLifecycle()
        ..currentState = BrokerAppLifecycleState.paused;
      final download = Completer<File>();
      final container = downloadContainer(
        platform: platform,
        downloader: (_, _) => download.future,
        lifecycle: lifecycle,
      );
      await container.read(androidClientUpdateControllerProvider.future);
      final controller = container.read(
        androidClientUpdateControllerProvider.notifier,
      );
      AndroidClientUpdateStatus? status() =>
          container.read(androidClientUpdateControllerProvider).value?.status;

      final installing = controller.downloadAndInstall();
      download.complete(File('nonexistent-test-apk'));
      await pumpEventQueue();

      expect(status(), AndroidClientUpdateStatus.readyToInstall);
      final ready = platform.stops.last!;
      expect(ready.title, 'Cosyncing 1.2.0 is ready to install');
      expect(ready.text, 'Tap to install the update.');
      // Android opens an installer only for an app in front.
      expect(platform.installCalls, 0);
      // A periodic re-check must not drop the verified APK it is holding.
      await controller.checkIfStale();
      expect(status(), AndroidClientUpdateStatus.readyToInstall);

      lifecycle.emit(BrokerAppLifecycleState.inactive);
      await pumpEventQueue();
      expect(platform.installCalls, 0);

      lifecycle
        ..currentState = BrokerAppLifecycleState.resumed
        ..emit(BrokerAppLifecycleState.resumed);
      await installing;
      expect(platform.installCalls, 1);
      // Back in front, the ready notice goes before the installer opens.
      expect(platform.stops.last, isNull);
      expect(status(), AndroidClientUpdateStatus.installerLaunched);
    },
  );

  test('a refused service still downloads while the app stays open', () async {
    final platform = _FakeAndroidPlatform(
      versionCode: 11,
      signer: digest,
      serviceStarts: false,
    );
    final container = downloadContainer(
      platform: platform,
      downloader: (_, onProgress) async {
        onProgress(0.5);
        return File('nonexistent-test-apk');
      },
    );
    await container.read(androidClientUpdateControllerProvider.future);

    await container
        .read(androidClientUpdateControllerProvider.notifier)
        .downloadAndInstall();

    expect(platform.installCalls, 1);
    expect(
      container.read(androidClientUpdateControllerProvider).value?.status,
      AndroidClientUpdateStatus.installerLaunched,
    );
  });

  test(
    'a failed download stops its service and leaves no ready notice',
    () async {
      final platform = _FakeAndroidPlatform(versionCode: 11, signer: digest);
      final container = downloadContainer(
        platform: platform,
        downloader: (_, _) async =>
            throw const FormatException('downloaded APK digest does not match'),
      );
      await container.read(androidClientUpdateControllerProvider.future);

      await container
          .read(androidClientUpdateControllerProvider.notifier)
          .downloadAndInstall();

      expect(platform.starts, hasLength(1));
      expect(platform.stops, [isNull, isNull]);
      expect(platform.installCalls, 0);
      final state = container.read(androidClientUpdateControllerProvider).value;
      expect(state?.status, AndroidClientUpdateStatus.failed);
      expect(state?.detailCode, 'install-failed');
    },
  );
}

/// Lifecycle the test moves by hand. Starts in front, like the app.
final class _FakeLifecycle implements BrokerAppLifecycleMonitor {
  final _changes = StreamController<BrokerAppLifecycleState>.broadcast();

  @override
  BrokerAppLifecycleState currentState = BrokerAppLifecycleState.resumed;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges => _changes.stream;

  void emit(BrokerAppLifecycleState value) => _changes.add(value);

  @override
  void dispose() => unawaited(_changes.close());
}

final class _FakeAndroidPlatform implements AndroidUpdatePlatform {
  _FakeAndroidPlatform({
    required this.versionCode,
    required this.signer,
    this.serviceStarts = true,
  });

  final int versionCode;
  final String signer;
  final bool serviceStarts;
  int identityCalls = 0;
  int installCalls = 0;
  final starts = <AndroidUpdateDownloadNotice>[];
  final percents = <int>[];
  final stops = <AndroidUpdateReadyNotice?>[];

  @override
  bool get supported => true;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() async {
    identityCalls += 1;
    return AndroidInstalledAppIdentity(
      applicationId: 'com.cosyncing.client',
      versionCode: versionCode,
      signerSha256: signer,
    );
  }

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
  Future<bool> startDownloadService(AndroidUpdateDownloadNotice notice) async {
    starts.add(notice);
    return serviceStarts;
  }

  @override
  Future<void> showDownloadProgress(int percent) async => percents.add(percent);

  @override
  Future<void> stopDownloadService({AndroidUpdateReadyNotice? ready}) async =>
      stops.add(ready);
}
