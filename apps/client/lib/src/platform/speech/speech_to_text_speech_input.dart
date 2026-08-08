import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_failure_classification.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_backend.dart';

/// Platform-neutral [SpeechInput] adapter backed by a [SpeechToTextBackend].
///
/// Owns permission/init, partial/final results, status/errors, stop/cancel,
/// sound-level normalization, and race/disposal behavior. No plugin types
/// escape this class; views and controllers depend on [SpeechInput], not on
/// [SpeechToTextBackend].
///
/// **Initialization:** [requestPermission] calls
/// [SpeechToTextBackend.initialize] only from direct user action (the
/// microphone tap). It is called at most once per adapter lifetime because
/// the plugin's callbacks cannot be reset.
/// Before initialization, capabilities are optimistic (based on platform
/// support from the factory). After a failed initialization, capabilities
/// become [SpeechInputCapabilities.unavailable].
///
/// **Sound-level normalization:** raw platform levels are normalized to
/// `0.0..1.0` per listening session using observed min/max with finite/range
/// guards. Fabricated random activity never stands in for real input.
///
/// **Race safety:** a monotonic [_generation] invalidates stale callbacks.
/// Backend status/error callbacks after [stop], [cancel], or [dispose] from a
/// stale generation must not mutate a newer session.
///
/// **Finalization:** [stop] transitions to [SpeechInputProcessing] and waits
/// for a final callback (or a bounded timeout). If no final callback arrives,
/// the latest nonempty partial text becomes the editable draft; otherwise the
/// adapter returns to idle honestly. Never sends.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (sections "Native voice input" and "Flutter Integration Direction").
class SpeechToTextSpeechInput implements SpeechInput {
  /// Creates an adapter backed by a backend.
  ///
  /// [onDeviceCapable] is `true` only on platforms where the adapter can
  /// enforce on-device recognition (conservatively Android/iOS/macOS).
  SpeechToTextSpeechInput(
    SpeechToTextBackend backend, {
    required bool onDeviceCapable,
    Set<BackendInitializationOption> initializationOptions = const {
      BackendInitializationOption.androidNoBluetooth,
    },
    Duration finalizationTimeout = const Duration(seconds: 3),
  }) : this._(
         backend,
         onDeviceCapable,
         Set<BackendInitializationOption>.unmodifiable(initializationOptions),
         finalizationTimeout,
       );

  SpeechToTextSpeechInput._(
    this._backend,
    this._onDeviceCapable,
    this._initializationOptions,
    this._finalizationTimeout,
  );

  final SpeechToTextBackend _backend;
  final bool _onDeviceCapable;
  final Set<BackendInitializationOption> _initializationOptions;
  final Duration _finalizationTimeout;

  SpeechInputState _current = const SpeechInputIdle();
  StreamController<SpeechInputState>? _stateController =
      StreamController<SpeechInputState>.broadcast();

  bool _initialized = false;
  bool _available = false;
  bool _permissionDenied = false;
  bool _hasSoundLevelEvents = false;

  /// Monotonic generation. Incremented on every [start], [cancel], and
  /// [dispose]. Each listen callback captures the generation it belongs to.
  int _generation = 0;

  String _partialTranscript = '';

  /// Latest normalized sound level (0..1) during this listening session.
  double? _lastSoundLevel;

  /// Observed min/max raw levels for normalization this session.
  double _minLevel = double.infinity;
  double _maxLevel = double.negativeInfinity;

  /// Whether [stop] was called and we are awaiting a final callback.
  bool _awaitingFinal = false;

  /// Bounded finalization timeout after [stop].
  Timer? _finalizationTimer;

  /// The generation whose final result or timeout fallback was completed.
  ///
  /// This is an explicit one-shot guard independent of the current UI state,
  /// so duplicate final callbacks and stop/timeout races cannot emit a second
  /// ready transition.
  int? _completedGeneration;

  /// Active cancellation, including the backend's terminal-status settling.
  ///
  /// A restart waits for this operation so an old web recognizer cannot emit
  /// its abort/onend status into the new dictation.
  Future<void>? _cancelOperation;
  int? _cancelingGeneration;

  /// Guards against emitting to a closed stream or touching a disposed backend.
  bool _disposed = false;

  @override
  SpeechInputCapabilities get capabilities {
    if (_initialized && !_available) {
      return SpeechInputCapabilities.unavailable;
    }
    return SpeechInputCapabilities(
      recognition: true,
      onDeviceRecognition: _onDeviceCapable,
      soundLevelEvents: _hasSoundLevelEvents,
    );
  }

  @override
  SpeechInputState get current => _current;

  @override
  Stream<SpeechInputState> get states {
    final controller = _stateController;
    if (controller != null) return controller.stream;
    return const Stream<SpeechInputState>.empty();
  }

  @override
  Future<void> requestPermission() async {
    if (_disposed) return;
    _emit(const SpeechInputRequestingPermission());

    if (!_initialized) {
      try {
        final initialized = await _backend.initialize(
          onError: _onBackendError,
          onStatus: _onBackendStatus,
          options: _initializationOptions,
        );
        _available = initialized && !_permissionDenied;
        _initialized = true;
      } on Object {
        _initialized = true;
        _available = false;
        _safeEmit(
          const SpeechInputUnavailable('Speech recognition is not available.'),
        );
        return;
      }
    }

    if (_disposed) return;

    if (!_available) {
      _safeEmit(
        const SpeechInputUnavailable('Speech recognition is not available.'),
      );
      return;
    }

    _safeEmit(const SpeechInputIdle());
  }

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {
    Future<void>? pendingCancel;
    while ((pendingCancel = _cancelOperation) != null) {
      await pendingCancel;
    }
    if (_disposed) return;
    if (!_initialized || !_available) {
      _safeEmit(
        const SpeechInputUnavailable('Speech recognition is not available.'),
      );
      return;
    }

    // Start-in-flight guard: a second tap while a session is live or still
    // finalizing must not spawn a second recognizer (a common cause of a web
    // `InvalidStateError`).
    if (_current is SpeechInputListening || _current is SpeechInputProcessing) {
      return;
    }

    final onDevice = policy == SpeechRecognitionPolicy.onDeviceOnly;
    if (onDevice && !_onDeviceCapable) {
      _safeEmit(
        const SpeechInputError('On-device recognition is not available.'),
      );
      return;
    }

    final generation = ++_generation;
    _partialTranscript = '';
    _lastSoundLevel = null;
    _minLevel = double.infinity;
    _maxLevel = double.negativeInfinity;
    _awaitingFinal = false;
    _completedGeneration = null;
    _finalizationTimer?.cancel();

    _safeEmit(const SpeechInputListening());

    try {
      await _backend.listen(
        onResult: (result) => _onResult(result, generation),
        options: BackendListenOptions(
          onDevice: onDevice,
        ),
        onSoundLevelChange: (level) => _onSoundLevel(level, generation),
      );
    } on Object catch (error) {
      if (!_disposed && generation == _generation) {
        // Preserve the raw failure signal instead of discarding it: classify a
        // DOM exception name / plugin code into an actionable kind, keep the
        // raw string in `detail` for Debug, and never blind-retry.
        final kind = classifySpeechFailureSignal('${error.runtimeType} $error');
        if (kind == SpeechInputFailureKind.alreadyActive) {
          // A stale/active recognizer (InvalidStateError): recreate for the
          // next tap by cancelling now rather than looping on this instance.
          unawaited(
            _trackBackendCancel(
              generation: generation,
              emitIdleWhenDone: false,
            ),
          );
        }
        _safeEmit(
          SpeechInputError(
            defaultSpeechFailureReason(kind),
            kind: kind,
            detail: '$error',
          ),
        );
      }
      return;
    }

    if (_disposed || generation != _generation) {
      await _trackBackendCancel(
        generation: generation,
        emitIdleWhenDone: false,
      );
    }
  }

  @override
  Future<void> stop() async {
    if (_disposed) return;
    if (_current is! SpeechInputListening) return;

    final gen = _generation;
    _emit(const SpeechInputProcessing());
    _awaitingFinal = true;

    try {
      await _backend.stop();
    } on Object {
      // Stop failed; rely on finalization timeout fallback.
    }

    if (_disposed || gen != _generation) return;

    // Bounded finalization timeout: if no final callback arrives, use the
    // latest nonempty partial text as the editable draft.
    _scheduleFinalization(gen);
  }

  void _scheduleFinalization(int generation) {
    _finalizationTimer?.cancel();
    _finalizationTimer = Timer(_finalizationTimeout, () {
      if (_disposed || generation != _generation) return;
      if (!_awaitingFinal) return;
      _awaitingFinal = false;
      final text = _partialTranscript.trim();
      if (text.isNotEmpty) {
        _finalize(text, generation);
      } else {
        _finalize('', generation);
      }
    });
  }

  @override
  Future<void> cancel() {
    if (_disposed) return Future<void>.value();
    final pending = _cancelOperation;
    if (pending != null) return pending;

    final generation = ++_generation;
    _awaitingFinal = false;
    _completedGeneration = null;
    _finalizationTimer?.cancel();
    _partialTranscript = '';
    _lastSoundLevel = null;
    _current = const SpeechInputIdle();
    _minLevel = double.infinity;
    _maxLevel = double.negativeInfinity;

    return _trackBackendCancel(
      generation: generation,
      emitIdleWhenDone: true,
    );
  }

  Future<void> _trackBackendCancel({
    required int generation,
    required bool emitIdleWhenDone,
  }) {
    final pending = _cancelOperation;
    if (pending != null) return pending;

    final completer = Completer<void>();
    _cancelOperation = completer.future;
    _cancelingGeneration = generation;
    unawaited(
      _finishTrackedCancel(
        generation: generation,
        emitIdleWhenDone: emitIdleWhenDone,
        completer: completer,
      ),
    );
    return completer.future;
  }

  Future<void> _finishTrackedCancel({
    required int generation,
    required bool emitIdleWhenDone,
    required Completer<void> completer,
  }) async {
    try {
      await _backend.cancel();
    } on Object {
      // Best-effort cancel.
    }

    if (_cancelingGeneration == generation) {
      _cancelingGeneration = null;
      _cancelOperation = null;
    }
    if (emitIdleWhenDone && !_disposed && generation == _generation) {
      _safeEmit(const SpeechInputIdle());
    }
    completer.complete();
  }

  @override
  String? consumeReady() {
    if (_disposed) return null;
    final state = _current;
    if (state is SpeechInputReady) {
      _safeEmit(const SpeechInputIdle());
      return state.transcript;
    }
    return null;
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    final generation = ++_generation;
    _awaitingFinal = false;
    _completedGeneration = null;
    _finalizationTimer?.cancel();
    _partialTranscript = '';
    _lastSoundLevel = null;
    _current = const SpeechInputIdle();

    await _trackBackendCancel(
      generation: generation,
      emitIdleWhenDone: false,
    );
    try {
      _backend.dispose();
    } on Object {
      // Best-effort backend disposal.
    }

    final controller = _stateController;
    _stateController = null;
    if (controller != null) {
      await controller.close();
    }
  }

  // ---- Internal callbacks ----

  void _onResult(BackendRecognitionResult result, int generation) {
    if (_disposed || generation != _generation) return;

    if (result.isFinal) {
      if (_completedGeneration == generation) return;
      _partialTranscript = result.recognizedWords;
      if (_awaitingFinal) {
        _awaitingFinal = false;
        _finalizationTimer?.cancel();
        _finalize(result.recognizedWords, generation);
      } else if (_current is SpeechInputListening) {
        // Auto-final from platform silence while still "listening".
        _finalize(result.recognizedWords, generation);
      }
      // If already in ready/idle/processing (timer fired), ignore stale final.
    } else {
      _partialTranscript = result.recognizedWords;
      if (_current is SpeechInputListening) {
        _safeEmit(
          SpeechInputListening(
            partialTranscript: _partialTranscript,
            soundLevel: _lastSoundLevel,
          ),
        );
      }
    }
  }

  void _finalize(String recognizedWords, int gen) {
    if (_disposed || gen != _generation) return;
    if (_completedGeneration == gen) return;
    _completedGeneration = gen;
    _awaitingFinal = false;
    _finalizationTimer?.cancel();
    final text = recognizedWords.trim();
    if (text.isNotEmpty) {
      _safeEmit(SpeechInputReady(text));
    } else {
      _safeEmit(const SpeechInputIdle());
    }
  }

  void _onSoundLevel(double level, int generation) {
    if (_disposed || generation != _generation) return;
    if (_current is! SpeechInputListening) return;
    if (!level.isFinite) return;

    // Update observed min/max for this listening session.
    if (level < _minLevel) _minLevel = level;
    if (level > _maxLevel) _maxLevel = level;

    // Normalize to 0.0..1.0 using observed range.
    double normalized;
    if (_maxLevel > _minLevel) {
      normalized = (level - _minLevel) / (_maxLevel - _minLevel);
    } else {
      normalized = 0.5;
    }

    // Clamp to 0..1 with finite guard.
    if (!normalized.isFinite) {
      normalized = 0.0;
    } else if (normalized < 0.0) {
      normalized = 0.0;
    } else if (normalized > 1.0) {
      normalized = 1.0;
    }

    _lastSoundLevel = normalized;
    _hasSoundLevelEvents = true;

    _safeEmit(
      SpeechInputListening(
        partialTranscript: _partialTranscript,
        soundLevel: normalized,
      ),
    );
  }

  void _onBackendError(BackendSpeechError error) {
    if (_disposed) return;
    final kind = classifySpeechFailureSignal(error.code);
    final reason = defaultSpeechFailureReason(kind);
    // Permission/secure-context/missing-device are hard failures that make
    // recognition unavailable until re-granted; a permanent service failure is
    // treated the same. Everything else is a retryable error.
    final hardUnavailable =
        kind == SpeechInputFailureKind.permissionDenied ||
        kind == SpeechInputFailureKind.secureContext ||
        kind == SpeechInputFailureKind.noCaptureDevice ||
        (kind == SpeechInputFailureKind.serviceUnavailable && error.permanent);
    final callbackMayBeStale = _cancelingGeneration != null;
    if (callbackMayBeStale && !hardUnavailable) return;

    final generation = ++_generation;
    _awaitingFinal = false;
    _finalizationTimer?.cancel();
    unawaited(
      _trackBackendCancel(
        generation: generation,
        emitIdleWhenDone: false,
      ),
    );

    if (hardUnavailable) {
      if (kind == SpeechInputFailureKind.permissionDenied) {
        _permissionDenied = true;
      }
      _available = false;
      _safeEmit(SpeechInputUnavailable(reason, kind: kind, detail: error.code));
      return;
    }

    _safeEmit(SpeechInputError(reason, kind: kind, detail: error.code));
  }

  void _onBackendStatus(String status) {
    if (_disposed) return;
    if (status == 'listening') {
      return;
    }
    if (_cancelingGeneration != null ||
        (status != 'done' && status != 'notListening')) {
      return;
    }
    if (_current is SpeechInputListening) {
      _awaitingFinal = true;
      _safeEmit(const SpeechInputProcessing());
    }
    if (_awaitingFinal) _scheduleFinalization(_generation);
  }

  void _emit(SpeechInputState state) {
    _current = state;
    _stateController?.add(state);
  }

  void _safeEmit(SpeechInputState state) {
    if (_disposed) return;
    _emit(state);
  }
}
