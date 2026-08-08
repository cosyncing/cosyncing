import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// DR1b: the synchronous keepalive record and its adoption into the durable
/// row.
///
/// The record protocol is what closes the teardown gap DR1 left open, so the
/// assertions here are about ordering and lifetime, not storage mechanics: the
/// value exists in synchronous storage before the edit's own turn of the event
/// loop ends, it is retired the instant the durable row holds it, and a record
/// a destroyed document left behind becomes an ordinary dirty local edit on
/// the next start.
void main() {
  // `RosterSource.storageKey` shape: profile AND endpoint.
  const scope = 'profile-a@https%3A%2F%2Fbroker.example';
  const otherScope = 'profile-b@https%3A%2F%2Fbroker.example';
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  const otherKey = SessionDetailKey(tool: 'claude', sessionId: 'session-2');

  Map<String, String> recordsOf(MemorySessionDraftKeepaliveStore store) => {
    for (final entry in store.readAll().entries)
      if (entry.key.startsWith(sessionDraftKeepalivePrefix))
        entry.key: entry.value,
  };

  String? storedText(
    MemorySessionDraftKeepaliveStore store, {
    String brokerProfileId = scope,
    SessionDetailKey sessionKey = key,
  }) {
    for (final entry in recordsOf(store).entries) {
      final decoded = jsonDecode(entry.value) as Map<String, dynamic>;
      if (decoded['p'] == brokerProfileId &&
          decoded['t'] == sessionKey.tool &&
          decoded['s'] == sessionKey.sessionId) {
        return decoded['x'] as String;
      }
    }
    return null;
  }

  group('recording', () {
    test('an edit is in synchronous storage before its own turn ends', () {
      final store = MemorySessionDraftKeepaliveStore();

      // No await between the edit and the read: this is exactly what a
      // document destroyed by a hard refresh cannot get in front of.
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'unsent prompt',
      );

      expect(storedText(store), 'unsent prompt');
    });

    test('clearing the composer removes the record instead of storing an '
        'empty value', () {
      final store = MemorySessionDraftKeepaliveStore();

      SessionDraftKeepalive(store, installTerminalHook: false)
        ..record(brokerProfileId: scope, sessionKey: key, text: 'draft')
        ..record(brokerProfileId: scope, sessionKey: key, text: '');

      // The mechanism can only ever restore text: with no empty record there
      // is no path by which it erases a draft it did not write.
      expect(recordsOf(store), isEmpty);
    });

    test(
      'an oversized value is refused and leaves the last recoverable one',
      () {
        final store = MemorySessionDraftKeepaliveStore();

        SessionDraftKeepalive(store, installTerminalHook: false)
          ..record(brokerProfileId: scope, sessionKey: key, text: 'kept')
          ..record(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'x' * (maxLocalDraftTextChars + 1),
          );

        expect(storedText(store), 'kept');
      },
    );

    test('records stay bounded, evicting the oldest session first', () {
      final store = MemorySessionDraftKeepaliveStore();
      var tick = 0;
      final keepalive = SessionDraftKeepalive(
        store,
        installTerminalHook: false,
        clock: () => DateTime.fromMillisecondsSinceEpoch(tick += 1000),
      );

      for (
        var index = 0;
        index < maxSessionDraftKeepaliveRecords + 3;
        index++
      ) {
        keepalive.record(
          brokerProfileId: scope,
          sessionKey: SessionDetailKey(tool: 'claude', sessionId: 's$index'),
          text: 'draft $index',
        );
      }

      expect(recordsOf(store), hasLength(maxSessionDraftKeepaliveRecords));
      expect(
        storedText(
          store,
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 's0',
          ),
        ),
        isNull,
      );
      expect(
        storedText(
          store,
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 's10',
          ),
        ),
        'draft 10',
      );
    });

    test('a refused write yields older records to the newest value', () {
      // Room for one record only: the second write is refused until the first
      // record — which still has its durable row behind it — is evicted.
      final store = MemorySessionDraftKeepaliveStore(capacityChars: 220);
      var tick = 0;
      SessionDraftKeepalive(
          store,
          installTerminalHook: false,
          clock: () => DateTime.fromMillisecondsSinceEpoch(tick += 1000),
        )
        ..record(brokerProfileId: scope, sessionKey: key, text: 'older')
        ..record(
          brokerProfileId: scope,
          sessionKey: otherKey,
          text: 'newest',
        );

      expect(store.refusedWrites, greaterThan(0));
      expect(recordsOf(store), hasLength(1));
      expect(storedText(store, sessionKey: otherKey), 'newest');
    });

    test('a write nothing can make room for is retried at teardown', () {
      final store = MemorySessionDraftKeepaliveStore(capacityChars: 1);
      final keepalive = SessionDraftKeepalive(store, installTerminalHook: false)
        ..record(brokerProfileId: scope, sessionKey: key, text: 'draft');
      expect(keepalive.refusedWriteCount, 1);
      expect(recordsOf(store), isEmpty);

      // The terminal hook calls exactly this on pagehide/visibilitychange.
      store.capacityChars = null;
      keepalive.retryRefusedWrites();

      expect(keepalive.refusedWriteCount, 0);
      expect(storedText(store), 'draft');
    });

    test('sessions and profiles never share a record', () {
      final store = MemorySessionDraftKeepaliveStore();

      SessionDraftKeepalive(store, installTerminalHook: false)
        ..record(brokerProfileId: scope, sessionKey: key, text: 'one')
        ..record(brokerProfileId: scope, sessionKey: otherKey, text: 'two')
        ..record(brokerProfileId: otherScope, sessionKey: key, text: 'three');

      expect(storedText(store), 'one');
      expect(storedText(store, sessionKey: otherKey), 'two');
      expect(storedText(store, brokerProfileId: otherScope), 'three');
    });
  });

  group('inheritance', () {
    test('only what a previous document left behind is inheritable', () {
      final store = MemorySessionDraftKeepaliveStore();
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'typed before the refresh',
      );

      // A new document over the same backing: the snapshot is taken once, at
      // construction, so this document's own edits can never be adopted back
      // over the composer that is writing them.
      final next = SessionDraftKeepalive(store, installTerminalHook: false);
      expect(next.inherited, hasLength(1));
      expect(next.inherited.single.text, 'typed before the refresh');

      next.record(
        brokerProfileId: scope,
        sessionKey: otherKey,
        text: 'live typing',
      );
      expect(
        next.inheritedFor(brokerProfileId: scope, sessionKey: otherKey),
        isNull,
      );
    });

    test('a full store of unadopted records survives a ninth live edit', () {
      // An inherited record is, by definition, a value whose durable write may
      // never have completed. Evicting one to make room leaves its text in
      // this document's memory only, and the next teardown loses it for good.
      // The bound must fall on the NEW write instead.
      final store = MemorySessionDraftKeepaliveStore();
      var tick = 0;
      final previousDocument = SessionDraftKeepalive(
        store,
        installTerminalHook: false,
        clock: () => DateTime.fromMillisecondsSinceEpoch(tick += 1000),
      );
      for (var index = 0; index < maxSessionDraftKeepaliveRecords; index++) {
        previousDocument.record(
          brokerProfileId: scope,
          sessionKey: SessionDetailKey(tool: 'claude', sessionId: 's$index'),
          text: 'inherited draft $index',
        );
      }
      expect(recordsOf(store), hasLength(maxSessionDraftKeepaliveRecords));
      final live = SessionDraftKeepalive(store, installTerminalHook: false);
      expect(live.inherited, hasLength(maxSessionDraftKeepaliveRecords));

      // A ninth session is edited in this document, with every inherited
      // record still unadopted.
      live.record(
        brokerProfileId: scope,
        sessionKey: const SessionDetailKey(tool: 'claude', sessionId: 's-new'),
        text: 'the ninth, live edit',
      );

      // Document destruction: a new keepalive over the same backing is all
      // that is left to recover from.
      final afterTeardown = SessionDraftKeepalive(
        store,
        installTerminalHook: false,
      );
      final recovered = afterTeardown.inherited.map((r) => r.text).toSet();
      for (var index = 0; index < maxSessionDraftKeepaliveRecords; index++) {
        expect(
          recovered,
          contains('inherited draft $index'),
          reason: 'an unadopted record was evicted to make room',
        );
      }
    });

    test('an adopted record stops protecting its slot', () {
      final store = MemorySessionDraftKeepaliveStore();
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'no longer needed once adopted',
      );
      final live = SessionDraftKeepalive(store, installTerminalHook: false);
      live.discardInherited(live.inherited.single);

      expect(recordsOf(store), isEmpty);
      expect(live.inherited, isEmpty);
    });

    test('malformed entries are dropped rather than inherited', () {
      final store = MemorySessionDraftKeepaliveStore(
        seed: {
          '${sessionDraftKeepalivePrefix}broken': 'not json',
          'unrelated.key': 'left alone',
        },
      );

      final keepalive = SessionDraftKeepalive(
        store,
        installTerminalHook: false,
      );

      expect(keepalive.inherited, isEmpty);
      expect(recordsOf(store), isEmpty);
      expect(store.readAll()['unrelated.key'], 'left alone');
    });
  });

  group('adoption into the durable row', () {
    late AppDatabase database;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
    });

    ({SessionDraftKeepalive keepalive, DriftSessionDraftRepository repository})
    reopenOver(MemorySessionDraftKeepaliveStore store) {
      final keepalive = SessionDraftKeepalive(
        store,
        installTerminalHook: false,
      );
      return (
        keepalive: keepalive,
        repository: DriftSessionDraftRepository(
          database,
          keepalive: keepalive,
        ),
      );
    }

    test(
      'a keystroke during the FIRST save rebases onto the inserted row',
      () async {
        // The insert path is this tab's own lineage too. Before the first save
        // there is no row, so a keystroke recorded while that insert is in
        // flight carries a null base — and a null base is not "typed over some
        // other row", it is "typed over nothing", which is exactly what the
        // insert also found. Settling must rebase it, or the next start
        // reads it against the freshly inserted row and manufactures a
        // conflict out of one tab's own typing.
        final store = MemorySessionDraftKeepaliveStore();
        final keepalive = SessionDraftKeepalive(
          store,
          installTerminalHook: false,
        );
        final repository = DriftSessionDraftRepository(
          database,
          keepalive: keepalive,
        );

        // The composer types; nothing is durable yet, so the base is null.
        keepalive.record(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'first word, then more',
        );
        // The debounce writes the earlier value. With no row present this is an
        // INSERT, and it lands at version 1.
        final inserted = await repository.save(
          SessionLocalDraft.create(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'first word',
          ),
        );
        expect(inserted!.mutationVersion, 1);

        final next = reopenOver(store);
        final loaded = await next.repository.load(
          brokerProfileId: scope,
          sessionKey: key,
        );

        // Same tab, one linear history: the tail is adopted, not disputed.
        expect(loaded?.text, 'first word, then more');
        expect(
          loaded?.conflictText,
          isNull,
          reason: "a conflict was manufactured from one tab's own typing",
        );
      },
    );

    test('a row another tab advanced survives, and the record is kept as its '
        'second version', () async {
      // The inverse of the favourable ordering: the RECORD is written first,
      // against the row as this tab last saw it, and only then does another
      // tab (sharing the Drift row, not this tab's sessionStorage) write
      // something newer. Adoption must not roll that back.
      final store = MemorySessionDraftKeepaliveStore();
      final shared = DriftSessionDraftRepository(database);
      final asThisTabSawIt = await shared.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'what this tab was editing',
        ),
      );
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'unsent tail this tab never landed',
        baseMutationVersion: asThisTabSawIt!.mutationVersion,
      );
      // Another tab moves the shared row on while this one is gone.
      final byAnotherTab = await shared.save(
        asThisTabSawIt.copyWith(text: 'newer, written by another tab'),
      );
      expect(
        byAnotherTab!.mutationVersion,
        greaterThan(asThisTabSawIt.mutationVersion),
      );

      final next = reopenOver(store);
      final loaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      // The newer row wins the composer.
      expect(loaded?.text, 'newer, written by another tab');
      // And this tab's unsent text is not dropped: it becomes the row's second
      // version, which is what DR1's Keep-device/Use-shared choice offers.
      expect(loaded?.conflictText, 'unsent tail this tab never landed');
      expect(next.keepalive.inherited, isEmpty);
    });

    test(
      'a row another tab advanced to the SAME text needs no conflict',
      () async {
        final store = MemorySessionDraftKeepaliveStore();
        final shared = DriftSessionDraftRepository(database);
        final base = await shared.save(
          SessionLocalDraft.create(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'starting point',
          ),
        );
        SessionDraftKeepalive(store, installTerminalHook: false).record(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'both arrived here',
          baseMutationVersion: base!.mutationVersion,
        );
        await shared.save(base.copyWith(text: 'both arrived here'));

        final next = reopenOver(store);
        final loaded = await next.repository.load(
          brokerProfileId: scope,
          sessionKey: key,
        );

        expect(loaded?.text, 'both arrived here');
        expect(loaded?.conflictText, isNull);
        expect(next.keepalive.inherited, isEmpty);
      },
    );

    test('a record with no row at all becomes a dirty local draft', () async {
      final store = MemorySessionDraftKeepaliveStore();
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'never debounced',
      );

      final next = reopenOver(store);
      final loaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      expect(loaded?.text, 'never debounced');
      expect(loaded?.dirty, isTrue);
      // Adopted, therefore retired: the durable row is authoritative again.
      expect(next.keepalive.inherited, isEmpty);
      expect(recordsOf(store), isEmpty);
      final reloaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );
      expect(reloaded?.text, 'never debounced');
      expect(reloaded?.localRevision, loaded?.localRevision);
    });

    test(
      'a record newer than the row supersedes it and stays publishable',
      () async {
        final store = MemorySessionDraftKeepaliveStore();
        final seeded = DriftSessionDraftRepository(database);
        final debounced = await seeded.save(
          SessionLocalDraft.create(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'hello',
          ).copyWith(dirty: false, submittedClientMessageId: 'send-1'),
        );
        SessionDraftKeepalive(store, installTerminalHook: false).record(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'hello world',
          // The composer was editing exactly this row, which is what the live
          // recording path passes and what makes adoption safe to do.
          baseMutationVersion: debounced!.mutationVersion,
        );

        final next = reopenOver(store);
        final loaded = await next.repository.load(
          brokerProfileId: scope,
          sessionKey: key,
        );

        expect(loaded?.text, 'hello world');
        expect(loaded?.dirty, isTrue);
        expect(loaded!.localRevision, greaterThan(debounced.localRevision));
        // A new local value retires the outbox association, exactly as an edit
        // typed into the live composer does.
        expect(loaded.submittedClientMessageId, isNull);
      },
    );

    test('a record the row already holds is retired without a write', () async {
      final store = MemorySessionDraftKeepaliveStore();
      final seeded = DriftSessionDraftRepository(database);
      final stored = await seeded.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'landed',
        ),
      );
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'landed',
      );

      final next = reopenOver(store);
      final loaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      expect(loaded?.text, 'landed');
      expect(loaded?.mutationVersion, stored?.mutationVersion);
      expect(recordsOf(store), isEmpty);
    });

    test('a preserved second version survives adoption', () async {
      final store = MemorySessionDraftKeepaliveStore();
      final seeded = await DriftSessionDraftRepository(database).save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'mine',
        ).copyWith(conflictText: 'theirs', conflictBrokerRevision: 7),
      );
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'mine, extended',
        baseMutationVersion: seeded!.mutationVersion,
      );

      final loaded = await reopenOver(store).repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      expect(loaded?.text, 'mine, extended');
      expect(loaded?.conflictText, 'theirs');
      expect(loaded?.conflictBrokerRevision, 7);
    });

    test('only the addressed profile and session are adopted', () async {
      final store = MemorySessionDraftKeepaliveStore();
      SessionDraftKeepalive(store, installTerminalHook: false)
        ..record(brokerProfileId: scope, sessionKey: key, text: 'a')
        ..record(brokerProfileId: otherScope, sessionKey: key, text: 'b')
        ..record(brokerProfileId: scope, sessionKey: otherKey, text: 'c');

      final next = reopenOver(store);
      expect(next.keepalive.inherited, hasLength(3));
      expect(
        (await next.repository.load(
          brokerProfileId: otherScope,
          sessionKey: key,
        ))?.text,
        'b',
      );
      // The other two are untouched until their own sessions hydrate.
      expect(next.keepalive.inherited, hasLength(2));
      expect(
        (await next.repository.load(
          brokerProfileId: scope,
          sessionKey: otherKey,
        ))?.text,
        'c',
      );
      expect(
        (await next.repository.load(
          brokerProfileId: scope,
          sessionKey: key,
        ))?.text,
        'a',
      );
    });

    test('a record whose base row was deleted elsewhere resurfaces as a fresh '
        'dirty draft', () async {
      // Another tab sends and deletes the shared row. Its delete cannot reach
      // this tab's sessionStorage, so the record survives with a base that no
      // longer names any row. The text in it is unsent typing: leaving it
      // inherited-but-invisible loses it forever, so it must come back as an
      // ordinary dirty draft.
      final store = MemorySessionDraftKeepaliveStore();
      final shared = DriftSessionDraftRepository(database);
      final asThisTabSawIt = await shared.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'what both tabs were editing',
        ),
      );
      SessionDraftKeepalive(store, installTerminalHook: false).record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'unsent typing only this tab ever held',
        baseMutationVersion: asThisTabSawIt!.mutationVersion,
      );
      expect(
        await shared.delete(
          brokerProfileId: scope,
          sessionKey: key,
          expectedMutationVersion: asThisTabSawIt.mutationVersion,
        ),
        isTrue,
      );

      final next = reopenOver(store);
      final loaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      expect(loaded?.text, 'unsent typing only this tab ever held');
      expect(loaded?.dirty, isTrue);
      expect(next.keepalive.inherited, isEmpty);
      expect(recordsOf(store), isEmpty);
    });

    test('a same-tab save rebases an in-flight record onto the row it '
        'produced', () async {
      // Row v1 exists; a save of B is in flight; the user types C, recording
      // base v1; B commits v2. C was typed on top of THIS tab's own linear
      // history, not a competing writer's, so the successful save must carry
      // C's lineage forward — otherwise the next start reads C/base-v1 against
      // row v2 and manufactures a conflict out of one tab's own typing.
      final store = MemorySessionDraftKeepaliveStore();
      final live = SessionDraftKeepalive(store, installTerminalHook: false);
      final withKeepalive = DriftSessionDraftRepository(
        database,
        keepalive: live,
      );
      final v1 = await withKeepalive.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'A',
        ),
      );
      live.record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'C, typed while B was landing',
        baseMutationVersion: v1!.mutationVersion,
      );
      final v2 = await withKeepalive.save(v1.copyWith(text: 'B'));
      expect(v2, isNotNull);

      final next = reopenOver(store);
      final loaded = await next.repository.load(
        brokerProfileId: scope,
        sessionKey: key,
      );

      // The record adopts cleanly over the same tab's own advance — the tail
      // keeps the composer and NO conflict is manufactured.
      expect(loaded?.text, 'C, typed while B was landing');
      expect(loaded?.conflictText, isNull);
      expect(next.keepalive.inherited, isEmpty);
    });

    test(
      'losing the adoption CAS returns the winner, never the stale row',
      () async {
        // Another tab advances the row between adoption's read and its write.
        // The failed CAS must not hand the controller the pre-race row: the
        // controller caches what load returns and marks the scope loaded, so a
        // stale return is a stale composer.
        final store = MemorySessionDraftKeepaliveStore();
        final shared = DriftSessionDraftRepository(database);
        final v1 = await shared.save(
          SessionLocalDraft.create(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'what this tab last saw',
          ),
        );
        SessionDraftKeepalive(store, installTerminalHook: false).record(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'unsent tail this tab never landed',
          baseMutationVersion: v1!.mutationVersion,
        );

        final next = reopenOver(store);
        // Deterministic interleave, no seam: Drift executes statements in
        // submission order. `load` submits its SELECT and suspends; the
        // competing save submits its UPDATE next; adoption's own UPDATE is
        // submitted third and therefore loses the CAS against the winner.
        final race = next.repository.load(
          brokerProfileId: scope,
          sessionKey: key,
        );
        await shared.save(v1.copyWith(text: 'winner, written by another tab'));
        final loaded = await race;

        // The returned row reflects the winner, not the pre-race snapshot …
        expect(loaded?.text, 'winner, written by another tab');
        // … and the unsent text still is not dropped: against the now-newer row
        // it is preserved as the second version.
        expect(loaded?.conflictText, 'unsent tail this tab never landed');
      },
    );
  });

  group('retirement', () {
    late AppDatabase database;
    late MemorySessionDraftKeepaliveStore store;
    late SessionDraftKeepalive keepalive;
    late DriftSessionDraftRepository repository;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      store = MemorySessionDraftKeepaliveStore();
      keepalive = SessionDraftKeepalive(store, installTerminalHook: false);
      repository = DriftSessionDraftRepository(database, keepalive: keepalive);
    });

    test(
      'the record is dropped once the durable row holds its value',
      () async {
        keepalive.record(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'debounced',
        );

        await repository.save(
          SessionLocalDraft.create(
            brokerProfileId: scope,
            sessionKey: key,
            text: 'debounced',
          ),
        );

        expect(recordsOf(store), isEmpty);
      },
    );

    test('a record newer than the write survives it', () async {
      final stored = await repository.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'first',
        ),
      );
      // The keystroke that landed inside the write's own flight.
      keepalive.record(
        brokerProfileId: scope,
        sessionKey: key,
        text: 'first and more',
      );

      await repository.save(stored!.copyWith(text: 'first'));

      expect(storedText(store), 'first and more');
    });

    test('a delivered send cannot be resurrected', () async {
      final stored = await repository.save(
        SessionLocalDraft.create(
          brokerProfileId: scope,
          sessionKey: key,
          text: 'sent',
        ),
      );
      keepalive.record(brokerProfileId: scope, sessionKey: key, text: 'sent');

      final deleted = await repository.delete(
        brokerProfileId: scope,
        sessionKey: key,
        expectedMutationVersion: stored!.mutationVersion,
      );

      expect(deleted, isTrue);
      expect(recordsOf(store), isEmpty);
    });

    test('removing a broker profile removes only its records', () async {
      keepalive
        ..record(brokerProfileId: scope, sessionKey: key, text: 'a')
        ..record(brokerProfileId: otherScope, sessionKey: key, text: 'b');

      await repository.deleteForProfile('profile-a');

      expect(storedText(store), isNull);
      expect(storedText(store, brokerProfileId: otherScope), 'b');
    });
  });

  group('a destroyed document', () {
    late AppDatabase database;
    late MemorySessionDraftKeepaliveStore store;

    setUp(() {
      // One durable database and one tab's synchronous storage, carried across
      // the "refresh" exactly as the Drift worker and `sessionStorage` are.
      database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      store = MemorySessionDraftKeepaliveStore();
    });

    Future<ProviderContainer> openDocument() async {
      final socket = FakeSessionDetailConnection();
      final container = buildControllerContainer(
        key,
        socket,
        FakeControllerAttachmentPicker(),
        appDatabase: database,
        draftKeepalive: SessionDraftKeepalive(
          store,
          installTerminalHook: false,
        ),
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      socket.emitEvent(defaultControllerHello);
      await drainSessionDetailMicrotasks();
      return container;
    }

    test(
      'gives back the text that was on screen, not the last debounced one',
      () async {
        final first = await openDocument();
        final scopeKey = fakeControllerBrokerScope();

        // The composer stages a keystroke. The 300 ms debounce never fires,
        // no lifecycle flush runs, and `dispose()` never gets its turn: the
        // hard-refresh shape, with nothing having reached Drift.
        first
            .read(sessionDetailControllerProvider(key).notifier)
            .stageLocalDraft('half a sen');
        expect(
          await DriftSessionDraftRepository(database).load(
            brokerProfileId: scopeKey,
            sessionKey: key,
          ),
          isNull,
        );

        final second = await openDocument();

        expect(
          second.read(sessionDetailControllerProvider(key)).draftSurface?.text,
          'half a sen',
        );
        // Adopted as an ordinary dirty local edit, so the shared broker copy
        // catches up without another keystroke.
        final adopted = await DriftSessionDraftRepository(database).load(
          brokerProfileId: scopeKey,
          sessionKey: key,
        );
        expect(adopted?.text, 'half a sen');
        expect(adopted?.dirty, isTrue);
      },
    );

    test('a landed debounce leaves nothing to adopt', () async {
      final first = await openDocument();
      final controller = first.read(
        sessionDetailControllerProvider(key).notifier,
      )..stageLocalDraft('landed');
      await controller.recordLocalDraft('landed');
      await drainSessionDetailMicrotasks();
      expect(recordsOf(store), isEmpty);

      final second = await openDocument();

      expect(
        second.read(sessionDetailControllerProvider(key)).draftSurface?.text,
        'landed',
      );
    });

    test('another session is untouched by this one', () async {
      final first = await openDocument();
      first
          .read(sessionDetailControllerProvider(key).notifier)
          .stageLocalDraft('session one only');

      final second = await openDocument();

      expect(
        second.read(sessionDetailControllerProvider(otherKey)).draftSurface,
        isNull,
      );
      expect(
        await DriftSessionDraftRepository(database).load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: otherKey,
        ),
        isNull,
      );
    });
  });
}
