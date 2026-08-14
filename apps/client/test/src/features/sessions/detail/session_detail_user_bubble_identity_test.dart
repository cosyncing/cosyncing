import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// C1R rendered proof: the user bubble keeps ONE element identity and ONE
/// on-screen position across optimistic → delivered, even when the answer
/// rendered before the echo arrived.
void main() {
  group('SessionDetailPage user bubble identity', () {
    testWidgets(
      'the bubble neither remounts nor drops below its answer when the echo '
      'arrives after the answer',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        const prompt = 'Where is my bubble';
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          prompt,
        );
        await tester.pump();
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-detail-send-button')),
            )
            .onPressed!();
        await tester.pumpAndSettle();
        expect(connection.sendPromptCount, 1);
        expect(find.text(prompt), findsOneWidget);
        final optimisticElement = tester.element(find.text(prompt));

        // The answer streams in before the user echo.
        connection.emitEvent(
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson(const {
              'type': 'model-output',
              'key': 'answer-1',
              'text': 'Right above me',
              'final': true,
            }),
          ),
        );
        await tester.pumpAndSettle();
        final answerFinder = find.textContaining(
          'Right above me',
          findRichText: true,
        );
        expect(answerFinder, findsOneWidget);
        expect(
          tester.getTopLeft(find.text(prompt)).dy,
          lessThan(tester.getTopLeft(answerFinder).dy),
          reason: 'the streamed answer must not overtake the prompt',
        );

        // The delayed echo adopts the row IN PLACE: same element (no remount,
        // no scroll jump), same position relative to the answer.
        final clientMessageId = connection.lastPromptClientMessageId!;
        connection.emitEvent(
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'user-message',
              'key': 'native-echo-1',
              'clientKey': clientMessageId,
              'text': prompt,
            }),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text(prompt), findsOneWidget);
        expect(
          tester.element(find.text(prompt)),
          same(optimisticElement),
          reason: 'echo adoption must be an in-place update, not a remount',
        );
        expect(
          tester.getTopLeft(find.text(prompt)).dy,
          lessThan(tester.getTopLeft(answerFinder).dy),
        );
      },
    );

    testWidgets(
      'two identical prompts render as two distinctly keyed bubbles',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        const prompt = 'again please';
        for (var send = 0; send < 2; send++) {
          await tester.enterText(
            find.byKey(const Key('session-detail-prompt-input')),
            prompt,
          );
          await tester.pump();
          tester
              .widget<IconButton>(
                find.byKey(const Key('session-detail-send-button')),
              )
              .onPressed!();
          await tester.pumpAndSettle();
        }

        expect(connection.sendPromptCount, 2);
        expect(
          find.text(prompt),
          findsNWidgets(2),
          reason: 'equal text is never identity — no global dedupe',
        );
      },
    );
  });
}
