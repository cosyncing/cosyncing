import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A settled question card says who closed it, in the sentences a permission
/// card already uses: answered in the app, answered in the terminal, or left
/// when cosyncing stopped waiting. With no word from the broker it says what
/// it said before. The seat that sent the answer says "Answered in the app"
/// too, live and after the card is rebuilt from history.
///
/// A question can also close with nothing picked: Escape at the terminal, or
/// Stop or Dismiss in the app. Those cards say where it was closed and that
/// it was not answered, never that it was answered.
const _id = 'toolu_settled_by';

const Map<String, Object> _colour = {
  'question': 'Which colour?',
  'header': 'Colour',
  'multiple': false,
  'options': [
    {'label': 'Amber'},
    {'label': 'Teal'},
  ],
};

const _question = AgentMessage(
  type: AgentMessageType.questionRequest,
  raw: {
    'type': 'question-request',
    'requestId': _id,
    'questions': [_colour],
  },
);

AgentMessage _resolved(
  Map<String, Object> attribution, {
  bool answered = true,
}) => AgentMessage(
  type: AgentMessageType.questionResolved,
  raw: {
    'type': 'question-resolved',
    'requestId': _id,
    if (answered)
      'answers': const [
        ['Teal'],
      ],
    ...attribution,
  },
);

Finder get _outcome =>
    find.byKey(const Key('session-detail-question-outcome-$_id'));

String? _outcomeText(WidgetTester tester) =>
    tester.widgetList<Text>(_outcome).singleOrNull?.data;

/// Each end the broker reports, and the sentence a card shows for it.
final _ends =
    <
      ({
        String label,
        Map<String, Object> attribution,
        bool answered,
        String Function(AppLocalizations) sentence,
      })
    >[
      (
        label: 'answered in the app',
        answered: true,
        attribution: {'decidedBy': 'app'},
        sentence: (l10n) => l10n.sessionRequestDecidedByApp,
      ),
      (
        label: 'taken back by the terminal',
        answered: true,
        attribution: {'releaseReason': 'band'},
        sentence: (l10n) => l10n.sessionRequestReleaseBand,
      ),
      (
        label: 'left when cosyncing stopped waiting',
        answered: true,
        attribution: {'decidedBy': 'expired', 'releaseReason': 'expired'},
        sentence: (l10n) => l10n.sessionRequestReleaseExpired,
      ),
      (
        label: 'with no word on who',
        answered: true,
        attribution: const {},
        sentence: (l10n) => l10n.sessionQuestionSettledElsewhere,
      ),
      // Closed with nothing picked. Escape at the terminal reaches the broker
      // as the terminal taking the question back; Stop or Dismiss in the app
      // as the app deciding it. Neither is an answer.
      (
        label: 'escaped in the terminal with nothing picked',
        answered: false,
        attribution: {'releaseReason': 'band'},
        sentence: (l10n) => l10n.sessionQuestionClosedUnansweredInTerminal,
      ),
      (
        label: 'stopped or dismissed in the app with nothing picked',
        answered: false,
        attribution: {'decidedBy': 'app'},
        sentence: (l10n) => l10n.sessionQuestionClosedUnansweredInApp,
      ),
      (
        label: 'left unanswered when cosyncing stopped waiting',
        answered: false,
        attribution: {'decidedBy': 'expired', 'releaseReason': 'expired'},
        sentence: (l10n) => l10n.sessionRequestReleaseExpired,
      ),
      // An older broker names nobody and sends no answers either, so a card
      // it closed cannot tell "unanswered" from "not said", and says what it
      // said before.
      (
        label: 'unanswered, with no word on who',
        answered: false,
        attribution: const {},
        sentence: (l10n) => l10n.sessionQuestionSettledElsewhere,
      ),
    ];

const _locales = [
  Locale('en'),
  Locale('zh'),
  Locale('ja'),
  Locale('ko'),
  Locale('es'),
];

void main() {
  for (final locale in _locales) {
    final l10n = lookupAppLocalizations(locale);
    for (final end in _ends) {
      testWidgets('[$locale] a question ${end.label} says so, live and after '
          'a history reset', (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            const MessageWireEvent(seq: 1, message: _question),
            MessageWireEvent(
              seq: 2,
              message: _resolved(end.attribution, answered: end.answered),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            locale: locale,
          ),
        );
        await tester.pumpAndSettle();
        expect(_outcomeText(tester), end.sentence(l10n));

        connection.emitEvent(
          HistoryWireEvent(
            messages: [
              _question,
              _resolved(end.attribution, answered: end.answered),
            ],
            reset: true,
            cursor: 'reset',
          ),
        );
        await tester.pumpAndSettle();
        expect(_outcomeText(tester), end.sentence(l10n));
      });
    }
  }

  final en = lookupAppLocalizations(const Locale('en'));

  testWidgets('the seat that sent the answer says it was answered in the app, '
      'live and after a history reset', (tester) async {
    final connection = ScriptedSessionDetailConnection(
      events: const [MessageWireEvent(seq: 1, message: _question)],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    tester
        .widget<FilterChip>(
          find.byKey(const Key('session-detail-question-option-$_id-0-1')),
        )
        .onSelected!(true);
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
      MessageWireEvent(seq: 2, message: _resolved({'decidedBy': 'app'})),
    );
    await tester.pumpAndSettle();
    expect(_outcomeText(tester), en.sessionRequestDecidedByApp);

    connection.emitEvent(
      HistoryWireEvent(
        messages: [
          _question,
          _resolved({'decidedBy': 'app'}),
        ],
        reset: true,
        cursor: 'reset',
      ),
    );
    await tester.pumpAndSettle();
    expect(_outcomeText(tester), en.sessionRequestDecidedByApp);
    expect(find.text(en.sessionQuestionSettledElsewhere), findsNothing);
  });
  testWidgets('the seat that dismissed the question says it was closed from '
      'the app without an answer, live and after a history reset', (
    tester,
  ) async {
    final connection = ScriptedSessionDetailConnection(
      events: const [MessageWireEvent(seq: 1, message: _question)],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    tester
        .widget<TextButton>(
          find.byKey(const Key('session-detail-question-reject-$_id')),
        )
        .onPressed!();
    await tester.pumpAndSettle();
    expect(connection.rejectQuestionCount, 1);

    connection.emitEvent(
      MessageWireEvent(
        seq: 2,
        message: _resolved({'decidedBy': 'app'}, answered: false),
      ),
    );
    await tester.pumpAndSettle();
    expect(_outcomeText(tester), en.sessionQuestionClosedUnansweredInApp);

    connection.emitEvent(
      HistoryWireEvent(
        messages: [
          _question,
          _resolved({'decidedBy': 'app'}, answered: false),
        ],
        reset: true,
        cursor: 'reset',
      ),
    );
    await tester.pumpAndSettle();
    expect(_outcomeText(tester), en.sessionQuestionClosedUnansweredInApp);
    expect(find.text(en.sessionRequestDecidedByApp), findsNothing);
  });
}
