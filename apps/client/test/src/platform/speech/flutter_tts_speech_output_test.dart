import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/flutter_tts_backend.dart';
import 'package:cosyncing_client/src/platform/speech/flutter_tts_speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _FakeBackend backend;
  late FlutterTtsSpeechOutput output;

  setUp(() async {
    backend = _FakeBackend();
    output = FlutterTtsSpeechOutput(backend);
    await output.initialize();
    await pumpEventQueue();
  });

  group('ordered chunk playback', () {
    test('speaks utterances in order', () async {
      await output.speak(
        messageKey: 'm1',
        utterances: const [
          SpeechUtterance('one'),
          SpeechUtterance('two'),
          SpeechUtterance('three'),
        ],
      );
      await backend.completeAllSpeaks();
      await pumpEventQueue();

      expect(backend.spokenTexts, ['one', 'two', 'three']);
      expect(output.current, isA<SpeechOutputIdle>());
    });

    test('transitions through speaking then idle on completion', () async {
      final states = <SpeechOutputState>[];
      final sub = output.states.listen(states.add);

      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      await backend.completeAllSpeaks();
      await pumpEventQueue();
      await sub.cancel();

      expect(states, contains(isA<SpeechOutputSpeaking>()));
      expect(states.last, isA<SpeechOutputIdle>());
    });
  });

  group('stop', () {
    test('stop returns to idle and cancels remaining queue', () async {
      await output.speak(
        messageKey: 'm1',
        utterances: const [
          SpeechUtterance('one'),
          SpeechUtterance('two'),
          SpeechUtterance('three'),
        ],
      );
      // 'one' is speaking (blocked on completer). Call stop before
      // it completes so the queue never advances to 'two'.
      await output.stop();
      await pumpEventQueue();

      expect(output.current, isA<SpeechOutputIdle>());
      expect(backend.spokenTexts, ['one']);
    });

    test('stop failure emits scoped error instead of claiming idle', () async {
      backend.stopException = Exception('stop channel crash');
      await output.stop();
      await pumpEventQueue();

      final current = output.current;
      expect(current, isA<SpeechOutputError>());
      expect((current as SpeechOutputError).reason, 'Playback error.');
      expect(current.reason, isNot(contains('channel')));
    });
  });

  group('replacement / race cancellation', () {
    test('starting a new message cancels the prior queue', () async {
      await output.speak(
        messageKey: 'A',
        utterances: const [
          SpeechUtterance('a1'),
          SpeechUtterance('a2'),
          SpeechUtterance('a3'),
        ],
      );
      // a1 is speaking; don't complete it yet.
      await pumpEventQueue();

      await output.speak(
        messageKey: 'B',
        utterances: const [SpeechUtterance('b1')],
      );
      await backend.completeAllSpeaks();
      await pumpEventQueue();

      // a1 was started then cancelled by B's stop; b1 was spoken.
      expect(backend.spokenTexts, contains('a1'));
      expect(backend.spokenTexts, contains('b1'));
      expect(backend.spokenTexts, isNot(contains('a2')));
      expect(backend.spokenTexts, isNot(contains('a3')));

      final current = output.current;
      if (current is SpeechOutputSpeaking) {
        expect(current.messageKey, 'B');
      } else {
        expect(current, isA<SpeechOutputIdle>());
      }
    });

    test('ignores an error callback retained by a superseded queue', () async {
      await output.speak(
        messageKey: 'A',
        utterances: const [SpeechUtterance('a1')],
      );
      final staleErrorHandler = backend.errorHandler;

      await output.speak(
        messageKey: 'B',
        utterances: const [SpeechUtterance('b1')],
      );
      staleErrorHandler?.call('late error from A');
      await pumpEventQueue();

      final current = output.current;
      expect(current, isA<SpeechOutputSpeaking>());
      expect((current as SpeechOutputSpeaking).messageKey, 'B');

      await backend.completeAllSpeaks();
      await pumpEventQueue();
    });
  });

  group('error handling', () {
    test('error handler produces a sanitized error state', () async {
      backend.nextError = 'java.lang.UnsatisfiedLinkError: libtts.so';

      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      await backend.completeAllSpeaks();
      await pumpEventQueue();

      final current = output.current;
      expect(current, isA<SpeechOutputError>());
      final error = current as SpeechOutputError;
      expect(error.reason, 'Playback error.');
      expect(error.reason, isNot(contains('java')));
      expect(error.messageKey, 'm1');
    });

    test(
      'speak exception becomes sanitized error, not raw exception',
      () async {
        backend.speakException = Exception('platform channel crash');

        await output.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await pumpEventQueue();

        final current = output.current;
        expect(current, isA<SpeechOutputError>());
        expect((current as SpeechOutputError).reason, 'Playback error.');
      },
    );

    test(
      'non-string error payload (Map) produces sanitized error with no raw '
      'content',
      () async {
        backend.nextErrorPayload = <String, dynamic>{
          'code': 500,
          'secret': 'super-secret-api-key',
        };

        await output.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await backend.completeAllSpeaks();
        await pumpEventQueue();

        final current = output.current;
        expect(current, isA<SpeechOutputError>());
        final error = current as SpeechOutputError;
        expect(error.reason, 'Playback error.');
        expect(error.reason, isNot(contains('secret')));
        expect(error.reason, isNot(contains('api-key')));
        expect(error.reason, isNot(contains('500')));
      },
    );

    test(
      'Exception error payload produces sanitized error with no raw content',
      () async {
        backend.nextErrorPayload = StateError(
          'internal plugin failure details',
        );

        await output.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await backend.completeAllSpeaks();
        await pumpEventQueue();

        final current = output.current;
        expect(current, isA<SpeechOutputError>());
        final error = current as SpeechOutputError;
        expect(error.reason, 'Playback error.');
        expect(error.reason, isNot(contains('internal')));
        expect(error.reason, isNot(contains('StateError')));
      },
    );
  });

  group('pre-playback stop failure', () {
    test(
      'backend.speak not invoked after pre-stop failure; scoped error emitted',
      () async {
        backend.stopException = Exception('stop failed before speak');

        await output.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await pumpEventQueue();

        // backend.speak was never called.
        expect(backend.spokenTexts, isEmpty);
        // A scoped error was emitted.
        final current = output.current;
        expect(current, isA<SpeechOutputError>());
        final error = current as SpeechOutputError;
        expect(error.messageKey, 'm1');
        expect(error.reason, 'Playback error.');
        // Raw exception text not exposed.
        expect(error.reason, isNot(contains('stop failed')));
      },
    );
  });

  group('capabilities', () {
    test('reports unavailable when no languages', () async {
      final bareBackend = _FakeBackend()..languages = const [];
      final bareOutput = FlutterTtsSpeechOutput(bareBackend);
      await bareOutput.initialize();
      await pumpEventQueue();

      expect(bareOutput.capabilities.synthesis, isFalse);
      expect(bareOutput.capabilities.pauseResume, isFalse);
    });

    test('reports synthesis and voices when languages present', () async {
      expect(output.capabilities.synthesis, isTrue);
      expect(
        output.capabilities.installedLanguageVoiceAvailability,
        isTrue,
      );
    });

    test(
      'pauseResume is always false (flutter_tts has pause but no resume)',
      () {
        expect(output.capabilities.pauseResume, isFalse);
      },
    );
  });

  group('pause and resume are honest no-ops', () {
    test('pause does not transition to paused state', () async {
      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      await pumpEventQueue();

      await output.pause();
      // Still speaking, not paused.
      expect(output.current, isA<SpeechOutputSpeaking>());
    });

    test('resume does not transition state', () async {
      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      await pumpEventQueue();

      await output.resume();
      expect(output.current, isA<SpeechOutputSpeaking>());
    });

    test('pause is a no-op when idle', () async {
      await output.pause();
      expect(output.current, isA<SpeechOutputIdle>());
    });
  });

  group('nonempty input', () {
    test('speak asserts on empty utterance list', () {
      expect(
        () => output.speak(messageKey: 'm1', utterances: const []),
        throwsA(isA<AssertionError>()),
      );
    });
  });

  group('speak must initialize and honor capabilities', () {
    test(
      'direct speak triggers initialization exactly once',
      () async {
        final directBackend = _FakeBackend();
        final directOutput = FlutterTtsSpeechOutput(directBackend);
        // Do NOT call initialize() first.
        await directOutput.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await directBackend.completeAllSpeaks();
        await pumpEventQueue();

        // Initialization ran: getLanguages was called exactly once.
        expect(directBackend.getLanguagesCallCount, 1);
        // Capabilities are now set.
        expect(directOutput.capabilities.synthesis, isTrue);
        // Speak proceeded.
        expect(directBackend.spokenTexts, ['hello']);
      },
    );

    test(
      'unavailable synthesis never invokes backend speak',
      () async {
        final noLangBackend = _FakeBackend()..languages = const [];
        final noLangOutput = FlutterTtsSpeechOutput(noLangBackend);
        await noLangOutput.initialize();
        await pumpEventQueue();

        expect(noLangOutput.capabilities.synthesis, isFalse);

        await noLangOutput.speak(
          messageKey: 'm1',
          utterances: const [SpeechUtterance('hello')],
        );
        await pumpEventQueue();

        expect(noLangBackend.spokenTexts, isEmpty);
      },
    );
  });

  group('initialization race-safety', () {
    test('initialize is idempotent', () async {
      await output.initialize();
      await output.initialize();
      // No crash, capabilities still correct.
      expect(output.capabilities.synthesis, isTrue);
      // getLanguages called only once across all init calls.
      expect(backend.getLanguagesCallCount, 1);
    });

    test('init failure reports unavailable with no uncaught error', () async {
      final failBackend = _FakeBackend()
        ..enableAwaitCompletionException = Exception('init crash');
      final failOutput = FlutterTtsSpeechOutput(failBackend);
      await failOutput.initialize();
      await pumpEventQueue();

      expect(failOutput.capabilities.synthesis, isFalse);
      expect(failOutput.capabilities.pauseResume, isFalse);
    });

    test('getLanguages failure reports unavailable', () async {
      final failBackend = _FakeBackend()
        ..languagesException = Exception('languages crash');
      final failOutput = FlutterTtsSpeechOutput(failBackend);
      await failOutput.initialize();
      await pumpEventQueue();

      expect(failOutput.capabilities.synthesis, isFalse);
    });

    test(
      'dispose before delayed init: no getLanguages, no handler, no emissions',
      () async {
        final slowBackend = _FakeBackend()
          ..languagesDelay = const Duration(milliseconds: 50);
        final slowOutput = FlutterTtsSpeechOutput(slowBackend);
        final states = <SpeechOutputState>[];
        final sub = slowOutput.states.listen(states.add);

        unawaited(slowOutput.initialize()); // fire-and-forget
        await slowOutput.dispose(); // dispose before init reaches getLanguages
        await pumpEventQueue();
        await sub.cancel();

        // getLanguages was never called (dispose happened before it).
        expect(slowBackend.getLanguagesCallCount, 0);
        // Error handler was never registered (dispose happened before it).
        expect(slowBackend.errorHandler, isNull);
        // No states emitted after disposal.
        expect(states, isEmpty);
      },
    );

    test(
      'dispose during getLanguages: no state emissions after disposal',
      () async {
        final slowBackend = _FakeBackend()
          ..languagesDelay = const Duration(milliseconds: 50);
        final slowOutput = FlutterTtsSpeechOutput(slowBackend);
        final states = <SpeechOutputState>[];
        final sub = slowOutput.states.listen(states.add);

        unawaited(slowOutput.initialize());
        // Let init progress past enableAwaitCompletion + setErrorHandler
        // so it reaches the getLanguages await.
        await Future<void>.delayed(Duration.zero);
        await slowOutput.dispose();
        // Wait for the delayed getLanguages to complete.
        await Future<void>.delayed(const Duration(milliseconds: 100));
        await sub.cancel();

        // No states emitted after disposal.
        expect(states, isEmpty);
        // getLanguages was called (init progressed past it) but no state
        // was emitted because _disposed was true when it resumed.
        expect(slowBackend.getLanguagesCallCount, 1);
      },
    );

    test('double dispose is safe', () async {
      await output.dispose();
      await output.dispose();
      // No exception.
    });

    test('stop after dispose does not invoke backend again', () async {
      await output.dispose();
      // dispose itself calls backend.stop; capture the count after that.
      final stopCountAfterDispose = backend.stopCallCount;
      await output.stop();
      // backend.stop was not called again by the post-dispose stop().
      expect(backend.stopCallCount, stopCountAfterDispose);
    });

    test('no states emitted after disposal', () async {
      final states = <SpeechOutputState>[];
      final sub = output.states.listen(states.add);

      await output.dispose();
      await pumpEventQueue();
      states.clear();

      // Attempting to speak after dispose should not emit.
      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      await pumpEventQueue();
      await sub.cancel();

      expect(states, isEmpty);
    });

    test('stale error handler after dispose does not emit', () async {
      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hello')],
      );
      final capturedHandler = backend.errorHandler;
      expect(capturedHandler, isNotNull);
      await output.dispose();
      capturedHandler?.call('late error');
      await pumpEventQueue();
      // No crash, no state change.
    });
  });
}

Future<void> pumpEventQueue() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class _FakeBackend implements FlutterTtsBackend {
  final List<String> spokenTexts = [];
  List<String> languages = ['en-US'];
  Duration languagesDelay = Duration.zero;
  Exception? enableAwaitCompletionException;
  Exception? languagesException;
  Exception? speakException;
  Exception? stopException;
  void Function(Object?)? errorHandler;
  String? nextError;
  Object? nextErrorPayload;
  int getLanguagesCallCount = 0;
  Completer<void>? _speakCompleter;

  @override
  Future<void> enableAwaitCompletion() async {
    if (enableAwaitCompletionException != null) {
      throw enableAwaitCompletionException!;
    }
  }

  @override
  Future<void> speak(String text) async {
    spokenTexts.add(text);
    if (speakException != null) {
      final ex = speakException!;
      speakException = null;
      throw ex;
    }
    _speakCompleter = Completer<void>();
    await _speakCompleter!.future;
    final error = nextError;
    if (error != null) {
      nextError = null;
      errorHandler?.call(error);
    }
    final payload = nextErrorPayload;
    if (payload != null) {
      nextErrorPayload = null;
      errorHandler?.call(payload);
    }
  }

  int stopCallCount = 0;

  @override
  Future<void> stop() async {
    stopCallCount++;
    if (stopException != null) {
      final ex = stopException!;
      stopException = null;
      throw ex;
    }
    final c = _speakCompleter;
    _speakCompleter = null;
    if (c != null && !c.isCompleted) {
      c.complete();
    }
  }

  @override
  void setErrorHandler(void Function(Object? message) handler) {
    errorHandler = handler;
  }

  @override
  Future<List<String>> getLanguages() async {
    getLanguagesCallCount++;
    if (languagesDelay > Duration.zero) {
      await Future<void>.delayed(languagesDelay);
    }
    if (languagesException != null) {
      throw languagesException!;
    }
    return languages;
  }

  @override
  void dispose() {}

  void completeCurrentSpeak() {
    final c = _speakCompleter;
    if (c != null && !c.isCompleted) {
      c.complete();
    }
  }

  Future<void> completeAllSpeaks() async {
    for (var i = 0; i < 10; i++) {
      completeCurrentSpeak();
      await Future<void>.delayed(Duration.zero);
    }
  }
}
