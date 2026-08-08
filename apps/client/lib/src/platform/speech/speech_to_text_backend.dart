/// App-owned recognition result (no plugin types escape this boundary).
///
/// The real wrapper translates the plugin's `SpeechRecognitionResult` into
/// this plain class so views, controllers, and tests never depend on
/// `speech_to_text` types.
class BackendRecognitionResult {
  /// Creates a backend recognition result.
  const BackendRecognitionResult({
    required this.recognizedWords,
    required this.isFinal,
  });

  /// The recognized text so far (partial or final).
  final String recognizedWords;

  /// Whether this is a final result (no more updates for this utterance).
  final bool isFinal;
}

/// App-owned speech-recognition error.
///
/// The plugin's error object is translated at the platform boundary so the
/// adapter can classify failures without importing plugin types.
class BackendSpeechError {
  /// Creates a backend speech error.
  const BackendSpeechError({required this.code, required this.permanent});

  /// Stable plugin error code, such as `error_permission`.
  final String code;

  /// Whether the recognizer reports that retrying this instance cannot help.
  final bool permanent;
}

/// App-owned initialization options for the speech recognition backend.
///
/// The real backend maps these values to plugin-specific configuration
/// objects. Keeping the options here makes runtime selection testable without
/// importing plugin types or invoking platform channels.
enum BackendInitializationOption {
  /// Avoid Android Bluetooth permission requests.
  androidNoBluetooth,

  /// Disable Web Speech result aggregation on Android browsers.
  webDoNotAggregate,
}

/// Selects backend initialization options for the current runtime.
///
/// Android Chrome needs [BackendInitializationOption.webDoNotAggregate]
/// because its Web Speech implementation otherwise repeats aggregated text.
/// No other web or native runtime receives that option. The existing
/// no-Bluetooth behavior remains enabled independently.
Set<BackendInitializationOption> speechBackendOptionsForRuntime({
  required bool isWeb,
  required bool isAndroid,
}) {
  return Set<BackendInitializationOption>.unmodifiable({
    BackendInitializationOption.androidNoBluetooth,
    if (isWeb && isAndroid) BackendInitializationOption.webDoNotAggregate,
  });
}

/// App-owned listen options for the speech recognition backend.
///
/// The real wrapper maps these to the plugin's `SpeechListenOptions`.
class BackendListenOptions {
  /// Creates backend listen options.
  const BackendListenOptions({
    this.partialResults = true,
    this.onDevice = false,
    this.cancelOnError = true,
  });

  /// Whether partial (non-final) results are delivered.
  final bool partialResults;

  /// Whether recognition must stay on-device (mapped from
  /// the app's on-device-only recognition policy).
  final bool onDevice;

  /// Whether the recognizer should auto-cancel on error.
  final bool cancelOnError;
}

/// Narrow, injectable seam over the `speech_to_text` plugin.
///
/// The real implementation wraps `SpeechToText` and lives in
/// `speech_to_text_backend_real.dart` (production code that imports
/// `package:speech_to_text`). Tests inject a fake that implements this
/// interface, so adapter behavior is verifiable without platform channels.
///
/// No plugin classes, results, or errors escape this boundary. The wrapper
/// translates plugin callbacks into app-owned [BackendRecognitionResult]
/// values and plain `double` sound levels.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - adapter boundary).
abstract interface class SpeechToTextBackend {
  /// Initialize the plugin and request microphone/speech permission.
  ///
  /// Returns `true` when recognition is available. Must only be called from
  /// direct user action. Should be called once per plugin instance because
  /// callbacks cannot be reset.
  ///
  /// [options] contains app-owned values that the real backend maps to plugin
  /// configuration types.
  Future<bool> initialize({
    required void Function(BackendSpeechError error) onError,
    required void Function(String status) onStatus,
    Set<BackendInitializationOption> options = const {
      BackendInitializationOption.androidNoBluetooth,
    },
  });

  /// Begin listening for speech.
  ///
  /// [onResult] fires for each partial and final result. [onSoundLevelChange]
  /// fires with a raw platform sound level (adapter normalizes to 0..1).
  /// [options] controls partial results, on-device mode, and error behavior.
  Future<void> listen({
    required void Function(BackendRecognitionResult) onResult,
    required BackendListenOptions options,
    void Function(double level)? onSoundLevelChange,
  });

  /// Stop listening and request the final result.
  ///
  /// A final callback may follow after this future completes.
  Future<void> stop();

  /// Cancel listening without producing a final result.
  ///
  Future<void> cancel();

  /// Whether the recognizer is currently listening.
  bool get isListening;

  /// Release platform resources.
  void dispose();
}
