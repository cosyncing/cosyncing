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

/// The notification an APK download shows while it runs, in the app's
/// language.
final class AndroidUpdateDownloadNotice {
  const AndroidUpdateDownloadNotice({
    required this.channelName,
    required this.title,
  });

  final String channelName;
  final String title;
}

/// The notification left when a download finishes while the app is out of
/// sight. Tapping it opens the app, which then opens Android's installer.
final class AndroidUpdateReadyNotice {
  const AndroidUpdateReadyNotice({
    required this.channelName,
    required this.title,
    required this.text,
  });

  final String channelName;
  final String title;
  final String text;
}

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

  /// Runs the APK download under a foreground service whose notification
  /// shows its progress, so Android keeps the app running after the user
  /// leaves it. Returns false when Android refuses; the download then runs
  /// only while the app stays open.
  Future<bool> startDownloadService(AndroidUpdateDownloadNotice notice);

  /// Moves the service notification's bar to [percent] (0–100).
  Future<void> showDownloadProgress(int percent);

  /// Stops the service. With [ready], leaves a notification that opens the
  /// app to install; without it, also clears any such notification.
  Future<void> stopDownloadService({AndroidUpdateReadyNotice? ready});
}
