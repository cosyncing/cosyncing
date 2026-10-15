// The device's text-to-speech engine for feature tests: the platform edge
// read-aloud speaks through. It records what the app asked it to say and lets
// the test play the engine's side (an error, a finished utterance).
import 'dart:async';

import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// A fake speech engine.
final class FakeSpeechOutput implements SpeechOutput {
  /// Creates the engine; [supportsPauseResume] false models one that can only
  /// stop.
  FakeSpeechOutput({this.supportsPauseResume = true});

  /// Whether the engine can pause and resume.
  final bool supportsPauseResume;

  /// Message keys the app asked it to speak, in order.
  final List<String> spokenMessageKeys = [];

  /// The text of each spoken request.
  final List<String> spokenTexts = [];

  /// Rates the app set.
  final List<double> rateCalls = [];

  final _states = StreamController<SpeechOutputState>.broadcast();

  @override
  SpeechOutputCapabilities get capabilities => SpeechOutputCapabilities(
    synthesis: true,
    pauseResume: supportsPauseResume,
    installedLanguageVoiceAvailability: false,
  );

  @override
  SpeechOutputState current = const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states => _states.stream;

  void _emit(SpeechOutputState state) {
    current = state;
    _states.add(state);
  }

  /// The engine reports a failure for [messageKey].
  void fail({required String reason, String? messageKey}) =>
      _emit(SpeechOutputError(reason: reason, messageKey: messageKey));

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {
    spokenMessageKeys.add(messageKey);
    spokenTexts.add(utterances.map((u) => u.text).join(' '));
    _emit(SpeechOutputSpeaking(messageKey));
  }

  @override
  Future<void> setRate(double rate) async => rateCalls.add(rate);

  @override
  Future<void> pause() async {
    if (current case SpeechOutputSpeaking(:final messageKey)) {
      _emit(SpeechOutputPaused(messageKey));
    }
  }

  @override
  Future<void> resume() async {
    if (current case SpeechOutputPaused(:final messageKey)) {
      _emit(SpeechOutputSpeaking(messageKey));
    }
  }

  @override
  Future<void> stop() async => _emit(const SpeechOutputIdle());

  /// Times the app disposed the engine.
  int disposals = 0;

  @override
  Future<void> dispose() async => disposals++;

  /// The provider override that hands this engine to the App. The state
  /// stream is closed at the end of the test.
  Override get providerOverride {
    addTearDown(_states.close);
    return speechOutputFactoryProvider.overrideWithValue(() => this);
  }
}

/// The device's speech recognizer (dictation into the composer).
final class FakeSpeechInput implements SpeechInput {
  final _states = StreamController<SpeechInputState>.broadcast();
  SpeechInputState _current = const SpeechInputIdle();

  /// Times the app cancelled recognition.
  int cancelCalls = 0;

  @override
  SpeechInputCapabilities get capabilities => const SpeechInputCapabilities(
    recognition: true,
    onDeviceRecognition: true,
    soundLevelEvents: true,
  );

  @override
  SpeechInputState get current => _current;

  @override
  Stream<SpeechInputState> get states => _states.stream;

  void _emit(SpeechInputState next) {
    _current = next;
    _states.add(next);
  }

  /// The recognizer heard [transcript] and is done.
  void hear(String transcript) => _emit(SpeechInputReady(transcript));

  /// The recognizer is listening.
  void listening() => _emit(const SpeechInputListening());

  /// The recognizer cannot work ([reason] is what it says).
  void unavailable(String reason) => _emit(SpeechInputUnavailable(reason));

  @override
  Future<void> requestPermission() async {
    _emit(const SpeechInputRequestingPermission());
    _emit(const SpeechInputIdle());
  }

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async =>
      _emit(const SpeechInputListening());

  @override
  Future<void> stop() async => _emit(const SpeechInputProcessing());

  @override
  Future<void> cancel() async {
    cancelCalls += 1;
    _emit(const SpeechInputIdle());
  }

  @override
  String? consumeReady() {
    final value = _current;
    if (value is! SpeechInputReady) return null;
    _emit(const SpeechInputIdle());
    return value.transcript;
  }

  @override
  Future<void> dispose() async => _states.close();

  /// The provider override that hands this recognizer to the App.
  Override get providerOverride =>
      speechInputFactoryProvider.overrideWithValue(() => this);
}
