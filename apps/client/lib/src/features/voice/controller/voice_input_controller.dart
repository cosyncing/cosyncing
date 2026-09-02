import 'dart:async';

import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_backend_real.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-owned voice-input state combining the platform input state with the
/// adapter's reported capabilities, a bounded sound-level history for the
/// waveform, and the in-memory chosen recognition policy.
@immutable
class VoiceInputState {
  /// Creates a voice-input state.
  const VoiceInputState({
    this.inputState = const SpeechInputIdle(),
    this.capabilities = SpeechInputCapabilities.unavailable,
    this.soundLevelHistory = const [],
    this.chosenPolicy,
  });

  /// The current platform input state.
  final SpeechInputState inputState;

  /// The adapter's reported capabilities.
  final SpeechInputCapabilities capabilities;

  /// Bounded history of normalized sound levels (0..1) for the waveform.
  final List<double> soundLevelHistory;

  /// The recognition policy chosen by the user this session, or `null` when
  /// the first-use disclosure has not yet been accepted.
  final SpeechRecognitionPolicy? chosenPolicy;

  /// Whether the first-use recognition disclosure still needs a choice.
  bool get needsPolicyChoice => chosenPolicy == null;

  /// Whether recognition is actively in progress (permission, listening, or
  /// processing).
  bool get isActive =>
      inputState is SpeechInputRequestingPermission ||
      inputState is SpeechInputListening ||
      inputState is SpeechInputProcessing;

  /// Whether currently listening.
  bool get isListening => inputState is SpeechInputListening;

  /// Whether finalizing after stop.
  bool get isProcessing => inputState is SpeechInputProcessing;

  /// Whether requesting permission.
  bool get isRequestingPermission =>
      inputState is SpeechInputRequestingPermission;

  /// Whether a final transcript is ready to consume.
  bool get isReady => inputState is SpeechInputReady;

  /// Whether an error occurred.
  bool get hasError => inputState is SpeechInputError;

  /// Whether recognition is unavailable.
  bool get isUnavailable => inputState is SpeechInputUnavailable;

  /// The latest partial transcript while listening, or the empty string.
  String get partialTranscript {
    final state = inputState;
    if (state is SpeechInputListening) return state.partialTranscript;
    return '';
  }

  /// The ready transcript, or `null` when not in the ready state.
  String? get readyTranscript {
    final state = inputState;
    if (state is SpeechInputReady) return state.transcript;
    return null;
  }
}

/// Maximum number of sound-level samples retained for the waveform.
const int _maxSoundLevelHistory = 60;

/// Injectable factory for the platform speech-input adapter.
///
/// Tests override this factory instead of [speechInputProvider], preserving
/// the production provider's ownership and disposal behavior.
final Provider<SpeechInput Function()> speechInputFactoryProvider = Provider(
  (ref) => createDefaultSpeechInput,
);

/// Provider for the platform [SpeechInput] adapter.
///
/// Creates the platform-default adapter via [createDefaultSpeechInput]. On
/// unsupported platforms (Linux native, Fuchsia), insecure web origins, or
/// construction failure, returns an unavailable stub. Tests override this
/// provider with a fake. The provider owns disposal of the input (which
/// cancels any active recognition).
final AutoDisposeProvider<SpeechInput> speechInputProvider =
    Provider.autoDispose<SpeechInput>((ref) {
      final input = ref.watch(speechInputFactoryProvider)();
      ref.onDispose(() => unawaited(input.dispose()));
      return input;
    });

/// Controller for native push-to-talk ASR/dictation.
///
/// Consumes [SpeechInput] and coordinates with [ReadAloudController] so that
/// starting ASR stops any active TTS first. The controller never auto-starts
/// recognition - playback begins only when the user taps the microphone action
/// and has accepted the first-use policy disclosure.
///
/// Uses `ref.watch` (not `ref.read`) so the autoDispose [speechInputProvider]
/// stays alive for the controller's lifetime. The provider owns disposal of
/// the input (which cancels recognition); the controller's cleanup only marks
/// itself disposed, cancels its subscription, and ignores late state events.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Native voice input").
class VoiceInputController extends AutoDisposeNotifier<VoiceInputState> {
  /// Creates a voice-input controller.
  VoiceInputController();

  SpeechInput? _input;
  StreamSubscription<SpeechInputState>? _subscription;
  SpeechRecognitionPolicy? _chosenPolicy;
  bool _disposed = false;
  final List<double> _soundLevelHistory = [];

  @override
  VoiceInputState build() {
    _disposed = false;
    // Future policy/locale settings may invalidate the watched adapter. Cancel
    // the prior stream and ignore any late events from that adapter.
    unawaited(_subscription?.cancel());
    _subscription = null;
    _soundLevelHistory.clear();
    final input = ref.watch(speechInputProvider);
    _input = input;
    _subscription = input.states.listen(
      (inputState) => _onInputState(input, inputState),
    );
    ref.onDispose(_cleanup);
    return VoiceInputState(
      inputState: input.current,
      capabilities: input.capabilities,
      chosenPolicy: _chosenPolicy,
    );
  }

  void _onInputState(SpeechInput source, SpeechInputState inputState) {
    if (_disposed || !identical(source, _input)) return;

    // Update sound-level history from listening states.
    if (inputState is SpeechInputListening && inputState.soundLevel != null) {
      _soundLevelHistory.add(inputState.soundLevel!);
      if (_soundLevelHistory.length > _maxSoundLevelHistory) {
        _soundLevelHistory.removeAt(0);
      }
    } else if (inputState is! SpeechInputListening) {
      _soundLevelHistory.clear();
    }

    state = VoiceInputState(
      inputState: inputState,
      capabilities: source.capabilities,
      soundLevelHistory: List<double>.unmodifiable(_soundLevelHistory),
      chosenPolicy: _chosenPolicy,
    );
  }

  /// The workspace pane that was focused when this controller last started.
  ///
  /// Opaque here on purpose: this layer never interprets it. The workspace
  /// stamps it and reads it back, so a focus change can stop the media the
  /// *other* pane started without silencing the pane now in front. One voice
  /// and one microphone stay global — a singleton with an owner is both
  /// cheaper and more correct than one controller per pane.
  Object? owningPane;

  /// Begin push-to-talk recognition with the given [policy].
  ///
  /// Stops any active TTS first, then requests permission and starts
  /// listening. The chosen policy is remembered for this controller lifetime
  /// so the user is not prompted on every tap.
  Future<void> begin(SpeechRecognitionPolicy policy) async {
    if (_disposed) return;
    final input = _input;
    if (input == null || !input.capabilities.recognition) return;

    // Stop TTS first so only one audio modality is active. Avoid constructing
    // the output adapter merely to stop an idle, never-created controller.
    if (ref.exists(readAloudControllerProvider)) {
      final readAloudState = ref.read(readAloudControllerProvider);
      if (readAloudState.isSpeaking || readAloudState.isPaused) {
        await ref.read(readAloudControllerProvider.notifier).stop();
      }
    }

    _chosenPolicy = policy;
    _soundLevelHistory.clear();

    await input.requestPermission();
    if (_disposed) return;
    // A settings change can replace the adapter while permission UI is open.
    if (!identical(input, _input)) return;
    final current = input.current;
    if (current is SpeechInputError || current is SpeechInputUnavailable) {
      return;
    }
    await input.start(policy: policy);
  }

  /// Stop listening and request the final transcript.
  Future<void> stop() async {
    if (_disposed) return;
    await _input?.stop();
  }

  /// Cancel recognition, discarding all in-flight/partial/final text.
  Future<void> cancel() async {
    if (_disposed) return;
    await _input?.cancel();
  }

  /// Consume the ready transcript and return to idle.
  ///
  /// Returns the consumed transcript, or `null` if not in the ready state.
  /// The caller inserts the transcript into the composer; ASR never sends.
  String? consumeReady() {
    if (_disposed) return null;
    return _input?.consumeReady();
  }

  void _cleanup() {
    _disposed = true;
    _input = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
  }
}

/// Provider for the voice-input controller.
final AutoDisposeNotifierProvider<VoiceInputController, VoiceInputState>
voiceInputControllerProvider =
    NotifierProvider.autoDispose<VoiceInputController, VoiceInputState>(
      VoiceInputController.new,
    );
