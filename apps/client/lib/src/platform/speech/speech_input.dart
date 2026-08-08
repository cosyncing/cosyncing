import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';

/// Platform-neutral speech-input (ASR) boundary.
///
/// V0 defines the contract only; real adapters arrive in V2. No plugin types
/// escape this boundary - views and controllers depend on this interface, not
/// on `speech_to_text` or platform APIs. The platform's default recognizer and
/// default voice are used first.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (sections "Native voice input" and "Flutter Integration Direction").
abstract interface class SpeechInput {
  /// Capabilities reported by this adapter.
  SpeechInputCapabilities get capabilities;

  /// The current input state.
  SpeechInputState get current;

  /// Stream of input-state changes.
  Stream<SpeechInputState> get states;

  /// Request speech and microphone permission.
  ///
  /// Must be called only from direct user action (the microphone action),
  /// never automatically.
  Future<void> requestPermission();

  /// Begin push-to-talk listening.
  ///
  /// [policy] is required - there is no permissive default. The caller (the
  /// V2 controller) chooses explicitly after checking [capabilities] and
  /// consent; see [SpeechRecognitionPolicy].
  Future<void> start({required SpeechRecognitionPolicy policy});

  /// Stop and request the final transcript, transitioning to
  /// [SpeechInputReady].
  Future<void> stop();

  /// Discard the in-flight recognition without producing a transcript.
  Future<void> cancel();

  /// Consume the ready transcript and return to idle.
  ///
  /// Called after the UI has read and inserted the transcript from
  /// [SpeechInputReady]. Returns the consumed transcript, or `null` if the
  /// current state is not [SpeechInputReady].
  String? consumeReady();

  /// Release platform resources.
  Future<void> dispose();
}
