import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter/foundation.dart';

/// Creates the platform-appropriate [SpeechOutput].
///
/// This is a pure function: it does not invoke platform channels. The caller
/// supplies [isWeb] (typically `kIsWeb`) and [platform] (typically
/// `defaultTargetPlatform`) so the decision is fully explicit and testable.
///
/// **Web overrides host platform:** when [isWeb] is `true`, the supported
/// adapter factory is invoked regardless of [platform]. This ensures Chromium
/// running on a Linux host is not disabled (web TTS works through the browser,
/// not the host OS).
///
/// **Native whitelist:** when [isWeb] is `false`, only Android, iOS, macOS,
/// and Windows are supported. Linux, Fuchsia, and any other target return
/// [UnavailableSpeechOutput] without calling [createSupportedAdapter].
///
/// If [createSupportedAdapter] throws synchronously, the result degrades to
/// [UnavailableSpeechOutput] rather than crashing bootstrap.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction").
SpeechOutput createSpeechOutputForPlatform({
  required bool isWeb,
  required TargetPlatform platform,
  required SpeechOutput Function() createSupportedAdapter,
}) {
  if (isWeb) {
    try {
      return createSupportedAdapter();
    } on Object {
      return const UnavailableSpeechOutput();
    }
  }

  // Native: only Android, iOS, macOS, and Windows are supported by flutter_tts.
  // Linux, Fuchsia, and other targets degrade honestly.
  if (platform == TargetPlatform.android ||
      platform == TargetPlatform.iOS ||
      platform == TargetPlatform.macOS ||
      platform == TargetPlatform.windows) {
    try {
      return createSupportedAdapter();
    } on Object {
      return const UnavailableSpeechOutput();
    }
  }

  return const UnavailableSpeechOutput();
}

/// A [SpeechOutput] that reports no capabilities and never speaks.
///
/// Used on unsupported platforms (Linux native, Fuchsia) and when adapter
/// construction fails.
class UnavailableSpeechOutput implements SpeechOutput {
  /// Creates an unavailable speech output.
  const UnavailableSpeechOutput();

  @override
  SpeechOutputCapabilities get capabilities =>
      SpeechOutputCapabilities.unavailable;

  @override
  SpeechOutputState get current => const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states =>
      const Stream<SpeechOutputState>.empty();

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {}

  @override
  Future<void> setRate(double rate) async {}

  @override
  Future<void> pause() async {}

  @override
  Future<void> resume() async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}
