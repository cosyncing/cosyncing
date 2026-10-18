import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// V1/V2-R1 Status-action refinements: distinct icons, purposeful groups, a
/// labeled single-session Local data zone, token-driven
/// destructive confirmation, and disabled reasons — in English and Chinese.
void main() {
  Icon leadingIconOf(WidgetTester tester, Key tileKey) {
    final tile = tester.widget<ListTile>(find.byKey(tileKey));
    return tile.leading! as Icon;
  }

  Future<void> openStatusTab(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
  }

  group('Session Detail Status actions refinement', () {
    testWidgets('Duplicate and Copy transcript carry distinct icons', (
      tester,
    ) async {
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-copy-transcript-button'),
      );

      final duplicate = leadingIconOf(
        tester,
        const Key('session-detail-clone-button'),
      );
      final copyTranscript = leadingIconOf(
        tester,
        const Key('session-detail-copy-transcript-button'),
      );
      expect(duplicate.icon, Icons.difference_outlined);
      expect(copyTranscript.icon, Icons.copy_all_outlined);
      expect(duplicate.icon, isNot(copyTranscript.icon));
    });

    testWidgets(
      'actions are grouped into Session, Transcript, and Local data zones',
      (tester) async {
        await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
        await openStatusTab(tester);
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-clear-current-cache-button'),
        );

        for (final (group, tile) in [
          ('session-actions-group-session', 'session-detail-detach-button'),
          ('session-actions-group-session', 'session-detail-fork-button'),
          ('session-actions-group-session', 'session-detail-clone-button'),
          (
            'session-actions-group-transcript',
            'session-detail-export-transcript-button',
          ),
          (
            'session-actions-group-transcript',
            'session-detail-copy-transcript-button',
          ),
          (
            'session-actions-group-local-data',
            'session-detail-clear-current-cache-button',
          ),
        ]) {
          expect(
            find.descendant(
              of: find.byKey(Key(group)),
              matching: find.byKey(Key(tile)),
            ),
            findsOneWidget,
            reason: '$tile must live in $group',
          );
        }

        // Local cleanup stays scoped to this session. Device-wide cleanup
        // belongs to Settings → General → Storage.
        expect(
          find.byKey(const Key('session-actions-local-data-caption')),
          findsOneWidget,
        );
        expect(
          find.text('Local data — rebuildable, but gone until re-synced'),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-clear-all-cache-button')),
          findsNothing,
        );
      },
    );

    testWidgets('destructive confirmation buttons use statusError', (
      tester,
    ) async {
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-current-cache-button'),
      );
      await tester.tap(
        find.byKey(const Key('session-detail-clear-current-cache-button')),
      );
      await tester.pumpAndSettle();

      final confirmFinder = find.byKey(
        const Key('session-detail-clear-current-cache-confirm'),
      );
      final tokens = Theme.of(
        tester.element(confirmFinder),
      ).extension<AppTokens>()!;
      final confirm = tester.widget<FilledButton>(confirmFinder);
      expect(
        confirm.style?.backgroundColor?.resolve(const {}),
        tokens.statusError,
      );
      // The consequence explanation stays selectable.
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
    });

    for (final (densityName, density) in [
      ('Compact', UiDensity.compact),
      ('Roomy', UiDensity.spacious),
    ]) {
      testWidgets(
        'grouping and zone label hold at $densityName density',
        (tester) async {
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: const [],
              theme: buildAppTheme(
                themeSpecById(kDefaultThemeId).light,
                Brightness.light,
                density: density.visualDensity,
              ),
            ),
          );
          await openStatusTab(tester);
          await showSessionStatusTestItem(
            tester,
            const Key('session-detail-clear-current-cache-button'),
          );

          for (final key in const [
            Key('session-actions-group-session'),
            Key('session-actions-group-transcript'),
            Key('session-actions-group-local-data'),
            Key('session-actions-local-data-caption'),
          ]) {
            expect(
              find.byKey(key),
              findsOneWidget,
              reason: '$key must survive $densityName density',
            );
          }
        },
      );
    }

    testWidgets('grouping, zone label, and reasons render in Chinese', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          locale: const Locale('zh'),
          brokerClient: FakeBrokerClient(
            agents: [
              fakeAgentInfo(canClone: false, canTranscriptExport: false),
            ],
          ),
        ),
      );
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-current-cache-button'),
      );

      expect(find.text('本地数据 — 可重建，重新同步前不可用'), findsOneWidget);
      expect(find.text('此代理类型不支持复制会话。'), findsOneWidget);
      expect(find.text('此代理类型不支持导出对话记录。'), findsOneWidget);

      await tester.tap(
        find.byKey(const Key('session-detail-clear-current-cache-button')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-clear-current-cache-confirm')),
        findsOneWidget,
      );
    });
  });
}
