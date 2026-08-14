// Placement coverage for the context meter inside the session composer.
//
// The widget's own behaviour (ring/verbose painting, text-scaler response, the
// 85% threshold, ratio arithmetic, clamping, newest-reading-wins) is covered by
// `session_context_meter_test.dart`. Nothing here re-tests any of that. What
// these tests pin is the integration: where the meter sits, which style each
// breakpoint gets, that it occupies no space when there is no reading, and that
// its arrival cannot move the composer.

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_context_meter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart'
    show kComposerCollapseWidth;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  SessionWireEvent session() => SessionWireEvent(
    info: SessionInfo.fromJson(const {
      'id': 'session-1',
      'tool': 'codex',
      'title': 'Context session',
      'status': 'working',
      'attachMode': 'resume',
      'control': {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      },
    }),
  );

  /// The broker frame that carries a real used/max pair.
  MessageWireEvent contextUsage({
    int seq = 1,
    int used = 258000,
    int max = 973000,
  }) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson({
      'type': 'metadata-update',
      'key': 'contextUsage',
      'value': {'used': used, 'max': max},
    }),
  );

  /// Advertises a model and a permission mode, so the left cluster renders in
  /// full and the meter's position within it is actually meaningful.
  OptionsWireEvent leftClusterOptions() => const OptionsWireEvent(
    models: [
      ModelOption(
        providerID: 'openai',
        modelID: 'gpt-5.4',
        label: 'GPT-5.4',
      ),
    ],
    agents: [],
    modes: [ModeOption(value: 'auto', label: 'Auto')],
  );

  void sizeViewport(WidgetTester tester, double width) {
    tester.view
      ..physicalSize = Size(width, 900)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  /// The control row's own width, which is what the collapse rule reads — the
  /// composer sits inside a readable-width column, so this is narrower than the
  /// viewport and is the number the breakpoint must be judged against.
  double controlRowWidth(WidgetTester tester) => tester
      .getSize(find.byKey(const Key('session-detail-composer-bottom-bar')))
      .width;

  group('context meter placement in the composer', () {
    testWidgets('renders in verbose style at wide width', (tester) async {
      sizeViewport(tester, 1280);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session(), contextUsage()]),
      );
      await tester.pumpAndSettle();

      expect(
        controlRowWidth(tester),
        greaterThanOrEqualTo(kComposerCollapseWidth),
        reason: 'precondition: this viewport must not be collapsed',
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsNothing,
      );
      expect(find.text('258k / 973k'), findsOneWidget);
    });

    testWidgets('sits in the left cluster, after the permission button', (
      tester,
    ) async {
      sizeViewport(tester, 1280);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), leftClusterOptions(), contextUsage()],
        ),
      );
      await tester.pumpAndSettle();

      final meter = tester.getRect(
        find.byKey(const Key('session-context-meter-verbose')),
      );
      final permission = tester.getRect(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      final send = tester.getRect(
        find.byKey(const Key('session-detail-send-button')),
      );

      // Information, not an action: right of the permission control but still
      // well left of the action cluster.
      expect(meter.left, greaterThan(permission.left));
      expect(meter.left, lessThan(send.left));
    });

    testWidgets('drops to ring style below the collapse width', (tester) async {
      sizeViewport(tester, 420);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session(), contextUsage()]),
      );
      await tester.pumpAndSettle();

      expect(
        controlRowWidth(tester),
        lessThan(kComposerCollapseWidth),
        reason: 'precondition: this viewport must be collapsed',
      );
      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
    });

    testWidgets('the style flips exactly at kComposerCollapseWidth', (
      tester,
    ) async {
      // Pins the threshold itself, not just the two ends: a layout change that
      // silently moved the flip would leave one of these two assertions wrong.
      for (final (width, wantRing) in <(double, bool)>[
        (1280, false),
        (420, true),
      ]) {
        sizeViewport(tester, width);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: [session(), contextUsage()]),
        );
        await tester.pumpAndSettle();

        final rowWidth = controlRowWidth(tester);
        final collapsed = rowWidth < kComposerCollapseWidth;
        expect(
          collapsed,
          wantRing,
          reason: 'control row is ${rowWidth}px at viewport ${width}px',
        );
        expect(
          find.byKey(const Key('session-context-meter-ring')),
          collapsed ? findsOneWidget : findsNothing,
        );
        expect(
          find.byKey(const Key('session-context-meter-verbose')),
          collapsed ? findsNothing : findsOneWidget,
        );
      }
    });

    testWidgets('occupies nothing at all without a reading', (tester) async {
      // The common case, not the edge case: no non-codex agent advertises a
      // context window today, so most sessions must show no meter and reserve
      // no space for one.
      sizeViewport(tester, 1280);
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
      // No placeholder and no reserved box: the widget is present in the tree
      // but must lay out to zero.
      expect(
        tester.getSize(find.byType(SessionContextMeter)),
        Size.zero,
        reason: 'no zero state, no reserved empty box',
      );
    });

    testWidgets('a first reading arriving mid-session does not move the '
        'composer', (tester) async {
      // The regression a user would hit before CI did. The first context frame
      // lands while the transcript is already on screen; if the meter grows the
      // composer, everything above it jumps.
      sizeViewport(tester, 1280);
      final connection = ScriptedSessionDetailConnection(events: [session()]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final composer = find.byKey(const Key('session-detail-composer'));
      final controlRow = find.byKey(
        const Key('session-detail-composer-bottom-bar'),
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
      final beforeComposer = tester.getRect(composer);
      final beforeRow = tester.getSize(controlRow);

      connection.emitEvent(contextUsage(seq: 2));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsOneWidget,
        reason: 'precondition: the reading actually landed',
      );
      final afterComposer = tester.getRect(composer);
      final afterRow = tester.getSize(controlRow);

      expect(afterComposer.height, beforeComposer.height);
      expect(afterRow.height, beforeRow.height);
      // Unmoved, not merely the same size: the composer must not shift either.
      expect(afterComposer.top, beforeComposer.top);
    });

    testWidgets('the meter stays clear of the collapsed composer at 420', (
      tester,
    ) async {
      sizeViewport(tester, 420);
      final connection = ScriptedSessionDetailConnection(events: [session()]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final composer = find.byKey(const Key('session-detail-composer'));
      final before = tester.getSize(composer).height;

      connection.emitEvent(contextUsage(seq: 2));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsOneWidget,
      );
      expect(tester.getSize(composer).height, before);
    });
  });
}
