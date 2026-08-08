import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage telemetry', () {
    SessionWireEvent session() => SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'claude',
        'title': 'Telemetry session',
        'status': 'working',
        'attachMode': 'resume',
        'control': const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
          'input': 'full',
        },
      }),
    );

    List<WireEvent> eventsWithTelemetry() => [
      session(),
      MessageWireEvent(
        seq: 1,
        message: AgentMessage.fromJson(const {
          'type': 'model-output',
          'text': 'Here is the answer.',
        }),
      ),
      MessageWireEvent(
        seq: 2,
        message: AgentMessage.fromJson(const {
          'type': 'token-count',
          'input': 4,
          'output': 567,
          'cacheRead': 332792,
          'cacheWrite': 656,
        }),
      ),
      MessageWireEvent(
        seq: 3,
        message: AgentMessage.fromJson(const {
          'type': 'metadata-update',
          'key': 'contextUsage',
          'value': {'used': 90000, 'max': 100000},
        }),
      ),
    ];

    testWidgets('token lines never reach the transcript', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Tokens:'), findsNothing);
      expect(
        find.byKey(const Key('transcript-token-count-line')),
        findsNothing,
      );
      expect(find.textContaining('Here is the answer.'), findsOneWidget);
    });

    // Variant C's split: the 36dp strip carries nothing telemetric, the
    // composer carries context usage only, and Status keeps the breakdown.
    testWidgets('the composer shows the latest context reading', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsOneWidget,
      );
      expect(find.text('90k / 100k'), findsOneWidget);
    });

    testWidgets('the strip carries no telemetry', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      // Tokens, cost and runtime belong to Status; the strip stays a title,
      // a drive pill and the view menu.
      expect(find.text('334k'), findsNothing);
      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsNothing,
      );
    });

    testWidgets('the context meter is hidden without any reading', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()]),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsNothing,
      );
    });

    testWidgets('the Status view holds the full breakdown', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsOneWidget,
      );
      expect(find.text('334,019'), findsOneWidget);
      expect(find.text('332,792'), findsOneWidget);
      expect(find.text('Usage & context'), findsOneWidget);
    });

    testWidgets('tapping the drive pill opens Status', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-detail-status-chip')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsOneWidget,
      );
    });

    testWidgets('Status reports an empty state before any reading', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()]),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      expect(
        find.byKey(const Key('session-detail-telemetry-empty')),
        findsOneWidget,
      );
    });
  });
}
