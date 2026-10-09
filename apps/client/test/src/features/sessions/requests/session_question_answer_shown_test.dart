import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A settled question card shows the answer it closed with: the options picked
/// checked, and anything typed as text. Every seat shows it, the one that sent
/// it included, and a reload shows it again.
const _id = 'toolu_answer_shown';

const Map<String, Object> _colour = {
  'question': 'Which colour?',
  'header': 'Colour',
  'multiple': false,
  'options': [
    {'label': 'Amber'},
    {'label': 'Teal'},
  ],
};

const Map<String, Object> _checks = {
  'question': 'Which checks?',
  'header': 'Checks',
  'multiple': true,
  'options': [
    {'label': 'Lint'},
    {'label': 'Small, cheap'},
    {'label': 'Types'},
  ],
};

AgentMessage _question(
  List<Map<String, Object>> questions, {
  bool readOnly = false,
}) => AgentMessage(
  type: AgentMessageType.questionRequest,
  raw: {
    'type': 'question-request',
    'requestId': _id,
    if (readOnly) 'readOnly': true,
    'questions': questions,
  },
);

AgentMessage _resolved(List<List<String>>? answers) => AgentMessage(
  type: AgentMessageType.questionResolved,
  raw: {
    'type': 'question-resolved',
    'requestId': _id,
    'answers': ?answers,
  },
);

Finder _option(int question, int option) =>
    find.byKey(Key('session-detail-question-option-$_id-$question-$option'));

FilterChip _chip(WidgetTester tester, int question, int option) =>
    tester.widget<FilterChip>(_option(question, option));

Finder _typed(int question) =>
    find.byKey(Key('session-detail-question-typed-$_id-$question'));

Future<ScriptedSessionDetailConnection> _pump(
  WidgetTester tester,
  List<WireEvent> events,
) async {
  final connection = ScriptedSessionDetailConnection(events: events);
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: connection),
  );
  await tester.pumpAndSettle();
  return connection;
}

void main() {
  testWidgets('answered from this app: the card it sent from shows the pick, '
      'checked and disabled', (tester) async {
    final connection = await _pump(tester, [
      MessageWireEvent(seq: 1, message: _question([_colour])),
    ]);
    _chip(tester, 0, 1).onSelected!(true);
    await tester.pump();
    tester
        .widget<FilledButton>(
          find.byKey(const Key('session-detail-question-answer-button-$_id')),
        )
        .onPressed!();
    await tester.pumpAndSettle();
    expect(connection.lastQuestionAnswers, const [
      ['Teal'],
    ]);

    connection.emitEvent(
      MessageWireEvent(
        seq: 2,
        message: _resolved(const [
          ['Teal'],
        ]),
      ),
    );
    await tester.pumpAndSettle();
    expect(_chip(tester, 0, 1).selected, isTrue);
    expect(_chip(tester, 0, 0).selected, isFalse);
    expect(_chip(tester, 0, 1).onSelected, isNull);
    expect(_typed(0), findsNothing);
  });

  testWidgets('answered in the terminal: every pick checked, and typed text '
      'shown as text, never as an option', (tester) async {
    await _pump(tester, [
      MessageWireEvent(
        seq: 1,
        message: _question([_colour, _checks], readOnly: true),
      ),
      MessageWireEvent(
        seq: 2,
        message: _resolved(const [
          ['a dark green'],
          ['Lint', 'Small, cheap'],
        ]),
      ),
    ]);
    expect(_chip(tester, 0, 0).selected, isFalse);
    expect(_chip(tester, 0, 1).selected, isFalse);
    expect(
      find.descendant(of: _typed(0), matching: find.text('a dark green')),
      findsOneWidget,
    );
    expect(_chip(tester, 1, 0).selected, isTrue);
    expect(_chip(tester, 1, 1).selected, isTrue);
    expect(_chip(tester, 1, 2).selected, isFalse);
    expect(_typed(1), findsNothing);
    for (final question in [0, 1]) {
      expect(
        find.byKey(Key('session-detail-question-custom-$_id-$question')),
        findsNothing,
      );
    }
  });

  testWidgets('a bare resolution after the answer does not take it away', (
    tester,
  ) async {
    await _pump(tester, [
      MessageWireEvent(seq: 1, message: _question([_colour], readOnly: true)),
      MessageWireEvent(
        seq: 2,
        message: _resolved(const [
          ['Amber'],
        ]),
      ),
      MessageWireEvent(seq: 3, message: _resolved(null)),
    ]);
    expect(_chip(tester, 0, 0).selected, isTrue);
  });

  testWidgets('after a history reset the card still shows the answer', (
    tester,
  ) async {
    final connection = await _pump(tester, [
      MessageWireEvent(seq: 1, message: _question([_colour], readOnly: true)),
    ]);
    connection.emitEvent(
      HistoryWireEvent(
        messages: [
          _question([_colour], readOnly: true),
          _resolved(const [
            ['Amber'],
          ]),
        ],
        reset: true,
        cursor: 'reset',
      ),
    );
    await tester.pumpAndSettle();
    expect(_chip(tester, 0, 0).selected, isTrue);
    expect(_chip(tester, 0, 1).selected, isFalse);
  });

  testWidgets('a resolution that says nothing leaves the card as before', (
    tester,
  ) async {
    await _pump(tester, [
      MessageWireEvent(seq: 1, message: _question([_colour], readOnly: true)),
      MessageWireEvent(seq: 2, message: _resolved(null)),
    ]);
    expect(_chip(tester, 0, 0).selected, isFalse);
    expect(_chip(tester, 0, 1).selected, isFalse);
    expect(_typed(0), findsNothing);
  });
}
