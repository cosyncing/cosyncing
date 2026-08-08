/// Native desktop "a newer build exists" detection.
///
/// The web client hands its tab to a replacement build on its own (see
/// `web_client_update.dart`) and the mobile packages update through their
/// stores. Native desktop packages have neither: after the broker upgrades,
/// the shell keeps running whatever was installed. This is a pointer, not an
/// updater — nothing here downloads or installs anything.
library;

import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// Download page for native desktop builds.
///
const String desktopClientDownloadUrl =
    'https://github.com/cosyncing/cosyncing/releases';

/// Whether this build is a native desktop package.
///
/// [isWeb] is a parameter rather than a direct `kIsWeb` read because it is not
/// redundant with [platform]: a browser running on a desktop OS still reports
/// [TargetPlatform.macOS] and friends, and the web client must never be told
/// to go download anything.
bool isDesktopClientPlatform(TargetPlatform platform, {required bool isWeb}) {
  if (isWeb) return false;
  return platform == TargetPlatform.windows ||
      platform == TargetPlatform.linux ||
      platform == TargetPlatform.macOS;
}

/// Which client-update notice, if any, owns the current Settings guidance.
enum ClientUpdateGuidance {
  /// No trustworthy update guidance is available.
  none,

  /// The desktop app is behind the broker release and should show its link.
  desktopDownload,

  /// Contract negotiation should provide the update guidance instead.
  compatibilityFallback,
}

/// Resolves desktop release comparison and contract fallback precedence.
///
/// The version pointer owns a native-desktop `broker > client` result even
/// when contract negotiation also says the client is behind. An ahead client
/// suppresses the fallback because recommending a client update there would
/// contradict the release identities. Equal or unreadable versions cannot
/// establish that contradiction, so a separately validated compatibility
/// fallback may still explain the contract mismatch.
///
/// Web and mobile never receive desktop download guidance. Their existing
/// compatibility fallback remains eligible because it is based on the broker
/// handshake rather than a desktop-package comparison.
ClientUpdateGuidance resolveClientUpdateGuidance({
  required TargetPlatform platform,
  required bool isWeb,
  required String? brokerVersion,
  required String clientVersion,
  required bool compatibilityFallbackAvailable,
}) {
  if (!isDesktopClientPlatform(platform, isWeb: isWeb)) {
    return compatibilityFallbackAvailable
        ? ClientUpdateGuidance.compatibilityFallback
        : ClientUpdateGuidance.none;
  }

  final client = _parseReleaseVersion(clientVersion);
  final broker = _parseReleaseVersion(brokerVersion);
  if (client == null || broker == null) {
    return compatibilityFallbackAvailable
        ? ClientUpdateGuidance.compatibilityFallback
        : ClientUpdateGuidance.none;
  }

  for (var index = 0; index < client.length; index++) {
    if (broker[index] > client[index]) {
      return ClientUpdateGuidance.desktopDownload;
    }
    if (broker[index] < client[index]) {
      return ClientUpdateGuidance.none;
    }
  }
  return compatibilityFallbackAvailable
      ? ClientUpdateGuidance.compatibilityFallback
      : ClientUpdateGuidance.none;
}

/// Whether [brokerVersion] is a newer release than this desktop build.
///
/// Broker and client ship as one release pair stamped from the same source
/// version, so the broker's running release is also the release this desktop
/// build should be at.
///
/// Fails closed on every uncertainty. [clientVersion] is the compiled-in
/// `COSYNCING_CLIENT_VERSION`, which is the `0.0.0-dev` sentinel on any build
/// no release pipeline stamped, and a broker may answer with no version at
/// all. Neither side may be guessed: an unreadable version on either side
/// reports no update rather than sending the user after a build they may
/// already be running.
bool desktopClientUpdateAvailable({
  required TargetPlatform platform,
  required bool isWeb,
  required String? brokerVersion,
  String clientVersion = cosyncingClientVersion,
}) {
  return resolveClientUpdateGuidance(
        platform: platform,
        isWeb: isWeb,
        brokerVersion: brokerVersion,
        clientVersion: clientVersion,
        compatibilityFallbackAvailable: false,
      ) ==
      ClientUpdateGuidance.desktopDownload;
}

/// Strict `major.minor.patch`. Pre-release and build suffixes — including the
/// `0.0.0-dev` default of an unstamped build — are not release identities and
/// yield `null` so the caller stays silent.
final RegExp _releaseVersionPattern = RegExp(r'^(\d+)\.(\d+)\.(\d+)$');

List<int>? _parseReleaseVersion(String? value) {
  final match = _releaseVersionPattern.firstMatch(value?.trim() ?? '');
  if (match == null) return null;
  final parsed = <int>[];
  for (var group = 1; group <= 3; group++) {
    final number = int.tryParse(match.group(group)!);
    if (number == null) return null;
    parsed.add(number);
  }
  return parsed;
}
