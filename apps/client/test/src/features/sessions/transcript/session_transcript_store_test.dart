import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftSessionTranscriptRepository repository;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftSessionTranscriptRepository(database);
  });

  tearDown(() => database.close());

  test('round-trips one profile-scoped transactional snapshot', () async {
    const key = SessionDetailKey(tool: 'codex', sessionId: 'session-1');
    final snapshot = SessionTranscriptSnapshot(
      brokerProfileId: 'profile-a',
      sessionKey: key,
      messages: [
        AgentMessage.fromJson(const {
          'type': 'model-output',
          'key': 'answer-1',
          'text': 'Persisted answer',
        }),
      ],
      cursor: 'newest:42',
      olderCursor: 'older:20',
      hasEarlier: true,
      gap: const HistoryGap(
        code: 'HISTORY_CURSOR_GONE',
        message: 'Full replay used',
      ),
      truncation: const HistoryTruncation(shown: 20, total: 42),
      updatedAt: DateTime.utc(2026, 7, 17, 12),
    );

    await repository.upsert(snapshot);

    final restored = await repository.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(restored, isNotNull);
    expect(restored!.messages.single.raw['text'], 'Persisted answer');
    expect(restored.cursor, 'newest:42');
    expect(restored.olderCursor, 'older:20');
    expect(restored.hasEarlier, isTrue);
    expect(restored.gap?.code, 'HISTORY_CURSOR_GONE');
    expect(restored.truncation?.total, 42);
    expect(restored.updatedAt.toUtc(), DateTime.utc(2026, 7, 17, 12));
  });

  test('same tool/session never leaks across broker profiles', () async {
    const key = SessionDetailKey(tool: 'codex', sessionId: 'same-id');
    await repository.upsert(
      SessionTranscriptSnapshot(
        brokerProfileId: 'profile-a',
        sessionKey: key,
        messages: [
          AgentMessage.fromJson(const {
            'type': 'user-message',
            'key': 'secret-a',
            'text': 'profile A only',
          }),
        ],
        hasEarlier: false,
        updatedAt: DateTime.utc(2026, 7, 17),
      ),
    );

    expect(
      await repository.load(
        brokerProfileId: 'profile-b',
        sessionKey: key,
      ),
      isNull,
    );
  });

  test('upsert atomically replaces messages and represented cursors', () async {
    const key = SessionDetailKey(tool: 'codex', sessionId: 'session-2');
    Future<void> write(String text, String cursor) => repository.upsert(
      SessionTranscriptSnapshot(
        brokerProfileId: 'profile-a',
        sessionKey: key,
        messages: [
          AgentMessage.fromJson({
            'type': 'model-output',
            'key': cursor,
            'text': text,
          }),
        ],
        cursor: cursor,
        hasEarlier: false,
        updatedAt: DateTime.utc(2026, 7, 17),
      ),
    );

    await write('old', 'cursor-1');
    await write('new', 'cursor-2');

    final restored = await repository.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(restored!.messages, hasLength(1));
    expect(restored.messages.single.raw['text'], 'new');
    expect(restored.cursor, 'cursor-2');
  });

  group('persisted message cap', () {
    test('keeps the newest messages and surfaces honest truncation', () async {
      const key = SessionDetailKey(tool: 'codex', sessionId: 'big');
      await repository.upsert(
        _snapshotWith(
          profileId: 'profile-a',
          key: key,
          messageCount: 600,
        ),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored!.messages, hasLength(maxPersistedTranscriptMessages));
      // Oldest 100 dropped; newest 500 (m100..m599) retained in order.
      expect(restored.messages.first.raw['key'], 'm100');
      expect(restored.messages.last.raw['key'], 'm599');
      expect(restored.truncation?.shown, maxPersistedTranscriptMessages);
      expect(restored.truncation?.total, 600);
      // The count cap dropped 100 messages this row no longer represents, so
      // the reconnect cursor's "resume after everything here" claim is false
      // and is not persisted — the next attach fetches authoritative history
      // instead of being told there is nothing to send.
      expect(restored.cursor, isNull);
      // Backward paging state still describes real broker history.
      expect(restored.olderCursor, 'older');
      expect(restored.hasEarlier, isTrue);
    });

    test('honest total keeps the larger broker-reported total', () async {
      const key = SessionDetailKey(tool: 'codex', sessionId: 'big-broker');
      await repository.upsert(
        _snapshotWith(
          profileId: 'profile-a',
          key: key,
          messageCount: 600,
          truncation: const HistoryTruncation(shown: 600, total: 4200),
        ),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored!.truncation?.shown, maxPersistedTranscriptMessages);
      expect(restored.truncation?.total, 4200);
    });

    test('leaves a within-cap snapshot untouched', () async {
      const key = SessionDetailKey(tool: 'codex', sessionId: 'small');
      await repository.upsert(
        _snapshotWith(profileId: 'profile-a', key: key, messageCount: 3),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored!.messages, hasLength(3));
      expect(restored.truncation, isNull);
    });
  });

  group('row retention', () {
    Future<int> rowCount(String profileId) async {
      final rows =
          await (database.select(database.sessionTranscriptRows)..where(
                (row) => row.brokerProfileId.equals(profileId),
              ))
              .get();
      return rows.length;
    }

    Future<void> writeSession(
      String profileId,
      String sessionId,
      DateTime updatedAt,
    ) {
      return repository.upsert(
        _snapshotWith(
          profileId: profileId,
          key: SessionDetailKey(tool: 'codex', sessionId: sessionId),
          messageCount: 1,
          updatedAt: updatedAt,
        ),
      );
    }

    final base = DateTime.utc(2026, 7, 17, 12);

    test('evicts the oldest row once the profile cap is exceeded', () async {
      for (var i = 0; i < maxRetainedTranscriptSessions; i++) {
        await writeSession(
          'profile-a',
          'session-$i',
          base.add(Duration(seconds: i)),
        );
      }
      expect(await rowCount('profile-a'), maxRetainedTranscriptSessions);

      await writeSession(
        'profile-a',
        'session-new',
        base.add(const Duration(seconds: 1000)),
      );

      expect(await rowCount('profile-a'), maxRetainedTranscriptSessions);
      // The oldest row is gone; the just-written and next-oldest remain.
      expect(
        await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-0',
          ),
        ),
        isNull,
      );
      expect(
        await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-new',
          ),
        ),
        isNotNull,
      );
    });

    test('never evicts the row just written, even when oldest', () async {
      for (var i = 0; i < maxRetainedTranscriptSessions; i++) {
        await writeSession(
          'profile-a',
          'session-$i',
          base.add(Duration(seconds: i)),
        );
      }

      // The new row is the oldest by timestamp but must survive as the
      // just-written row; the oldest OTHER row is evicted instead.
      await writeSession(
        'profile-a',
        'session-stale',
        base.subtract(const Duration(days: 1)),
      );

      expect(await rowCount('profile-a'), maxRetainedTranscriptSessions);
      expect(
        await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-stale',
          ),
        ),
        isNotNull,
      );
      expect(
        await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-0',
          ),
        ),
        isNull,
      );
    });

    test('eviction is scoped per broker profile', () async {
      await writeSession('profile-b', 'kept', base);
      for (var i = 0; i <= maxRetainedTranscriptSessions; i++) {
        await writeSession(
          'profile-a',
          'session-$i',
          base.add(Duration(seconds: i)),
        );
      }

      expect(await rowCount('profile-a'), maxRetainedTranscriptSessions);
      expect(await rowCount('profile-b'), 1);
      expect(
        await repository.load(
          brokerProfileId: 'profile-b',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'kept',
          ),
        ),
        isNotNull,
      );
    });
  });

  group('serialized-byte budgets (DR1)', () {
    const key = SessionDetailKey(tool: 'codex', sessionId: 'bytes');

    SessionTranscriptSnapshot sizedSnapshot({
      required int smallCount,
      int largeBytes = 0,
      String profileId = 'profile-a',
      SessionDetailKey sessionKey = key,
      DateTime? updatedAt,
    }) {
      return SessionTranscriptSnapshot(
        brokerProfileId: profileId,
        sessionKey: sessionKey,
        messages: [
          if (largeBytes > 0)
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'large',
              'text': 'L' * largeBytes,
            }),
          for (var i = 0; i < smallCount; i++)
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'small-$i',
              'text': 's$i',
            }),
        ],
        cursor: 'tail',
        hasEarlier: false,
        updatedAt: updatedAt ?? DateTime.utc(2026, 7, 17, 12),
      );
    }

    test('the byte cap is hard: an oversized message is omitted', () async {
      // The newest message alone exceeds the budget. Retaining it anyway would
      // make the advertised cap a suggestion and let one pathological message
      // set the cache size, so it is omitted — the snapshot reports the honest
      // shortfall and the broker cursor remains authoritative for the rest.
      await repository.upsert(
        SessionTranscriptSnapshot(
          brokerProfileId: 'profile-a',
          sessionKey: key,
          messages: [
            for (var i = 0; i < 2; i++)
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'small-$i',
                'text': 's$i',
              }),
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'large',
              'text': 'L' * (maxPersistedTranscriptSnapshotBytes + 1024),
            }),
          ],
          cursor: 'tail',
          olderCursor: 'older',
          hasEarlier: true,
          updatedAt: DateTime.utc(2026, 7, 17, 12),
        ),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored, isNotNull);
      expect(restored!.messages, isEmpty);
      // Honest truncation: 0 of 3 shown.
      expect(restored.truncation?.shown, 0);
      expect(restored.truncation?.total, 3);
      // The tail cursor named the message that was just dropped, so it must not
      // be persisted — resuming from it would ask the broker for everything
      // AFTER the omitted message and silently skip it.
      expect(restored.cursor, isNull);
      // The backward paging cursor still describes real earlier history.
      expect(restored.olderCursor, 'older');
      expect(restored.hasEarlier, isTrue);
    });

    test(
      'a dropped newest message does not leave a cursor claiming it',
      () async {
        // The worst shape: one oversized newest message, a tail reconnect
        // cursor, and NO earlier-history cursor. Keeping the tail cursor would
        // tell the next attach "already at the tail", the broker would send
        // nothing, and with no page to walk back the message would exist in no
        // local row and be reachable by no request.
        await repository.upsert(
          SessionTranscriptSnapshot(
            brokerProfileId: 'profile-a',
            sessionKey: key,
            messages: [
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'only-and-oversized',
                'text': 'L' * (maxPersistedTranscriptSnapshotBytes + 1024),
              }),
            ],
            cursor: 'tail-cursor',
            hasEarlier: false,
            updatedAt: DateTime.utc(2026, 7, 17, 12),
          ),
        );

        final restored = await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: key,
        );
        expect(restored, isNotNull);
        expect(restored!.messages, isEmpty);
        // No cursor is seeded on reopen, so bootstrap asks for authoritative
        // history instead of resuming from a tail it cannot show.
        expect(restored.cursor, isNull);
        expect(restored.truncation?.shown, 0);
        expect(restored.truncation?.total, 1);
      },
    );

    test('dropping only OLDER messages still invalidates the cursor', () async {
      // The newest messages fit and are retained, but older ones were dropped.
      // The tail cursor would still say "resume after everything here", so the
      // broker would send nothing — and with hasEarlier false there is no page
      // to walk back to the dropped messages. Partial truncation is just as
      // unrecoverable as total truncation, so the claim goes too.
      await repository.upsert(
        SessionTranscriptSnapshot(
          brokerProfileId: 'profile-a',
          sessionKey: key,
          messages: [
            for (var i = 0; i < 4; i++)
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'chunk-$i',
                'text': 'C' * (maxPersistedTranscriptSnapshotBytes ~/ 3),
              }),
          ],
          cursor: 'tail-cursor',
          hasEarlier: false,
          updatedAt: DateTime.utc(2026, 7, 17, 12),
        ),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored!.messages, isNotEmpty);
      expect(
        restored.messages.length,
        lessThan(4),
        reason: 'the fixture must actually exercise partial truncation',
      );
      expect(restored.cursor, isNull);
    });

    test('an untruncated snapshot keeps its reconnect cursor', () async {
      // The complementary case that must NOT regress: when the row represents
      // the whole snapshot, the cheap incremental reconnect is preserved.
      await repository.upsert(
        SessionTranscriptSnapshot(
          brokerProfileId: 'profile-a',
          sessionKey: key,
          messages: [
            for (var i = 0; i < 3; i++)
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'small-$i',
                'text': 's$i',
              }),
          ],
          cursor: 'tail-cursor',
          hasEarlier: false,
          updatedAt: DateTime.utc(2026, 7, 17, 12),
        ),
      );

      final restored = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(restored!.messages, hasLength(3));
      expect(restored.cursor, 'tail-cursor');
    });

    test('the stored snapshot never exceeds the advertised budget', () async {
      await repository.upsert(
        SessionTranscriptSnapshot(
          brokerProfileId: 'profile-a',
          sessionKey: key,
          messages: [
            for (var i = 0; i < 6; i++)
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'chunk-$i',
                'text': 'C' * (maxPersistedTranscriptSnapshotBytes ~/ 4),
              }),
          ],
          cursor: 'tail',
          hasEarlier: false,
          updatedAt: DateTime.utc(2026, 7, 17, 12),
        ),
      );

      final stored = await database
          .select(database.sessionTranscriptRows)
          .getSingle();
      expect(
        utf8Length(stored.messagesJson),
        lessThanOrEqualTo(maxPersistedTranscriptSnapshotBytes),
      );
    });

    test(
      'the per-session byte cap drops oldest messages with honest truncation',
      () async {
        // ~2 MiB large + 300 small stays under the 500-count cap but crosses
        // the 4 MiB serialized budget once the tail is big enough.
        const big = maxPersistedTranscriptBytesPerSession - (256 * 1024);
        await repository.upsert(
          sizedSnapshot(smallCount: 2, largeBytes: big),
        );
        final first = await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: key,
        );
        expect(first!.truncation, isNull);

        await repository.upsert(
          sizedSnapshot(smallCount: 4, largeBytes: big * 2),
        );
        final restored = await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: key,
        );
        expect(restored!.messages.length, lessThan(6));
        expect(restored.messages.last.raw['key'], 'small-3');
        expect(restored.truncation, isNotNull);
        expect(
          restored.truncation!.total,
          greaterThan(restored.messages.length),
        );
      },
    );

    test(
      'the per-profile byte budget evicts least-recently updated rows',
      () async {
        // 22 sessions × ~3 MiB ≈ 66 MiB crosses the 64 MiB profile budget.
        const sessions = 22;
        for (var i = 0; i < sessions; i++) {
          await repository.upsert(
            sizedSnapshot(
              smallCount: 0,
              largeBytes: 3 * 1024 * 1024,
              sessionKey: SessionDetailKey(tool: 'codex', sessionId: 'bulk-$i'),
              updatedAt: DateTime.utc(2026, 7, 17).add(Duration(minutes: i)),
            ),
          );
        }

        final total = await database
            .customSelect(
              'SELECT COALESCE(SUM(LENGTH(CAST(messages_json AS BLOB))), 0) '
              'AS total_bytes FROM session_transcript_rows '
              "WHERE broker_profile_id = 'profile-a'",
            )
            .getSingle();
        expect(
          total.read<int>('total_bytes'),
          lessThanOrEqualTo(maxRetainedTranscriptBytesPerProfile),
        );
        // The oldest row was evicted; the just-written newest row survives.
        expect(
          await repository.load(
            brokerProfileId: 'profile-a',
            sessionKey: const SessionDetailKey(
              tool: 'codex',
              sessionId: 'bulk-0',
            ),
          ),
          isNull,
        );
        expect(
          await repository.load(
            brokerProfileId: 'profile-a',
            sessionKey: const SessionDetailKey(
              tool: 'codex',
              sessionId: 'bulk-${sessions - 1}',
            ),
          ),
          isNotNull,
        );
      },
    );
  });
}

SessionTranscriptSnapshot _snapshotWith({
  required String profileId,
  required SessionDetailKey key,
  required int messageCount,
  HistoryTruncation? truncation,
  DateTime? updatedAt,
}) {
  return SessionTranscriptSnapshot(
    brokerProfileId: profileId,
    sessionKey: key,
    messages: [
      for (var i = 0; i < messageCount; i++)
        AgentMessage.fromJson({
          'type': 'model-output',
          'key': 'm$i',
          'text': 'msg $i',
        }),
    ],
    cursor: 'tail',
    olderCursor: 'older',
    hasEarlier: true,
    truncation: truncation,
    updatedAt: updatedAt ?? DateTime.utc(2026, 7, 17, 12),
  );
}
