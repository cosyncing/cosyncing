import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A question card says "Awaiting answer" only while somebody still owes the
/// answer. A settled card is drawn read-only too, and used to carry the hint
/// above its own "Settled in your terminal or another app.".
const _locales = ['en', 'zh', 'ja', 'ko', 'es'];

MessageWireEvent _question(
  int seq,
  String requestId, {
  required bool readOnly,
}) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    type: AgentMessageType.questionRequest,
    raw: {
      'type': 'question-request',
      'requestId': requestId,
      if (readOnly) 'readOnly': true,
      'questions': [
        {
          'question': 'Which colour?',
          'options': [
            {'label': 'Amber'},
            {'label': 'Teal'},
          ],
        },
      ],
    },
  ),
);

MessageWireEvent _resolved(int seq, String requestId) => MessageWireEvent(
  seq: seq,
  message: AgentMessage(
    type: AgentMessageType.questionResolved,
    raw: {'type': 'question-resolved', 'requestId': requestId},
  ),
);

Future<void> _pump(
  WidgetTester tester,
  List<WireEvent> events,
  String locale,
) async {
  final connection = ScriptedSessionDetailConnection(events: events);
  await tester.pumpWidget(
    buildSessionDetailTestPage(
      events: const [],
      connection: connection,
      locale: Locale(locale),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final locale in _locales) {
    final l10n = lookupAppLocalizations(Locale(locale));

    testWidgets(
      'a question still open in the terminal keeps "Awaiting answer" ($locale)',
      (tester) async {
        await _pump(tester, [
          _question(1, 'toolu_open', readOnly: true),
        ], locale);
        expect(
          find.textContaining(l10n.sessionRequestAwaitingAnswer),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a settled read-only question says it is settled, and not that it '
      'awaits an answer ($locale)',
      (tester) async {
        await _pump(tester, [
          _question(1, 'toolu_settled', readOnly: true),
          _resolved(2, 'toolu_settled'),
        ], locale);
        expect(
          find.text(l10n.sessionQuestionSettledElsewhere),
          findsOneWidget,
        );
        expect(
          find.textContaining(l10n.sessionRequestAwaitingAnswer),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a question answered from this app is drawn settled with no '
      '"Awaiting answer" ($locale)',
      (tester) async {
        await _pump(tester, [
          _question(1, 'toolu_answered', readOnly: false),
          _resolved(2, 'toolu_answered'),
        ], locale);
        expect(
          find.byKey(
            const Key('session-detail-question-outcome-toolu_answered'),
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining(l10n.sessionRequestAwaitingAnswer),
          findsNothing,
        );
      },
    );
  }
}
