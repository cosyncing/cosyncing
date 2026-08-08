import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('capabilities', () {
    test('input unavailable is all-false', () {
      const caps = SpeechInputCapabilities.unavailable;
      expect(caps.recognition, isFalse);
      expect(caps.onDeviceRecognition, isFalse);
      expect(caps.soundLevelEvents, isFalse);
    });

    test('output unavailable is all-false', () {
      const caps = SpeechOutputCapabilities.unavailable;
      expect(caps.synthesis, isFalse);
      expect(caps.pauseResume, isFalse);
      expect(caps.installedLanguageVoiceAvailability, isFalse);
    });

    test('input: onDeviceRecognition requires recognition', () {
      expect(
        () => SpeechInputCapabilities(
          recognition: false,
          onDeviceRecognition: true,
          soundLevelEvents: false,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('input: soundLevelEvents requires recognition', () {
      expect(
        () => SpeechInputCapabilities(
          recognition: false,
          onDeviceRecognition: false,
          soundLevelEvents: true,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('output: pauseResume requires synthesis', () {
      expect(
        () => SpeechOutputCapabilities(
          synthesis: false,
          pauseResume: true,
          installedLanguageVoiceAvailability: false,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('output: voice availability requires synthesis', () {
      expect(
        () => SpeechOutputCapabilities(
          synthesis: false,
          pauseResume: false,
          installedLanguageVoiceAvailability: true,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    test('input: valid full combo constructs', () {
      const caps = SpeechInputCapabilities(
        recognition: true,
        onDeviceRecognition: true,
        soundLevelEvents: true,
      );
      expect(caps.recognition, isTrue);
      expect(caps.onDeviceRecognition, isTrue);
      expect(caps.soundLevelEvents, isTrue);
    });

    test('output: valid full combo constructs', () {
      const caps = SpeechOutputCapabilities(
        synthesis: true,
        pauseResume: true,
        installedLanguageVoiceAvailability: true,
      );
      expect(caps.synthesis, isTrue);
      expect(caps.pauseResume, isTrue);
      expect(caps.installedLanguageVoiceAvailability, isTrue);
    });
  });

  group('SpeechInputListening sound level', () {
    test('accepts a normalized level in range', () {
      expect(const SpeechInputListening(soundLevel: 0.5).soundLevel, 0.5);
    });

    test('accepts null when no level events', () {
      expect(const SpeechInputListening().soundLevel, isNull);
    });

    test('accepts the boundaries 0.0 and 1.0', () {
      expect(const SpeechInputListening(soundLevel: 0).soundLevel, 0);
      expect(const SpeechInputListening(soundLevel: 1).soundLevel, 1);
    });

    test('rejects a level above 1.0', () {
      expect(
        () => SpeechInputListening(soundLevel: 1.1),
        throwsA(isA<AssertionError>()),
      );
    });

    test('rejects a negative level', () {
      expect(
        () => SpeechInputListening(soundLevel: -0.01),
        throwsA(isA<AssertionError>()),
      );
    });

    test('default partial transcript is empty', () {
      expect(const SpeechInputListening().partialTranscript, '');
    });
  });

  group('state invariants', () {
    test('output speaking and paused carry a message key', () {
      expect(const SpeechOutputSpeaking('k').messageKey, 'k');
      expect(const SpeechOutputPaused('k').messageKey, 'k');
    });

    test('output error carries a reason and optional key', () {
      expect(
        const SpeechOutputError(reason: 'boom').reason,
        'boom',
      );
      expect(const SpeechOutputError(reason: 'x').messageKey, isNull);
      expect(
        const SpeechOutputError(reason: 'x', messageKey: 'k').messageKey,
        'k',
      );
    });

    test('input ready carries the transcript', () {
      expect(const SpeechInputReady('hello').transcript, 'hello');
    });

    test('states are distinct types', () {
      expect(const SpeechOutputIdle(), isA<SpeechOutputState>());
      expect(const SpeechOutputSpeaking('k'), isA<SpeechOutputState>());
      expect(const SpeechOutputPaused('k'), isA<SpeechOutputState>());
      expect(const SpeechOutputError(reason: 'e'), isA<SpeechOutputState>());
      expect(const SpeechInputIdle(), isA<SpeechInputState>());
      expect(const SpeechInputListening(), isA<SpeechInputState>());
    });
  });

  group('SpeechOutput fake (fake-backed contract)', () {
    test('speak transitions to speaking and stores utterances', () async {
      final out = _FakeSpeechOutput();
      expect(out.current, isA<SpeechOutputIdle>());

      await out.speak(
        messageKey: 'k1',
        utterances: const [SpeechUtterance('hi')],
      );

      expect(out.current, isA<SpeechOutputSpeaking>());
      expect((out.current as SpeechOutputSpeaking).messageKey, 'k1');
      expect(out.queue, hasLength(1));
    });

    test('speak replaces the currently speaking message', () async {
      final out = _FakeSpeechOutput();
      await out.speak(
        messageKey: 'k1',
        utterances: const [SpeechUtterance('a')],
      );
      await out.speak(
        messageKey: 'k2',
        utterances: const [SpeechUtterance('b')],
      );

      expect((out.current as SpeechOutputSpeaking).messageKey, 'k2');
      expect(out.queue.last.text, 'b');
    });

    test('pause and resume round-trip the message key', () async {
      final out = _FakeSpeechOutput();
      await out.speak(
        messageKey: 'k1',
        utterances: const [SpeechUtterance('a')],
      );
      await out.pause();
      expect(out.current, isA<SpeechOutputPaused>());
      expect((out.current as SpeechOutputPaused).messageKey, 'k1');
      await out.resume();
      expect(out.current, isA<SpeechOutputSpeaking>());
      expect((out.current as SpeechOutputSpeaking).messageKey, 'k1');
    });

    test('stop clears the queue and returns to idle', () async {
      final out = _FakeSpeechOutput();
      await out.speak(
        messageKey: 'k1',
        utterances: const [SpeechUtterance('a')],
      );
      await out.stop();
      expect(out.current, isA<SpeechOutputIdle>());
      expect(out.queue, isEmpty);
    });

    test('states stream emits transitions', () async {
      final out = _FakeSpeechOutput();
      final emitted = <SpeechOutputState>[];
      final sub = out.states.listen(emitted.add);

      await out.speak(
        messageKey: 'k1',
        utterances: const [SpeechUtterance('a')],
      );
      await out.stop();
      await sub.cancel();

      expect(emitted, [
        isA<SpeechOutputSpeaking>(),
        isA<SpeechOutputIdle>(),
      ]);
    });

    test('speak rejects an empty utterance list', () {
      final out = _FakeSpeechOutput();
      expect(
        () => out.speak(messageKey: 'k1', utterances: const []),
        throwsA(isA<AssertionError>()),
      );
    });
  });

  group('SpeechInput fake (fake-backed contract)', () {
    test('start then stop yields a ready transcript', () async {
      final input = _FakeSpeechInput();
      await input.start(policy: SpeechRecognitionPolicy.onDeviceOnly);
      expect(input.current, isA<SpeechInputListening>());
      await input.stop();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'hi there');
    });

    test('cancel discards and returns to idle', () async {
      final input = _FakeSpeechInput();
      await input.start(
        policy: SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await input.cancel();
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('requestPermission transitions through requesting', () async {
      final input = _FakeSpeechInput();
      final emitted = <SpeechInputState>[];
      final sub = input.states.listen(emitted.add);
      await input.requestPermission();
      await sub.cancel();
      expect(emitted, contains(isA<SpeechInputRequestingPermission>()));
    });

    test('reports unavailable capabilities by default', () {
      expect(_FakeSpeechInput().capabilities.recognition, isFalse);
    });

    test('start records the chosen recognition policy', () async {
      final input = _FakeSpeechInput();
      await input.start(policy: SpeechRecognitionPolicy.onDeviceOnly);
      expect(input.lastPolicy, SpeechRecognitionPolicy.onDeviceOnly);
    });
  });
}

class _FakeSpeechOutput implements SpeechOutput {
  @override
  final SpeechOutputCapabilities capabilities =
      SpeechOutputCapabilities.unavailable;

  final StreamController<SpeechOutputState> _controller =
      StreamController<SpeechOutputState>.broadcast();

  SpeechOutputState _current = const SpeechOutputIdle();

  List<SpeechUtterance> queue = const <SpeechUtterance>[];

  @override
  SpeechOutputState get current => _current;

  @override
  Stream<SpeechOutputState> get states => _controller.stream;

  void _emit(SpeechOutputState state) {
    _current = state;
    _controller.add(state);
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
    queue = List<SpeechUtterance>.of(utterances);
    _emit(SpeechOutputSpeaking(messageKey));
  }

  @override
  Future<void> pause() async {
    final current = _current;
    if (current is SpeechOutputSpeaking) {
      _emit(SpeechOutputPaused(current.messageKey));
    }
  }

  @override
  Future<void> resume() async {
    final current = _current;
    if (current is SpeechOutputPaused) {
      _emit(SpeechOutputSpeaking(current.messageKey));
    }
  }

  @override
  Future<void> stop() async {
    queue = const <SpeechUtterance>[];
    _emit(const SpeechOutputIdle());
  }

  @override
  Future<void> dispose() async {
    await _controller.close();
  }
}

class _FakeSpeechInput implements SpeechInput {
  @override
  final SpeechInputCapabilities capabilities =
      SpeechInputCapabilities.unavailable;

  final StreamController<SpeechInputState> _controller =
      StreamController<SpeechInputState>.broadcast();

  SpeechInputState _current = const SpeechInputIdle();

  /// The last policy passed to [start], for assertion in tests.
  SpeechRecognitionPolicy? lastPolicy;

  @override
  SpeechInputState get current => _current;

  @override
  Stream<SpeechInputState> get states => _controller.stream;

  void _emit(SpeechInputState state) {
    _current = state;
    _controller.add(state);
  }

  @override
  Future<void> requestPermission() async {
    _emit(const SpeechInputRequestingPermission());
  }

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {
    lastPolicy = policy;
    _emit(const SpeechInputListening());
  }

  @override
  Future<void> stop() async {
    _emit(const SpeechInputReady('hi there'));
  }

  @override
  Future<void> cancel() async {
    _emit(const SpeechInputIdle());
  }

  @override
  String? consumeReady() {
    final state = _current;
    if (state is SpeechInputReady) {
      _emit(const SpeechInputIdle());
      return state.transcript;
    }
    return null;
  }

  @override
  Future<void> dispose() async {
    await _controller.close();
  }
}
