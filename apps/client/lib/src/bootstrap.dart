import 'dart:async';
import 'dart:developer';

import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/platform/startup/browser_context_menu_startup.dart';
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
    // `presentError` is what writes the framework's full diagnostic — library,
    // context, offending widget and stack — to the console. Replacing the hook
    // without calling it silently discards build failures: in a release web
    // build the only surviving evidence is Flutter's grey `RenderErrorBox`
    // painted over the subtree that threw, which reads as a rendering glitch
    // rather than the exception behind it.
    FlutterError.presentError(details);
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
      // Must settle before the first frame: a later flip of the global
      // `BrowserContextMenu.enabled` re-inflates every live `SelectionArea`'s
      // container, and release builds compile out the SDK assert that guards
      // the resulting double registration. See the web implementation.
      await disableBrowserContextMenuBeforeFirstFrame();
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
