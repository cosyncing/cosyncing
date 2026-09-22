import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A finished activity card reports the duration the tool measured, and nothing
/// else. Its fallback is a local first-render guess of the start time, and no
/// frame re-syncs it once the status lands, so a card that arrived terminal and
/// without `elapsedMs` grew on every rebuild — the climbing this card's running
/// floor exists to prevent, reintroduced on the finished path.
void main() {
  SessionWireEvent workingSession() => SessionWireEvent(
    info: SessionInfo.fromJson({
      'id': 'session-1',
      'tool': 'claude',
      'title': 'Review the change set',
      'status': 'working',
      'attachMode': 'observe',
      'control': const {
        'drive': {'state': 'observing', 'supported': false},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      },
    }),
  );

  MessageWireEvent activity(
    int seq, {
    required Map<String, Object?> activity,
  }) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson({
      'type': 'agent-activity',
      'key': 'subagent-1',
      'kind': 'subagent',
      'title': 'Review the change set',
      ...activity,
    }),
  );

  /// The card's one-line summary, read from the Status tab, which renders every
  /// live-state item as a full card rather than behind the chat band's strip.
  String summary(WidgetTester tester) {
    final text = tester.widget<Text>(
      find.byKey(const Key('session-agent-activity-summary')),
    );
    return text.data!;
  }

  Future<void> showCard(WidgetTester tester) async {
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
    await showSessionStatusTestItem(
      tester,
      const Key('session-agent-activity-summary'),
    );
  }

  testWidgets(
    'a finished card with no measured duration shows no duration, and stays '
    'showing none',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            activity(1, activity: const {'status': 'done'}),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);

      expect(summary(tester), 'Background agent');

      // Two minutes of wall clock and a rebuild: a duration invented from the
      // card's own first-render guess would have appeared and kept climbing.
      await tester.pump(const Duration(minutes: 2));
      await tester.pumpAndSettle();
      expect(summary(tester), 'Background agent');
    },
  );

  testWidgets(
    'a finished card reports the duration it was given and stops there',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            activity(
              1,
              activity: const {'status': 'done', 'elapsedMs': 42000},
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);

      expect(summary(tester), contains('42s'));

      await tester.pump(const Duration(minutes: 2));
      await tester.pumpAndSettle();
      expect(summary(tester), contains('42s'));
    },
  );

  // A command that finished without writing anything used to fall through to
  // the running card's copy -- "Progress remains live until the Server reports
  // completion." -- beside its own Done pill and its measured duration, so the
  // two facts on screen contradicted each other.
  MessageWireEvent command(int seq, Map<String, Object?> fields) =>
      MessageWireEvent(
        seq: seq,
        message: AgentMessage.fromJson({
          'type': 'agent-activity',
          'key': 'cmd:toolu_quiet',
          'kind': 'command',
          'title': 'Build the bundle',
          ...fields,
        }),
      );

  testWidgets(
    'a finished command that wrote nothing says so, not that progress is live',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            command(1, const {
              'status': 'done',
              'exitCode': 0,
              'elapsedMs': 4000,
            }),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);
      // The body lives in the card's expansion children, so the wording is only
      // on screen once the reader opens it.
      await tester.tap(find.text('Build the bundle'));
      await tester.pumpAndSettle();

      expect(find.text('No output'), findsOneWidget);
      expect(
        find.text('Progress remains live until the Server reports completion.'),
        findsNothing,
      );
    },
  );

  // ...and the RUNNING command keeps its own, different sentence, so the fix
  // above is a new branch rather than a rename of the existing one.
  testWidgets(
    'a running command with nothing on stdout yet keeps its own wording',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            command(1, const {'status': 'running', 'elapsedMs': 4000}),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);
      await tester.tap(find.text('Build the bundle'));
      await tester.pumpAndSettle();

      expect(find.text('No output yet'), findsOneWidget);
    },
  );

  // The other direction: the wall-clock floor belongs to the RUNNING path, and
  // a quiet running agent emits nothing for minutes. Dropping the fallback
  // wholesale would leave a running card with no elapsed at all.
  testWidgets(
    'a running card keeps a duration when the tool reported none',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            activity(1, activity: const {'status': 'running'}),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);

      expect(summary(tester), isNot('Background agent'));
      expect(summary(tester), contains('s'));
    },
  );

  testWidgets(
    'a running card reports the measured duration once it is the larger one',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            activity(
              1,
              activity: const {'status': 'running', 'elapsedMs': 5000},
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await showCard(tester);

      expect(summary(tester), contains('5s'));
    },
  );
}
