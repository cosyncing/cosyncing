// Small aggregation seam used across navigation surfaces.
// ignore_for_file: public_member_api_docs

import 'package:cosyncing_client/src/platform/update/android_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

bool supportsNativeClientUpdates(
  TargetPlatform platform, {
  required bool isWeb,
}) {
  if (isWeb) return false;
  return platform == TargetPlatform.android ||
      isDesktopClientPlatform(platform, isWeb: false);
}

/// Whether a native client update still needs the user's attention.
final nativeClientUpdateAvailableProvider = Provider<bool>((ref) {
  if (ref.watch(clientIsWebProvider)) return false;
  final platform = ref.watch(clientTargetPlatformProvider);
  if (platform == TargetPlatform.android) {
    final state = ref.watch(androidClientUpdateControllerProvider).valueOrNull;
    return state?.candidate != null &&
        state?.status != AndroidClientUpdateStatus.installerLaunched;
  }
  if (isDesktopClientPlatform(platform, isWeb: false)) {
    return ref
            .watch(desktopClientUpdateControllerProvider)
            .valueOrNull
            ?.status ==
        DesktopClientUpdateStatus.available;
  }
  return false;
});
