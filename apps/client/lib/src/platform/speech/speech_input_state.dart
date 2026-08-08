/// Explicit, testable states for speech input (ASR).
///
/// The state machine mirrors the design's input lifecycle:
/// `idle`, `requestingPermission`, `listening`, `processing`, `ready`,
/// `unavailable`, `error`.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - input state).
sealed class SpeechInputState {
  /// Creates a base input state.
  const SpeechInputState();
}

/// Typed classification of a speech-input failure.
///
/// The platform boundary maps a raw browser DOM-exception name or plugin error
/// code to one of these kinds so the UI can render an actionable, localized
/// recovery rather than a single generic string. The raw signal is preserved
/// separately (in [SpeechInputError.detail] / [SpeechInputUnavailable.detail])
/// for Debug and logs, never as the primary user message.
enum SpeechInputFailureKind {
  /// The web origin is not a secure context (needs https/localhost).
  secureContext,

  /// Microphone or speech-recognition permission was denied or revoked.
  permissionDenied,

  /// No capture device (microphone) was available.
  noCaptureDevice,

  /// The platform speech-recognition service is unavailable.
  serviceUnavailable,

  /// The recognizer could not reach the network-backed service.
  network,

  /// No speech was detected before the recognizer stopped.
  noSpeech,

  /// The recognizer is busy with another request.
  recognizerBusy,

  /// A recognizer was already active (e.g. a browser `InvalidStateError`).
  alreadyActive,

  /// Start failed for an otherwise unclassified reason.
  startFailed,

  /// Voice input is unavailable on this platform/browser (no engine).
  unsupported,

  /// An unclassified failure whose reason string is shown as-is.
  unknown,
}

/// No recognition in progress.
final class SpeechInputIdle extends SpeechInputState {
  /// Creates an idle state.
  const SpeechInputIdle();
}

/// Permission is being requested from direct user action.
final class SpeechInputRequestingPermission extends SpeechInputState {
  /// Creates a permission-requesting state.
  const SpeechInputRequestingPermission();
}

/// The recognizer is actively listening.
///
/// [partialTranscript] holds the latest partial recognition; it is empty until
/// the platform emits one. [soundLevel] is a platform-neutral normalized
/// microphone level in `0.0..1.0` (null when the platform exposes no level
/// events). Adapters normalize the platform-native measurement - e.g. Android
/// `onRmsChanged` dB or web `onSoundLevelChange` - to this range; fabricated
/// random activity must never stand in for real input.
final class SpeechInputListening extends SpeechInputState {
  /// Creates a listening state with an optional partial transcript and sound
  /// level.
  const SpeechInputListening({this.partialTranscript = '', double? soundLevel})
    : assert(
        soundLevel == null || (soundLevel >= 0.0 && soundLevel <= 1.0),
        'soundLevel must be null or within 0.0..1.0',
      ),
      soundLevel = soundLevel;

  /// The latest partial recognition text, or the empty string.
  final String partialTranscript;

  /// Normalized microphone sound level in `0.0..1.0`, or null when the
  /// platform exposes no level events.
  final double? soundLevel;
}

/// The recognizer is finalizing the result after the user stopped.
final class SpeechInputProcessing extends SpeechInputState {
  /// Creates a processing state.
  const SpeechInputProcessing();
}

/// A final transcript is ready to insert into the composer.
///
/// The user reviews and edits before sending; ASR never auto-sends.
final class SpeechInputReady extends SpeechInputState {
  /// Creates a ready state with the final transcript.
  const SpeechInputReady(this.transcript);

  /// The final recognized transcript.
  final String transcript;
}

/// Recognition is not available on this platform or origin (e.g. insecure web
/// origin, unsupported browser, no engine).
final class SpeechInputUnavailable extends SpeechInputState {
  /// Creates an unavailable state with an actionable reason.
  const SpeechInputUnavailable(
    this.reason, {
    this.kind = SpeechInputFailureKind.unknown,
    this.detail,
  });

  /// Why recognition is unavailable (non-localized fallback / Debug text).
  final String reason;

  /// Typed classification the UI localizes into an actionable message.
  final SpeechInputFailureKind kind;

  /// Raw diagnostic signal (DOM exception name / plugin code) for Debug and
  /// logs. Never audio or transcript content, and never the primary message.
  final String? detail;
}

/// Recognition failed or was interrupted.
final class SpeechInputError extends SpeechInputState {
  /// Creates an error state with a human-readable reason.
  const SpeechInputError(
    this.reason, {
    this.kind = SpeechInputFailureKind.unknown,
    this.detail,
  });

  /// Why recognition failed (non-localized fallback / Debug text).
  final String reason;

  /// Typed classification the UI localizes into an actionable message.
  final SpeechInputFailureKind kind;

  /// Raw diagnostic signal (DOM exception name / plugin code) for Debug and
  /// logs. Never audio or transcript content, and never the primary message.
  final String? detail;
}
