import 'dart:async';

import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_backend.dart';
import 'package:cosyncing_client/src/platform/speech/speech_to_text_speech_input.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _FakeBackend backend;
  late SpeechToTextSpeechInput input;

  setUp(() {
    backend = _FakeBackend();
    input = SpeechToTextSpeechInput(
      backend,
      onDeviceCapable: true,
      finalizationTimeout: const Duration(milliseconds: 20),
    );
  });

  tearDown(() async {
    await input.dispose();
  });

  group('runtime initialization options', () {
    test('Android web enables webDoNotAggregate', () {
      final options = speechBackendOptionsForRuntime(
        isWeb: true,
        isAndroid: true,
      );

      expect(
        options,
        contains(BackendInitializationOption.webDoNotAggregate),
      );
      expect(
        options,
        contains(BackendInitializationOption.androidNoBluetooth),
      );
    });

    test('native Android omits webDoNotAggregate', () {
      final options = speechBackendOptionsForRuntime(
        isWeb: false,
        isAndroid: true,
      );

      expect(
        options,
        isNot(contains(BackendInitializationOption.webDoNotAggregate)),
      );
    });

    test('other web and native runtimes omit webDoNotAggregate', () {
      for (final isWeb in [false, true]) {
        final options = speechBackendOptionsForRuntime(
          isWeb: isWeb,
          isAndroid: false,
        );
        expect(
          options,
          isNot(contains(BackendInitializationOption.webDoNotAggregate)),
        );
      }
    });

    test('adapter forwards selected options during permission init', () async {
      const selected = {
        BackendInitializationOption.androidNoBluetooth,
        BackendInitializationOption.webDoNotAggregate,
      };
      final configuredInput = SpeechToTextSpeechInput(
        backend,
        onDeviceCapable: false,
        initializationOptions: selected,
      );

      await configuredInput.requestPermission();

      expect(backend.lastInitializationOptions, selected);
      await configuredInput.dispose();
    });
  });

  group('capabilities', () {
    test('does not claim sound-level events before a real callback', () {
      final caps = input.capabilities;
      expect(caps.recognition, isTrue);
      expect(caps.onDeviceRecognition, isTrue);
      expect(caps.soundLevelEvents, isFalse);
    });

    test('becomes unavailable after failed init', () async {
      backend.initResult = false;
      await input.requestPermission();
      await pumpEventQueue();
      expect(input.capabilities, SpeechInputCapabilities.unavailable);
    });

    test('onDeviceCapable false reports onDeviceRecognition false', () {
      final offlineInput = SpeechToTextSpeechInput(
        _FakeBackend(),
        onDeviceCapable: false,
      );
      expect(offlineInput.capabilities.onDeviceRecognition, isFalse);
    });
  });

  group('initialization and permission', () {
    test(
      'initialize is called only once across multiple requestPermission',
      () async {
        await input.requestPermission();
        await pumpEventQueue();
        await input.requestPermission();
        await pumpEventQueue();
        expect(backend.initCallCount, 1);
      },
    );

    test('permission only requested from explicit requestPermission', () async {
      expect(backend.initCallCount, 0);
      await input.requestPermission();
      expect(backend.initCallCount, 1);
    });

    test('init exception becomes unavailable, no crash', () async {
      backend.initException = Exception('plugin failure');
      await input.requestPermission();
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputUnavailable>());
      expect(input.capabilities, SpeechInputCapabilities.unavailable);
    });

    test('init returning false becomes unavailable', () async {
      backend.initResult = false;
      await input.requestPermission();
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputUnavailable>());
    });

    test('permission callback during init cannot be overwritten', () async {
      backend.errorDuringInit = const BackendSpeechError(
        code: 'error_permission',
        permanent: true,
      );
      await input.requestPermission();
      expect(input.current, isA<SpeechInputUnavailable>());
      expect(input.capabilities, SpeechInputCapabilities.unavailable);
    });

    test(
      'requestPermission transitions through requestingPermission',
      () async {
        final states = <SpeechInputState>[];
        final sub = input.states.listen(states.add);
        await input.requestPermission();
        await pumpEventQueue();
        await sub.cancel();
        expect(states, contains(isA<SpeechInputRequestingPermission>()));
        expect(states.last, isA<SpeechInputIdle>());
      },
    );
  });

  group('start and policy mapping', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
    });

    test('onDeviceOnly maps to onDevice:true in backend options', () async {
      await input.start(policy: SpeechRecognitionPolicy.onDeviceOnly);
      await pumpEventQueue();
      expect(backend.lastOptions?.onDevice, isTrue);
      expect(backend.lastOptions?.partialResults, isTrue);
    });

    test('platformServiceAllowed maps to onDevice:false', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      expect(backend.lastOptions?.onDevice, isFalse);
    });

    test('onDeviceOnly rejected when onDeviceCapable is false', () async {
      final offlineInput = SpeechToTextSpeechInput(
        _FakeBackend()..initResult = true,
        onDeviceCapable: false,
      );
      await offlineInput.requestPermission();
      await pumpEventQueue();
      await offlineInput.start(policy: SpeechRecognitionPolicy.onDeviceOnly);
      await pumpEventQueue();
      expect(offlineInput.current, isA<SpeechInputError>());
      await offlineInput.dispose();
    });

    test('listen exception becomes sanitized error', () async {
      backend.listenException = Exception('listen failed');
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputError>());
      final error = input.current as SpeechInputError;
      expect(error.reason, isNot(contains('listen failed')));
    });

    test('start without permission emits unavailable', () async {
      final freshInput = SpeechToTextSpeechInput(
        _FakeBackend(),
        onDeviceCapable: true,
      );
      await freshInput.start(
        policy: SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await pumpEventQueue();
      expect(freshInput.current, isA<SpeechInputUnavailable>());
      await freshInput.dispose();
    });
  });

  group('partial and final results', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
    });

    test('partial results update partialTranscript while listening', () async {
      backend.deliverPartial('hello');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputListening>());
      expect(
        (input.current as SpeechInputListening).partialTranscript,
        'hello',
      );
    });

    test('final result while listening transitions to ready', () async {
      backend.deliverPartial('hello');
      await pumpEventQueue();
      backend.deliverFinal('hello world');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'hello world');
    });

    test('partial then final preserves order', () async {
      backend.deliverPartial('foo');
      await pumpEventQueue();
      backend.deliverPartial('foo bar');
      await pumpEventQueue();
      backend.deliverFinal('foo bar baz');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'foo bar baz');
    });

    test('cumulative partial hypotheses replace rather than append', () async {
      backend.deliverPartial('repeat');
      await pumpEventQueue();
      backend.deliverPartial('repeat repeat');
      await pumpEventQueue();

      expect(
        (input.current as SpeechInputListening).partialTranscript,
        'repeat repeat',
      );
    });

    test('duplicate final callbacks emit one ready transition', () async {
      final ready = <SpeechInputReady>[];
      final sub = input.states
          .where((state) => state is SpeechInputReady)
          .cast<SpeechInputReady>()
          .listen(ready.add);

      backend.deliverFinal('repeat repeat');
      await pumpEventQueue();
      backend.deliverFinal('repeat repeat');
      await pumpEventQueue();

      expect(ready, hasLength(1));
      expect(ready.single.transcript, 'repeat repeat');
      await sub.cancel();
    });

    test('empty final result returns to idle', () async {
      backend.deliverFinal('');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputIdle>());
    });
  });

  group('stop', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
    });

    test(
      'stop transitions to processing then ready on final callback',
      () async {
        final states = <SpeechInputState>[];
        final sub = input.states.listen(states.add);
        await input.stop();
        await pumpEventQueue();
        backend.deliverFinal('final text');
        await pumpEventQueue();
        await sub.cancel();
        expect(states, contains(isA<SpeechInputProcessing>()));
        expect(input.current, isA<SpeechInputReady>());
        expect((input.current as SpeechInputReady).transcript, 'final text');
      },
    );

    test('stop before final callback produces exactly one ready', () async {
      await input.stop();
      await pumpEventQueue();
      backend.deliverFinal('text one');
      await pumpEventQueue();
      backend.deliverFinal('text two');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'text one');
    });

    test('stop after final callback does not duplicate', () async {
      backend.deliverFinal('already final');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      await input.stop();
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'already final');
    });

    test('stop timeout uses latest partial when no final arrives', () async {
      backend.deliverPartial('partial text');
      await pumpEventQueue();
      await input.stop();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputReady>());
      expect((input.current as SpeechInputReady).transcript, 'partial text');
    });

    test('final after stop timeout cannot emit a second ready', () async {
      final ready = <SpeechInputReady>[];
      final sub = input.states
          .where((state) => state is SpeechInputReady)
          .cast<SpeechInputReady>()
          .listen(ready.add);
      backend.deliverPartial('timeout text');
      await pumpEventQueue();
      await input.stop();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      backend.deliverFinal('late final text');
      await pumpEventQueue();

      expect(ready, hasLength(1));
      expect(ready.single.transcript, 'timeout text');
      await sub.cancel();
    });

    test('stop exception is contained', () async {
      backend.stopException = Exception('stop failed');
      await input.stop();
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(input.current, isA<SpeechInputIdle>());
    });
  });

  group('cancel', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
    });

    test('cancel discards all text and returns to idle', () async {
      backend.deliverPartial('some text');
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('cancel exception is contained', () async {
      backend.cancelException = Exception('cancel failed');
      await input.cancel();
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('cancel ignores late final callback', () async {
      backend.deliverPartial('text');
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();
      backend.deliverFinal('late final');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputIdle>());
    });
  });

  group('stale generation', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
    });

    test('stale partial after cancel does not mutate newer session', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverPartial('old session');
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();

      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverPartial('old session', session: 0);
      await pumpEventQueue();
      expect(
        (input.current as SpeechInputListening).partialTranscript,
        isEmpty,
      );
      backend.deliverPartial('new session', session: 1);
      await pumpEventQueue();
      expect(
        (input.current as SpeechInputListening).partialTranscript,
        'new session',
      );
    });

    test('stale final after cancel is ignored', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();
      backend.deliverFinal('stale final');
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('cancel restart ignores stale final and accepts new final', () async {
      final ready = <SpeechInputReady>[];
      final sub = input.states
          .where((state) => state is SpeechInputReady)
          .cast<SpeechInputReady>()
          .listen(ready.add);
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();

      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend
        ..deliverFinal('stale final', session: 0)
        ..deliverFinal('new final', session: 1);
      await pumpEventQueue();

      expect(ready, hasLength(1));
      expect(ready.single.transcript, 'new final');
      await sub.cancel();
    });

    test('two consecutive dictations each become ready exactly once', () async {
      final ready = <SpeechInputReady>[];
      final sub = input.states
          .where((state) => state is SpeechInputReady)
          .cast<SpeechInputReady>()
          .listen(ready.add);

      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      backend.deliverFinal('first dictation');
      await pumpEventQueue();
      expect(input.consumeReady(), 'first dictation');

      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      backend
        ..deliverFinal('second dictation')
        ..deliverFinal('second dictation');
      await pumpEventQueue();

      expect(
        ready.map((state) => state.transcript),
        ['first dictation', 'second dictation'],
      );
      await sub.cancel();
    });

    test(
      'cancel drains stale status and error before restart begins',
      () async {
        backend.cancelCompleter = Completer<void>();
        await input.start(
          policy: SpeechRecognitionPolicy.platformServiceAllowed,
        );
        await pumpEventQueue();

        final cancel = input.cancel();
        final restart = input.start(
          policy: SpeechRecognitionPolicy.platformServiceAllowed,
        );
        await pumpEventQueue();

        expect(backend.listenCallCount, 1);
        backend
          ..deliverStatus('done')
          ..deliverError('error_network');
        await pumpEventQueue();
        expect(input.current, isA<SpeechInputIdle>());

        backend.cancelCompleter!.complete();
        await cancel;
        await restart;
        expect(backend.listenCallCount, 2);
        expect(input.current, isA<SpeechInputListening>());

        backend
          ..deliverStatus('listening')
          ..deliverFinal('new session', session: 1);
        await pumpEventQueue();
        expect(
          (input.current as SpeechInputReady).transcript,
          'new session',
        );
      },
    );

    test('restart preserves a current retryable startup error', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await input.cancel();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);

      backend.deliverError('error_network');
      await pumpEventQueue();

      final state = input.current as SpeechInputError;
      expect(state.kind, SpeechInputFailureKind.network);
    });

    test(
      'delayed cancel completion cannot overwrite restarted state',
      () async {
        backend.cancelCompleter = Completer<void>();
        await input.start(
          policy: SpeechRecognitionPolicy.platformServiceAllowed,
        );
        await pumpEventQueue();

        final cancel = input.cancel();
        final restart = input.start(
          policy: SpeechRecognitionPolicy.platformServiceAllowed,
        );
        await pumpEventQueue();
        expect(backend.listenCallCount, 1);

        backend.cancelCompleter!.complete();
        await cancel;
        await restart;

        expect(backend.listenCallCount, 2);
        expect(input.current, isA<SpeechInputListening>());
      },
    );

    test('concurrent cancels coalesce before restart', () async {
      backend.cancelCompleter = Completer<void>();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();

      final firstCancel = input.cancel();
      final secondCancel = input.cancel();
      final restart = input.start(
        policy: SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await pumpEventQueue();

      expect(backend.cancelCallCount, 1);
      expect(backend.listenCallCount, 1);

      backend.cancelCompleter!.complete();
      await Future.wait([firstCancel, secondCancel, restart]);

      expect(backend.cancelCallCount, 1);
      expect(backend.listenCallCount, 2);
      expect(input.current, isA<SpeechInputListening>());
    });

    test('hard permission error during cancel remains unavailable', () async {
      backend.cancelCompleter = Completer<void>();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();

      final cancel = input.cancel();
      backend.deliverError('error_permission', permanent: true);
      await pumpEventQueue();

      expect(input.current, isA<SpeechInputUnavailable>());
      expect(input.capabilities, SpeechInputCapabilities.unavailable);
      backend.cancelCompleter!.complete();
      await cancel;
    });
  });

  group('sound level normalization', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
    });

    test('normalized levels are finite and within 0..1', () async {
      backend
        ..deliverSoundLevel(-45)
        ..deliverSoundLevel(-10)
        ..deliverSoundLevel(-30);
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputListening>());
      final level = (input.current as SpeechInputListening).soundLevel;
      expect(level, isNotNull);
      expect(level! >= 0.0 && level <= 1.0, isTrue);
      expect(level.isFinite, isTrue);
    });

    test('single level value normalizes to 0.5', () async {
      backend.deliverSoundLevel(-20);
      await pumpEventQueue();
      final level = (input.current as SpeechInputListening).soundLevel;
      expect(level, 0.5);
      expect(input.capabilities.soundLevelEvents, isTrue);
    });

    test('non-finite level is ignored', () async {
      backend
        ..deliverSoundLevel(double.nan)
        ..deliverSoundLevel(double.infinity);
      await pumpEventQueue();
      final level = (input.current as SpeechInputListening).soundLevel;
      expect(level, isNull);
    });

    test('no fabricated events when no callbacks arrive', () async {
      await pumpEventQueue();
      final level = (input.current as SpeechInputListening).soundLevel;
      expect(level, isNull);
    });

    test('level resets between sessions', () async {
      backend
        ..deliverSoundLevel(-40)
        ..deliverSoundLevel(-10);
      await pumpEventQueue();
      await input.cancel();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      final level = (input.current as SpeechInputListening).soundLevel;
      expect(level, isNull);
    });
  });

  group('consumeReady', () {
    test('returns transcript and transitions to idle', () async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverFinal('consume me');
      await pumpEventQueue();
      final transcript = input.consumeReady();
      expect(transcript, 'consume me');
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('returns null when not in ready state', () {
      expect(input.consumeReady(), isNull);
    });
  });

  group('backend errors and status', () {
    setUp(() async {
      await input.requestPermission();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
    });

    test(
      'permission error becomes unavailable without exposing raw details',
      () {
        backend.deliverError('error_permission', permanent: true);
        expect(input.current, isA<SpeechInputUnavailable>());
        expect(input.capabilities, SpeechInputCapabilities.unavailable);
      },
    );

    test('network error becomes a sanitized retryable error', () {
      backend.deliverError('error_network_secret_detail');
      final state = input.current as SpeechInputError;
      expect(state.reason, contains('platform service'));
      expect(state.reason, isNot(contains('secret')));
    });

    test('restart waits for held cleanup after a backend error', () async {
      backend
        ..cancelCompleter = Completer<void>()
        ..deliverError('error_network');
      expect(input.current, isA<SpeechInputError>());
      expect(backend.cancelCallCount, 1);

      final restart = input.start(
        policy: SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await pumpEventQueue();

      expect(backend.listenCallCount, 1);
      backend.cancelCompleter!.complete();
      await restart;

      expect(backend.cancelCallCount, 1);
      expect(backend.listenCallCount, 2);
      expect(input.current, isA<SpeechInputListening>());
    });

    test('done status preserves bounded partial fallback after stop', () async {
      backend.deliverPartial('status fallback');
      await input.stop();
      backend.deliverStatus('done');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect((input.current as SpeechInputReady).transcript, 'status fallback');
    });

    test('automatic done status cannot leave listening stuck', () async {
      backend
        ..deliverPartial('automatic fallback')
        ..deliverStatus('done');
      expect(input.current, isA<SpeechInputProcessing>());
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(
        (input.current as SpeechInputReady).transcript,
        'automatic fallback',
      );
    });
  });

  group('V0 start guard and failure classification', () {
    setUp(() async {
      await input.requestPermission();
      await pumpEventQueue();
    });

    test('a start while already listening is ignored', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      expect(input.current, isA<SpeechInputListening>());
      expect(backend.listenCallCount, 1);

      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      // Guarded: no second recognizer is spawned.
      expect(backend.listenCallCount, 1);
      expect(input.current, isA<SpeechInputListening>());
    });

    test('an InvalidStateError start recreates the recognizer', () async {
      backend.listenException = Exception('InvalidStateError: already started');
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      final state = input.current as SpeechInputError;
      expect(state.kind, SpeechInputFailureKind.alreadyActive);
      expect(state.detail, contains('InvalidStateError'));
      // The stale recognizer was cancelled so the next tap starts clean.
      expect(backend.cancelCallCount, greaterThanOrEqualTo(1));
    });

    test('restart waits for held cleanup after InvalidStateError', () async {
      backend
        ..listenException = Exception('InvalidStateError: already started')
        ..cancelCompleter = Completer<void>();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      expect(input.current, isA<SpeechInputError>());
      expect(backend.cancelCallCount, 1);

      backend.listenException = null;
      final restart = input.start(
        policy: SpeechRecognitionPolicy.platformServiceAllowed,
      );
      await pumpEventQueue();

      expect(backend.listenCallCount, 1);
      backend.cancelCompleter!.complete();
      await restart;

      expect(backend.cancelCallCount, 1);
      expect(backend.listenCallCount, 2);
      expect(input.current, isA<SpeechInputListening>());
    });

    test('a NotAllowedError start classifies permission denial', () async {
      backend.listenException = Exception('NotAllowedError: user denied');
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      final state = input.current as SpeechInputError;
      expect(state.kind, SpeechInputFailureKind.permissionDenied);
    });

    test('audio-capture async error becomes unavailable no-device', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverError('audio-capture', permanent: true);
      final state = input.current as SpeechInputUnavailable;
      expect(state.kind, SpeechInputFailureKind.noCaptureDevice);
      expect(state.detail, 'audio-capture');
    });

    test('permanent service-not-allowed becomes unavailable service', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverError('service-not-allowed', permanent: true);
      final state = input.current as SpeechInputUnavailable;
      expect(state.kind, SpeechInputFailureKind.serviceUnavailable);
    });

    test('no-match async error stays a retryable typed error', () async {
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      backend.deliverError('error_no_match');
      final state = input.current as SpeechInputError;
      expect(state.kind, SpeechInputFailureKind.noSpeech);
    });
  });

  group('dispose', () {
    test('dispose is idempotent', () async {
      await input.dispose();
      await input.dispose();
    });

    test('dispose during listening cancels and closes stream', () async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      await input.dispose();
      expect(input.states, emitsDone);
    });

    test('no state emissions after disposal', () async {
      await input.requestPermission();
      await pumpEventQueue();
      await input.start(policy: SpeechRecognitionPolicy.platformServiceAllowed);
      await pumpEventQueue();
      await input.dispose();
      backend.deliverFinal('late');
      await pumpEventQueue();
      // No crash, no state change
      expect(input.current, isA<SpeechInputIdle>());
    });

    test('dispose before delayed init completes is safe', () async {
      backend.initDelay = const Duration(milliseconds: 100);
      final future = input.requestPermission();
      await input.dispose();
      await future;
      // No StateError, no crash
    });
  });
}

/// Fake backend for testing [SpeechToTextSpeechInput].
class _FakeBackend implements SpeechToTextBackend {
  bool initResult = true;
  Exception? initException;
  Exception? listenException;
  Exception? stopException;
  Exception? cancelException;
  Duration? initDelay;
  Duration? stopDuration;
  Completer<void>? cancelCompleter;
  BackendSpeechError? errorDuringInit;

  int initCallCount = 0;
  int listenCallCount = 0;
  int cancelCallCount = 0;
  BackendListenOptions? lastOptions;
  Set<BackendInitializationOption>? lastInitializationOptions;
  bool _isListening = false;

  void Function(BackendRecognitionResult)? _onResult;
  void Function(double)? _onSoundLevel;
  void Function(BackendSpeechError)? _onError;
  void Function(String)? _onStatus;
  final List<void Function(BackendRecognitionResult)> _resultCallbacks = [];

  void deliverPartial(String text, {int? session}) {
    final callback = session == null ? _onResult : _resultCallbacks[session];
    callback?.call(
      BackendRecognitionResult(recognizedWords: text, isFinal: false),
    );
  }

  void deliverFinal(String text, {int? session}) {
    final callback = session == null ? _onResult : _resultCallbacks[session];
    callback?.call(
      BackendRecognitionResult(recognizedWords: text, isFinal: true),
    );
  }

  void deliverSoundLevel(double level) {
    _onSoundLevel?.call(level);
  }

  void deliverError(String code, {bool permanent = false}) {
    _onError?.call(BackendSpeechError(code: code, permanent: permanent));
  }

  void deliverStatus(String status) {
    _onStatus?.call(status);
  }

  @override
  Future<bool> initialize({
    required void Function(BackendSpeechError error) onError,
    required void Function(String status) onStatus,
    Set<BackendInitializationOption> options = const {
      BackendInitializationOption.androidNoBluetooth,
    },
  }) async {
    initCallCount++;
    lastInitializationOptions = options;
    _onError = onError;
    _onStatus = onStatus;
    if (initDelay != null) {
      await Future<void>.delayed(initDelay!);
    }
    if (initException != null) {
      throw initException!;
    }
    final initError = errorDuringInit;
    if (initError != null) onError(initError);
    return initResult;
  }

  @override
  Future<void> listen({
    required void Function(BackendRecognitionResult) onResult,
    required BackendListenOptions options,
    void Function(double level)? onSoundLevelChange,
  }) async {
    listenCallCount++;
    if (listenException != null) {
      throw listenException!;
    }
    _onResult = onResult;
    _onSoundLevel = onSoundLevelChange;
    lastOptions = options;
    _resultCallbacks.add(onResult);
    _isListening = true;
  }

  @override
  Future<void> stop() async {
    if (stopDuration != null) {
      await Future<void>.delayed(stopDuration!);
    }
    if (stopException != null) {
      throw stopException!;
    }
    _isListening = false;
  }

  @override
  Future<void> cancel() async {
    cancelCallCount++;
    await cancelCompleter?.future;
    if (cancelException != null) {
      throw cancelException!;
    }
    _isListening = false;
    _onResult = null;
    _onSoundLevel = null;
  }

  @override
  bool get isListening => _isListening;

  @override
  void dispose() {}
}
