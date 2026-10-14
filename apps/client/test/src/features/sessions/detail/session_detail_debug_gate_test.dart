import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/settings/controller/debug_views_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('D1 debug-view gate', () {
    testWidgets('disabling while Debug is open returns to Chat', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], showDebugViews: true),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-debug');
      expect(find.text('Debug timeline'), findsOneWidget);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );
      await container
          .read(debugViewsControllerProvider.notifier)
          .setShowDebugViews(value: false);
      await tester.pumpAndSettle();

      expect(find.text('Debug timeline'), findsNothing);
      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
    });
  });
}
