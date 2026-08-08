import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

/// N3: the bounded roster identity snapshot.
///
/// Every bound is asserted as LOAD-BEARING — the test proves the store refuses
/// to exceed it, not merely that a cleanup pass eventually notices.
void main() {
  /// Every fixture captures from the same broker unless a test says otherwise.
  const endpoint = 'https://broker.example:8787';

  late AppDatabase database;
  late DriftRosterSnapshotRepository repository;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftRosterSnapshotRepository(database);
  });

  tearDown(() => database.close());

  SessionInfo session({
    String id = 's1',
    String tool = 'codex',
    String title = 'Session',
    SessionStatus status = SessionStatus.working,
    AttachMode attachMode = AttachMode.live,
    String? machine = 'mac',
    String? cwd = '/work/app',
    String? projectName,
    String? nativeId,
    String? parentThreadId,
    SessionOrigin? origin,
    int? updatedAt = 1000,
    String? model,
    SessionCurrentModel? currentModel,
    SessionControlState? control,
  }) => SessionInfo(
    id: id,
    tool: tool,
    title: title,
    status: status,
    attachMode: attachMode,
    machine: machine,
    cwd: cwd,
    projectName: projectName,
    nativeId: nativeId,
    parentThreadId: parentThreadId,
    origin: origin,
    updatedAt: updatedAt,
    model: model,
    currentModel: currentModel,
    control: control,
  );

  group('identity projection', () {
    test('stores identity and drops every activity field', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [
          session(
            status: SessionStatus.needsInput,
            attachMode: AttachMode.observe,
            nativeId: 'native-1',
            origin: SessionOrigin.subagent,
            parentThreadId: 'native-0',
            projectName: 'App',
            model: 'legacy-label',
            currentModel: const SessionCurrentModel(
              providerID: 'anthropic',
              modelID: 'claude-opus-5',
              label: 'Opus 5',
            ),
            control: const SessionControlState(
              drive: SessionDriveControl(
                state: DriveState.driving,
                supported: true,
                reason: 'held by this device',
              ),
              terminalSync: SessionTerminalSync(
                supported: true,
                syncAvailable: true,
                active: true,
                command: 'codex attach abc',
              ),
            ),
          ),
        ],
      );

      final row = await database
          .customSelect('SELECT rows_json FROM roster_snapshot_rows')
          .getSingle();
      final rowsJson = row.read<String>('rows_json');

      // The payload is inspected as raw text: an activity field must not be
      // present under ANY key, not merely unread by the decoder.
      for (final forbidden in <String>[
        'status',
        'needsInput',
        'working',
        'idle',
        'attachMode',
        'observe',
        'control',
        'drive',
        'terminalSync',
        'permission',
        'question',
        'telemetry',
        'capabilit',
      ]) {
        expect(
          rowsJson.toLowerCase(),
          isNot(contains(forbidden.toLowerCase())),
          reason: '$forbidden must never reach the roster snapshot',
        );
      }

      final loaded = await repository.load('profile-a', endpoint: endpoint);
      final identity = loaded!.rows.single;
      expect(identity.tool, 'codex');
      expect(identity.sessionId, 's1');
      expect(identity.title, 'Session');
      expect(identity.machine, 'mac');
      expect(identity.cwd, '/work/app');
      expect(identity.projectName, 'App');
      expect(identity.nativeId, 'native-1');
      expect(identity.parentThreadId, 'native-0');
      expect(identity.origin, SessionOrigin.subagent);
      expect(identity.modelLabel, 'Opus 5');
      expect(identity.modelId, 'claude-opus-5');
      expect(identity.updatedAt, 1000);
    });

    test(
      'falls back to the legacy model label when there is no rich model',
      () async {
        await repository.save(
          brokerProfileId: 'profile-a',
          endpoint: endpoint,
          sessions: [session(model: 'gpt-legacy')],
        );
        final loaded = await repository.load('profile-a', endpoint: endpoint);
        expect(loaded!.rows.single.modelLabel, 'gpt-legacy');
        expect(loaded.rows.single.modelId, isNull);
      },
    );
  });

  group('bounds', () {
    test('row bound is enforced on write, newest activity retained', () async {
      final stored = await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [
          for (var index = 0; index < maxRosterSnapshotRows + 40; index++)
            session(id: 's$index', updatedAt: index),
        ],
      );

      expect(stored.rows, hasLength(maxRosterSnapshotRows));
      expect(stored.omittedRowCount, 40);
      expect(stored.isPartial, isTrue);
      // Newest-first retention: the highest `updatedAt` survives, the lowest
      // does not.
      final retained = stored.rows.map((row) => row.sessionId).toSet();
      expect(retained, contains('s${maxRosterSnapshotRows + 39}'));
      expect(retained, isNot(contains('s0')));

      final loaded = await repository.load('profile-a', endpoint: endpoint);
      expect(loaded!.rows, hasLength(maxRosterSnapshotRows));
      expect(loaded.omittedRowCount, 40);
    });

    test('byte bound is enforced on write', () async {
      // Titles large enough that the row cap alone cannot keep the payload
      // inside the byte budget.
      final huge = 'x' * 4000;
      final stored = await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [
          for (var index = 0; index < 200; index++)
            session(id: 's$index', title: '$huge$index', updatedAt: index),
        ],
      );

      expect(stored.rows.length, lessThan(200));
      expect(stored.omittedRowCount, greaterThan(0));
      final row = await database
          .customSelect('SELECT rows_json FROM roster_snapshot_rows')
          .getSingle();
      expect(
        utf8.encode(row.read<String>('rows_json')).length,
        lessThanOrEqualTo(maxRosterSnapshotBytes),
      );
    });

    test('profile bound evicts the least-recently captured profile', () async {
      for (
        var index = 0;
        index < maxRetainedRosterSnapshotProfiles + 3;
        index++
      ) {
        await repository.save(
          brokerProfileId: 'profile-$index',
          endpoint: endpoint,
          sessions: [session(id: 's$index')],
          now: DateTime.utc(2026, 7).add(Duration(minutes: index)),
        );
      }

      final rows = await database
          .customSelect('SELECT broker_profile_id FROM roster_snapshot_rows')
          .get();
      expect(rows, hasLength(maxRetainedRosterSnapshotProfiles));
      final kept = rows
          .map((row) => row.read<String>('broker_profile_id'))
          .toSet();
      // The three oldest captures went; the newest write is always kept.
      expect(kept, isNot(contains('profile-0')));
      expect(kept, isNot(contains('profile-1')));
      expect(kept, isNot(contains('profile-2')));
      expect(
        kept,
        contains('profile-${maxRetainedRosterSnapshotProfiles + 2}'),
      );
    });

    test(
      'aggregate byte bound evicts other profiles, never the new row',
      () async {
        // Fill several profiles with near-maximal payloads, then confirm the
        // total never exceeds the published aggregate ceiling.
        final huge = 'y' * 3000;
        final base = DateTime.now().subtract(const Duration(hours: 1));
        for (
          var index = 0;
          index < maxRetainedRosterSnapshotProfiles;
          index++
        ) {
          await repository.save(
            brokerProfileId: 'profile-$index',
            endpoint: endpoint,
            sessions: [
              for (var row = 0; row < 90; row++)
                session(id: 's$row', title: '$huge$row', updatedAt: row),
            ],
            now: base.add(Duration(minutes: index)),
          );
        }

        final total = await database
            .customSelect(
              'SELECT COALESCE(SUM(LENGTH(CAST(rows_json AS BLOB))), 0) '
              'AS total FROM roster_snapshot_rows',
            )
            .getSingle();
        expect(
          total.read<int>('total'),
          lessThanOrEqualTo(maxRetainedRosterSnapshotBytesTotal),
        );
        // The most recent write survives the aggregate sweep.
        final last = await repository.load(
          'profile-${maxRetainedRosterSnapshotProfiles - 1}',
          endpoint: endpoint,
        );
        expect(last, isNotNull);
      },
    );

    test(
      'the byte bound is measured in encoded bytes, not code units',
      () async {
        // Every title is CJK: three UTF-8 bytes per UTF-16 code unit. A cap
        // checked against `String.length` would read this payload as roughly a
        // third of its real size and wave it straight through.
        final wide = '会话' * 1200; // 2400 code units, 7200 bytes
        await repository.save(
          brokerProfileId: 'profile-a',
          endpoint: endpoint,
          sessions: [
            for (var index = 0; index < 60; index++)
              session(id: 's$index', title: '$wide$index', updatedAt: index),
          ],
        );

        final row = await database
            .customSelect('SELECT rows_json FROM roster_snapshot_rows')
            .getSingle();
        final rowsJson = row.read<String>('rows_json');
        expect(
          utf8.encode(rowsJson).length,
          lessThanOrEqualTo(maxRosterSnapshotBytes),
          reason: 'the write path bounds encoded bytes',
        );
        expect(
          rowsJson.length,
          lessThan(utf8.encode(rowsJson).length),
          reason: 'the fixture really is multibyte, or this proves nothing',
        );
        // The load path agrees: a payload inside the byte budget survives.
        expect(
          await repository.load('profile-a', endpoint: endpoint),
          isNotNull,
        );
      },
    );

    test('a multibyte payload over the byte bound is refused', () async {
      // Written by something that did not honour the bounds. Its code-unit
      // length is comfortably inside the cap; its encoded length is not, and a
      // code-unit check would therefore accept an oversized row.
      final wide = '会' * (maxRosterSnapshotBytes ~/ 2);
      expect(wide.length, lessThan(maxRosterSnapshotBytes));
      expect(utf8.encode(wide).length, greaterThan(maxRosterSnapshotBytes));
      await database
          .into(database.rosterSnapshotRows)
          .insert(
            RosterSnapshotRowsCompanion.insert(
              brokerProfileId: 'profile-a',
              endpoint: endpoint,
              payloadVersion: rosterSnapshotPayloadVersion,
              rowsJson: jsonEncode([
                {'tool': 'codex', 'id': 's1', 'title': wide},
              ]),
              rowCount: const Value(1),
              capturedAt: DateTime.now(),
            ),
          );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
      );
    });

    test('a child is skipped when its parent cannot fit beside it', () async {
      // Exactly one slot short of the pair: the child is the newest row, its
      // parent the oldest. Keeping the child alone would invent an orphan whose
      // parent the roster actually has.
      final sessions = <SessionInfo>[
        session(id: 'parent', nativeId: 'native-parent', updatedAt: 0),
        for (var index = 0; index < maxRosterSnapshotRows - 1; index++)
          session(id: 'filler$index', updatedAt: 1000 + index),
        session(
          id: 'child',
          nativeId: 'native-child',
          parentThreadId: 'native-parent',
          origin: SessionOrigin.subagent,
          updatedAt: 999999,
        ),
      ];

      final stored = await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: sessions,
      );
      final ids = stored.rows.map((row) => row.sessionId).toSet();
      expect(
        ids.contains('child') && !ids.contains('parent'),
        isFalse,
        reason: 'a child is never retained without its available parent',
      );
      // The slot the skipped child would have taken still goes to real content.
      expect(stored.rows, hasLength(maxRosterSnapshotRows));
    });

    test(
      'a retained child keeps its parent so R1c adjacency survives',
      () async {
        // The parent is old enough to rank below the cap on recency alone; the
        // child pulls it in.
        final sessions = <SessionInfo>[
          session(id: 'parent', nativeId: 'native-parent', updatedAt: 0),
          for (var index = 0; index < maxRosterSnapshotRows; index++)
            session(id: 'filler$index', updatedAt: 1000 + index),
          session(
            id: 'child',
            nativeId: 'native-child',
            parentThreadId: 'native-parent',
            origin: SessionOrigin.subagent,
            updatedAt: 999999,
          ),
        ];

        final stored = await repository.save(
          brokerProfileId: 'profile-a',
          endpoint: endpoint,
          sessions: sessions,
        );
        final ids = stored.rows.map((row) => row.sessionId).toSet();
        expect(ids, contains('child'));
        expect(
          ids,
          contains('parent'),
          reason: 'a retained child must keep the parent it renders beneath',
        );
        expect(stored.rows.length, lessThanOrEqualTo(maxRosterSnapshotRows));
      },
    );

    test(
      'cleanup is opportunistic and deletes expired other profiles',
      () async {
        final old = DateTime.utc(2026);
        await repository.save(
          brokerProfileId: 'profile-old',
          endpoint: endpoint,
          sessions: [session()],
          now: old,
        );
        // A later write for another profile sweeps the expired row; no timer.
        await repository.save(
          brokerProfileId: 'profile-new',
          endpoint: endpoint,
          sessions: [session()],
          now: old.add(maxRosterSnapshotAge * 2),
        );

        final rows = await database
            .customSelect('SELECT broker_profile_id FROM roster_snapshot_rows')
            .get();
        expect(
          rows.map((row) => row.read<String>('broker_profile_id')),
          ['profile-new'],
        );
      },
    );
  });

  group('fail open', () {
    test('a corrupt payload returns null and deletes the row', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session()],
      );
      await database.customStatement(
        "UPDATE roster_snapshot_rows SET rows_json = '{ not json'",
      );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      final rows = await database
          .customSelect('SELECT 1 FROM roster_snapshot_rows')
          .get();
      expect(rows, isEmpty);
    });

    test('a future payload version returns null and deletes the row', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session()],
      );
      await database.customStatement(
        'UPDATE roster_snapshot_rows SET payload_version = '
        '${rosterSnapshotPayloadVersion + 1}',
      );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
      );
    });

    test('an expired snapshot returns null and deletes the row', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session()],
        now: DateTime.now().subtract(maxRosterSnapshotAge * 2),
      );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
      );
    });

    test('a snapshot captured in the future is refused', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session()],
        now: DateTime.now().add(const Duration(days: 3)),
      );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
      );
    });

    test(
      'an over-bound payload written outside the store is refused',
      () async {
        // Something that did not honour the write-path bounds; honouring it on
        // read would make the row cap advisory.
        final rows = [
          for (var index = 0; index < maxRosterSnapshotRows + 1; index++)
            {'tool': 'codex', 'id': 's$index'},
        ];
        await database
            .into(database.rosterSnapshotRows)
            .insert(
              RosterSnapshotRowsCompanion.insert(
                brokerProfileId: 'profile-a',
                endpoint: endpoint,
                payloadVersion: rosterSnapshotPayloadVersion,
                rowsJson: jsonEncode(rows),
                rowCount: Value(rows.length),
                capturedAt: DateTime.now(),
              ),
            );

        expect(await repository.load('profile-a', endpoint: endpoint), isNull);
        expect(
          await database
              .customSelect('SELECT 1 FROM roster_snapshot_rows')
              .get(),
          isEmpty,
        );
      },
    );

    test('an oversized stored payload is refused', () async {
      await database
          .into(database.rosterSnapshotRows)
          .insert(
            RosterSnapshotRowsCompanion.insert(
              brokerProfileId: 'profile-a',
              endpoint: endpoint,
              payloadVersion: rosterSnapshotPayloadVersion,
              rowsJson: '[${'"x",' * (maxRosterSnapshotBytes ~/ 2)}"x"]',
              rowCount: const Value(1),
              capturedAt: DateTime.now(),
            ),
          );

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
      );
    });
  });

  group('profile scope', () {
    test('load is scoped to the exact profile', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session(id: 'a-only')],
      );
      await repository.save(
        brokerProfileId: 'profile-b',
        endpoint: endpoint,
        sessions: [session(id: 'b-only')],
      );

      expect(
        (await repository.load(
          'profile-a',
          endpoint: endpoint,
        ))!.rows.single.sessionId,
        'a-only',
      );
      expect(
        (await repository.load(
          'profile-b',
          endpoint: endpoint,
        ))!.rows.single.sessionId,
        'b-only',
      );
      expect(await repository.load('profile-c', endpoint: endpoint), isNull);
    });

    test('deleting a profile removes only its snapshot', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session()],
      );
      await repository.save(
        brokerProfileId: 'profile-b',
        endpoint: endpoint,
        sessions: [session()],
      );

      await repository.deleteForProfile('profile-a');

      expect(await repository.load('profile-a', endpoint: endpoint), isNull);
      expect(await repository.load('profile-b', endpoint: endpoint), isNotNull);
    });

    test('a snapshot from another endpoint is refused and deleted', () async {
      // Editing a profile's broker URL keeps the profile id. Keying the
      // snapshot on the id alone would hydrate the NEW broker's roster from the
      // OLD broker's session identities — cross-broker leakage under a name the
      // user believes they repointed.
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: 'https://old-broker.example:8787',
        sessions: [session(id: 'old-broker-session')],
      );

      expect(
        await repository.load(
          'profile-a',
          endpoint: 'https://new-broker.example:8787',
        ),
        isNull,
        reason: 'the same profile pointed at a different broker starts empty',
      );
      expect(
        await database.customSelect('SELECT 1 FROM roster_snapshot_rows').get(),
        isEmpty,
        reason: 'the foreign row is deleted, not left to be re-examined',
      );
    });

    test('a matching endpoint still loads', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: 'https://broker.example:8787',
        sessions: [session(id: 'kept')],
      );
      final loaded = await repository.load(
        'profile-a',
        endpoint: 'https://broker.example:8787',
      );
      expect(loaded!.rows.single.sessionId, 'kept');
    });

    test(
      'reloading the original endpoint after repointing finds nothing',
      () async {
        await repository.save(
          brokerProfileId: 'profile-a',
          endpoint: 'https://one.example:8787',
          sessions: [session(id: 'one')],
        );
        await repository.save(
          brokerProfileId: 'profile-a',
          endpoint: 'https://two.example:8787',
          sessions: [session(id: 'two')],
        );

        // The row is per profile, so the second capture replaced the first:
        // going back must not resurrect the original broker's identities.
        expect(
          await repository.load(
            'profile-a',
            endpoint: 'https://one.example:8787',
          ),
          isNull,
        );
      },
    );

    test('a later save replaces the profile snapshot wholesale', () async {
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session(id: 'old')],
      );
      await repository.save(
        brokerProfileId: 'profile-a',
        endpoint: endpoint,
        sessions: [session(id: 'new')],
      );

      final loaded = await repository.load('profile-a', endpoint: endpoint);
      expect(loaded!.rows.map((row) => row.sessionId), ['new']);
    });
  });
}
