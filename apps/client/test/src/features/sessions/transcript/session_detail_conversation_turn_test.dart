import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

MessageWireEvent _user(int seq, String key, String text) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    type: AgentMessageType.userMessage,
    raw: {'type': 'user-message', 'key': key, 'text': text},
  ),
);

MessageWireEvent _model(int seq, String key, String text) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    id: 'model-$key',
    type: AgentMessageType.modelOutput,
    raw: {'type': 'model-output', 'key': key, 'text': text, 'final': true},
  ),
);

MessageWireEvent _runSummary(
  int seq, {
  required String assistantMessageKey,
  required String status,
  int? totalRuntimeMs,
  int? completedAt,
  Map<String, dynamic>? tokens,
}) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    type: AgentMessageType.runSummary,
    raw: {
      'type': 'run-summary',
      'key': 'rs-$assistantMessageKey',
      'turnId': 'turn-$assistantMessageKey',
      'assistantMessageKey': assistantMessageKey,
      'status': status,
      if (totalRuntimeMs != null) 'totalRuntimeMs': totalRuntimeMs,
      if (completedAt != null) 'completedAt': completedAt,
      if (tokens != null) 'tokens': tokens,
    },
  ),
);

MessageWireEvent _sentArtifact(
  int seq, {
  required String name,
  required String mimeType,
  required String url,
  String? userMessageKey,
}) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    type: AgentMessageType.fileArtifact,
    raw: {
      'type': 'file-artifact',
      'artifactKey': 'artifact-$name',
      'name': name,
      'mimeType': mimeType,
      'url': url,
      if (userMessageKey != null) 'userMessageKey': userMessageKey,
    },
  ),
);

void main() {
  // P6. End-to-end wiring: the projection nests the artifact and the transcript
  // hands it to the bubble instead of building a standalone artifact row.
  group('user attachments in the live transcript', () {
    testWidgets('renders a sent image inside its own user bubble', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'What is in this?'),
            _sentArtifact(
              2,
              name: 'screenshot.png',
              mimeType: 'image/png',
              url:
                  'data:image/png;base64,'
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42'
                  'mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              userMessageKey: 'u1',
            ),
            _model(3, 'a1', 'A single pixel'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('user-attachment-0')), findsOneWidget);
      // The artifact no longer has its own agent-side card.
      expect(find.byType(Card), findsNothing);
    });

    testWidgets('leaves an agent-produced artifact as its own row', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'Write the report'),
            _model(2, 'a1', 'Done'),
            _sentArtifact(
              3,
              name: 'report.pdf',
              mimeType: 'application/pdf',
              url: 'https://broker.example/artifacts/report.pdf',
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('user-attachment-0')), findsNothing);
      expect(find.text('report.pdf'), findsOneWidget);
    });
  });

  group('conversation turn footer', () {
    testWidgets('shows one footer with runtime, copy, and telemetry actions', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final speechOutput = RecordingSpeechOutput();
      addTearDown(speechOutput.close);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          speechOutput: speechOutput,
          events: [
            _user(1, 'u1', 'Do it'),
            _model(2, 'a1', 'First part'),
            _model(3, 'a2', 'Second part'),
            _runSummary(
              4,
              assistantMessageKey: 'a2',
              status: 'done',
              totalRuntimeMs: 4200,
              completedAt: DateTime(2026, 7, 23, 10, 15).millisecondsSinceEpoch,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('conversation-turn-telemetry')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('conversation-turn-copy')), findsOneWidget);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('conversation-turn-runtime-line')),
        findsOneWidget,
      );
      expect(find.textContaining('Ran for'), findsOneWidget);
      expect(find.textContaining('Finished at'), findsOneWidget);
      // Status and run-summary frames never reach Chat as rows.
      expect(find.text('Run summary'), findsNothing);
    });

    testWidgets('copy targets the full model-output aggregate', (tester) async {
      useRoomyTestViewport(tester);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            final args = call.arguments;
            if (args is Map<Object?, Object?>) copied = args['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'Do it'),
            _model(2, 'a1', 'First part'),
            _model(3, 'a2', 'Second part'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('conversation-turn-copy')));
      await tester.pumpAndSettle();
      expect(copied, 'First part\n\nSecond part');
    });

    testWidgets('read aloud speaks the turn aggregate under a stable key', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final speechOutput = RecordingSpeechOutput();
      addTearDown(speechOutput.close);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          speechOutput: speechOutput,
          events: [
            _user(1, 'u1', 'Do it'),
            _model(2, 'a1', 'First part'),
            _model(3, 'a2', 'Second part'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      expect(speechOutput.spokenMessageKeys, ['turn:user:u1']);
    });

    testWidgets(
      'read aloud continues when its virtualized footer scrolls away',
      (
        tester,
      ) async {
        useRoomyTestViewport(tester);
        final speechOutput = RecordingSpeechOutput();
        addTearDown(speechOutput.close);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            speechOutput: speechOutput,
            events: [
              for (var i = 0; i < 80; i++) ...[
                _user(i * 2 + 1, 'u$i', 'Question $i'),
                _model(i * 2 + 2, 'a$i', 'Answer $i'),
              ],
            ],
          ),
        );
        await tester.pumpAndSettle();

        final lastFooter = find.byKey(
          const Key('turn-footer-turn:user:u79'),
        );
        await tester.tap(
          find.descendant(
            of: lastFooter,
            matching: find.byKey(
              const Key('conversation-turn-read-aloud'),
            ),
          ),
        );
        await tester.pump();
        expect(speechOutput.current, isA<SpeechOutputSpeaking>());

        tester
            .widget<ListView>(
              find.byKey(const Key('session-detail-chat-scroll')),
            )
            .controller!
            .jumpTo(0);
        await tester.pumpAndSettle();

        expect(lastFooter, findsNothing);
        expect(speechOutput.disposeCallCount, 0);
        expect(speechOutput.current, isA<SpeechOutputSpeaking>());
      },
    );

    testWidgets('turn telemetry dialog shows attributable values', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'Do it'),
            const MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.toolCall,
                raw: {
                  'type': 'tool-call',
                  'callId': 'c1',
                  'toolClass': 'execute',
                },
              ),
            ),
            _model(3, 'a1', 'Done'),
            _runSummary(
              4,
              assistantMessageKey: 'a1',
              status: 'done',
              totalRuntimeMs: 3000,
              tokens: {'input': 100, 'output': 50},
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('conversation-turn-telemetry')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('conversation-turn-telemetry-dialog')),
        findsOneWidget,
      );
      expect(find.text('Completed'), findsOneWidget);
      expect(find.text('Status'), findsOneWidget);
      expect(find.text('Input'), findsOneWidget);
      expect(find.text('100'), findsOneWidget);
      expect(find.text('Output'), findsOneWidget);
      expect(find.text('50'), findsOneWidget);
      expect(find.text('Tokens'), findsNothing);
      expect(find.text('Tool calls'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('Completed'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      // One distinct tool call in this turn.
      expect(find.text('1'), findsWidgets);
    });

    testWidgets('a turn with only a running summary shows no runtime line', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'Do it'),
            _model(2, 'a1', 'Working on it'),
            _runSummary(3, assistantMessageKey: 'a1', status: 'running'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // The footer still exists (model output present) but shows no runtime.
      expect(find.byKey(const Key('conversation-turn-copy')), findsOneWidget);
      expect(
        find.byKey(const Key('conversation-turn-runtime-line')),
        findsNothing,
      );
    });

    testWidgets('a queued prompt renders the clean bubble, not the old card', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'First'),
            _model(2, 'a1', 'Working on it'),
            const MessageWireEvent(
              seq: 3,
              message: AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {
                  'type': 'user-message',
                  'key': 'u2',
                  'text': 'Queued next',
                  'queued': true,
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // The queued prompt goes through the clean bubble: no `User message`
      // header, and the localized queued badge is present.
      expect(find.text('User message'), findsNothing);
      expect(find.text('Queued next'), findsWidgets);
      expect(
        find.byKey(const Key('queued-user-message-badge')),
        findsWidgets,
      );
    });

    testWidgets(
      'a broker-shortened body renders a localized note, never broker prose',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              _user(1, 'u1', 'First'),
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  id: 'model-a1',
                  type: AgentMessageType.modelOutput,
                  raw: {
                    'type': 'model-output',
                    'key': 'a1',
                    'text': 'Beginning of a very large answer',
                    'final': true,
                    'bodyTruncated': true,
                  },
                ),
              ),
              const MessageWireEvent(
                seq: 3,
                message: AgentMessage(
                  type: AgentMessageType.userMessage,
                  raw: {
                    'type': 'user-message',
                    'key': 'u2',
                    'text': 'Beginning of a very large prompt',
                    'bodyTruncated': true,
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        // The body still renders, and the shortening is stated in the app's own
        // localized copy. The broker sends a flag, never a sentence.
        expect(find.text('Beginning of a very large answer'), findsWidgets);
        expect(
          find.byKey(const Key('model-output-body-truncated')),
          findsWidgets,
        );
        expect(
          find.byKey(const Key('user-message-body-truncated')),
          findsWidgets,
        );
        expect(find.text('Shortened to fit the history window.'), findsWidgets);
        expect(find.textContaining('truncated by cosyncing'), findsNothing);
      },
    );

    testWidgets(
      'a shortened thinking row shows the localized note once expanded',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              _user(1, 'u1', 'First'),
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  id: 'thinking-r1',
                  type: AgentMessageType.thinking,
                  raw: {
                    'type': 'thinking',
                    'key': 'r1',
                    'text': 'Beginning of a very long reasoning trace',
                    'bodyTruncated': true,
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        // The row is collapsed by default, so the body and its note are both
        // behind the expander.
        expect(find.byKey(const Key('thinking-body-truncated')), findsNothing);

        await tester.tap(find.byKey(const Key('conversation-thinking-toggle')));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('thinking-body-truncated')),
          findsWidgets,
        );
        expect(find.text('Shortened to fit the history window.'), findsWidgets);
        expect(find.textContaining('truncated by cosyncing'), findsNothing);
      },
    );

    testWidgets('an untruncated body carries no shortening note', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [_user(1, 'u1', 'First'), _model(2, 'a1', 'Complete answer')],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Complete answer'), findsWidgets);
      expect(
        find.byKey(const Key('model-output-body-truncated')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('user-message-body-truncated')),
        findsNothing,
      );
    });

    testWidgets('telemetry with nothing attributable shows only the note', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [_user(1, 'u1', 'Hi'), _model(2, 'a1', 'Hello')],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('conversation-turn-telemetry')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('conversation-turn-telemetry-empty')),
        findsOneWidget,
      );
      // No contradictory `Tool calls: 0` row alongside the empty note.
      expect(find.text('Tool calls'), findsNothing);
    });

    IconData readAloudIcon(WidgetTester tester, {Finder? within}) {
      final button = within == null
          ? find.byKey(const Key('conversation-turn-read-aloud'))
          : find.descendant(
              of: within,
              matching: find.byKey(const Key('conversation-turn-read-aloud')),
            );
      return (tester.widget<IconButton>(button).icon as Icon).icon!;
    }

    Future<void> pumpSingleTurn(
      WidgetTester tester,
      RecordingSpeechOutput speech,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          speechOutput: speech,
          events: [_user(1, 'u1', 'Do it'), _model(2, 'a1', 'Answer')],
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('read-aloud cycles play → pause → resume with a Stop', (
      tester,
    ) async {
      final speech = RecordingSpeechOutput();
      addTearDown(speech.close);
      await pumpSingleTurn(tester, speech);

      expect(readAloudIcon(tester), Icons.volume_up_outlined);
      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      // Speaking → pause primary + a Stop.
      expect(readAloudIcon(tester), Icons.pause_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      expect(readAloudIcon(tester), Icons.play_arrow_outlined); // resume

      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      expect(readAloudIcon(tester), Icons.pause_outlined); // speaking again
    });

    testWidgets('active read-aloud offers only the four truthful rates', (
      tester,
    ) async {
      final speech = RecordingSpeechOutput();
      addTearDown(speech.close);
      await pumpSingleTurn(tester, speech);

      final rateMenu = find.byKey(
        const Key('conversation-turn-read-aloud-rate'),
      );
      expect(rateMenu, findsNothing);
      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();

      expect(rateMenu, findsOneWidget);
      expect(find.text('1.0×'), findsOneWidget);
      await tester.tap(rateMenu);
      await tester.pumpAndSettle();
      for (final label in const ['0.75×', '1.0×', '1.25×', '1.5×']) {
        expect(find.text(label), findsWidgets);
      }
      await tester.tap(find.text('1.5×').last);
      await tester.pumpAndSettle();

      expect(speech.rateCalls, contains(1.5));
      expect(find.text('1.5×'), findsOneWidget);
      expect(find.byType(Slider), findsNothing);
    });

    testWidgets('Stop returns the footer to idle play', (tester) async {
      final speech = RecordingSpeechOutput();
      addTearDown(speech.close);
      await pumpSingleTurn(tester, speech);
      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
      );
      await tester.pumpAndSettle();
      expect(readAloudIcon(tester), Icons.volume_up_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsNothing,
      );
    });

    testWidgets('an error offers retry, which speaks again', (tester) async {
      final speech = RecordingSpeechOutput();
      addTearDown(speech.close);
      await pumpSingleTurn(tester, speech);
      speech.emitError(reason: 'boom', messageKey: 'turn:user:u1');
      await tester.pumpAndSettle();
      expect(readAloudIcon(tester), Icons.refresh);
      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      expect(speech.spokenMessageKeys, ['turn:user:u1']);
    });

    testWidgets('without pause/resume support, speaking shows Stop only', (
      tester,
    ) async {
      final speech = RecordingSpeechOutput(supportsPauseResume: false);
      addTearDown(speech.close);
      await pumpSingleTurn(tester, speech);
      await tester.tap(find.byKey(const Key('conversation-turn-read-aloud')));
      await tester.pumpAndSettle();
      // The primary itself stops; no separate stop button.
      expect(readAloudIcon(tester), Icons.stop_circle_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsNothing,
      );
    });

    testWidgets('another turn speaking leaves this turn at play', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final speech = RecordingSpeechOutput();
      addTearDown(speech.close);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          speechOutput: speech,
          events: [
            _user(1, 'u1', 'First'),
            _model(2, 'a1', 'First answer'),
            _user(3, 'u2', 'Second'),
            _model(4, 'a2', 'Second answer'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      final turn2Footer = find.byKey(const Key('turn-footer-turn:user:u2'));
      // Speak turn 1 by scoping to its footer.
      await tester.tap(
        find.descendant(
          of: find.byKey(const Key('turn-footer-turn:user:u1')),
          matching: find.byKey(const Key('conversation-turn-read-aloud')),
        ),
      );
      await tester.pumpAndSettle();
      // Turn 2's footer stays at play.
      expect(
        readAloudIcon(tester, within: turn2Footer),
        Icons.volume_up_outlined,
      );
    });

    testWidgets('cancelled status renders in the telemetry inspector', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            _user(1, 'u1', 'Do it'),
            _model(2, 'a1', 'Partial answer'),
            _runSummary(
              3,
              assistantMessageKey: 'a1',
              status: 'cancelled',
              totalRuntimeMs: 500,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('conversation-turn-telemetry')));
      await tester.pumpAndSettle();
      expect(find.text('Cancelled'), findsOneWidget);
    });
  });
}
