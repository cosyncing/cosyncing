import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('Session Detail cache actions', () {
    testWidgets('cache actions state scope and require confirmation', (
      tester,
    ) async {
      final brokerClient = _CacheBrokerClient();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: brokerClient,
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-current-cache-button'),
      );
      await tester.tap(
        find.byKey(const Key('session-detail-clear-current-cache-button')),
      );
      await tester.pumpAndSettle();
      expect(brokerClient.clearSessionCacheCount, 0);
      expect(find.textContaining('this session'), findsWidgets);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('session-detail-clear-current-cache-confirm')),
      );
      await tester.pumpAndSettle();
      expect(brokerClient.clearSessionCacheCount, 1);
    });

    testWidgets(
      'current cache clears locally when broker artifact cleanup fails',
      (tester) async {
        final brokerClient = _CacheBrokerClient()
          ..clearSessionCacheError = StateError('offline');
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-clear-current-cache-button'),
        );

        await tester.tap(
          find.byKey(const Key('session-detail-clear-current-cache-button')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('session-detail-clear-current-cache-confirm')),
        );
        await tester.pumpAndSettle();

        expect(brokerClient.clearSessionCacheCount, 1);
        expect(
          find.textContaining(
            'local transcript cache was cleared, but server artifacts',
          ),
          findsOneWidget,
        );
      },
    );
  });
}

final class _CacheBrokerClient extends FakeBrokerClient {
  Object? clearSessionCacheError;
  int clearSessionCacheCount = 0;

  @override
  Future<ClearSessionCacheResponse> clearSessionCache(
    String tool,
    String id,
  ) async {
    clearSessionCacheCount++;
    if (clearSessionCacheError case final error?) {
      Error.throwWithStackTrace(error, StackTrace.current);
    }
    return const ClearSessionCacheResponse(ok: true, clearedArtifacts: 2);
  }
}
