/// Real SpeechToText backend implementation and platform-default factory.
///
/// This is production code that imports `package:speech_to_text`. It is **not**
/// excluded from static analysis; it analyzes cleanly once `speech_to_text` is
/// resolved via `flutter pub get`. In sandboxes where the package cannot be
/// fetched, these files remain unresolved - that is a verification blocker,
/// not a repository policy. The testable adapter logic lives in
/// `speech_to_text_speech_input.dart`, which depends only on the
/// `SpeechToTextBackend` interface.
///
/// Uses the speech_to_text 7.4.0 API:
/// - `SpeechToText()` constructor
/// - `initialize({onError, onStatus, options})` requests permission and returns
///   `Future<bool>`; Android's no-Bluetooth behavior is a config option
/// - `listen({onResult, listenOptions, onSoundLevelChange})` starts dictation
/// - `SpeechRecognitionResult.recognizedWords` / `.finalResult`
/// - `stop()` requests final result; `cancel()` discards
/// - `onSoundLevelChange` callback delivers raw `double` levels
///
/// **API verification note:** The exact method signatures above are based on
/// the documented speech_to_text 7.4.0 API. The package could not be resolved
/// in-sandbox, so these signatures have not been verified against source. Any
/// mismatch will surface as a compile error once `flutter pub get` succeeds.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction").
library;

import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_factory.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_backend.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_speech_input.dart';
import 'package:flutter/foundation.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Production [SpeechToTextBackend] backed by the `speech_to_text` plugin.
class SpeechToTextBackendImpl implements SpeechToTextBackend {
  /// Creates a backend wrapping a new `SpeechToText` instance.
  SpeechToTextBackendImpl() : _stt = SpeechToText();

  static const _cancelStatusTimeout = Duration(seconds: 1);

  final SpeechToText _stt;
  Completer<void>? _cancelStatusCompleter;
  Future<void>? _cancelOperation;
  int _cancelSerial = 0;
  bool _cancelUnsettled = false;
  bool _listenRequested = false;

  @override
  Future<bool> initialize({
    required void Function(BackendSpeechError error) onError,
    required void Function(String status) onStatus,
    Set<BackendInitializationOption> options = const {
      BackendInitializationOption.androidNoBluetooth,
    },
  }) async {
    final pluginOptions = <SpeechConfigOption>[
      for (final option in options)
        switch (option) {
          BackendInitializationOption.androidNoBluetooth =>
            SpeechToText.androidNoBluetooth,
          BackendInitializationOption.webDoNotAggregate =>
            SpeechToText.webDoNotAggregate,
        },
    ];
    return _stt.initialize(
      onError: (error) => onError(
        BackendSpeechError(
          code: error.errorMsg,
          permanent: error.permanent,
        ),
      ),
      onStatus: (status) {
        if (status == SpeechToText.notListeningStatus) {
          _listenRequested = false;
          _cancelUnsettled = false;
          final completer = _cancelStatusCompleter;
          if (completer != null && !completer.isCompleted) {
            completer.complete();
          }
        } else if (!kIsWeb && status == SpeechToText.doneStatus) {
          _listenRequested = false;
        }
        onStatus(status);
      },
      options: pluginOptions.isEmpty ? null : pluginOptions,
    );
  }

  @override
  Future<void> listen({
    required void Function(BackendRecognitionResult) onResult,
    required BackendListenOptions options,
    void Function(double level)? onSoundLevelChange,
  }) async {
    if (_cancelUnsettled) {
      throw StateError(
        'InvalidStateError: prior speech cancellation is still settling',
      );
    }
    _listenRequested = true;
    try {
      await _stt.listen(
        onResult: (SpeechRecognitionResult result) {
          onResult(
            BackendRecognitionResult(
              recognizedWords: result.recognizedWords,
              isFinal: result.finalResult,
            ),
          );
        },
        listenOptions: SpeechListenOptions(
          partialResults: options.partialResults,
          onDevice: options.onDevice,
          cancelOnError: options.cancelOnError,
          listenMode: ListenMode.dictation,
        ),
        onSoundLevelChange: onSoundLevelChange != null
            ? (double level) => onSoundLevelChange(level)
            : null,
      );
    } on Object {
      _listenRequested = false;
      rethrow;
    }
  }

  @override
  Future<void> stop() => _stt.stop();

  @override
  Future<void> cancel() {
    final pending = _cancelOperation;
    if (pending != null) return pending;

    final serial = ++_cancelSerial;
    final operation = _cancelAndSettle(serial);
    _cancelOperation = operation;
    return operation;
  }

  Future<void> _cancelAndSettle(int serial) async {
    final waitForTerminalStatus = _listenRequested || _cancelUnsettled;
    final completer = waitForTerminalStatus ? Completer<void>() : null;
    _cancelStatusCompleter = completer;
    try {
      await _stt.cancel();
      if (completer != null) {
        try {
          await completer.future.timeout(_cancelStatusTimeout);
        } on TimeoutException {
          // Do not let a recognizer that failed to report onend corrupt a
          // restart. The next listen fails with typed InvalidStateError until
          // a late notListening status clears this barrier.
          _cancelUnsettled = true;
        }
      }
    } on Object {
      if (waitForTerminalStatus) {
        _cancelUnsettled = true;
      }
      rethrow;
    } finally {
      if (identical(_cancelStatusCompleter, completer)) {
        _cancelStatusCompleter = null;
      }
      _listenRequested = false;
      if (_cancelSerial == serial) {
        _cancelOperation = null;
      }
    }
  }

  @override
  bool get isListening => _stt.isListening;

  @override
  void dispose() {
    // SpeechToText has no explicit dispose; resources are released on cancel
    // or when the engine is GC'd.
  }
}

/// Creates a SpeechToText-backed [SpeechInput] for production use.
///
/// [onDeviceCapable] determines whether the adapter advertises on-device
/// recognition (conservatively Android/iOS/macOS only).
SpeechInput createSpeechToTextSpeechInput({
  required bool onDeviceCapable,
  Set<BackendInitializationOption> initializationOptions = const {
    BackendInitializationOption.androidNoBluetooth,
  },
}) {
  final backend = SpeechToTextBackendImpl();
  return SpeechToTextSpeechInput(
    backend,
    onDeviceCapable: onDeviceCapable,
    initializationOptions: initializationOptions,
  );
}

/// Creates the platform-default [SpeechInput] for the current platform.
///
/// Delegates to [createSpeechInputForPlatform] with `kIsWeb`,
/// `defaultTargetPlatform`, and a secure-context check. When `kIsWeb` is true,
/// the adapter is created regardless of host platform (so Chromium on Linux is
/// not disabled), but only if the web origin is secure (HTTPS or trusted
/// loopback). When false, only Android, iOS, macOS, and Windows are supported
/// (strict native whitelist); Linux, Fuchsia, and other targets, or any
/// construction failure, return an [UnavailableSpeechInput].
///
/// On-device recognition is offered only on Android, iOS, and macOS
/// (conservatively); web and Windows do not advertise it unless source proves
/// otherwise.
SpeechInput createDefaultSpeechInput() {
  final onDeviceCapable =
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS ||
          defaultTargetPlatform == TargetPlatform.macOS);
  final initializationOptions = speechBackendOptionsForRuntime(
    isWeb: kIsWeb,
    isAndroid: defaultTargetPlatform == TargetPlatform.android,
  );
  return createSpeechInputForPlatform(
    isWeb: kIsWeb,
    platform: defaultTargetPlatform,
    isSecureContext: _isSecureContext,
    createSupportedAdapter: () => createSpeechToTextSpeechInput(
      onDeviceCapable: onDeviceCapable,
      initializationOptions: initializationOptions,
    ),
  );
}

/// Whether the current origin is a secure context for web ASR.
///
/// On native, always `true` (secure context is a web concept). On web,
/// approximates `window.isSecureContext` by checking the scheme and host of
/// [Uri.base]. HTTPS origins and trusted loopback (`localhost`,
/// `127.0.0.1`, `::1`) are secure; plain-HTTP remote origins are not.
bool get _isSecureContext {
  if (!kIsWeb) return true;
  final uri = Uri.base;
  return uri.scheme == 'https' ||
      uri.host == 'localhost' ||
      uri.host == '127.0.0.1' ||
      uri.host == '::1';
}
