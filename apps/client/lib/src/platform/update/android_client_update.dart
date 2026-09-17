// The update state is intentionally explicit.
// Its names are the API documentation.
// ignore_for_file: public_member_api_docs

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform.dart';
import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

const androidReleaseManifestUrl =
    'https://github.com/cosyncing/cosyncing/releases/latest/download/'
    'release-manifest.json';
const androidReleaseManifestSignatureUrl = '$androidReleaseManifestUrl.sig';
// DER SPKI for docs/release/release-public-key.txt, encoded as base64url.
const androidReleasePublicKey =
    'MCowBQYDK2VwAyEA212_jMFGHeMA4GFANcquhrjxzNOA37XXpUbYj4lusI8';
const _applicationId = 'com.cosyncing.client';
const int _maxManifestBytes = 256 * 1024;
const int _ed25519SignatureBytes = 64;
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

typedef AndroidManifestFetcher = Future<Map<String, Object?>> Function();
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

final androidUpdateDioProvider = Provider<Dio>((_) => Dio());

final androidManifestFetcherProvider = Provider<AndroidManifestFetcher>((ref) {
  return () async {
    final dio = ref.read(androidUpdateDioProvider);
    final bytes = await _boundedGet(
      dio,
      androidReleaseManifestUrl,
      maxBytes: _maxManifestBytes,
      accept: 'application/json',
    );
    final signature = await _boundedGet(
      dio,
      androidReleaseManifestSignatureUrl,
      maxBytes: _ed25519SignatureBytes,
      accept: 'application/octet-stream',
    );
    if (!await verifyAndroidReleaseManifestSignature(
      manifestBytes: bytes,
      signatureBytes: signature,
    )) {
      throw const FormatException('release manifest signature is invalid');
    }
    return decodeAndroidReleaseManifest(bytes);
  };
});

final androidApkDownloaderProvider = Provider<AndroidApkDownloader>((ref) {
  return (candidate, onProgress) async {
    final directory = await getTemporaryDirectory();
    final file = File(p.join(directory.path, candidate.name));
    final cancelToken = CancelToken();
    try {
      await ref
          .read(androidUpdateDioProvider)
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
      final versionComparison = _compareVersions(
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
    try {
      final file = await ref.read(androidApkDownloaderProvider)(candidate, (
        progress,
      ) {
        state = AsyncData(
          AndroidClientUpdateState(
            status: AndroidClientUpdateStatus.downloading,
            candidate: candidate,
            progress: progress,
          ),
        );
      });
      _verifiedApk = file;
      await _openInstaller(candidate, file);
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

Future<List<int>> _boundedGet(
  Dio dio,
  String url, {
  required int maxBytes,
  required String accept,
}) async {
  final response = await dio.get<ResponseBody>(
    url,
    options: Options(
      responseType: ResponseType.stream,
      receiveTimeout: const Duration(seconds: 20),
      sendTimeout: const Duration(seconds: 20),
      headers: {'Accept': accept},
    ),
  );
  final body = response.data;
  if (body == null) {
    throw const FormatException('release metadata size is invalid');
  }
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in body.stream) {
    if (bytes.length + chunk.length > maxBytes) {
      throw const FormatException('release metadata size is invalid');
    }
    bytes.add(chunk);
  }
  final value = bytes.takeBytes();
  if (value.isEmpty) {
    throw const FormatException('release metadata size is invalid');
  }
  return value;
}

Future<bool> verifyAndroidReleaseManifestSignature({
  required List<int> manifestBytes,
  required List<int> signatureBytes,
  String publicKey = androidReleasePublicKey,
}) async {
  if (manifestBytes.isEmpty ||
      manifestBytes.length > _maxManifestBytes ||
      signatureBytes.length != _ed25519SignatureBytes) {
    return false;
  }
  return PairingCrypto.verifyIdentitySignature(
    publicKey: publicKey,
    message: manifestBytes,
    signature: base64UrlNoPadding(signatureBytes),
  );
}

Map<String, Object?> decodeAndroidReleaseManifest(List<int> bytes) {
  final value = jsonDecode(utf8.decode(bytes));
  if (value is! Map<String, Object?>) {
    throw const FormatException('release manifest is not an object');
  }
  return value;
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
  if (!_releaseVersion.hasMatch(version) ||
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

final _releaseVersion = RegExp(r'^\d+\.\d+\.\d+$');
final _sha256 = RegExp(r'^[a-f0-9]{64}$');

int? _compareVersions(String candidate, String current) {
  if (!_releaseVersion.hasMatch(candidate) ||
      !_releaseVersion.hasMatch(current)) {
    return null;
  }
  final left = candidate.split('.').map(int.parse).toList(growable: false);
  final right = current.split('.').map(int.parse).toList(growable: false);
  for (var index = 0; index < 3; index += 1) {
    if (left[index] != right[index]) return left[index].compareTo(right[index]);
  }
  return 0;
}
