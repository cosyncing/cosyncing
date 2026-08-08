import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/voice/model/read_aloud_eligibility.dart';
import 'package:cosyncing_client/src/features/voice/model/speech_text_compiler.dart';
import 'package:cosyncing_client/src/platform/speech/flutter_tts_backend_real.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:cosyncing_client/src/features/voice/model/read_aloud_eligibility.dart'
    show isReadAloudEligible, newestEligibleIndices, resolveReadAloudIdentity;

/// App-owned read-aloud state combining the platform output state with the
/// adapter's reported capabilities.
///
/// The controller mirrors [SpeechOutputState] and augments it with
/// [capabilities] so widgets can decide whether to show pause/resume controls
/// reactively.
@immutable
class ReadAloudState {
  /// Creates a read-aloud state.
  const ReadAloudState({
    this.outputState = const SpeechOutputIdle(),
    this.capabilities = SpeechOutputCapabilities.unavailable,
  });

  /// The current platform output state.
  final SpeechOutputState outputState;

  /// The adapter's reported capabilities.
  final SpeechOutputCapabilities capabilities;

  /// The message key currently speaking or paused, or null when idle/error.
  String? get activeMessageKey {
    final state = outputState;
    if (state is SpeechOutputSpeaking) return state.messageKey;
    if (state is SpeechOutputPaused) return state.messageKey;
    return null;
  }

  /// Whether playback is active for some message.
  bool get isSpeaking => outputState is SpeechOutputSpeaking;

  /// Whether playback is paused for some message.
  bool get isPaused => outputState is SpeechOutputPaused;
}

/// Injectable factory for the platform speech-output adapter.
///
/// Tests override this factory instead of [speechOutputProvider], preserving
/// the production provider's ownership and disposal behavior.
final Provider<SpeechOutput Function()> speechOutputFactoryProvider = Provider(
  (ref) => createDefaultSpeechOutput,
);

/// Provider for the platform [SpeechOutput] adapter.
///
/// Creates the platform-default adapter via [createDefaultSpeechOutput]. On
/// unsupported platforms (Linux native, Fuchsia) or construction failure,
/// returns an unavailable stub. Tests override this provider with a fake.
/// The provider owns disposal of the output (which stops playback).
final AutoDisposeProvider<SpeechOutput> speechOutputProvider =
    Provider.autoDispose<SpeechOutput>((ref) {
      final output = ref.watch(speechOutputFactoryProvider)();
      // Explicit unawaited: dispose is async (stops playback + closes stream).
      // The provider owns disposal; the controller cleanup does not stop.
      ref.onDispose(() => unawaited(output.dispose()));
      return output;
    });

/// Controller for manual final-message read-aloud.
///
/// Consumes [SpeechOutput] and [SpeechTextCompiler]. The controller never
/// auto-starts playback from live frames, replay, reconnect, or state changes
/// - playback begins only when the user taps the read-aloud action.
///
/// Uses `ref.watch` (not `ref.read`) so the autoDispose [speechOutputProvider]
/// stays alive for the controller's lifetime. The provider owns disposal of
/// the output (which stops playback); the controller's cleanup only marks
/// itself disposed, cancels its subscription, and ignores late state events
/// (no separate stop races disposal).
///
/// Designed so V2 can call [stop] to silence TTS when ASR starts.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Final-message read-aloud").
class ReadAloudController extends AutoDisposeNotifier<ReadAloudState> {
  /// Creates a read-aloud controller.
  ReadAloudController();

  SpeechOutput? _output;
  StreamSubscription<SpeechOutputState>? _subscription;
  bool _disposed = false;

  static const SpeechTextCompiler _compiler = SpeechTextCompiler();

  @override
  ReadAloudState build() {
    _disposed = false;
    // A watched adapter can change when future voice/rate settings invalidate
    // its provider. Detach from the old stream before adopting the replacement.
    unawaited(_subscription?.cancel());
    _subscription = null;
    // ref.watch keeps the autoDispose output provider alive for the
    // controller's lifetime.
    final output = ref.watch(speechOutputProvider);
    _output = output;
    _subscription = output.states.listen(
      (outputState) => _onOutputState(output, outputState),
    );
    ref.onDispose(_cleanup);
    return ReadAloudState(
      outputState: output.current,
      capabilities: output.capabilities,
    );
  }

  void _onOutputState(SpeechOutput source, SpeechOutputState outputState) {
    if (_disposed || !identical(source, _output)) return;
    state = ReadAloudState(
      outputState: outputState,
      capabilities: source.capabilities,
    );
  }

  /// Compiles the final complete text of [message] and starts playback.
  ///
  /// Stops any currently speaking message first. Does nothing when the message
  /// is not eligible, has no stable identity, synthesis is unavailable, or the
  /// compiler produces no speakable utterances. Never auto-starts - only call
  /// from user action.
  Future<void> speakForMessage(AgentMessage message) async {
    final sourceText = message.readAloudSourceText;
    if (sourceText == null) return;
    final identity = resolveReadAloudIdentity(message);
    if (identity == null) return;
    await speakText(messageKey: identity, text: sourceText);
  }

  /// Compiles [text] under a stable [messageKey] and starts playback.
  ///
  /// The turn-level Read aloud action passes the turn's aggregated model-output
  /// text so a preamble that preceded a tool call is not silently dropped. Like
  /// [speakForMessage] this stops any current playback first, does nothing when
  /// synthesis is unavailable or the text yields no speakable utterances, and
  /// never auto-starts.
  Future<void> speakText({
    required String messageKey,
    required String text,
  }) async {
    final output = _output;
    if (output == null || !output.capabilities.synthesis) return;
    if (text.trim().isEmpty) return;
    final utterances = _compiler.compile(text);
    if (utterances.isEmpty) return;
    await output.speak(messageKey: messageKey, utterances: utterances);
  }

  /// Stop playback and return to idle.
  Future<void> stop() async => _output?.stop();

  /// Pause playback where the adapter supports it.
  Future<void> pause() async => _output?.pause();

  /// Resume playback where the adapter supports it.
  Future<void> resume() async => _output?.resume();

  void _cleanup() {
    _disposed = true;
    _output = null;
    // The provider owns output.dispose (which stops playback). The controller
    // only cancels its subscription and ignores late state events.
    unawaited(_subscription?.cancel());
    _subscription = null;
  }
}

/// Provider for the read-aloud controller.
final AutoDisposeNotifierProvider<ReadAloudController, ReadAloudState>
readAloudControllerProvider =
    NotifierProvider.autoDispose<ReadAloudController, ReadAloudState>(
      ReadAloudController.new,
    );
