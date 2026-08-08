import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_draft_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

/// Two repositories over the same database file — the multi-tab shape: no
/// shared cache, no shared mutation chain, no shared transaction.
Future<(SessionDraftRepository, SessionDraftRepository)> _twoTabs() async {
  final directory = await Directory.systemTemp.createTemp('dr1-two-tab');
  addTearDown(() => directory.delete(recursive: true));
  final file = File('${directory.path}/client.sqlite');
  final tabOne = AppDatabase(NativeDatabase(file));
  addTearDown(tabOne.close);
  // Open (and migrate) sequentially — a real second tab opens an
  // already-migrated database; only the row writes race.
  await tabOne.customSelect('SELECT 1').get();
  final tabTwo = AppDatabase(NativeDatabase(file));
  addTearDown(tabTwo.close);
  await tabTwo.customSelect('SELECT 1').get();
  return (
    DriftSessionDraftRepository(tabOne),
    DriftSessionDraftRepository(tabTwo),
  );
}

void main() {
  late AppDatabase database;
  late DriftSessionDraftRepository repository;

  const key = SessionDetailKey(tool: 'codex', sessionId: 'session-1');

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftSessionDraftRepository(database);
  });

  tearDown(() => database.close());

  SessionLocalDraft draft({
    String brokerProfileId = 'profile-a',
    SessionDetailKey sessionKey = key,
    String text = 'draft text',
    bool dirty = true,
    int baseBrokerRevision = 0,
    String? submittedClientMessageId,
    String? conflictText,
    int? conflictBrokerRevision,
    DateTime? updatedAt,
  }) {
    return SessionLocalDraft(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      text: text,
      localRevision: 1,
      baseBrokerRevision: baseBrokerRevision,
      dirty: dirty,
      submittedClientMessageId: submittedClientMessageId,
      conflictText: conflictText,
      conflictBrokerRevision: conflictBrokerRevision,
      updatedAt: updatedAt ?? DateTime.utc(2026, 7, 24),
    );
  }

  test('round-trips one draft row with full conflict state', () async {
    await repository.save(
      draft(
        baseBrokerRevision: 7,
        submittedClientMessageId: 'cm-1',
        conflictText: 'shared version',
        conflictBrokerRevision: 9,
      ),
    );

    final row = await repository.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(row, isNotNull);
    expect(row!.text, 'draft text');
    expect(row.dirty, isTrue);
    expect(row.baseBrokerRevision, 7);
    expect(row.submittedClientMessageId, 'cm-1');
    expect(row.conflictText, 'shared version');
    expect(row.conflictBrokerRevision, 9);
    expect(row.hasConflict, isTrue);
  });

  test('save replaces the single current revision per session', () async {
    final first = await repository.save(draft(text: 'first'));
    // A write carries the version of the row it was computed from, so the
    // second one has to build on the first — that is what makes a concurrent
    // writer's change impossible to overwrite blind.
    final second = await repository.save(
      draft(
        text: 'second',
        dirty: false,
      ).copyWith(mutationVersion: first!.mutationVersion),
    );

    final row = await repository.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(row!.text, 'second');
    expect(row.dirty, isFalse);
    expect(row.mutationVersion, second!.mutationVersion);
  });

  test(
    'accepted writes are observable without polling and stay isolated',
    () async {
      final observed = <SessionLocalDraft?>[];
      final subscription = repository
          .watch(brokerProfileId: 'profile-a', sessionKey: key)
          .listen(observed.add);
      addTearDown(subscription.cancel);
      await Future<void>.delayed(Duration.zero);

      await repository.save(draft(text: 'visible in the other window'));
      await Future<void>.delayed(Duration.zero);

      expect(observed.last?.text, 'visible in the other window');
      await repository.save(
        draft(
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'different',
          ),
          text: 'different session',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(observed.last?.text, 'visible in the other window');
    },
  );

  test('two connections over one file cannot lose a write', () async {
    // A second browser tab is a second AppDatabase over the same file: it
    // shares no mutation chain and no transaction with this one, so the row
    // version is the only thing standing between them and a lost update.
    final directory = await Directory.systemTemp.createTemp('dr1-two-tab');
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/client.sqlite');
    final tabOne = AppDatabase(NativeDatabase(file));
    addTearDown(tabOne.close);
    final tabTwo = AppDatabase(NativeDatabase(file));
    addTearDown(tabTwo.close);
    final one = DriftSessionDraftRepository(tabOne);
    final two = DriftSessionDraftRepository(tabTwo);

    final seeded = await one.save(draft(text: 'seed'));

    // Both tabs read the same row, then both write from it.
    final readByOne = await one.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    final readByTwo = await two.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(readByOne!.mutationVersion, seeded!.mutationVersion);
    expect(readByTwo!.mutationVersion, seeded.mutationVersion);

    final firstWrite = await one.save(
      readByOne.copyWith(text: 'typed in tab one', updatedAt: DateTime.now()),
    );
    final secondWrite = await two.save(
      readByTwo.copyWith(text: 'typed in tab two', updatedAt: DateTime.now()),
    );

    expect(firstWrite, isNotNull);
    expect(
      secondWrite,
      isNull,
      reason: 'the second tab must be told to reload, not silently win',
    );
    final settled = await two.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(settled!.text, 'typed in tab one');

    // The loser proceeds by CARRYING the winner's value forward as the
    // preserved second version — rebuilding on the current row is not a
    // license to discard it. (The coordinator's edit retry does exactly
    // this; here the same contract is exercised at the repository level.)
    final retried = await two.save(
      settled.copyWith(
        text: 'typed in tab two',
        conflictText: settled.text,
        updatedAt: DateTime.now(),
      ),
    );
    expect(retried, isNotNull);
    final merged = await one.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(merged!.text, 'typed in tab two');
    expect(merged.conflictText, 'typed in tab one');
  });

  test('simultaneous saves from two connections admit exactly one', () async {
    // Truly overlapping writes, not sequential writes from stale snapshots:
    // both statements are in flight together and the database's own write
    // lock — not test ordering — decides the winner.
    final (one, two) = await _twoTabs();
    final seeded = await one.save(draft(text: 'seed'));
    final readByOne = await one.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    final readByTwo = await two.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );

    final results = await Future.wait([
      one.save(
        readByOne!.copyWith(
          text: 'raced by tab one',
          updatedAt: DateTime.now(),
        ),
      ),
      two.save(
        readByTwo!.copyWith(
          text: 'raced by tab two',
          updatedAt: DateTime.now(),
        ),
      ),
    ]);

    final winners = results.whereType<SessionLocalDraft>().toList();
    expect(winners, hasLength(1));
    final settled = await one.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(settled!.text, winners.single.text);
    expect(settled.mutationVersion, seeded!.mutationVersion + 1);
  });

  test('simultaneous first creates admit exactly one row', () async {
    // Neither connection has a stored row, so both writes take the insert
    // path; the conflict clause must refuse one instead of overwriting.
    final (one, two) = await _twoTabs();

    final results = await Future.wait([
      one.save(draft(text: 'created by tab one')),
      two.save(draft(text: 'created by tab two')),
    ]);

    final winners = results.whereType<SessionLocalDraft>().toList();
    expect(winners, hasLength(1));
    expect(
      (await two.load(brokerProfileId: 'profile-a', sessionKey: key))!.text,
      winners.single.text,
    );
  });

  test('delete is conditional on the version the deleter read', () async {
    final (one, two) = await _twoTabs();
    final seeded = await one.save(draft(text: 'seed'));
    // Tab one edits; tab two still reasons from the seeded version, so its
    // delete must refuse instead of destroying the newer text.
    final edited = await one.save(
      seeded!.copyWith(text: 'newer edit', updatedAt: DateTime.now()),
    );

    expect(
      await two.delete(
        brokerProfileId: 'profile-a',
        sessionKey: key,
        expectedMutationVersion: seeded.mutationVersion,
      ),
      isFalse,
    );
    expect(
      (await two.load(brokerProfileId: 'profile-a', sessionKey: key))!.text,
      'newer edit',
    );

    expect(
      await two.delete(
        brokerProfileId: 'profile-a',
        sessionKey: key,
        expectedMutationVersion: edited!.mutationVersion,
      ),
      isTrue,
    );
    expect(
      await one.load(brokerProfileId: 'profile-a', sessionKey: key),
      isNull,
    );
  });

  test('a save against a superseded version is refused', () async {
    final stored = await repository.save(draft(text: 'first'));
    expect(stored, isNotNull);

    // Another writer moved the row on; this one still holds the old version.
    await repository.save(
      draft(
        text: 'from another tab',
      ).copyWith(mutationVersion: stored!.mutationVersion),
    );
    final lost = await repository.save(
      draft(
        text: 'blind overwrite',
      ).copyWith(mutationVersion: stored.mutationVersion),
    );

    expect(lost, isNull, reason: 'the caller must reload, not overwrite');
    final row = await repository.load(
      brokerProfileId: 'profile-a',
      sessionKey: key,
    );
    expect(row!.text, 'from another tab');
  });

  test(
    'profile, tool, and session identities never leak into each other',
    () async {
      await repository.save(draft(text: 'a/codex/session-1'));
      await repository.save(
        draft(brokerProfileId: 'profile-b', text: 'b copy'),
      );
      await repository.save(
        draft(
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 'session-1',
          ),
          text: 'other tool',
        ),
      );
      await repository.save(
        draft(
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-2',
          ),
          text: 'other session',
        ),
      );

      expect(
        (await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: key,
        ))!.text,
        'a/codex/session-1',
      );
      expect(
        (await repository.load(
          brokerProfileId: 'profile-b',
          sessionKey: key,
        ))!.text,
        'b copy',
      );
      expect(
        (await repository.load(
          brokerProfileId: 'profile-a',
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 'session-1',
          ),
        ))!.text,
        'other tool',
      );
    },
  );

  test('delete removes only the scoped row', () async {
    final stored = await repository.save(draft());
    await repository.save(draft(brokerProfileId: 'profile-b', text: 'keep'));

    expect(
      await repository.delete(
        brokerProfileId: 'profile-a',
        sessionKey: key,
        expectedMutationVersion: stored!.mutationVersion,
      ),
      isTrue,
    );

    expect(
      await repository.load(brokerProfileId: 'profile-a', sessionKey: key),
      isNull,
    );
    expect(
      (await repository.load(
        brokerProfileId: 'profile-b',
        sessionKey: key,
      ))!.text,
      'keep',
    );
  });

  test(
    'deleteForProfile removes scope-keyed rows from EVERY endpoint the '
    'profile ever pointed at, and only that profile’s',
    () async {
      // Rows are keyed by broker scope (profile AND endpoint). Deleting the
      // profile is the one flow that spans endpoints: the profile row is
      // gone, so its rows at endpoint A, endpoint B, and any legacy bare-id
      // row all go — while an identically-prefixed OTHER profile survives.
      String scope(String profileId, String endpoint) => RosterSource(
        profileId: profileId,
        endpoint: endpoint,
      ).storageKey;
      await repository.save(
        draft(brokerProfileId: scope('profile-a', 'http://alpha.invalid')),
      );
      await repository.save(
        draft(brokerProfileId: scope('profile-a', 'http://beta.invalid')),
      );
      // The legacy pre-qualification row: a bare profile id.
      await repository.save(draft());
      await repository.save(
        draft(
          brokerProfileId: scope('profile-ab', 'http://alpha.invalid'),
          text: 'keep',
        ),
      );

      await repository.deleteForProfile('profile-a');

      for (final gone in [
        scope('profile-a', 'http://alpha.invalid'),
        scope('profile-a', 'http://beta.invalid'),
        'profile-a',
      ]) {
        expect(
          await repository.load(brokerProfileId: gone, sessionKey: key),
          isNull,
          reason: '$gone must be removed with the profile',
        );
      }
      expect(
        (await repository.load(
          brokerProfileId: scope('profile-ab', 'http://alpha.invalid'),
          sessionKey: key,
        ))!.text,
        'keep',
        reason: 'a longer profile id sharing the prefix is untouched',
      );
    },
  );

  test('deleteForProfile removes every row a removed profile owned', () async {
    await repository.save(draft());
    await repository.save(
      draft(
        sessionKey: const SessionDetailKey(tool: 'claude', sessionId: 's-9'),
      ),
    );
    await repository.save(draft(brokerProfileId: 'profile-b', text: 'keep'));

    await repository.deleteForProfile('profile-a');

    expect(
      await repository.load(brokerProfileId: 'profile-a', sessionKey: key),
      isNull,
    );
    expect(
      (await repository.load(
        brokerProfileId: 'profile-b',
        sessionKey: key,
      ))!.text,
      'keep',
    );
  });

  test(
    'oversized text is refused outright, never stored as a prefix',
    () async {
      // A silently persisted prefix would present a malformed prompt as the
      // draft on the next open while save reported the full value as stored.
      final before = await repository.save(draft(text: 'small recoverable'));
      expect(before, isNotNull);

      final huge = 'x' * (maxLocalDraftTextChars + 5000);
      await expectLater(
        repository.save(
          before!.copyWith(text: huge, localRevision: before.localRevision + 1),
        ),
        throwsArgumentError,
      );

      // The previously stored value survives untouched as the recovery copy.
      final row = await repository.load(
        brokerProfileId: 'profile-a',
        sessionKey: key,
      );
      expect(row!.text, 'small recoverable');
      expect(row.mutationVersion, before.mutationVersion);
    },
  );
}
