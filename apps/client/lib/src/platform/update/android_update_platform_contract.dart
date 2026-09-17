// This small native bridge is self-describing at each method boundary.
// ignore_for_file: public_member_api_docs

/// Native identity of the installed Android application.
final class AndroidInstalledAppIdentity {
  const AndroidInstalledAppIdentity({
    required this.applicationId,
    required this.versionCode,
    required this.signerSha256,
  });

  final String applicationId;
  final int versionCode;
  final String signerSha256;
}

enum AndroidInstallLaunchResult { launched, permissionRequired }

/// Small native seam for inspecting and handing an APK to Android.
abstract interface class AndroidUpdatePlatform {
  bool get supported;

  Future<AndroidInstalledAppIdentity> installedIdentity();

  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  });
}
