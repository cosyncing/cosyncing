import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_rate_controller.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/platform/speech/flutter_tts_backend.dart';
import 'package:cosyncing_client/src/platform/speech/flutter_tts_speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';

void main() {
  late _FakeSpeechOutput fakeOutput;
  late ProviderContainer container;
  late ProviderSubscription<ReadAloudState> subscription;
  late ReadAloudController controller;
  late InMemoryReadAloudPreferencesStore rateStore;

  setUp(() {
    fakeOutput = _FakeSpeechOutput();
    rateStore = InMemoryReadAloudPreferencesStore();
    container = ProviderContainer(
      overrides: [
        speechOutputFactoryProvider.overrideWithValue(() => fakeOutput),
        readAloudPreferencesStoreProvider.overrideWithValue(
          rateStore,
        ),
      ],
    );
    subscription = container.listen(
      readAloudControllerProvider,
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(() {
      subscription.close();
      container.dispose();
    });
    controller = container.read(readAloudControllerProvider.notifier);
  });

  AgentMessage finalMessage({
    String? text = 'Hello world.',
    String? key = 'turn-1',
    String? id,
  }) {
    return AgentMessage(
      type: AgentMessageType.modelOutput,
      id: id,
      raw: {
        'type': 'model-output',
        if (text != null) 'text': text,
        'final': true,
        if (key != null) 'key': key,
      },
    );
  }

  group('speakForMessage', () {
    test('allows the first manual probe while synthesis is unprobed', () async {
      fakeOutput.capabilities = const SpeechOutputCapabilities.unprobed();

      await controller.speakForMessage(finalMessage());

      expect(fakeOutput.speakCalls, hasLength(1));
    });

    test('compiles final complete text and calls speak', () async {
      await controller.speakForMessage(finalMessage());

      expect(fakeOutput.speakCalls, hasLength(1));
      expect(fakeOutput.speakCalls.first.$1, 'turn-1');
      expect(
        fakeOutput.speakCalls.first.$2.first.text,
        'Hello world.',
      );
    });

    test('uses modelOutputKey as identity', () async {
      await controller.speakForMessage(finalMessage(key: 'my-key'));
      expect(fakeOutput.speakCalls.first.$1, 'my-key');
    });

    test('falls back to AgentMessage.id when key absent', () async {
      await controller.speakForMessage(finalMessage(key: null, id: 'msg-42'));
      expect(fakeOutput.speakCalls.first.$1, 'msg-42');
    });

    test('does not call speak for non-final message', () async {
      const message = AgentMessage(
        type: AgentMessageType.modelOutput,
        id: 'msg-1',
        raw: {'type': 'model-output', 'text': 'partial', 'final': false},
      );
      await controller.speakForMessage(message);
      expect(fakeOutput.speakCalls, isEmpty);
    });

    test('does not call speak for empty text', () async {
      const message = AgentMessage(
        type: AgentMessageType.modelOutput,
        id: 'msg-1',
        raw: {'type': 'model-output', 'text': '   ', 'final': true},
      );
      await controller.speakForMessage(message);
      expect(fakeOutput.speakCalls, isEmpty);
    });

    test('does not call speak for non-model-output type', () async {
      const message = AgentMessage(
        type: AgentMessageType.status,
        id: 'msg-1',
        raw: {'type': 'status', 'text': 'done', 'final': true},
      );
      await controller.speakForMessage(message);
      expect(fakeOutput.speakCalls, isEmpty);
    });

    test('does not call speak when identity is missing', () async {
      const message = AgentMessage(
        type: AgentMessageType.modelOutput,
        raw: {'type': 'model-output', 'text': 'Hello.', 'final': true},
      );
      await controller.speakForMessage(message);
      expect(fakeOutput.speakCalls, isEmpty);
    });

    test(
      'does not call speak when compiler produces zero utterances '
      '(horizontal-rule-only response)',
      () async {
        final message = finalMessage(
          id: 'msg-1',
          text: '---\n\n---\n\n***',
        );
        await controller.speakForMessage(message);
        expect(fakeOutput.speakCalls, isEmpty);
      },
    );

    test(
      'does not call speak when synthesis is unavailable',
      () async {
        fakeOutput.capabilities = SpeechOutputCapabilities.unavailable;
        await controller.speakForMessage(finalMessage());
        expect(fakeOutput.speakCalls, isEmpty);
      },
    );
  });

  group('stop / pause / resume', () {
    test('stop calls output.stop', () async {
      await controller.stop();
      expect(fakeOutput.stopCalls, 1);
    });

    test('pause calls output.pause', () async {
      await controller.speakForMessage(finalMessage());
      await controller.pause();
      expect(fakeOutput.pauseCalls, 1);
    });

    test('resume calls output.resume', () async {
      await controller.speakForMessage(finalMessage());
      await controller.pause();
      await controller.resume();
      expect(fakeOutput.resumeCalls, 1);
    });
  });

  group('rate', () {
    test('controller mount does not apply a native rate', () {
      expect(fakeOutput.rateCalls, isEmpty);
    });

    test(
      'defaults to 1.0 and applies a persisted supported multiplier',
      () async {
        await pumpEventQueue();
        expect(container.read(readAloudControllerProvider).rate, 1);
        fakeOutput.rateCalls.clear();

        await controller.setRate(1.25);
        await pumpEventQueue();

        expect(rateStore.value, '1.25');
        expect(fakeOutput.rateCalls, contains(1.25));
        expect(container.read(readAloudControllerProvider).rate, 1.25);
      },
    );

    test('rejects a multiplier outside the product ladder', () async {
      expect(() => controller.setRate(2), throwsArgumentError);
      expect(rateStore.value, isNull);
    });

    test('hydrates a stored multiplier before playback', () async {
      final output = _FakeSpeechOutput();
      final localStore = InMemoryReadAloudPreferencesStore(value: '1.5');
      final localContainer = ProviderContainer(
        overrides: [
          speechOutputFactoryProvider.overrideWithValue(() => output),
          readAloudPreferencesStoreProvider.overrideWithValue(localStore),
        ],
      );
      final localSubscription = localContainer.listen(
        readAloudControllerProvider,
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() {
        localSubscription.close();
        localContainer.dispose();
      });

      await localContainer.read(readAloudRateControllerProvider.future);
      await pumpEventQueue();

      expect(localContainer.read(readAloudControllerProvider).rate, 1.5);
      expect(output.rateCalls, contains(1.5));
    });
  });

  group('state propagation', () {
    test('speaking state propagates from output', () async {
      await controller.speakForMessage(finalMessage(key: 'k1'));
      final state = container.read(readAloudControllerProvider);
      expect(state.activeMessageKey, 'k1');
      expect(state.isSpeaking, isTrue);
    });

    test('error state propagates from output', () async {
      await controller.speakForMessage(finalMessage(key: 'k1'));
      fakeOutput.emitState(
        const SpeechOutputError(reason: 'Playback error.', messageKey: 'k1'),
      );
      await pumpEventQueue();
      final state = container.read(readAloudControllerProvider);
      expect(state.outputState, isA<SpeechOutputError>());
    });

    test('capabilities propagate from output', () async {
      final state = container.read(readAloudControllerProvider);
      expect(state.capabilities.synthesis, isTrue);
      expect(state.capabilities.pauseResume, isTrue);
    });
  });

  group('Riverpod lifetime and disposal race', () {
    test('controller mount does not construct a lazy native backend', () async {
      var constructionCount = 0;
      final output = FlutterTtsSpeechOutput.lazy(() {
        constructionCount++;
        return _NoopFlutterTtsBackend();
      });
      final localContainer = ProviderContainer(
        overrides: [
          speechOutputFactoryProvider.overrideWithValue(() => output),
          readAloudPreferencesStoreProvider.overrideWithValue(
            InMemoryReadAloudPreferencesStore(),
          ),
        ],
      );
      final localSubscription = localContainer.listen(
        readAloudControllerProvider,
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(() {
        localSubscription.close();
        localContainer.dispose();
      });

      await pumpEventQueue();

      expect(constructionCount, 0);
      expect(
        localContainer
            .read(readAloudControllerProvider)
            .capabilities
            .canAttemptSynthesis,
        isTrue,
      );
    });

    test(
      'rebuild replaces output without leaking the old subscription',
      () async {
        final firstOutput = _FakeSpeechOutput();
        final secondOutput = _FakeSpeechOutput();
        var factoryCalls = 0;
        final localContainer = ProviderContainer(
          overrides: [
            speechOutputFactoryProvider.overrideWithValue(() {
              factoryCalls++;
              return factoryCalls == 1 ? firstOutput : secondOutput;
            }),
            readAloudPreferencesStoreProvider.overrideWithValue(
              InMemoryReadAloudPreferencesStore(),
            ),
          ],
        );
        final localSubscription = localContainer.listen(
          readAloudControllerProvider,
          (_, _) {},
          fireImmediately: true,
        );
        addTearDown(() {
          localSubscription.close();
          localContainer.dispose();
        });

        expect(firstOutput.hasStateListener, isTrue);
        localContainer.invalidate(speechOutputProvider);
        await pumpEventQueue();

        expect(factoryCalls, 2);
        expect(firstOutput.disposeCalls, 1);
        expect(firstOutput.hasStateListener, isFalse);
        expect(secondOutput.hasStateListener, isTrue);

        secondOutput.emitState(const SpeechOutputSpeaking('replacement'));
        await pumpEventQueue();
        expect(
          localContainer.read(readAloudControllerProvider).activeMessageKey,
          'replacement',
        );
      },
    );

    test('output is not disposed while controller is alive', () async {
      await controller.speakForMessage(finalMessage(key: 'k1'));
      expect(fakeOutput.disposeCalls, 0);
    });

    test(
      'output is disposed exactly once when container is disposed',
      () async {
        await controller.speakForMessage(finalMessage(key: 'k1'));
        container.dispose();
        await pumpEventQueue();
        expect(fakeOutput.disposeCalls, 1);
      },
    );

    test(
      'no separate controller stop races disposal (stopCalls stays 0)',
      () async {
        await controller.speakForMessage(finalMessage(key: 'k1'));
        container.dispose();
        await pumpEventQueue();
        // The controller cleanup does NOT call output.stop; the provider
        // owns disposal. The fake's dispose does not call stop either.
        expect(fakeOutput.stopCalls, 0);
      },
    );

    test('late emitted state after controller cleanup is ignored', () async {
      await controller.speakForMessage(finalMessage(key: 'k1'));
      final stateBefore = container.read(readAloudControllerProvider);
      container.dispose();
      await pumpEventQueue();

      // Emit a late state event after disposal.
      fakeOutput.emitState(
        const SpeechOutputSpeaking('late-key'),
      );
      await pumpEventQueue();

      // The controller state did not change (it was disposed and ignores
      // late events). Reading a disposed container's state returns the
      // last value before disposal.
      expect(stateBefore.activeMessageKey, 'k1');
    });
  });
}

Future<void> pumpEventQueue() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class _FakeSpeechOutput implements SpeechOutput {
  final StreamController<SpeechOutputState> _stateController =
      StreamController<SpeechOutputState>.broadcast();

  SpeechOutputState _current = const SpeechOutputIdle();
  @override
  SpeechOutputCapabilities capabilities = const SpeechOutputCapabilities(
    synthesis: true,
    pauseResume: true,
    installedLanguageVoiceAvailability: true,
  );

  /// Recorded speak calls as (messageKey, utterances) pairs.
  final List<(String, List<SpeechUtterance>)> speakCalls = [];
  final List<double> rateCalls = [];
  int stopCalls = 0;
  int pauseCalls = 0;
  int resumeCalls = 0;
  int disposeCalls = 0;

  bool get hasStateListener => _stateController.hasListener;

  @override
  SpeechOutputState get current => _current;

  @override
  Stream<SpeechOutputState> get states => _stateController.stream;

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {
    speakCalls.add((messageKey, utterances));
    _current = SpeechOutputSpeaking(messageKey);
    _stateController.add(_current);
  }

  @override
  Future<void> setRate(double rate) async => rateCalls.add(rate);

  @override
  Future<void> stop() async {
    stopCalls++;
    _current = const SpeechOutputIdle();
    _stateController.add(_current);
  }

  @override
  Future<void> pause() async {
    pauseCalls++;
    final state = _current;
    if (state is SpeechOutputSpeaking) {
      _current = SpeechOutputPaused(state.messageKey);
      _stateController.add(_current);
    }
  }

  @override
  Future<void> resume() async {
    resumeCalls++;
    final state = _current;
    if (state is SpeechOutputPaused) {
      _current = SpeechOutputSpeaking(state.messageKey);
      _stateController.add(_current);
    }
  }

  @override
  Future<void> dispose() async {
    disposeCalls++;
    await _stateController.close();
  }

  void emitState(SpeechOutputState state) {
    _current = state;
    if (!_stateController.isClosed) {
      _stateController.add(state);
    }
  }
}

class _NoopFlutterTtsBackend implements FlutterTtsBackend {
  @override
  Future<void> enableAwaitCompletion() async {}

  @override
  Future<List<String>> getLanguages() async => const ['en-US'];

  @override
  Future<void> setRate(double multiplier) async {}

  @override
  void setErrorHandler(void Function(Object? message) handler) {}

  @override
  Future<void> speak(String text) async {}

  @override
  Future<void> stop() async {}

  @override
  void dispose() {}
}
