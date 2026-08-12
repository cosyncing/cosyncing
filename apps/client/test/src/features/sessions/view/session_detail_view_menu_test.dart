// Guards the signals Variant C inherited from the deleted tab strip.
//
// The failure mode this file exists for: the Status badge count and the
// Terminal fresh-output dot are still *computed* correctly after the tabs are
// gone, so every test asserting on those numbers keeps passing while nothing
// is drawn. These tests therefore assert on the rendered badge/dot widgets, not
// on the counts behind them.

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  SessionWireEvent session() => SessionWireEvent(
    info: SessionInfo.fromJson(const {
      'id': 'session-1',
      'tool': 'claude',
      'title': 'Signal session',
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

  /// A blocked goal is `actionRequired`, which is what drives the Status badge.
  MessageWireEvent blockedGoal(int seq, String key) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson({
      'type': 'goal-state',
      'key': key,
      'status': 'blocked',
      'title': 'Blocked objective $key',
    }),
  );

  MessageWireEvent terminalOutput(int seq) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson(const {
      'type': 'terminal-output',
      'command': 'printf hi',
      'output': 'hi',
    }),
  );

  group('SessionDetailPage view menu signals', () {
    testWidgets('the Status badge renders its count inside the menu', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), blockedGoal(1, 'a'), blockedGoal(2, 'b')],
        ),
      );
      await tester.pumpAndSettle();

      await withSessionDetailViewMenu(tester, () async {
        final badge = find.byKey(const Key('session-detail-view-badge-status'));
        expect(
          badge,
          findsOneWidget,
          reason: 'badge must be drawn, not just counted',
        );
        expect(
          find.descendant(of: badge, matching: find.text('2')),
          findsOneWidget,
        );
      });
    });

    testWidgets('the aggregate dot marks the closed menu button', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), blockedGoal(1, 'a')],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsOneWidget,
      );
    });

    testWidgets('no pending signal leaves the menu button undecorated', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()]),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsNothing,
      );
    });

    testWidgets('the aggregate dot clears once Status is the active view', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), blockedGoal(1, 'a')],
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsOneWidget,
      );

      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      // The badge itself stays — the count is still real — but the dot stops
      // nagging about a view the user is already looking at.
      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsNothing,
      );
    });

    testWidgets('terminal output raises a fresh dot that opening the view '
        'clears', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), terminalOutput(1)],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsOneWidget,
      );
      await withSessionDetailViewMenu(tester, () async {
        expect(
          find.byKey(const Key('session-detail-view-badge-terminal')),
          findsOneWidget,
        );
      });

      await openSessionDetailTestTab(tester, 'session-detail-tab-terminal');

      expect(
        find.byKey(const Key('session-detail-tab-panel-terminal')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsNothing,
        reason: 'on-view means seen',
      );
      await withSessionDetailViewMenu(tester, () async {
        expect(
          find.byKey(const Key('session-detail-view-badge-terminal')),
          findsNothing,
        );
      });
    });

    testWidgets('both signals at once keep both badges', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), blockedGoal(1, 'a'), terminalOutput(2)],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsOneWidget,
      );
      await withSessionDetailViewMenu(tester, () async {
        expect(
          find.byKey(const Key('session-detail-view-badge-status')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-view-badge-terminal')),
          findsOneWidget,
        );
      });
    });
  });

  group('SessionDetailPage view navigation', () {
    testWidgets('entering a sub-view swaps the title slot for a back slot', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()], showDebugViews: true),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-detail-view-back')), findsNothing);
      expect(find.text('Signal session'), findsOneWidget);

      await openSessionDetailTestTab(tester, 'session-detail-tab-debug');

      expect(
        find.byKey(const Key('session-detail-view-back')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-view-title')),
        findsOneWidget,
      );
      expect(find.text('Debug'), findsWidgets);

      await tester.tap(find.byKey(const Key('session-detail-view-back')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-detail-view-back')), findsNothing);
      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
    });

    testWidgets('the strip is 32dp and full-width across layouts and themes', (
      tester,
    ) async {
      final spec = themeSpecById(kDefaultThemeId);
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        for (final width in <double>[1440, 420]) {
          tester.view
            ..physicalSize = Size(width, 900)
            ..devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);

          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: [session()],
              theme: buildAppTheme(tokens, brightness),
            ),
          );
          await tester.pumpAndSettle();

          expect(
            tester
                .getSize(find.byKey(const Key('session-detail-top-strip')))
                .height,
            32,
            reason:
                'the session strip is pinned to 32dp at ${width}px in '
                '$brightness (owner override of the 36dp spec)',
          );
          expect(
            tester
                .getSize(find.byKey(const Key('session-detail-view-menu')))
                .height,
            lessThanOrEqualTo(32),
            reason:
                'menu button must fit the strip at ${width}px in $brightness',
          );
          final stripRect = tester.getRect(
            find.byKey(const Key('session-detail-top-strip')),
          );
          final menuRect = tester.getRect(
            find.byKey(const Key('session-detail-view-menu')),
          );
          expect(
            stripRect.width,
            width,
            reason:
                'the session chrome must span the full detail pane in '
                '$brightness',
          );
          expect(
            stripRect.right - menuRect.right,
            4,
            reason:
                'the drive control and overflow menu stay at the rightmost '
                'strip edge, not at a readable-column boundary in $brightness',
          );
        }
      }
    });

    testWidgets(
      'with telemetry present the status cluster stays anchored at the '
      'trailing edge',
      (tester) async {
        // The regression: the tab-row telemetry entered the strip as a loose
        // Flexible beside the expanded title. RenderFlex then split the free
        // space between them, and the unused half of the telemetry's share
        // collapsed AFTER the menu — the telemetry, status chip, and overflow
        // menu floated near the middle of a wide pane. The no-telemetry
        // sibling test cannot catch it: the flex branch never enters the tree.
        tester.view
          ..physicalSize = const Size(1440, 900)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              session(),
              MessageWireEvent(
                seq: 1,
                message: AgentMessage.fromJson(const {
                  'type': 'token-count',
                  'input': 2500000000,
                  'output': 5700000,
                }),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-top-row-telemetry')),
          findsOneWidget,
          reason: 'the fixture must actually exercise the telemetry slot',
        );
        final stripRect = tester.getRect(
          find.byKey(const Key('session-detail-top-strip')),
        );
        final menuRect = tester.getRect(
          find.byKey(const Key('session-detail-view-menu')),
        );
        expect(
          stripRect.right - menuRect.right,
          4,
          reason:
              'the status cluster and overflow menu must hold the trailing '
              'edge of a wide pane even when telemetry renders beside the '
              'title',
        );
        // The cluster reads right-to-left from the edge: menu, then the chip
        // immediately before it — never a mid-pane float.
        final chipRect = tester.getRect(
          find.byKey(const Key('session-detail-bottom-status-button')),
        );
        expect(
          menuRect.left - chipRect.right,
          lessThanOrEqualTo(8),
          reason: 'the status chip sits immediately before the overflow menu',
        );
      },
    );

    testWidgets('the aggregate dot stays small enough for a 16px glyph', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [session(), blockedGoal(1, 'a')],
        ),
      );
      await tester.pumpAndSettle();

      // 4dp, not the 6 this shipped with: it rides the corner of the ⋮ glyph,
      // and anything larger reads as a blob in a 36dp strip.
      expect(
        tester.getSize(find.byKey(const Key('session-detail-view-menu-dot'))),
        const Size(4, 4),
      );
    });

    testWidgets('the menu stays compact once opened', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()], showDebugViews: true),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-detail-view-menu')));
      await tester.pumpAndSettle();

      // Rows are 32dp, not Material's 48 or the 40 this menu shipped with.
      // Pinned because the compaction was an explicit product-owner request and
      // would otherwise drift back on the next Material default bump.
      for (final name in ['chat', 'status', 'files', 'debug', 'report']) {
        expect(
          tester
              .getSize(find.byKey(Key('session-detail-view-item-$name')))
              .height,
          32,
          reason: '$name row must stay 32dp',
        );
      }
    });

    testWidgets('the composer keeps no overflow of its own', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: [session()]),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-overflow')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-report-view-toggle')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-tool-expand-toggle')),
        findsNothing,
      );
    });
  });
}
