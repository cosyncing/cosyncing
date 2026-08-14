import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
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
          'input': 10800000,
          'output': 212000,
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
      MessageWireEvent(
        seq: 4,
        message: AgentMessage.fromJson(const {
          'type': 'run-summary',
          'status': 'done',
          'totalRuntimeMs': 246000,
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

    // The composer carries context usage while the roomy strip carries a
    // compact raw-bucket summary and Status keeps the full breakdown.
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

    testWidgets('compact strips hide telemetry below 840dp', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-top-row-telemetry')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsNothing,
      );
    });

    testWidgets('roomy strip shows separate input, output, and runtime', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();

      final telemetry = find.byKey(
        const Key('session-detail-top-row-telemetry'),
      );
      expect(telemetry, findsOneWidget);
      expect(
        find.text('in 10.8M · out 212k · run 4m'),
        findsOneWidget,
      );
      expect(
        find.ancestor(of: telemetry, matching: find.byType(ExcludeSemantics)),
        findsOneWidget,
      );
      expect(find.textContaining('cache'), findsNothing);
      expect(find.textContaining('total'), findsNothing);
    });

    testWidgets('top telemetry follows the exact 840dp breakpoint', (
      tester,
    ) async {
      for (final width in const [839.0, 840.0, 1280.0, 839.0]) {
        tester.view
          ..physicalSize = Size(width, 900)
          ..devicePixelRatio = 1;
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: eventsWithTelemetry()),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-top-row-telemetry')),
          width >= 840 ? findsOneWidget : findsNothing,
        );
        expect(tester.takeException(), isNull);
      }
      addTearDown(tester.view.reset);
    });

    testWidgets('top telemetry tolerates themes, brightness, and 2x text', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(840, 900)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      for (final themeId in const [kDefaultThemeId, 'soft-minimalist']) {
        final spec = themeSpecById(themeId);
        for (final brightness in Brightness.values) {
          for (final scale in const [1.0, 2.0]) {
            await tester.pumpWidget(
              buildSessionDetailTestPage(
                events: eventsWithTelemetry(),
                theme: buildAppTheme(
                  brightness == Brightness.dark ? spec.dark : spec.light,
                  brightness,
                ),
                textScale: scale,
              ),
            );
            await tester.pumpAndSettle();

            expect(
              find.byKey(const Key('session-detail-top-row-telemetry')),
              findsOneWidget,
            );
            expect(tester.takeException(), isNull);
          }
        }
      }
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
      expect(find.text('10,800,000'), findsOneWidget);
      expect(find.text('212,000'), findsOneWidget);
      expect(find.text('332,792'), findsOneWidget);
      expect(find.text('656'), findsOneWidget);
      expect(find.text('Session summary'), findsOneWidget);
      expect(find.text('Total tokens'), findsNothing);
      expect(find.textContaining('cache hit'), findsNothing);
    });

    testWidgets('Status uses quiet labels and primary tabular values', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      final context = tester.element(
        find.byKey(const Key('session-detail-telemetry-panel')),
      );
      final textTheme = Theme.of(context).textTheme;
      final inputLabel = tester.widget<Text>(find.text('Input'));
      final inputValue = tester.widget<Text>(find.text('10,800,000'));
      expect(inputLabel.style?.fontSize, textTheme.labelMedium?.fontSize);
      expect(inputLabel.style?.fontWeight, textTheme.labelMedium?.fontWeight);
      expect(inputValue.style?.fontSize, textTheme.bodyMedium?.fontSize);
      expect(inputValue.style?.fontWeight, textTheme.bodyMedium?.fontWeight);
      expect(inputValue.style?.fontFeatures, isNotEmpty);
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
