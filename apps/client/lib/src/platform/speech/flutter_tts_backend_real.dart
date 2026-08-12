/// Real FlutterTts backend implementation and platform-default factory.
///
/// This is production code that imports `package:flutter_tts`. It is **not**
/// excluded from static analysis; it analyzes cleanly once `flutter_tts` is
/// resolved via `flutter pub get`. In sandboxes where the package cannot be
/// fetched, these files remain unresolved - that is a verification blocker,
/// not a repository policy. The testable adapter logic lives in
/// `flutter_tts_speech_output.dart`, which depends only on the
/// `FlutterTtsBackend` interface.
///
/// Uses the flutter_tts 4.2.5 API:
/// - `FlutterTts()` constructor
/// - `awaitSpeakCompletion(bool)` so `speak` resolves on completion/cancel/error
/// - `speak(String)`, `stop()`, `pause()` (no `resume()` in 4.2.5)
/// - `setSpeechRate(double)` (1.0 normal on web, 0.5 normal on native)
/// - `setErrorHandler(void Function(dynamic))` (adapted to `Object?`)
/// - `getLanguages` (`Future<dynamic>`)
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction").
library;

import 'package:cosyncing_client/src/platform/speech/flutter_tts_backend.dart';
import 'package:cosyncing_client/src/platform/speech/flutter_tts_speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_factory.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';

/// Production [FlutterTtsBackend] backed by the `flutter_tts` plugin.
class FlutterTtsBackendImpl implements FlutterTtsBackend {
  /// Creates a backend wrapping a new `FlutterTts` instance.
  FlutterTtsBackendImpl() : _tts = FlutterTts();

  final FlutterTts _tts;

  @override
  Future<void> enableAwaitCompletion() async {
    await _tts.awaitSpeakCompletion(true);
  }

  @override
  Future<void> speak(String text) async {
    await _tts.speak(text);
  }

  @override
  Future<void> setRate(double multiplier) async {
    // flutter_tts normalizes native platforms around 0.5 (including Android,
    // where the plugin doubles the value before calling TextToSpeech) while
    // Web Speech uses 1.0. Keep that mismatch inside the platform wrapper so
    // the app-level contract remains an honest multiplier.
    final pluginRate = flutterTtsPluginRateForMultiplier(
      multiplier,
      isWeb: kIsWeb,
    );
    await _tts.setSpeechRate(pluginRate);
  }

  @override
  Future<void> stop() async {
    await _tts.stop();
  }

  @override
  void setErrorHandler(void Function(Object? message) handler) {
    // Adapt explicitly: the plugin's ErrorHandler typedef is
    // void Function(dynamic). The closure satisfies that signature while
    // the app-level seam uses Object? so no dynamic leaks beyond this
    // platform wrapper.
    _tts.setErrorHandler((dynamic message) => handler(message));
  }

  @override
  Future<List<String>> getLanguages() async {
    final result = await _tts.getLanguages;
    if (result is List) {
      return result.map((Object? e) => e.toString()).toList();
    }
    return const [];
  }

  @override
  void dispose() {
    // FlutterTts 4.x has no public dispose; platform resources are released
    // when the engine is GC'd or the app shuts down.
  }
}

/// Creates a FlutterTts-backed [SpeechOutput] for production use.
///
/// Backend construction and capability probing are deferred until the first
/// manual Read-aloud action. Merely mounting or resizing a session therefore
/// sends no traffic through the native plugin.
SpeechOutput createFlutterTtsSpeechOutput() {
  return FlutterTtsSpeechOutput.lazy(FlutterTtsBackendImpl.new);
}

/// Creates the platform-default [SpeechOutput] for the current platform.
///
/// Delegates to [createSpeechOutputForPlatform] with `kIsWeb` and
/// `defaultTargetPlatform`. When `kIsWeb` is true, the FlutterTts-backed
/// adapter is created regardless of host platform (so Chromium on Linux is not
/// disabled). When false, only Android, iOS, macOS, and Windows are supported
/// (strict native whitelist); Linux, Fuchsia, and other targets, or any
/// construction failure, return an [UnavailableSpeechOutput].
SpeechOutput createDefaultSpeechOutput() {
  return createSpeechOutputForPlatform(
    isWeb: kIsWeb,
    platform: defaultTargetPlatform,
    createSupportedAdapter: createFlutterTtsSpeechOutput,
  );
}
