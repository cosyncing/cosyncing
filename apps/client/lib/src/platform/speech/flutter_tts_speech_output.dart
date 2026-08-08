import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/flutter_tts_backend.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';

/// Platform-neutral [SpeechOutput] adapter backed by a [FlutterTtsBackend].
///
/// Owns utterance sequencing, completion/error/cancel semantics, race-safe
/// cancellation (a stopped or replaced queue must not continue on a late
/// completion), and runtime capability reporting. No plugin types escape this
/// class; views and controllers depend on [SpeechOutput], not on
/// [FlutterTtsBackend].
///
/// **pauseResume:** `flutter_tts` 4.2.5 exposes `pause()` but no callable
/// `resume()`, so this adapter always reports `pauseResume: false`. `pause`
/// and `resume` are honest no-ops that never transition state. A future native
/// adapter that supports both may advertise `pauseResume: true`; the
/// platform-neutral [SpeechOutput] contract preserves both methods for that
/// purpose.
///
/// **Initialization:** [initialize] is idempotent and absorbs all backend
/// failures. After every awaited boundary it checks [_disposed] and returns
/// immediately so a disposed backend is never touched again. [speak] calls
/// [initialize] automatically so direct callers need not initialize first.
///
/// **Pre-playback stop:** when switching or starting a message, a
/// [FlutterTtsBackend.stop] failure aborts the new queue and emits a sanitized
/// [SpeechOutputError] scoped to the requested message identity - it never
/// continues and risks overlapping speech.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (sections "Final-message read-aloud" and "Flutter Integration Direction").
class FlutterTtsSpeechOutput implements SpeechOutput {
  /// Creates an adapter backed by a backend.
  ///
  /// Call [initialize] after construction to probe capabilities and enable
  /// await-speak-completion. Until initialization completes, capabilities
  /// report [SpeechOutputCapabilities.unavailable]. [speak] also calls
  /// [initialize] automatically.
  FlutterTtsSpeechOutput(this._backend);

  final FlutterTtsBackend _backend;

  SpeechOutputCapabilities _capabilities = SpeechOutputCapabilities.unavailable;
  SpeechOutputState _current = const SpeechOutputIdle();
  StreamController<SpeechOutputState>? _stateController =
      StreamController<SpeechOutputState>.broadcast();

  /// Monotonic token. Incremented on every [speak] and [stop] so the playback
  /// loop can detect stale completions.
  int _speakToken = 0;

  List<SpeechUtterance> _queue = const [];
  int _queueIndex = 0;
  String? _speakingKey;

  /// Whether the error handler fired during a pending [speak].
  /// The raw plugin payload is never retained; a boolean marker is
  /// sufficient because all errors produce the same sanitized state.
  bool _pendingError = false;

  /// Cached initialization future so [initialize] is idempotent.
  Future<void>? _initFuture;

  /// Guards against emitting to a closed stream or touching a disposed backend.
  bool _disposed = false;

  @override
  SpeechOutputCapabilities get capabilities => _capabilities;

  @override
  SpeechOutputState get current => _current;

  @override
  Stream<SpeechOutputState> get states {
    final controller = _stateController;
    if (controller != null) return controller.stream;
    return const Stream<SpeechOutputState>.empty();
  }

  /// Probes capabilities at runtime and enables await-speak-completion.
  ///
  /// Idempotent: returns the same future on repeated calls. All backend
  /// failures are caught and result in [SpeechOutputCapabilities.unavailable]
  /// so initialization never leaks an unhandled async error. After every
  /// awaited boundary the method checks [_disposed] and returns immediately.
  Future<void> initialize() {
    _initFuture ??= _doInitialize();
    return _initFuture!;
  }

  Future<void> _doInitialize() async {
    try {
      await _backend.enableAwaitCompletion();
    } on Object {
      // Backend unavailable; capabilities stay unavailable.
      _safeEmit(_current);
      return;
    }
    if (_disposed) return;
    var synthesis = false;
    var voices = false;

    try {
      final languages = await _backend.getLanguages();
      if (_disposed) return;
      if (languages.isNotEmpty) {
        synthesis = true;
        voices = true;
      }
    } on Object {
      // TTS engine unavailable on this platform.
    }

    if (_disposed) return;

    // flutter_tts 4.2.5 has pause() but no resume(), so pauseResume is always
    // false for this adapter. Do not probe pause during initialization.
    _capabilities = SpeechOutputCapabilities(
      synthesis: synthesis,
      pauseResume: false,
      installedLanguageVoiceAvailability: voices,
    );
    _safeEmit(_current);
  }

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {
    assert(
      utterances.isNotEmpty,
      'speak requires a non-empty utterance list',
    );
    if (_disposed) return;
    // Ensure initialization has been attempted even for direct callers.
    try {
      await initialize();
    } on Object {
      // Initialization failed; capabilities are unavailable.
      return;
    }
    if (_disposed) return;
    // Honor capabilities: never invoke the backend if synthesis is unavailable.
    if (!_capabilities.synthesis) return;

    _speakToken++;
    final token = _speakToken;
    try {
      await _backend.stop();
    } on Object {
      // Pre-playback stop failed: abort the new queue and emit a scoped
      // error rather than risking overlapping speech.
      _speakingKey = null;
      _queue = const [];
      _queueIndex = 0;
      _pendingError = false;
      _safeEmit(
        SpeechOutputError(
          reason: _sanitizeError('stop failed'),
          messageKey: messageKey,
        ),
      );
      return;
    }
    if (_disposed) return;
    _queue = List<SpeechUtterance>.unmodifiable(utterances);
    _queueIndex = 0;
    _speakingKey = messageKey;
    _pendingError = false;
    _safeEmit(SpeechOutputSpeaking(messageKey));
    unawaited(_speakQueue(token));
  }

  Future<void> _speakQueue(int token) async {
    while (token == _speakToken && _queueIndex < _queue.length && !_disposed) {
      _pendingError = false;
      _safeSetErrorHandler(token);
      try {
        await _backend.speak(_queue[_queueIndex].text);
      } on Object {
        if (token == _speakToken && !_disposed) {
          _handleError();
        }
        return;
      }
      if (token != _speakToken || _disposed) return;
      if (_pendingError) {
        _handleError();
        return;
      }
      _queueIndex++;
    }
    if (token == _speakToken && !_disposed) {
      _speakingKey = null;
      _queue = const [];
      _queueIndex = 0;
      _safeEmit(const SpeechOutputIdle());
    }
  }

  void _safeSetErrorHandler(int token) {
    if (_disposed) return;
    try {
      _backend.setErrorHandler(
        (message) => _onErrorHandler(token, message),
      );
    } on Object {
      // Backend does not support error handlers.
    }
  }

  void _onErrorHandler(int token, Object? message) {
    if (_disposed || token != _speakToken) return;
    // Only record if actively speaking; a stale error from a superseded queue
    // or after stop is ignored when the backend preserves handler identity.
    // The raw plugin payload (which may be a String, Map, Exception, or
    // any dynamic value) is never retained or exposed.
    if (_current is! SpeechOutputSpeaking) return;
    _pendingError = true;
  }

  void _handleError() {
    _speakToken++;
    final key = _speakingKey;
    _speakingKey = null;
    _queue = const [];
    _queueIndex = 0;
    _pendingError = false;
    _safeEmit(SpeechOutputError(reason: 'Playback error.', messageKey: key));
  }

  String _sanitizeError(String message) {
    // Never expose raw plugin text; provide a compact, user-facing message.
    return 'Playback error.';
  }

  @override
  Future<void> stop() async {
    if (_disposed) return;
    _speakToken++;
    final key = _speakingKey;
    _speakingKey = null;
    _queue = const [];
    _queueIndex = 0;
    _pendingError = false;
    try {
      await _backend.stop();
      _safeEmit(const SpeechOutputIdle());
    } on Object {
      // Stop failed: we cannot confirm silence. Emit an honest scoped error
      // rather than falsely claiming idle. Stop remains available for retry.
      _safeEmit(
        SpeechOutputError(
          reason: _sanitizeError('stop failed'),
          messageKey: key,
        ),
      );
    }
  }

  /// No-op: `flutter_tts` 4.2.5 has `pause()` but no `resume()`, so this
  /// adapter reports `pauseResume: false` and never transitions to a paused
  /// state. The method exists to satisfy the platform-neutral [SpeechOutput]
  /// contract for future adapters.
  @override
  Future<void> pause() async {}

  /// No-op: see [pause]. Never transitions state for this adapter.
  @override
  Future<void> resume() async {}

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _speakToken++;
    _speakingKey = null;
    _queue = const [];
    _queueIndex = 0;
    _pendingError = false;
    try {
      await _backend.stop();
    } on Object {
      // Best-effort stop during disposal.
    }
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

  void _safeEmit(SpeechOutputState state) {
    if (_disposed) return;
    _current = state;
    _stateController?.add(state);
  }
}
