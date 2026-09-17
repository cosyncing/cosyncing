import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
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
    final container = ProviderContainer(
      overrides: [
        androidUpdatePlatformProvider.overrideWithValue(platform),
        androidClientVersionProvider.overrideWithValue('1.1.0'),
        androidManifestFetcherProvider.overrideWithValue(
          () async => manifest(),
        ),
        androidApkDownloaderProvider.overrideWithValue((_, _) {
          downloadCalls += 1;
          return download.future;
        }),
      ],
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
}

final class _FakeAndroidPlatform implements AndroidUpdatePlatform {
  _FakeAndroidPlatform({required this.versionCode, required this.signer});

  final int versionCode;
  final String signer;
  int identityCalls = 0;
  int installCalls = 0;

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
}
