import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';

/// Platform-neutral speech-output (TTS) boundary.
///
/// V0 defines the contract only; real adapters arrive in V1. The synthesizer
/// receives only [SpeechUtterance] plain-text chunks produced by the
/// `SpeechTextCompiler` - never raw Markdown or message JSON. Only one message
/// may speak at a time; [speak] stops any currently speaking message first.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (sections "Final-message read-aloud" and "Flutter Integration Direction").
abstract interface class SpeechOutput {
  /// Capabilities reported by this adapter.
  SpeechOutputCapabilities get capabilities;

  /// The current output state.
  SpeechOutputState get current;

  /// Stream of output-state changes.
  Stream<SpeechOutputState> get states;

  /// Speak [utterances] for the message identified by [messageKey].
  ///
  /// [utterances] must be non-empty: there is no speaking-with-no-audio
  /// state. Stops any currently speaking message first, then speaks the
  /// chunks in order. Each chunk is a clean cancellation boundary.
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  });

  /// Pause synthesis where the platform supports it.
  Future<void> pause();

  /// Resume synthesis where the platform supports it.
  Future<void> resume();

  /// Stop synthesis and clear the utterance queue.
  Future<void> stop();

  /// Release platform resources.
  Future<void> dispose();
}
