import 'dart:async';
import 'dart:developer';

import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/platform/startup/executing_client_build_identity.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// Bootstrap the app with error capture and Riverpod scope.
///
/// [builder] returns the root widget (typically the App shell).
/// All platform-specific entry points call this after configuring
/// their environment.
Future<void> bootstrap(Widget Function() builder) async {
  FlutterError.onError = (details) {
    log(details.exceptionAsString(), stackTrace: details.stack);
  };

  // Wire the transcript link opener once. The render layer stays dependency
  // free and only ever hands us http(s) URLs (the scheme gate lives in
  // isTranscriptHttpUrl); local paths are never launched.
  transcriptLinkOpener = (uri) =>
      unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));

  await runZonedGuarded(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      publishExecutingClientBuildIdentity();
      runApp(
        ProviderScope(
          child: builder(),
        ),
      );
    },
    (error, stackTrace) {
      log(error.toString(), stackTrace: stackTrace);
    },
  );
}
