import 'dart:async';

import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';

void main() {
  late _FakeSpeechInput fakeInput;
  late _FakeSpeechOutput fakeOutput;
  late ProviderContainer container;
  late ProviderSubscription<VoiceInputState> subscription;
  late VoiceInputController controller;

  setUp(() {
    fakeInput = _FakeSpeechInput();
    fakeOutput = _FakeSpeechOutput();
    container = ProviderContainer(
      overrides: [
        speechInputFactoryProvider.overrideWithValue(() => fakeInput),
        speechOutputProvider.overrideWithValue(fakeOutput),
        readAloudPreferencesStoreProvider.overrideWithValue(
          InMemoryReadAloudPreferencesStore(),
        ),
      ],
    );
    subscription = container.listen(
      voiceInputControllerProvider,
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(() {
      subscription.close();
      container.dispose();
    });
    controller = container.read(voiceInputControllerProvider.notifier);
  });

  group('begin', () {
    test('stops TTS first before starting ASR', () async {
      fakeOutput
        ..isSpeaking = true
        ..stopCompleter = Completer<void>();
      container.read(readAloudControllerProvider);
      final begin = controller.begin(
        SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await pumpEventQueue();

      expect(fakeOutput.stopCallCount, 1);
      expect(fakeInput.requestPermissionCallCount, 0);
      expect(fakeInput.startCallCount, 0);

      fakeOutput.stopCompleter!.complete();
      await begin;
      expect(fakeInput.requestPermissionCallCount, 1);
      expect(fakeInput.startCallCount, 1);
    });

    test(
      'does not construct an idle read-aloud stack just to stop it',
      () async {
        expect(container.exists(readAloudControllerProvider), isFalse);
        expect(container.exists(speechOutputProvider), isFalse);

        await controller.begin(SpeechRecognitionPolicy.platformServiceAllowed);

        expect(container.exists(readAloudControllerProvider), isFalse);
        expect(container.exists(speechOutputProvider), isFalse);
        expect(fakeOutput.stopCallCount, 0);
      },
    );

    test('forwards required policy to input.start', () async {
      await controller.begin(SpeechRecognitionPolicy.onDeviceOnly);
      expect(fakeInput.lastPolicy, SpeechRecognitionPolicy.onDeviceOnly);
    });

    test('forwards platformServiceAllowed policy', () async {
      await controller.begin(SpeechRecognitionPolicy.platformServiceAllowed);
      expect(
        fakeInput.lastPolicy,
        SpeechRecognitionPolicy.platformServiceAllowed,
      );
    });

    test('does not start when recognition unavailable', () async {
      fakeInput.caps = SpeechInputCapabilities.unavailable;
      await controller.begin(SpeechRecognitionPolicy.platformServiceAllowed);
      expect(fakeInput.startCallCount, 0);
    });

    test('remembers chosen policy for subsequent taps', () async {
      await controller.begin(SpeechRecognitionPolicy.onDeviceOnly);
      expect(fakeInput.startCallCount, 1);
      // The state should reflect the chosen policy
      final state = container.read(voiceInputControllerProvider);
      expect(state.chosenPolicy, SpeechRecognitionPolicy.onDeviceOnly);
    });
  });

  group('consumeReady', () {
    test('returns transcript and transitions to idle', () async {
      fakeInput.emitReady('hello world');
      await pumpEventQueue();
      final transcript = controller.consumeReady();
      expect(transcript, 'hello world');
      expect(fakeInput.consumeReadyCallCount, 1);
    });

    test('consumeReady is not auto-send', () async {
      fakeInput.emitReady('some text');
      await pumpEventQueue();
      final transcript = controller.consumeReady();
      // Verify no prompt was sent - the controller has no send mechanism
      expect(transcript, 'some text');
      expect(fakeInput.consumeReadyCallCount, 1);
    });

    test('returns null when not ready', () {
      expect(controller.consumeReady(), isNull);
    });
  });

  group('stop', () {
    test('calls input.stop', () async {
      fakeInput.emitListening('partial');
      await pumpEventQueue();
      await controller.stop();
      expect(fakeInput.stopCallCount, 1);
    });
  });

  group('cancel', () {
    test('calls input.cancel and returns to idle', () async {
      fakeInput.emitListening('partial text');
      await pumpEventQueue();
      await controller.cancel();
      expect(fakeInput.cancelCallCount, 1);
      final state = container.read(voiceInputControllerProvider);
      expect(state.inputState, isA<SpeechInputIdle>());
    });

    test('cancel clears sound level history', () async {
      fakeInput.emitListening('text', 0.5);
      await pumpEventQueue();
      fakeInput.emitListening('text', 0.8);
      await pumpEventQueue();
      await controller.cancel();
      await pumpEventQueue();
      final state = container.read(voiceInputControllerProvider);
      expect(state.soundLevelHistory, isEmpty);
    });
  });

  group('state propagation', () {
    test('listening state with sound level updates history', () async {
      fakeInput.emitListening('hello', 0.3);
      await pumpEventQueue();
      fakeInput.emitListening('hello world', 0.7);
      await pumpEventQueue();
      final state = container.read(voiceInputControllerProvider);
      expect(state.isListening, isTrue);
      expect(state.partialTranscript, 'hello world');
      expect(state.soundLevelHistory, hasLength(2));
      expect(state.soundLevelHistory[0], 0.3);
      expect(state.soundLevelHistory[1], 0.7);
    });

    test('error state propagates', () async {
      fakeInput.emitError('recognition failed');
      await pumpEventQueue();
      final state = container.read(voiceInputControllerProvider);
      expect(state.hasError, isTrue);
    });

    test('unavailable state propagates', () async {
      fakeInput.emitUnavailable('not supported');
      await pumpEventQueue();
      final state = container.read(voiceInputControllerProvider);
      expect(state.isUnavailable, isTrue);
    });
  });

  group('provider lifetime and disposal', () {
    test(
      'rebuild replaces input without leaking the old subscription',
      () async {
        final firstInput = _FakeSpeechInput();
        final secondInput = _FakeSpeechInput();
        var factoryCalls = 0;
        final localContainer = ProviderContainer(
          overrides: [
            speechInputFactoryProvider.overrideWithValue(() {
              factoryCalls++;
              return factoryCalls == 1 ? firstInput : secondInput;
            }),
            speechOutputProvider.overrideWithValue(fakeOutput),
          ],
        );
        final localSubscription = localContainer.listen(
          voiceInputControllerProvider,
          (_, _) {},
          fireImmediately: true,
        );
        addTearDown(() {
          localSubscription.close();
          localContainer.dispose();
        });

        expect(firstInput.hasStateListener, isTrue);
        localContainer.invalidate(speechInputProvider);
        await pumpEventQueue();

        expect(factoryCalls, 2);
        expect(firstInput.disposeCallCount, 1);
        expect(firstInput.hasStateListener, isFalse);
        expect(secondInput.hasStateListener, isTrue);

        secondInput.emitListening('replacement', 0.4);
        await pumpEventQueue();
        expect(
          localContainer.read(voiceInputControllerProvider).partialTranscript,
          'replacement',
        );
      },
    );

    test('input is not disposed while controller is alive', () {
      expect(fakeInput.disposeCallCount, 0);
    });

    test('input is disposed when container is disposed', () async {
      container.dispose();
      await pumpEventQueue();
      expect(fakeInput.disposeCallCount, 1);
    });
  });
}

class _FakeSpeechInput implements SpeechInput {
  SpeechInputCapabilities caps = const SpeechInputCapabilities(
    recognition: true,
    onDeviceRecognition: true,
    soundLevelEvents: true,
  );

  final StreamController<SpeechInputState> _controller =
      StreamController<SpeechInputState>.broadcast();

  SpeechInputState _current = const SpeechInputIdle();
  SpeechRecognitionPolicy? lastPolicy;
  int startCallCount = 0;
  int stopCallCount = 0;
  int cancelCallCount = 0;
  int disposeCallCount = 0;
  int consumeReadyCallCount = 0;
  int requestPermissionCallCount = 0;

  bool get hasStateListener => _controller.hasListener;

  @override
  SpeechInputCapabilities get capabilities => caps;

  @override
  SpeechInputState get current => _current;

  @override
  Stream<SpeechInputState> get states => _controller.stream;

  void emit(SpeechInputState state) {
    _current = state;
    _controller.add(state);
  }

  void emitListening(String partial, [double? level]) {
    emit(SpeechInputListening(partialTranscript: partial, soundLevel: level));
  }

  void emitReady(String transcript) {
    emit(SpeechInputReady(transcript));
  }

  void emitError(String reason) {
    emit(SpeechInputError(reason));
  }

  void emitUnavailable(String reason) {
    emit(SpeechInputUnavailable(reason));
  }

  @override
  Future<void> requestPermission() async {
    requestPermissionCallCount++;
    emit(const SpeechInputRequestingPermission());
    emit(const SpeechInputIdle());
  }

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {
    lastPolicy = policy;
    startCallCount++;
    emit(const SpeechInputListening());
  }

  @override
  Future<void> stop() async {
    stopCallCount++;
    emit(const SpeechInputProcessing());
  }

  @override
  Future<void> cancel() async {
    cancelCallCount++;
    emit(const SpeechInputIdle());
  }

  @override
  String? consumeReady() {
    consumeReadyCallCount++;
    final state = _current;
    if (state is SpeechInputReady) {
      emit(const SpeechInputIdle());
      return state.transcript;
    }
    return null;
  }

  @override
  Future<void> dispose() async {
    disposeCallCount++;
    await _controller.close();
  }
}

class _FakeSpeechOutput implements SpeechOutput {
  bool isSpeaking = false;
  int stopCallCount = 0;
  Completer<void>? stopCompleter;

  @override
  SpeechOutputCapabilities get capabilities =>
      SpeechOutputCapabilities.unavailable;

  @override
  SpeechOutputState get current => isSpeaking
      ? const SpeechOutputSpeaking('test')
      : const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states => const Stream.empty();

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {}

  @override
  Future<void> setRate(double rate) async {}

  @override
  Future<void> pause() async {}

  @override
  Future<void> resume() async {}

  @override
  Future<void> stop() async {
    stopCallCount++;
    await stopCompleter?.future;
    isSpeaking = false;
  }

  @override
  Future<void> dispose() async {}
}
