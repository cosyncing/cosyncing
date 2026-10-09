import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A question the app was drawn answerable can move to the agent's own picker:
/// the person at the terminal chose it there. The broker then draws the same
/// card again, read-only and open in the terminal. From that moment the card
/// offers nothing to send and says where to answer, and the answer given there
/// settles it.
const _id = 'toolu_in_terminal';

const Map<String, Object> _colour = {
  'question': 'Which colour?',
  'header': 'Colour',
  'multiple': false,
  'options': [
    {'label': 'Amber'},
    {'label': 'Teal'},
  ],
};

/// The card as the broker first draws it. A held mod card carries no
/// `blocking`; a nonblocking card is one whose authority this client learns
/// from the live event itself.
AgentMessage _answerable({required bool nonblocking}) => AgentMessage(
  type: AgentMessageType.questionRequest,
  raw: {
    'type': 'question-request',
    'requestId': _id,
    if (nonblocking) 'blocking': false,
    'questions': [_colour],
  },
);

/// The same card, restated: read-only, open in the terminal.
const _inTerminal = AgentMessage(
  type: AgentMessageType.questionRequest,
  raw: {
    'type': 'question-request',
    'requestId': _id,
    'readOnly': true,
    'answerInTerminal': true,
    'questions': [_colour],
  },
);

const _answered = AgentMessage(
  type: AgentMessageType.questionResolved,
  raw: {
    'type': 'question-resolved',
    'requestId': _id,
    'answers': [
      ['Teal'],
    ],
  },
);

Finder _option(int option) =>
    find.byKey(Key('session-detail-question-option-$_id-0-$option'));

FilterChip _chip(WidgetTester tester, int option) =>
    tester.widget<FilterChip>(_option(option));

Finder get _answerButton =>
    find.byKey(const Key('session-detail-question-answer-button-$_id'));

Finder get _waitingInTerminal =>
    find.byKey(const Key('session-detail-question-in-terminal-$_id'));

Finder get _outcome =>
    find.byKey(const Key('session-detail-question-outcome-$_id'));

void main() {
  final l10n = lookupAppLocalizations(const Locale('en'));

  for (final nonblocking in [false, true]) {
    final kind = nonblocking ? 'a nonblocking card' : 'a held card';

    testWidgets('$kind restated as open in the terminal is read-only and says '
        'to answer there, then settles with the answer given there', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          MessageWireEvent(
            seq: 1,
            message: _answerable(nonblocking: nonblocking),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      expect(_chip(tester, 1).onSelected, isNotNull);
      expect(_answerButton, findsOneWidget);

      connection.emitEvent(
        const MessageWireEvent(seq: 2, message: _inTerminal),
      );
      await tester.pumpAndSettle();
      expect(_chip(tester, 1).onSelected, isNull);
      expect(_answerButton, findsNothing);
      expect(
        find.descendant(
          of: _waitingInTerminal,
          matching: find.text(l10n.sessionQuestionAnswerInTerminal),
          matchRoot: true,
        ),
        findsOneWidget,
      );

      connection.emitEvent(const MessageWireEvent(seq: 3, message: _answered));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _outcome,
          matching: find.text(l10n.sessionRequestSettledInTerminal),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(_chip(tester, 1).selected, isTrue);
      expect(_chip(tester, 0).selected, isFalse);
      expect(_chip(tester, 1).onSelected, isNull);
    });

    testWidgets('$kind: a history reset while the picker is open keeps the '
        'card read-only and open in the terminal', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          MessageWireEvent(
            seq: 1,
            message: _answerable(nonblocking: nonblocking),
          ),
          const MessageWireEvent(seq: 2, message: _inTerminal),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      // What a resync sends: the transcript's copy of the question, then the
      // card the session is still waiting on.
      connection
        ..emitEvent(
          const HistoryWireEvent(
            messages: [_inTerminal],
            reset: true,
            cursor: 'reset',
          ),
        )
        ..emitEvent(const MessageWireEvent(seq: 3, message: _inTerminal));
      await tester.pumpAndSettle();
      expect(_chip(tester, 1).onSelected, isNull);
      expect(_answerButton, findsNothing);
      expect(_waitingInTerminal, findsOneWidget);
    });

    testWidgets('$kind: a history reset after the answer keeps the card '
        'settled in the terminal, with the pick checked', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          MessageWireEvent(
            seq: 1,
            message: _answerable(nonblocking: nonblocking),
          ),
          const MessageWireEvent(seq: 2, message: _inTerminal),
          const MessageWireEvent(seq: 3, message: _answered),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      connection.emitEvent(
        const HistoryWireEvent(
          messages: [_inTerminal, _answered],
          reset: true,
          cursor: 'reset',
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _outcome,
          matching: find.text(l10n.sessionRequestSettledInTerminal),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(_chip(tester, 1).selected, isTrue);
      expect(_chip(tester, 1).onSelected, isNull);
    });
  }
}
