// The implementation is private; only its conditional factory is exported.
// ignore_for_file: public_member_api_docs

import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';

AndroidUpdatePlatform createAndroidUpdatePlatform() =>
    const _UnsupportedAndroidUpdatePlatform();

final class _UnsupportedAndroidUpdatePlatform implements AndroidUpdatePlatform {
  const _UnsupportedAndroidUpdatePlatform();

  @override
  bool get supported => false;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() =>
      throw UnsupportedError('Android updates are unavailable');

  @override
  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  }) => throw UnsupportedError('Android updates are unavailable');
}
