import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';

/// Classifies a raw speech-input failure signal into a typed
/// [SpeechInputFailureKind].
///
/// The signal is a browser DOM-exception name (e.g. `InvalidStateError`,
/// `NotAllowedError`) on web, or a plugin/native error code (e.g.
/// `error_permission`, `not-allowed`, `service-not-allowed`, `audio-capture`).
/// Matching is substring-based over a lowercased signal so both spellings of a
/// family map to the same kind. Order matters: more specific families
/// (`service-not-allowed`, which also contains `not-allowed`) are matched
/// before broader ones.
///
/// This is the single place the client decides what a start/recognition failure
/// means; it never inspects audio or transcript content.
SpeechInputFailureKind classifySpeechFailureSignal(String signal) {
  final s = signal.toLowerCase();

  bool has(String needle) => s.contains(needle);

  if (has('invalidstate')) return SpeechInputFailureKind.alreadyActive;
  if (has('security') || has('insecure') || has('secure-context')) {
    return SpeechInputFailureKind.secureContext;
  }
  // `service-not-allowed` also contains `not-allowed`, so check service first.
  if (has('service')) return SpeechInputFailureKind.serviceUnavailable;
  if (has('notallowed') ||
      has('not-allowed') ||
      has('not_allowed') ||
      has('permission') ||
      has('denied')) {
    return SpeechInputFailureKind.permissionDenied;
  }
  if (has('notfound') ||
      has('audio-capture') ||
      has('audio_capture') ||
      has('audiocapture') ||
      has('no-capture') ||
      has('capture')) {
    return SpeechInputFailureKind.noCaptureDevice;
  }
  if (has('network')) return SpeechInputFailureKind.network;
  if (has('no_match') ||
      has('no-match') ||
      has('nomatch') ||
      has('no-speech') ||
      has('no_speech') ||
      has('speech_timeout') ||
      has('speech-timeout')) {
    return SpeechInputFailureKind.noSpeech;
  }
  if (has('busy')) return SpeechInputFailureKind.recognizerBusy;
  return SpeechInputFailureKind.startFailed;
}

/// A non-localized fallback reason for [kind].
///
/// Shown only when the UI cannot localize (or for the `unknown` kind); the
/// localized message lives in the composer/view. The network reason keeps the
/// "platform service" wording other surfaces already assert on.
String defaultSpeechFailureReason(SpeechInputFailureKind kind) =>
    switch (kind) {
      SpeechInputFailureKind.secureContext =>
        'Voice input needs a secure (https) connection.',
      SpeechInputFailureKind.permissionDenied =>
        'Microphone or speech-recognition permission was denied.',
      SpeechInputFailureKind.noCaptureDevice =>
        'No microphone was available for voice input.',
      SpeechInputFailureKind.serviceUnavailable =>
        'The speech-recognition service is unavailable.',
      SpeechInputFailureKind.network =>
        "Speech recognition couldn't reach the platform service. Try again.",
      SpeechInputFailureKind.noSpeech => 'No speech was recognized. Try again.',
      SpeechInputFailureKind.recognizerBusy =>
        'Speech recognition is busy. Try again.',
      SpeechInputFailureKind.alreadyActive =>
        'Voice input was already active. Try again.',
      SpeechInputFailureKind.startFailed =>
        "Voice input couldn't start. Try again.",
      SpeechInputFailureKind.unsupported =>
        'Voice input is not available here.',
      SpeechInputFailureKind.unknown => 'Speech recognition failed. Try again.',
    };
