import 'package:broker_contract/broker_contract.dart';
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
