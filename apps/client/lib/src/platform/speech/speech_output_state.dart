/// Explicit, testable states for speech output (TTS).
///
/// The state machine mirrors the design's output lifecycle:
/// `idle`, `speaking(messageKey)`, `paused(messageKey)`, `error`. Only one
/// message may speak at a time; starting a new one stops the prior.
///
/// The `messageKey` carried by speaking/paused states is the read-aloud
/// action's stable identity. The V1 controller assigns it - typically the
/// final `model-output` frame's `key` (see the model-output accessor in
/// `broker_contract`). Identity resolution (including any fallback) is a V1
/// concern; V0 defines only the state shape.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - output state).
sealed class SpeechOutputState {
  /// Creates a base output state.
  const SpeechOutputState();
}

/// No synthesis in progress.
final class SpeechOutputIdle extends SpeechOutputState {
  /// Creates an idle state.
  const SpeechOutputIdle();
}

/// Synthesizer is speaking the utterances for the given message key.
final class SpeechOutputSpeaking extends SpeechOutputState {
  /// Creates a speaking state for the given message key.
  const SpeechOutputSpeaking(this.messageKey);

  /// The stable key of the message being spoken.
  final String messageKey;
}

/// Synthesis is paused for the given message key (only where supported).
final class SpeechOutputPaused extends SpeechOutputState {
  /// Creates a paused state for the given message key.
  const SpeechOutputPaused(this.messageKey);

  /// The stable key of the paused message.
  final String messageKey;
}

/// Synthesis failed.
final class SpeechOutputError extends SpeechOutputState {
  /// Creates an error state with a required reason and optional message key.
  const SpeechOutputError({required this.reason, this.messageKey});

  /// Why synthesis failed.
  final String reason;

  /// The message key that was speaking when the error occurred, if any.
  final String? messageKey;
}
