import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_local_maintenance.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_store.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_outbox.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftSessionOutboxRepository outbox;
  late DriftSessionDraftRepository drafts;
  late SessionLocalMaintenance maintenance;

  const key = SessionDetailKey(tool: 'codex', sessionId: 'session-1');
  final now = DateTime.utc(2026, 7, 24, 12);

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    outbox = DriftSessionOutboxRepository(database);
    drafts = DriftSessionDraftRepository(database);
    maintenance = SessionLocalMaintenance(database);
  });

  tearDown(() => database.close());

  SessionOutboxMessage promptRow(
    String id, {
    DateTime? createdAt,
    String text = 'prompt text',
  }) {
    final created = createdAt ?? now;
    return SessionOutboxMessage(
      sessionKey: key,
      brokerProfileId: 'local',
      clientMessageId: id,
      kind: SessionOutboxMessageKind.prompt,
      payload: {'text': text},
      status: SessionOutboxMessageStatus.queued,
      createdAt: created,
      updatedAt: created,
    );
  }

  group('delivered outbox pruning', () {
    test(
      'delivery strips the payload and cleanup deletes the aged shell',
      () async {
        await outbox.upsert(
          promptRow(
            'cm-delivered',
            createdAt: now.subtract(const Duration(days: 2)),
          ),
        );
        await outbox.markDelivered('cm-delivered');
        // Deterministic clock: backdate the delivery stamp relative to `now`.
        await database.customStatement(
          'UPDATE session_outbox_rows SET updated_at = ? '
          "WHERE client_message_id = 'cm-delivered'",
          [now.millisecondsSinceEpoch ~/ 1000],
        );

        // Payload removed on delivery; recovery no longer needs it.
        var rows = await outbox.loadForSession(key, brokerProfileId: 'local');
        expect(rows.single.status, SessionOutboxMessageStatus.delivered);
        expect(rows.single.payload, isEmpty);

        // The stripped shell survives the short grace, then bounded cleanup
        // deletes it.
        var report = await maintenance.runOnce(now: now);
        expect(report.prunedDeliveredRows, 0);
        report = await maintenance.runOnce(
          now: now.add(
            sessionOutboxDeliveredRetention + const Duration(hours: 1),
          ),
        );
        expect(report.prunedDeliveredRows, 1);
        rows = await outbox.loadForSession(key, brokerProfileId: 'local');
        expect(rows, isEmpty);
      },
    );

    test('late receipts on a pruned row are harmless no-ops', () async {
      await outbox.upsert(
        promptRow('cm-gone', createdAt: now.subtract(const Duration(days: 2))),
      );
      await outbox.markDelivered('cm-gone');
      await database.customStatement(
        'UPDATE session_outbox_rows SET updated_at = ? '
        "WHERE client_message_id = 'cm-gone'",
        [now.millisecondsSinceEpoch ~/ 1000],
      );
      await maintenance.runOnce(
        now: now.add(const Duration(days: 3)),
      );

      await outbox.markDelivered('cm-gone');
      await outbox.markFailed('cm-gone', 'late nack');
      final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
      expect(rows, isEmpty);
    });
  });

  group('failed-row retention', () {
    test(
      'recent failures stay visible; abandoned ones expire finitely',
      () async {
        await outbox.upsert(promptRow('cm-recent'));
        await outbox.markFailed('cm-recent', 'recent nack');
        await outbox.upsert(
          promptRow(
            'cm-ancient',
            createdAt: now.subtract(const Duration(days: 40)),
          ),
        );
        await outbox.markFailed('cm-ancient', 'ancient nack');
        // Backdate the ancient row's mutation time past the TTL.
        await database.customStatement(
          'UPDATE session_outbox_rows SET updated_at = ? '
          "WHERE client_message_id = 'cm-ancient'",
          [
            now
                    .subtract(sessionOutboxFailedRetention)
                    .subtract(const Duration(days: 1))
                    .millisecondsSinceEpoch ~/
                1000,
          ],
        );

        final report = await maintenance.runOnce(now: now);
        expect(report.prunedFailedRows, 1);

        final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
        expect(rows.single.clientMessageId, 'cm-recent');
        expect(rows.single.status, SessionOutboxMessageStatus.failed);
      },
    );
  });

  group('live-row expiry and draft restore', () {
    test(
      'an over-window prompt fails terminally and restores its text',
      () async {
        await outbox.upsert(
          promptRow(
            'cm-expired',
            createdAt: now.subtract(
              sessionOutboxRetryWindow + const Duration(minutes: 1),
            ),
            text: 'unsent important text',
          ),
        );

        final report = await maintenance.runOnce(now: now);
        expect(report.expiredOutboxRows, 1);
        expect(report.restoredDrafts, 1);

        final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
        expect(rows.single.status, SessionOutboxMessageStatus.failed);

        final draft = await drafts.load(
          brokerProfileId: 'local',
          sessionKey: key,
        );
        expect(draft, isNotNull);
        expect(draft!.text, 'unsent important text');
        expect(draft.dirty, isTrue);
      },
    );

    test(
      'expiry never clobbers a newer dirty draft; it preserves a conflict',
      () async {
        await outbox.upsert(
          promptRow(
            'cm-expired-2',
            createdAt: now.subtract(const Duration(hours: 1)),
            text: 'old failed prompt',
          ),
        );
        await drafts.save(
          SessionLocalDraft(
            brokerProfileId: 'local',
            sessionKey: key,
            text: 'newer local edit',
            localRevision: 3,
            baseBrokerRevision: 2,
            dirty: true,
            updatedAt: now,
          ),
        );

        final report = await maintenance.runOnce(now: now);
        expect(report.expiredOutboxRows, 1);

        final draft = await drafts.load(
          brokerProfileId: 'local',
          sessionKey: key,
        );
        expect(draft!.text, 'newer local edit');
        expect(draft.conflictText, 'old failed prompt');
      },
    );

    test('retryable rows inside the window are never expired', () async {
      await outbox.upsert(promptRow('cm-live', createdAt: now));

      final report = await maintenance.runOnce(now: now);
      expect(report.expiredOutboxRows, 0);
      final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
      expect(rows.single.status, SessionOutboxMessageStatus.queued);
    });

    test(
      'a receipt racing the expiry pass never regresses to failed',
      () async {
        await outbox.upsert(
          promptRow(
            'cm-race',
            createdAt: now.subtract(const Duration(hours: 1)),
            text: 'delivered meanwhile',
          ),
        );
        await outbox.markSending('cm-race');

        // The pass SELECTs its candidates first; the receipt lands right after,
        // before the conditional claim. Statement order on one drift executor
        // is FIFO, so this interleaving is deterministic: select, deliver,
        // claim. An unconditional mark here would overwrite the delivered
        // status and "restore" a prompt the agent already ran.
        final pass = maintenance.runOnce(now: now);
        await outbox.markDelivered('cm-race');
        final report = await pass;

        expect(report.expiredOutboxRows, 0);
        expect(report.restoredDrafts, 0);
        final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
        expect(rows.single.status, SessionOutboxMessageStatus.delivered);
        expect(
          await drafts.load(brokerProfileId: 'local', sessionKey: key),
          isNull,
          reason: 'an already-sent prompt must not come back as a draft',
        );
      },
    );

    test('a restore advances the version every other writer checks', () async {
      final seeded = await drafts.save(
        SessionLocalDraft(
          brokerProfileId: 'local',
          sessionKey: key,
          text: 'old failed prompt',
          localRevision: 2,
          baseBrokerRevision: 1,
          dirty: false,
          submittedClientMessageId: 'cm-expired-3',
          updatedAt: now,
        ),
      );
      await outbox.upsert(
        promptRow(
          'cm-expired-3',
          createdAt: now.subtract(const Duration(hours: 1)),
          text: 'old failed prompt',
        ),
      );

      final report = await maintenance.runOnce(now: now);
      expect(report.restoredDrafts, 1);

      final restored = await drafts.load(
        brokerProfileId: 'local',
        sessionKey: key,
      );
      expect(
        restored!.mutationVersion,
        greaterThan(seeded!.mutationVersion),
        reason: 'maintenance writes must be visible to conditional writers',
      );
      // A controller still reasoning from the pre-maintenance row is refused —
      // this is how a live session learns the row changed underneath it.
      expect(
        await drafts.save(
          seeded.copyWith(text: 'stale controller write', updatedAt: now),
        ),
        isNull,
      );
    });
  });

  group('draft retention', () {
    test(
      'TTL expires abandoned rows but preserves fresh unresolved conflicts',
      () async {
        await drafts.save(
          SessionLocalDraft(
            brokerProfileId: 'local',
            sessionKey: key,
            text: 'abandoned',
            localRevision: 1,
            baseBrokerRevision: 0,
            dirty: true,
            updatedAt: now.subtract(
              localDraftRetention + const Duration(days: 1),
            ),
          ),
        );
        await drafts.save(
          SessionLocalDraft(
            brokerProfileId: 'local',
            sessionKey: const SessionDetailKey(tool: 'codex', sessionId: 's-2'),
            text: 'fresh conflict',
            localRevision: 1,
            baseBrokerRevision: 1,
            dirty: true,
            conflictText: 'shared side',
            conflictBrokerRevision: 2,
            updatedAt: now,
          ),
        );

        final report = await maintenance.runOnce(now: now);
        expect(report.prunedDraftRows, 1);
        expect(
          await drafts.load(brokerProfileId: 'local', sessionKey: key),
          isNull,
        );
        final kept = await drafts.load(
          brokerProfileId: 'local',
          sessionKey: const SessionDetailKey(tool: 'codex', sessionId: 's-2'),
        );
        expect(kept!.conflictText, 'shared side');
      },
    );

    test('the per-profile LRU cap evicts oldest rows first', () async {
      for (var i = 0; i < maxRetainedLocalDraftsPerProfile + 5; i++) {
        await drafts.save(
          SessionLocalDraft(
            brokerProfileId: 'local',
            sessionKey: SessionDetailKey(tool: 'codex', sessionId: 's-$i'),
            text: 'draft $i',
            localRevision: 1,
            baseBrokerRevision: 0,
            dirty: true,
            updatedAt: now.subtract(Duration(minutes: i)),
          ),
        );
      }

      final report = await maintenance.runOnce(now: now);
      expect(report.prunedDraftRows, 5);

      final remaining = await database
          .customSelect('SELECT COUNT(*) AS c FROM session_draft_rows')
          .getSingle();
      expect(remaining.read<int>('c'), maxRetainedLocalDraftsPerProfile);
      // The newest rows survived.
      expect(
        await drafts.load(
          brokerProfileId: 'local',
          sessionKey: const SessionDetailKey(tool: 'codex', sessionId: 's-0'),
        ),
        isNotNull,
      );
      expect(
        await drafts.load(
          brokerProfileId: 'local',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 's-${maxRetainedLocalDraftsPerProfile + 4}',
          ),
        ),
        isNull,
      );
    });
  });

  group('bounded batches and forward progress', () {
    test('one pass is capped and repeated passes finish the work', () async {
      const total = SessionLocalMaintenance.cleanupBatchLimit + 30;
      for (var i = 0; i < total; i++) {
        await outbox.upsert(
          promptRow(
            'cm-bulk-$i',
            createdAt: now.subtract(const Duration(days: 3)),
          ),
        );
        await outbox.markDelivered('cm-bulk-$i');
      }
      await database.customStatement(
        'UPDATE session_outbox_rows SET updated_at = ?',
        [now.subtract(const Duration(days: 2)).millisecondsSinceEpoch ~/ 1000],
      );

      final first = await maintenance.runOnce(now: now);
      expect(
        first.prunedDeliveredRows,
        SessionLocalMaintenance.cleanupBatchLimit,
      );
      expect(first.madeProgress, isTrue);

      final second = await maintenance.runOnce(now: now);
      expect(second.prunedDeliveredRows, 30);

      final third = await maintenance.runOnce(now: now);
      expect(third.madeProgress, isFalse);
      final rows = await outbox.loadForSession(key, brokerProfileId: 'local');
      expect(rows, isEmpty);
    });
  });
}
