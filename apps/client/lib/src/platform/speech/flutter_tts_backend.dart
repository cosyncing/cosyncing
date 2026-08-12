/// Converts an app-facing multiplier to flutter_tts's platform convention.
///
/// Web Speech uses 1.0 as normal. flutter_tts's supported native adapters use
/// 0.5 as normal (Android doubles that value before calling TextToSpeech).
double flutterTtsPluginRateForMultiplier(
  double multiplier, {
  required bool isWeb,
}) => isWeb ? multiplier : multiplier / 2;

/// Narrow, injectable seam over the `flutter_tts` plugin.
///
/// The real implementation wraps `FlutterTts` and lives in
/// `flutter_tts_backend_real.dart` (production code that imports
/// `package:flutter_tts`). Tests inject a fake that implements this
/// interface, so adapter behavior is verifiable without platform channels.
///
/// `flutter_tts` 4.2.5 exposes `pause()` but **no** `resume()` method, so this
/// seam intentionally omits `resume`. The adapter reports `pauseResume: false`
/// and treats `pause`/`resume` as honest no-ops; a future native adapter that
/// supports both may advertise `pauseResume: true`.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - adapter boundary).
abstract interface class FlutterTtsBackend {
  /// Enable await-speak-completion so [speak] resolves on completion, cancel,
  /// or error - not fire-and-forget.
  Future<void> enableAwaitCompletion();

  /// Speak [text]. Resolves when the utterance completes, is cancelled (by
  /// [stop]), or errors (reported via [setErrorHandler] before this resolves).
  Future<void> speak(String text);

  /// Apply a human-facing speed [multiplier], where 1.0 is normal.
  Future<void> setRate(double multiplier);

  /// Stop the current utterance and clear the platform queue.
  Future<void> stop();

  /// Set the error handler. Fires before a pending [speak] resolves when an
  /// error occurs.
  void setErrorHandler(void Function(Object? message) handler);

  /// Return available languages, or an empty list when TTS is unavailable.
  Future<List<String>> getLanguages();

  /// Release platform resources.
  void dispose();
}
