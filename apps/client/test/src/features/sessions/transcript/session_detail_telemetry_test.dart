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

    testWidgets('session information preserves telemetry outside the header', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: eventsWithTelemetry()),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-top-row-telemetry')),
        findsNothing,
      );
      await tester.tap(find.byKey(const Key('session-detail-information')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsOneWidget,
      );
      expect(find.text('10.8M tokens'), findsOneWidget);
      expect(find.text('212k tokens'), findsOneWidget);
      expect(find.text('4m'), findsOneWidget);
    });

    testWidgets('telemetry stays in information at every width', (
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
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      }
      addTearDown(tester.view.reset);
    });

    testWidgets('information affordance tolerates themes and 2x text', (
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
              find.byKey(const Key('session-detail-information')),
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
      final inputValue = tester.widget<Text>(find.text('10.8M tokens'));
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
  });
}
