import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// Status keeps useful actions and a plain session-cache cleanup row.
void main() {
  Future<void> openStatusTab(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
  }

  group('Session Detail Status actions refinement', () {
    testWidgets('Status keeps Fork and Export without Duplicate or Copy', (
      tester,
    ) async {
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-current-cache-button'),
      );
      for (final key in [
        'session-detail-fork-button',
        'session-detail-export-transcript-button',
        'session-detail-clear-current-cache-button',
      ]) {
        expect(find.byKey(Key(key)), findsOneWidget);
      }
      for (final key in [
        'session-detail-clone-button',
        'session-detail-copy-transcript-button',
        'session-actions-group-local-data',
        'session-actions-local-data-caption',
        'session-detail-clear-all-cache-button',
      ]) {
        expect(find.byKey(Key(key)), findsNothing);
      }
    });

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
        'actions hold at $densityName density',
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
            Key('session-detail-clear-current-cache-button'),
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

    testWidgets('cache confirmation and disabled reasons render in Chinese', (
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

      expect(find.text('本地数据 — 可重建，重新同步前不可用'), findsNothing);
      expect(find.text('此代理类型不支持复制会话。'), findsNothing);
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
