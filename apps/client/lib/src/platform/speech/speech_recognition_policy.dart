/// Platform-neutral recognition policy the caller must choose explicitly when
/// starting speech input.
///
/// The design warns that "client-side" does not guarantee on-device
/// processing: platform recognizers may silently use a remote service. To
/// prevent silent network fallback, `SpeechInput.start` requires the caller to
/// state its policy up front - there is no permissive default. The V2
/// controller chooses after checking capabilities and consent.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Native voice input" - on-device vs network fallback).
enum SpeechRecognitionPolicy {
  /// Recognition must stay on-device.
  ///
  /// Adapters must not silently fall back to a network-backed service; if
  /// on-device recognition is unavailable they should surface an unavailable
  /// or error input state rather than reaching a remote service without
  /// disclosure.
  onDeviceOnly,

  /// The caller has consented to a platform recognition service that may be
  /// network-backed.
  ///
  /// Adapters may use the platform default recognizer even when it reaches a
  /// remote service, because the user accepted that trade-off.
  platformServiceAllowed,
}
