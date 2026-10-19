import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/view/storage_settings_page.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
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

      unawaited(
        Navigator.of(
          tester.element(find.byKey(const Key('session-detail-view-menu'))),
        ).push(
          MaterialPageRoute<void>(builder: (_) => const StorageSettingsPage()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('storage-clear-cache')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('all server profiles'), findsWidgets);
      await tester.tap(
        find.byKey(const Key('storage-clear-cache-confirm')),
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

    testWidgets('all-local cache clear works without an active broker', (
      tester,
    ) async {
      final database = AppDatabase(NativeDatabase.memory());
      final transcripts = DriftSessionTranscriptRepository(database);
      await transcripts.upsert(
        SessionTranscriptSnapshot(
          brokerProfileId: 'offline-profile@https://offline.example',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'offline-session',
          ),
          messages: [
            AgentMessage.fromJson(const {
              'type': 'model-output',
              'text': 'cached offline',
            }),
          ],
          hasEarlier: false,
          updatedAt: DateTime(2026),
        ),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          database: database,
          withActiveBrokerClient: false,
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');
      unawaited(
        Navigator.of(
          tester.element(find.byKey(const Key('session-detail-view-menu'))),
        ).push(
          MaterialPageRoute<void>(builder: (_) => const StorageSettingsPage()),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('storage-clear-cache')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('all server profiles'), findsWidgets);
      await tester.tap(
        find.byKey(const Key('storage-clear-cache-confirm')),
      );
      await tester.pumpAndSettle();

      expect(
        await database
            .customSelect(
              'SELECT COUNT(*) AS count FROM session_transcript_rows',
            )
            .getSingle()
            .then((row) => row.read<int>('count')),
        0,
      );
      expect(find.text('All local session cache was cleared'), findsOneWidget);
    });
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
