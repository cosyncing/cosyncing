// The update state is intentionally explicit.
// Its names are the API documentation.
// ignore_for_file: public_member_api_docs

import 'dart:async';
import 'dart:io';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

const _applicationId = 'com.cosyncing.client';
const int _maxApkBytes = 256 * 1024 * 1024;
const _resumeCheckInterval = Duration(minutes: 15);
const _retryDelays = <Duration>[
  Duration(minutes: 1),
  Duration(minutes: 5),
  Duration(minutes: 30),
];

enum AndroidClientUpdateStatus {
  unsupported,
  current,
  available,
  downloading,
  readyToInstall,
  openingInstaller,
  permissionRequired,
  installerLaunched,
  failed,
}

final class AndroidClientUpdateCandidate {
  const AndroidClientUpdateCandidate({
    required this.version,
    required this.versionCode,
    required this.name,
    required this.url,
    required this.size,
    required this.sha256,
    required this.signerSha256,
  });

  final String version;
  final int versionCode;
  final String name;
  final Uri url;
  final int size;
  final String sha256;
  final String signerSha256;
}

final class AndroidClientUpdateState {
  const AndroidClientUpdateState({
    required this.status,
    this.candidate,
    this.progress,
    this.detailCode,
  });

  const AndroidClientUpdateState.unsupported()
    : this(status: AndroidClientUpdateStatus.unsupported);

  final AndroidClientUpdateStatus status;
  final AndroidClientUpdateCandidate? candidate;
  final double? progress;
  final String? detailCode;
}

typedef AndroidManifestFetcher = StableReleaseManifestFetcher;
typedef AndroidApkDownloader =
    Future<File> Function(
      AndroidClientUpdateCandidate candidate,
      void Function(double progress) onProgress,
    );

final androidUpdatePlatformProvider = Provider<AndroidUpdatePlatform>(
  (_) => createAndroidUpdatePlatform(),
);

final androidClientVersionProvider = Provider<String>(
  (_) => cosyncingClientVersion,
);

final androidManifestFetcherProvider = Provider<AndroidManifestFetcher>((ref) {
  return ref.watch(stableReleaseManifestFetcherProvider);
});

final androidApkDownloaderProvider = Provider<AndroidApkDownloader>((ref) {
  return (candidate, onProgress) async {
    final directory = await getTemporaryDirectory();
    final file = File(p.join(directory.path, candidate.name));
    final cancelToken = CancelToken();
    try {
      await ref
          .read(stableReleaseDioProvider)
          .download(
            candidate.url.toString(),
            file.path,
            cancelToken: cancelToken,
            options: Options(
              receiveTimeout: const Duration(minutes: 5),
              sendTimeout: const Duration(seconds: 20),
            ),
            onReceiveProgress: (received, total) {
              if (received > candidate.size) {
                cancelToken.cancel('APK exceeds its signed size');
                return;
              }
              final expected = total > 0 ? total : candidate.size;
              onProgress((received / expected).clamp(0, 1));
            },
          );
    } on Object {
      _deleteIfPresent(file);
      rethrow;
    }
    final stat = file.statSync();
    if (stat.type != FileSystemEntityType.file || stat.size != candidate.size) {
      _deleteIfPresent(file);
      throw const FormatException('downloaded APK size does not match');
    }
    final digest = await sha256StreamDigest(file.openRead());
    if (digest.digest != 'sha256:${candidate.sha256}') {
      _deleteIfPresent(file);
      throw const FormatException('downloaded APK digest does not match');
    }
    return file;
  };
});

/// The language the download's notifications speak: the app's own.
final androidUpdateNoticeLocalizationsProvider = Provider<AppLocalizations>(
  (ref) =>
      resolveAppLocalizations(ref.watch(localeControllerProvider).valueOrNull),
);

final androidClientUpdateControllerProvider =
    AsyncNotifierProvider<
      AndroidClientUpdateController,
      AndroidClientUpdateState
    >(AndroidClientUpdateController.new);

final class AndroidClientUpdateController
    extends AsyncNotifier<AndroidClientUpdateState> {
  File? _verifiedApk;
  Timer? _retryTimer;
  DateTime? _lastCheckedAt;
  int _retryIndex = 0;
  bool _checkInFlight = false;
  bool _installInFlight = false;

  @override
  Future<AndroidClientUpdateState> build() async {
    ref.onDispose(() {
      _retryTimer?.cancel();
      _discardVerifiedApk();
    });
    final platform = ref.read(androidUpdatePlatformProvider);
    if (!platform.supported) {
      return const AndroidClientUpdateState.unsupported();
    }
    // A ready-to-install notice left by a process Android has since ended
    // names an APK this process never verified.
    unawaited(_quietly(platform.stopDownloadService));
    return _runCheck(platform);
  }

  Future<void> check() async {
    final platform = ref.read(androidUpdatePlatformProvider);
    if (!platform.supported || _checkInFlight || _installInFlight) return;
    state = const AsyncLoading();
    state = AsyncData(await _runCheck(platform));
  }

  Future<void> checkIfStale() async {
    final status = state.valueOrNull?.status;
    final lastCheckedAt = _lastCheckedAt;
    if (status != AndroidClientUpdateStatus.installerLaunched &&
        lastCheckedAt != null &&
        DateTime.now().difference(lastCheckedAt) < _resumeCheckInterval) {
      return;
    }
    await check();
  }

  Future<AndroidClientUpdateState> _runCheck(
    AndroidUpdatePlatform platform,
  ) async {
    _checkInFlight = true;
    _lastCheckedAt = DateTime.now();
    try {
      final result = await _check(platform);
      if (result.detailCode == 'check-failed') {
        _scheduleRetry();
      } else {
        _retryTimer?.cancel();
        _retryIndex = 0;
      }
      return result;
    } finally {
      _checkInFlight = false;
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    final index = _retryIndex < _retryDelays.length
        ? _retryIndex
        : _retryDelays.length - 1;
    final delay = _retryDelays[index];
    if (_retryIndex < _retryDelays.length - 1) _retryIndex += 1;
    _retryTimer = Timer(delay, () => unawaited(check()));
  }

  Future<AndroidClientUpdateState> _check(
    AndroidUpdatePlatform platform,
  ) async {
    try {
      final installed = await platform.installedIdentity();
      if (installed.applicationId != _applicationId ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(installed.signerSha256)) {
        return const AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.failed,
          detailCode: 'installed-identity-invalid',
        );
      }
      final manifest = await ref.read(androidManifestFetcherProvider)();
      final candidate = parseAndroidUpdateCandidate(manifest);
      if (candidate == null ||
          installed.signerSha256 != candidate.signerSha256) {
        return const AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.failed,
          detailCode: 'release-identity-invalid',
        );
      }
      final versionComparison = compareStableReleaseVersions(
        candidate.version,
        ref.read(androidClientVersionProvider),
      );
      final codeComparison = candidate.versionCode.compareTo(
        installed.versionCode,
      );
      if (versionComparison == null ||
          (versionComparison > 0) != (codeComparison > 0)) {
        return const AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.failed,
          detailCode: 'release-version-incoherent',
        );
      }
      if (versionComparison <= 0) {
        return const AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.current,
        );
      }
      return AndroidClientUpdateState(
        status: AndroidClientUpdateStatus.available,
        candidate: candidate,
      );
    } on Object {
      return const AndroidClientUpdateState(
        status: AndroidClientUpdateStatus.failed,
        detailCode: 'check-failed',
      );
    }
  }

  Future<void> downloadAndInstall() async {
    if (_installInFlight) return;
    final candidate = state.valueOrNull?.candidate;
    if (candidate == null) return;
    _installInFlight = true;
    try {
      await _downloadAndInstall(candidate);
    } finally {
      _installInFlight = false;
    }
  }

  Future<void> _downloadAndInstall(
    AndroidClientUpdateCandidate candidate,
  ) async {
    final cachedApk = _verifiedApk;
    if (state.valueOrNull?.status ==
            AndroidClientUpdateStatus.permissionRequired &&
        cachedApk != null &&
        cachedApk.existsSync()) {
      await _openInstaller(candidate, cachedApk);
      return;
    }
    state = AsyncData(
      AndroidClientUpdateState(
        status: AndroidClientUpdateStatus.downloading,
        candidate: candidate,
        progress: 0,
      ),
    );
    final platform = ref.read(androidUpdatePlatformProvider);
    final l10n = ref.read(androidUpdateNoticeLocalizationsProvider);
    // Without a foreground service Android freezes the app soon after the
    // user leaves it, and the download stops with it. Not awaited: the
    // download need not wait for it, and channel calls keep their order, so
    // Android sees the start before any progress or stop.
    unawaited(
      _quietly(
        () => platform.startDownloadService(
          AndroidUpdateDownloadNotice(
            channelName: l10n.androidUpdateChannelName,
            title: l10n.androidUpdateNotificationDownloadingTitle(
              candidate.version,
            ),
          ),
        ),
      ),
    );
    final File file;
    try {
      var shownPercent = -1;
      file = await ref.read(androidApkDownloaderProvider)(candidate, (
        progress,
      ) {
        // The download reports every chunk it receives; the bar and the
        // notification need each percent once.
        final percent = (progress * 100).floor();
        if (percent == shownPercent) return;
        shownPercent = percent;
        state = AsyncData(
          AndroidClientUpdateState(
            status: AndroidClientUpdateStatus.downloading,
            candidate: candidate,
            progress: progress,
          ),
        );
        unawaited(_quietly(() => platform.showDownloadProgress(percent)));
      });
    } on Object {
      _discardVerifiedApk();
      await _quietly(platform.stopDownloadService);
      state = AsyncData(
        AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.failed,
          candidate: candidate,
          detailCode: 'install-failed',
        ),
      );
      return;
    }
    _verifiedApk = file;
    final lifecycle = ref.read(sessionNotificationLifecycleMonitorProvider);
    if (lifecycle.currentState != BrokerAppLifecycleState.resumed) {
      // Android opens an installer only for an app in front, so the
      // download that finished out of sight waits for the user to return,
      // with a notification that brings them back.
      state = AsyncData(
        AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.readyToInstall,
          candidate: candidate,
        ),
      );
      await _quietly(
        () => platform.stopDownloadService(
          ready: AndroidUpdateReadyNotice(
            channelName: l10n.androidUpdateChannelName,
            title: l10n.androidUpdateNotificationReadyTitle(candidate.version),
            text: l10n.androidUpdateNotificationReadyText,
          ),
        ),
      );
      final back = await lifecycle.stateChanges.firstWhere(
        (value) => value == BrokerAppLifecycleState.resumed,
        // The monitor closed: the app is shutting down, and the next launch
        // offers the update again.
        orElse: () => BrokerAppLifecycleState.detached,
      );
      if (back != BrokerAppLifecycleState.resumed) return;
    }
    await _quietly(platform.stopDownloadService);
    await _openInstaller(candidate, file);
  }

  Future<void> _openInstaller(
    AndroidClientUpdateCandidate candidate,
    File file,
  ) async {
    try {
      state = AsyncData(
        AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.openingInstaller,
          candidate: candidate,
        ),
      );
      final result = await ref
          .read(androidUpdatePlatformProvider)
          .installApk(
            path: file.path,
            applicationId: _applicationId,
            version: candidate.version,
            versionCode: candidate.versionCode,
            signerSha256: candidate.signerSha256,
          );
      if (result == AndroidInstallLaunchResult.permissionRequired) {
        state = AsyncData(
          AndroidClientUpdateState(
            status: AndroidClientUpdateStatus.permissionRequired,
            candidate: candidate,
          ),
        );
      } else {
        _discardVerifiedApk();
        state = AsyncData(
          AndroidClientUpdateState(
            status: AndroidClientUpdateStatus.installerLaunched,
            candidate: candidate,
          ),
        );
      }
    } on Object {
      _discardVerifiedApk();
      state = AsyncData(
        AndroidClientUpdateState(
          status: AndroidClientUpdateStatus.failed,
          candidate: candidate,
          detailCode: 'install-failed',
        ),
      );
    }
  }

  void _discardVerifiedApk() {
    final file = _verifiedApk;
    _verifiedApk = null;
    if (file != null) _deleteIfPresent(file);
  }
}

Future<bool> verifyAndroidReleaseManifestSignature({
  required List<int> manifestBytes,
  required List<int> signatureBytes,
  String publicKey = stableReleasePublicKey,
}) => verifyStableReleaseManifestSignature(
  manifestBytes: manifestBytes,
  signatureBytes: signatureBytes,
  publicKey: publicKey,
);

Map<String, Object?> decodeAndroidReleaseManifest(List<int> bytes) =>
    decodeStableReleaseManifest(bytes);

/// Runs a notification call whose failure must never cost the update: the
/// download and the installer work without it.
Future<void> _quietly(Future<Object?> Function() call) async {
  try {
    await call();
  } on Object {
    // Best effort by design.
  }
}

void _deleteIfPresent(File file) {
  try {
    if (file.existsSync()) file.deleteSync();
  } on FileSystemException {
    // The rejected download is unusable and will be overwritten next time.
  }
}

AndroidClientUpdateCandidate? parseAndroidUpdateCandidate(
  Map<String, Object?> manifest,
) {
  if (manifest['schemaVersion'] != 1 ||
      manifest['product'] != 'cosyncing' ||
      manifest['channel'] != 'stable') {
    return null;
  }
  final version = manifest['version'];
  final value = manifest['androidApp'];
  if (version is! String || value is! Map<String, Object?>) return null;
  final name = value['name'];
  final applicationId = value['applicationId'];
  final versionCode = value['versionCode'];
  final size = value['size'];
  final sha256 = value['sha256'];
  final urlValue = value['url'];
  final signerSha256 = value['signerSha256'];
  final expectedName = 'cosyncing-client-$version-android.apk';
  final uri = urlValue is String ? Uri.tryParse(urlValue) : null;
  if (!stableReleaseVersionPattern.hasMatch(version) ||
      name is! String ||
      name != expectedName ||
      applicationId != _applicationId ||
      versionCode is! int ||
      versionCode <= 0 ||
      size is! int ||
      size <= 0 ||
      size > _maxApkBytes ||
      sha256 is! String ||
      !_sha256.hasMatch(sha256) ||
      signerSha256 is! String ||
      !_sha256.hasMatch(signerSha256) ||
      uri == null ||
      uri.scheme != 'https' ||
      uri.host != 'github.com' ||
      uri.query.isNotEmpty ||
      uri.fragment.isNotEmpty ||
      uri.path !=
          '/cosyncing/cosyncing/releases/download/broker-v$version/$name') {
    return null;
  }
  return AndroidClientUpdateCandidate(
    version: version,
    versionCode: versionCode,
    name: name,
    url: uri,
    size: size,
    sha256: sha256,
    signerSha256: signerSha256,
  );
}

final _sha256 = RegExp(r'^[a-f0-9]{64}$');
