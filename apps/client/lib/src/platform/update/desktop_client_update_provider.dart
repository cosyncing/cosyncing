// The update state is intentionally explicit and self-documenting.
// ignore_for_file: public_member_api_docs

import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:cosyncing_client/src/platform/update/stable_release_manifest.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// Release version compiled into this build.
///
/// A provider rather than a direct constant read so widget tests can pump a
/// stamped build: `flutter test` passes no `--dart-define`, so the compiled-in
/// value under test is always the `0.0.0-dev` sentinel.
final desktopClientVersionProvider = Provider<String>(
  (_) => cosyncingClientVersion,
);

/// Hands a URL to the system browser.
typedef DesktopDownloadLauncher = Future<bool> Function(Uri url);

/// Seam for the system-browser launch, overridden in tests.
final desktopDownloadLauncherProvider = Provider<DesktopDownloadLauncher>(
  (_) =>
      (url) => launchUrl(url, mode: LaunchMode.externalApplication),
);

/// Runtime platform seams shared by native update UI and tests.
final clientTargetPlatformProvider = Provider<TargetPlatform>(
  (_) => defaultTargetPlatform,
);
final clientIsWebProvider = Provider<bool>((_) => kIsWeb);

enum DesktopClientUpdateStatus { unsupported, current, available, failed }

final class DesktopClientUpdateCandidate {
  const DesktopClientUpdateCandidate({
    required this.version,
    required this.url,
  });

  final String version;
  final Uri url;
}

final class DesktopClientUpdateState {
  const DesktopClientUpdateState({required this.status, this.candidate});

  const DesktopClientUpdateState.unsupported()
    : this(status: DesktopClientUpdateStatus.unsupported);

  final DesktopClientUpdateStatus status;
  final DesktopClientUpdateCandidate? candidate;
}

final desktopClientUpdateControllerProvider =
    AsyncNotifierProvider<
      DesktopClientUpdateController,
      DesktopClientUpdateState
    >(DesktopClientUpdateController.new);

final class DesktopClientUpdateController
    extends AsyncNotifier<DesktopClientUpdateState> {
  DateTime? _lastCheckedAt;
  bool _checkInFlight = false;

  @override
  Future<DesktopClientUpdateState> build() async {
    if (!_supported()) return const DesktopClientUpdateState.unsupported();
    return _runCheck();
  }

  Future<void> check() async {
    if (!_supported() || _checkInFlight) return;
    state = const AsyncLoading();
    state = AsyncData(await _runCheck());
  }

  Future<void> checkIfStale() async {
    final checkedAt = _lastCheckedAt;
    if (checkedAt != null &&
        DateTime.now().difference(checkedAt) < const Duration(minutes: 15)) {
      return;
    }
    await check();
  }

  bool _supported() => isDesktopClientPlatform(
    ref.read(clientTargetPlatformProvider),
    isWeb: ref.read(clientIsWebProvider),
  );

  Future<DesktopClientUpdateState> _runCheck() async {
    _checkInFlight = true;
    _lastCheckedAt = DateTime.now();
    try {
      final manifest = await ref.read(stableReleaseManifestFetcherProvider)();
      return parseDesktopClientUpdate(
        manifest,
        platform: ref.read(clientTargetPlatformProvider),
        currentVersion: ref.read(desktopClientVersionProvider),
      );
    } on Object {
      return const DesktopClientUpdateState(
        status: DesktopClientUpdateStatus.failed,
      );
    } finally {
      _checkInFlight = false;
    }
  }
}

DesktopClientUpdateState parseDesktopClientUpdate(
  Map<String, Object?> manifest, {
  required TargetPlatform platform,
  required String currentVersion,
}) {
  if (manifest['schemaVersion'] != 1 ||
      manifest['product'] != 'cosyncing' ||
      manifest['channel'] != 'stable') {
    return const DesktopClientUpdateState(
      status: DesktopClientUpdateStatus.failed,
    );
  }
  final version = manifest['version'];
  if (version is! String) {
    return const DesktopClientUpdateState(
      status: DesktopClientUpdateStatus.failed,
    );
  }
  final comparison = compareStableReleaseVersions(version, currentVersion);
  final url = desktopClientDownloadUri(platform, version);
  if (comparison == null || url == null) {
    return const DesktopClientUpdateState(
      status: DesktopClientUpdateStatus.failed,
    );
  }
  if (comparison <= 0) {
    return const DesktopClientUpdateState(
      status: DesktopClientUpdateStatus.current,
    );
  }
  return DesktopClientUpdateState(
    status: DesktopClientUpdateStatus.available,
    candidate: DesktopClientUpdateCandidate(version: version, url: url),
  );
}
