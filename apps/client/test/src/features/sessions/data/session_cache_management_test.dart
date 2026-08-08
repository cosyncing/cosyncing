import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_cache_management.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_cache_write_fence.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_transcript_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late SessionCacheWriteFence writeFence;
  late DriftSessionTranscriptRepository transcripts;
  late DriftRosterSnapshotRepository rosters;
  late SessionCacheManagement cache;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    writeFence = SessionCacheWriteFence();
    transcripts = DriftSessionTranscriptRepository(
      database,
      writeFence: writeFence,
    );
    rosters = DriftRosterSnapshotRepository(
      database,
      writeFence: writeFence,
    );
    cache = SessionCacheManagement(database, writeFence: writeFence);
  });

  tearDown(() => database.close());

  Future<void> seed(String source, String sessionId) => transcripts.upsert(
    SessionTranscriptSnapshot(
      brokerProfileId: source,
      sessionKey: SessionDetailKey(tool: 'codex', sessionId: sessionId),
      messages: [
        AgentMessage.fromJson({
          'type': 'model-output',
          'text': '$source/$sessionId',
        }),
      ],
      hasEarlier: false,
      updatedAt: DateTime(2026),
    ),
  );

  Future<void> seedRoster(String profile) async {
    await rosters.save(
      brokerProfileId: profile,
      endpoint: 'https://$profile.example',
      sessions: const [
        SessionInfo(
          id: 'roster-session',
          tool: 'codex',
          title: 'Roster row',
          status: SessionStatus.idle,
          attachMode: AttachMode.observe,
        ),
      ],
    );
  }

  test('current clear deletes only exact source + tool + session', () async {
    await seed('profile-a@endpoint-a', 'same-id');
    await seed('profile-a@endpoint-b', 'same-id');
    await seed('profile-a@endpoint-a', 'other-id');

    final removed = await cache.clearCurrentSession(
      brokerSourceKey: 'profile-a@endpoint-a',
      sessionKey: const SessionDetailKey(
        tool: 'codex',
        sessionId: 'same-id',
      ),
    );

    expect(removed, 1);
    expect(
      await transcripts.load(
        brokerProfileId: 'profile-a@endpoint-a',
        sessionKey: const SessionDetailKey(
          tool: 'codex',
          sessionId: 'same-id',
        ),
      ),
      isNull,
    );
    expect(
      await transcripts.load(
        brokerProfileId: 'profile-a@endpoint-b',
        sessionKey: const SessionDetailKey(
          tool: 'codex',
          sessionId: 'same-id',
        ),
      ),
      isNotNull,
    );
    expect(
      await transcripts.load(
        brokerProfileId: 'profile-a@endpoint-a',
        sessionKey: const SessionDetailKey(
          tool: 'codex',
          sessionId: 'other-id',
        ),
      ),
      isNotNull,
    );
  });

  test(
    'current clear invalidates only its exact controller admission',
    () async {
      final exact = writeFence.admitTranscript(
        brokerSourceKey: 'profile-a@endpoint-a',
        tool: 'codex',
        sessionId: 'same-id',
      );
      final otherSource = writeFence.admitTranscript(
        brokerSourceKey: 'profile-a@endpoint-b',
        tool: 'codex',
        sessionId: 'same-id',
      );
      final otherSession = writeFence.admitTranscript(
        brokerSourceKey: 'profile-a@endpoint-a',
        tool: 'codex',
        sessionId: 'other-id',
      );
      final otherTool = writeFence.admitTranscript(
        brokerSourceKey: 'profile-a@endpoint-a',
        tool: 'claude',
        sessionId: 'same-id',
      );
      final roster = writeFence.admitRoster();

      await cache.clearCurrentSession(
        brokerSourceKey: 'profile-a@endpoint-a',
        sessionKey: const SessionDetailKey(
          tool: 'codex',
          sessionId: 'same-id',
        ),
      );

      expect(writeFence.claim(exact), isFalse);
      expect(writeFence.claim(otherSource), isTrue);
      expect(writeFence.claim(otherSession), isTrue);
      expect(writeFence.claim(otherTool), isTrue);
      expect(writeFence.claim(roster), isTrue);
    },
  );

  test('all clear invalidates every controller cache admission', () async {
    final transcriptA = writeFence.admitTranscript(
      brokerSourceKey: 'profile-a@endpoint-a',
      tool: 'codex',
      sessionId: 'one',
    );
    final transcriptB = writeFence.admitTranscript(
      brokerSourceKey: 'profile-b@endpoint-b',
      tool: 'claude',
      sessionId: 'two',
    );
    final roster = writeFence.admitRoster();

    await cache.clearAll();

    expect(writeFence.claim(transcriptA), isFalse);
    expect(writeFence.claim(transcriptB), isFalse);
    expect(writeFence.claim(roster), isFalse);
  });

  test(
    'current clear drains an admitted transcript write before deletion',
    () async {
      final entered = Completer<void>();
      final release = Completer<void>();
      final blocker = writeFence.write(() async {
        entered.complete();
        await release.future;
      });
      await entered.future;

      final heldWrite = seed('profile-a@endpoint-a', 'held');
      final clearing = cache.clearCurrentSession(
        brokerSourceKey: 'profile-a@endpoint-a',
        sessionKey: const SessionDetailKey(
          tool: 'codex',
          sessionId: 'held',
        ),
      );
      release.complete();
      await blocker;
      await heldWrite;

      expect(await clearing, 1);
      expect(
        await transcripts.load(
          brokerProfileId: 'profile-a@endpoint-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'held',
          ),
        ),
        isNull,
        reason: 'the older held write must not resurrect the cleared row',
      );

      await seed('profile-a@endpoint-a', 'held');
      expect(
        await transcripts.load(
          brokerProfileId: 'profile-a@endpoint-a',
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'held',
          ),
        ),
        isNotNull,
        reason: 'a genuinely post-clear event remains persistable',
      );
    },
  );

  test('all clear drains an admitted roster write before deletion', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final blocker = writeFence.write(() async {
      entered.complete();
      await release.future;
    });
    await entered.future;

    final heldWrite = seedRoster('held-profile');
    final clearing = cache.clearAll();
    release.complete();
    await blocker;
    await heldWrite;

    expect((await clearing).rosters, 1);
    expect(
      await rosters.load(
        'held-profile',
        endpoint: 'https://held-profile.example',
      ),
      isNull,
      reason: 'the older held write must not recreate a cleared roster',
    );

    await seedRoster('held-profile');
    expect(
      await rosters.load(
        'held-profile',
        endpoint: 'https://held-profile.example',
      ),
      isNotNull,
      reason: 'a genuinely post-clear roster remains persistable',
    );
  });

  test(
    'all clear deletes only rebuildable transcript and roster cache',
    () async {
      await seed('profile-a@endpoint-a', 'one');
      await seed('profile-b@endpoint-b', 'two');
      for (final profile in ['profile-a', 'profile-b']) {
        await seedRoster(profile);
      }
      await database.customStatement(
        'INSERT INTO app_setting_rows (key, value, updated_at) '
        'VALUES (?, ?, ?)',
        ['unrelated-authority', 'keep', 0],
      );

      final removed = await cache.clearAll();

      expect(removed.transcripts, 2);
      expect(removed.rosters, 2);
      expect(
        await database
            .customSelect(
              'SELECT COUNT(*) AS count FROM session_transcript_rows',
            )
            .getSingle()
            .then((row) => row.read<int>('count')),
        0,
      );
      expect(
        await database
            .customSelect('SELECT COUNT(*) AS count FROM roster_snapshot_rows')
            .getSingle()
            .then((row) => row.read<int>('count')),
        0,
      );
      expect(
        await database
            .customSelect(
              'SELECT COUNT(*) AS count FROM app_setting_rows',
            )
            .getSingle()
            .then((row) => row.read<int>('count')),
        1,
      );
    },
  );
}
