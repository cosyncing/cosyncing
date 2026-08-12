import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/features/voice/view/read_aloud_action.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';

void main() {
  group('ReadAloudAction visibility', () {
    testWidgets('shows action for eligible final model-output', (tester) async {
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsOneWidget);
    });

    testWidgets('hides the idle button when the host opts out', (tester) async {
      // The chat transcript passes showIdleAction: false — starting playback
      // lives in the per-message context menu there.
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        showIdleAction: false,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
      expect(find.byType(IconButton), findsNothing);
    });

    testWidgets('hides action for non-model-output type', (tester) async {
      await _pumpAction(
        tester,
        message: const AgentMessage(
          type: AgentMessageType.status,
          id: 'msg-1',
          raw: {'type': 'status', 'text': 'done', 'final': true},
        ),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
    });

    testWidgets('hides action for non-final model-output', (tester) async {
      await _pumpAction(
        tester,
        message: const AgentMessage(
          type: AgentMessageType.modelOutput,
          id: 'msg-1',
          raw: {'type': 'model-output', 'text': 'partial', 'final': false},
        ),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
    });

    testWidgets('hides action for empty text', (tester) async {
      await _pumpAction(
        tester,
        message: const AgentMessage(
          type: AgentMessageType.modelOutput,
          id: 'msg-1',
          raw: {'type': 'model-output', 'text': '  ', 'final': true},
        ),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
    });

    testWidgets('hides action when identity is missing', (tester) async {
      await _pumpAction(
        tester,
        message: const AgentMessage(
          type: AgentMessageType.modelOutput,
          raw: {'type': 'model-output', 'text': 'Hello.', 'final': true},
        ),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
    });

    testWidgets(
      'hides action when not newest for identity',
      (tester) async {
        await _pumpAction(
          tester,
          message: _finalMessage(key: 'turn-1', id: 'msg-1'),
          isNewestForIdentity: false,
        );

        expect(find.byTooltip('Read aloud'), findsNothing);
      },
    );
  });

  group('zero-height hidden state', () {
    testWidgets('hidden action renders zero height with no padding', (
      tester,
    ) async {
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: false,
      );

      final actionFinder = find.byType(ReadAloudAction);
      final size = tester.getSize(actionFinder);
      expect(size.height, 0);
      expect(size.width, 0);
      // No Padding widget rendered.
      expect(find.byType(Padding), findsNothing);
    });

    testWidgets('hidden for non-model-output renders zero height', (
      tester,
    ) async {
      await _pumpAction(
        tester,
        message: const AgentMessage(
          type: AgentMessageType.status,
          id: 'msg-1',
          raw: {'type': 'status', 'text': 'done'},
        ),
        isNewestForIdentity: true,
      );

      final size = tester.getSize(find.byType(ReadAloudAction));
      expect(size.height, 0);
    });

    testWidgets('hidden when synthesis unavailable renders zero height', (
      tester,
    ) async {
      final output = _FakeSpeechOutput()
        ..capabilities = SpeechOutputCapabilities.unavailable;
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      final size = tester.getSize(find.byType(ReadAloudAction));
      expect(size.height, 0);
      expect(find.byType(Padding), findsNothing);
    });
  });

  group('visible action has padding', () {
    testWidgets('visible action includes top padding', (tester) async {
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
      );

      // The ReadAloudAction wraps its content in a Padding(top: 8).
      final paddingFinder = find.ancestor(
        of: find.byTooltip('Read aloud'),
        matching: find.byType(Padding),
      );
      expect(paddingFinder, findsOneWidget);
      final padding = tester.widget<Padding>(paddingFinder);
      expect(padding.padding, const EdgeInsets.only(top: 8));
    });
  });

  group('identity fallback', () {
    testWidgets('shows action with id fallback when key absent', (
      tester,
    ) async {
      await _pumpAction(
        tester,
        message: _finalMessage(id: 'msg-42'),
        isNewestForIdentity: true,
      );

      expect(find.byTooltip('Read aloud'), findsOneWidget);
      expect(find.byKey(const ValueKey('read-aloud-msg-42')), findsOneWidget);
    });

    testWidgets('uses key over id when both present', (tester) async {
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-42'),
        isNewestForIdentity: true,
      );

      expect(find.byKey(const ValueKey('read-aloud-turn-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('read-aloud-msg-42')), findsNothing);
    });
  });

  group('no autoplay', () {
    testWidgets('pumping does not trigger playback', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      expect(output.speakCalls, isEmpty);
    });
  });

  group('tap interaction', () {
    testWidgets('tapping calls speakForMessage', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      await tester.tap(find.byTooltip('Read aloud'));
      await tester.pumpAndSettle();

      expect(output.speakCalls, hasLength(1));
      expect(output.speakCalls.first.$1, 'turn-1');
    });

    testWidgets('shows pause and stop while speaking', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      await tester.tap(find.byTooltip('Read aloud'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Pause'), findsOneWidget);
      expect(find.byTooltip('Stop'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('read-aloud-stop-turn-1')),
        findsOneWidget,
      );
    });

    testWidgets('pause then resume shows correct controls', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      await tester.tap(find.byTooltip('Read aloud'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Pause'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Resume'), findsOneWidget);
      expect(find.byTooltip('Stop'), findsOneWidget);

      await tester.tap(find.byTooltip('Resume'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Pause'), findsOneWidget);
    });

    testWidgets('stop returns to speaker icon', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      await tester.tap(find.byTooltip('Read aloud'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Stop'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Read aloud'), findsOneWidget);
      expect(find.byTooltip('Stop'), findsNothing);
    });
  });

  group('capability gating', () {
    testWidgets('shows action while synthesis is unprobed', (tester) async {
      final output = _FakeSpeechOutput()
        ..capabilities = const SpeechOutputCapabilities.unprobed();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      expect(find.byTooltip('Read aloud'), findsOneWidget);
    });

    testWidgets('hides action when synthesis unavailable', (tester) async {
      final output = _FakeSpeechOutput()
        ..capabilities = SpeechOutputCapabilities.unavailable;
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      expect(find.byTooltip('Read aloud'), findsNothing);
    });

    testWidgets('hides pause when pauseResume unavailable', (tester) async {
      final output = _FakeSpeechOutput()
        ..capabilities = const SpeechOutputCapabilities(
          synthesis: true,
          pauseResume: false,
          installedLanguageVoiceAvailability: true,
        );
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      await tester.tap(find.byTooltip('Read aloud'));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Pause'), findsNothing);
      expect(find.byTooltip('Stop'), findsOneWidget);
    });
  });

  group('scoped error state', () {
    testWidgets('shows both retry and Stop in error state', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      // Trigger an error state for this message.
      output.emitState(
        const SpeechOutputError(
          reason: 'Playback error.',
          messageKey: 'turn-1',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byTooltip('Retry read aloud'), findsOneWidget);
      expect(find.byTooltip('Stop'), findsOneWidget);
    });

    testWidgets('tapping Stop in error state calls output.stop', (
      tester,
    ) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      output.emitState(
        const SpeechOutputError(
          reason: 'Playback error.',
          messageKey: 'turn-1',
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Stop'));
      await tester.pumpAndSettle();

      expect(output.stopCalls, 1);
    });

    testWidgets('stable keys present in error state', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      output.emitState(
        const SpeechOutputError(
          reason: 'Playback error.',
          messageKey: 'turn-1',
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('read-aloud-turn-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('read-aloud-stop-turn-1')),
        findsOneWidget,
      );
    });

    testWidgets('error row does not overflow', (tester) async {
      final output = _FakeSpeechOutput();
      await _pumpAction(
        tester,
        message: _finalMessage(key: 'turn-1', id: 'msg-1'),
        isNewestForIdentity: true,
        output: output,
      );

      output.emitState(
        const SpeechOutputError(
          reason: 'Playback error.',
          messageKey: 'turn-1',
        ),
      );
      await tester.pumpAndSettle();

      // No overflow errors thrown by the framework.
      expect(tester.takeException(), isNull);
    });
  });
}

AgentMessage _finalMessage({String? key, String? id}) {
  return AgentMessage(
    type: AgentMessageType.modelOutput,
    id: id,
    raw: {
      'type': 'model-output',
      'text': 'Hello world.',
      'final': true,
      if (key != null) 'key': key,
    },
  );
}

Future<void> _pumpAction(
  WidgetTester tester, {
  required AgentMessage message,
  required bool isNewestForIdentity,
  _FakeSpeechOutput? output,
  bool showIdleAction = true,
}) async {
  output ??= _FakeSpeechOutput();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        speechOutputProvider.overrideWithValue(output),
        readAloudPreferencesStoreProvider.overrideWithValue(
          InMemoryReadAloudPreferencesStore(),
        ),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: ReadAloudAction(
            message: message,
            isNewestForIdentity: isNewestForIdentity,
            showIdleAction: showIdleAction,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
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

  final List<(String, List<SpeechUtterance>)> speakCalls = [];
  final List<double> rateCalls = [];
  int stopCalls = 0;
  int pauseCalls = 0;
  int resumeCalls = 0;

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
    await _stateController.close();
  }

  void emitState(SpeechOutputState state) {
    _current = state;
    if (!_stateController.isClosed) {
      _stateController.add(state);
    }
  }
}
