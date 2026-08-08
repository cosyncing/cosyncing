import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/foundation.dart';

/// Creates the platform-appropriate [SpeechInput].
///
/// This is a pure function: it does not invoke platform channels. The caller
/// supplies [isWeb] (typically `kIsWeb`), [platform] (typically
/// `defaultTargetPlatform`), and [isSecureContext] (on web, whether the page
/// origin is HTTPS or trusted loopback; `true` on native) so the decision is
/// fully explicit and testable.
///
/// **Web overrides host platform:** when [isWeb] is `true`, the supported
/// adapter factory is invoked regardless of [platform]. This ensures Chromium
/// running on a Linux host is not disabled (web ASR works through the browser,
/// not the host OS). However, web ASR requires a secure context
/// ([isSecureContext] must be `true`); an insecure origin returns
/// [UnavailableSpeechInput] without constructing the adapter.
///
/// **Native whitelist:** when [isWeb] is `false`, only Android, iOS, macOS,
/// and Windows are supported. Linux, Fuchsia, and any other target return
/// [UnavailableSpeechInput] without calling [createSupportedAdapter].
/// (Windows ASR is beta and documented as such; it is included in the
/// whitelist so it can be validated, not deferred.)
///
/// If [createSupportedAdapter] throws synchronously, the result degrades to
/// [UnavailableSpeechInput] rather than crashing bootstrap.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction").
SpeechInput createSpeechInputForPlatform({
  required bool isWeb,
  required TargetPlatform platform,
  required bool isSecureContext,
  required SpeechInput Function() createSupportedAdapter,
}) {
  if (isWeb) {
    if (!isSecureContext) {
      return const UnavailableSpeechInput(
        'Voice input requires a secure connection (HTTPS).',
        kind: SpeechInputFailureKind.secureContext,
      );
    }
    try {
      return createSupportedAdapter();
    } on Object {
      return const UnavailableSpeechInput(
        'Speech recognition is not available.',
        kind: SpeechInputFailureKind.unsupported,
      );
    }
  }

  // Native: only Android, iOS, macOS, and Windows are supported by
  // speech_to_text. Linux, Fuchsia, and other targets degrade honestly.
  if (platform == TargetPlatform.android ||
      platform == TargetPlatform.iOS ||
      platform == TargetPlatform.macOS ||
      platform == TargetPlatform.windows) {
    try {
      return createSupportedAdapter();
    } on Object {
      return const UnavailableSpeechInput(
        'Speech recognition is not available.',
        kind: SpeechInputFailureKind.unsupported,
      );
    }
  }

  return const UnavailableSpeechInput(
    'Speech recognition is not available on this platform.',
    kind: SpeechInputFailureKind.unsupported,
  );
}

/// A [SpeechInput] that reports no capabilities and never listens.
///
/// Used on unsupported platforms (Linux native, Fuchsia), insecure web
/// origins, and when adapter construction fails.
class UnavailableSpeechInput implements SpeechInput {
  /// Creates an unavailable speech input with an actionable reason and a typed
  /// [kind] the UI can localize.
  const UnavailableSpeechInput(
    this.reason, {
    this.kind = SpeechInputFailureKind.unknown,
  });

  /// Why recognition is unavailable (non-localized fallback / Debug text).
  final String reason;

  /// Typed classification the UI localizes into an actionable message.
  final SpeechInputFailureKind kind;

  @override
  SpeechInputCapabilities get capabilities =>
      SpeechInputCapabilities.unavailable;

  @override
  SpeechInputState get current => SpeechInputUnavailable(reason, kind: kind);

  @override
  Stream<SpeechInputState> get states => Stream<SpeechInputState>.value(
    SpeechInputUnavailable(reason, kind: kind),
  );

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> cancel() async {}

  @override
  String? consumeReady() => null;

  @override
  Future<void> dispose() async {}
}
