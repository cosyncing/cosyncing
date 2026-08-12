/// Platform speech-input (ASR) capabilities reported by an adapter.
///
/// The capability model - not the platform name - is the only thing the UI
/// trusts. Anything a device cannot report as available degrades to a disabled
/// microphone action with an honest reason.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - capabilities).
class SpeechInputCapabilities {
  /// Creates an immutable ASR capability snapshot.
  ///
  /// Sub-features imply their parent: [onDeviceRecognition] and
  /// [soundLevelEvents] cannot be true when [recognition] is false.
  const SpeechInputCapabilities({
    required this.recognition,
    required this.onDeviceRecognition,
    required this.soundLevelEvents,
  }) : assert(
         !onDeviceRecognition || recognition,
         'onDeviceRecognition requires recognition',
       ),
       assert(
         !soundLevelEvents || recognition,
         'soundLevelEvents requires recognition',
       );

  /// Speech recognition is available on this platform/origin at all.
  final bool recognition;

  /// The platform can guarantee on-device recognition (no audio leaves the
  /// device). When false, recognition may use a remote service.
  final bool onDeviceRecognition;

  /// Real sound-level events are exposed to drive a live waveform. Fabricated
  /// random activity must never stand in for real microphone level.
  final bool soundLevelEvents;

  /// All capabilities off. Used by stub or unavailable adapters and tests.
  static const SpeechInputCapabilities unavailable = SpeechInputCapabilities(
    recognition: false,
    onDeviceRecognition: false,
    soundLevelEvents: false,
  );
}

/// Platform speech-output (TTS) capabilities reported by an adapter.
///
/// Together with [SpeechInputCapabilities], these cover the six capability
/// dimensions from the design: recognition, on-device recognition, sound-level
/// events, synthesis, pause/resume, and installed language/voice availability.
enum SpeechSynthesisAvailability {
  /// The platform supports a synthesis adapter, but no native probe has run.
  unprobed,

  /// A native probe confirmed synthesis is available.
  available,

  /// The platform is unsupported or a native probe failed.
  unavailable,
}

/// Platform speech-output capabilities and their native probe state.
class SpeechOutputCapabilities {
  /// Creates an immutable TTS capability snapshot.
  ///
  /// Sub-features imply their parent: [pauseResume] and
  /// [installedLanguageVoiceAvailability] cannot be true when [synthesis] is
  /// false.
  const SpeechOutputCapabilities({
    required bool synthesis,
    required this.pauseResume,
    required this.installedLanguageVoiceAvailability,
  }) : synthesisAvailability = synthesis
           ? SpeechSynthesisAvailability.available
           : SpeechSynthesisAvailability.unavailable,
       assert(
         !pauseResume || synthesis,
         'pauseResume requires synthesis',
       ),
       assert(
         !installedLanguageVoiceAvailability || synthesis,
         'installedLanguageVoiceAvailability requires synthesis',
       );

  /// Creates a platform-supported capability that has not touched native TTS.
  const SpeechOutputCapabilities.unprobed()
    : synthesisAvailability = SpeechSynthesisAvailability.unprobed,
      pauseResume = false,
      installedLanguageVoiceAvailability = false;

  /// Current three-state synthesis probe result.
  final SpeechSynthesisAvailability synthesisAvailability;

  /// Whether a native probe confirmed text-to-speech synthesis.
  bool get synthesis =>
      synthesisAvailability == SpeechSynthesisAvailability.available;

  /// Whether a manual Read-aloud action may perform the first native probe.
  bool get canAttemptSynthesis =>
      synthesisAvailability != SpeechSynthesisAvailability.unavailable;

  /// Pause/resume is supported. The adapter reports whether its platform
  /// exposes pause/resume; the capability reflects adapter behavior, not a
  /// platform-name assumption.
  final bool pauseResume;

  /// Installed languages/voices can be enumerated.
  final bool installedLanguageVoiceAvailability;

  /// All capabilities off. Used by stub or unavailable adapters and tests.
  static const SpeechOutputCapabilities unavailable = SpeechOutputCapabilities(
    synthesis: false,
    pauseResume: false,
    installedLanguageVoiceAvailability: false,
  );
}
