import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('Session Detail transcript copy and cache actions', () {
    testWidgets('copies the whole retained transcript without exporting', (
      tester,
    ) async {
      String? clipboardText;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboardText =
                (call.arguments as Map<Object?, Object?>)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final brokerClient = _CacheBrokerClient();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          brokerClient: brokerClient,
          events: [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson(const {
                'type': 'user-message',
                'text': 'Question exactly',
              }),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage.fromJson(const {
                'type': 'model-output',
                'text': 'Answer with ```fence``` exactly',
              }),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-copy-transcript-button'),
      );
      await tester.tap(
        find.byKey(const Key('session-detail-copy-transcript-button')),
      );
      await tester.pumpAndSettle();

      expect(
        clipboardText,
        'Question exactly\n\nAnswer with ```fence``` exactly',
      );
      expect(brokerClient.prepareTranscriptExportCount, 0);
      expect(brokerClient.exportTranscriptCount, 0);
      expect(find.text('Transcript copied'), findsOneWidget);
    });

    test('retained transcript copy makes every history gap explicit', () {
      final copied = buildRetainedTranscriptCopyText(
        segments: [
          [
            AgentMessage.fromJson(const {
              'type': 'user-message',
              'text': 'Earlier exact text',
            }),
          ],
          [
            AgentMessage.fromJson(const {
              'type': 'model-output',
              'text': 'Later ```source``` text',
            }),
          ],
        ],
        omissionMarker: '[omitted]',
        hasLeadingOmission: true,
      );

      expect(
        copied,
        '[omitted]\n\nEarlier exact text\n\n[omitted]\n\n'
        'Later ```source``` text',
      );
    });

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

      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-all-cache-button'),
      );
      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-button')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('all broker profiles'), findsWidgets);
      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-confirm')),
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
            'local transcript cache was cleared, but broker artifacts',
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
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-all-cache-button'),
      );

      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-button')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('all broker profiles'), findsWidgets);
      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-confirm')),
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
