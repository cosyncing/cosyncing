import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_rate_controller.dart';
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
    this.rate = kDefaultReadAloudRate,
  });

  /// The current platform output state.
  final SpeechOutputState outputState;

  /// The adapter's reported capabilities.
  final SpeechOutputCapabilities capabilities;

  /// Human-facing playback multiplier.
  final double rate;

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

/// App-lifetime provider for the platform [SpeechOutput] adapter.
///
/// Creates the platform-default adapter via [createDefaultSpeechOutput]. On
/// unsupported platforms (Linux native, Fuchsia) or construction failure,
/// returns an unavailable stub. Tests override this provider with a fake.
/// The provider owns disposal of the output (which stops playback). It is
/// deliberately not auto-disposed: responsive session routing replaces the
/// expanded detail page with a compact detail route. On Windows, disposing one
/// `flutter_tts` instance while constructing its replacement can race inside
/// the native plugin and fault the process. One provider-container-owned
/// adapter also preserves active playback across that presentation-only swap.
final Provider<SpeechOutput> speechOutputProvider = Provider<SpeechOutput>((
  ref,
) {
  final output = ref.watch(speechOutputFactoryProvider)();
  // Explicit unawaited: disposal is async (stop + stream close). A normal
  // provider stays alive until invalidated or its ProviderScope is torn
  // down, so responsive route swaps cannot overlap native instances.
  ref.onDispose(() => unawaited(output.dispose()));
  return output;
});

/// Controller for manual final-message read-aloud.
///
/// Consumes [SpeechOutput] and [SpeechTextCompiler]. The controller never
/// auto-starts playback from live frames, replay, reconnect, or state changes
/// - playback begins only when the user taps the read-aloud action.
///
/// Uses `ref.watch` (not `ref.read`) so provider invalidation still rebuilds
/// the controller when future voice/rate settings replace the app-lifetime
/// [speechOutputProvider]. The provider owns disposal of the output (which
/// stops playback); the controller's cleanup only marks
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
  double _rate = kDefaultReadAloudRate;

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
    _rate =
        ref.read(readAloudRateControllerProvider).valueOrNull ??
        kDefaultReadAloudRate;
    _output = output;
    _subscription = output.states.listen(
      (outputState) => _onOutputState(output, outputState),
    );
    ref
      ..onDispose(_cleanup)
      ..listen(readAloudRateControllerProvider, (_, next) {
        final rate = next.valueOrNull;
        if (rate == null || rate == _rate || _disposed) return;
        _rate = rate;
        unawaited(output.setRate(rate));
        state = ReadAloudState(
          outputState: output.current,
          capabilities: output.capabilities,
          rate: rate,
        );
      });
    return ReadAloudState(
      outputState: output.current,
      capabilities: output.capabilities,
      rate: _rate,
    );
  }

  void _onOutputState(SpeechOutput source, SpeechOutputState outputState) {
    if (_disposed || !identical(source, _output)) return;
    state = ReadAloudState(
      outputState: outputState,
      capabilities: source.capabilities,
      rate: _rate,
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
    if (output == null || !output.capabilities.canAttemptSynthesis) return;
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

  /// Applies and durably stores one of the supported playback multipliers.
  Future<void> setRate(double rate) async {
    if (!isSupportedReadAloudRate(rate)) {
      throw ArgumentError.value(rate, 'rate', 'unsupported read-aloud rate');
    }
    await _output?.setRate(rate);
    await ref.read(readAloudRateControllerProvider.notifier).setRate(rate);
  }

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
