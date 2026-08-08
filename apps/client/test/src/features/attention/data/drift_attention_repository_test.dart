import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftAttentionRepository', () {
    group('schema migration', () {
      test(
        'migrates 4 to the current schema without duplicating outbox columns',
        () async {
          final database = _seedV4Database();

          final outboxColumnNames = await _columnNames(
            database,
            'session_outbox_rows',
          );
          expect(
            outboxColumnNames.where((name) => name == 'broker_profile_id'),
            hasLength(1),
          );
          final userVersion = await database
              .customSelect('PRAGMA user_version')
              .getSingle();
          expect(userVersion.data['user_version'], 19);

          await database.close();
        },
      );

      test('migrates 5 to the current schema with durable tables', () async {
        final database = _seedV5Database();

        final tables = await database
            .customSelect(
              'SELECT name FROM sqlite_master '
              "WHERE type='table' AND name IN "
              "('attention_event_rows','attention_cursor_rows',"
              "'session_transcript_rows')",
            )
            .get();

        expect(tables, hasLength(3));

        final userVersion = await database
            .customSelect('PRAGMA user_version')
            .getSingle();
        final userVersionValue = userVersion.data['user_version'];
        expect(userVersionValue, isA<int>());
        expect(userVersionValue as int, 19);

        expect(database.schemaVersion, 19);

        final eventColumnNames = await _columnNames(
          database,
          'attention_event_rows',
        );
        final cursorColumnNames = await _columnNames(
          database,
          'attention_cursor_rows',
        );
        final transferColumnNames = await _columnNames(
          database,
          'artifact_transfer_rows',
        );
        final outboxColumnNames = await _columnNames(
          database,
          'session_outbox_rows',
        );

        expect(eventColumnNames, contains('historical_baseline'));
        expect(cursorColumnNames, contains('baseline_through_cursor'));
        expect(transferColumnNames, contains('upload_id'));
        expect(transferColumnNames, contains('partial_file_path'));
        expect(transferColumnNames, contains('download_etag'));
        expect(transferColumnNames, contains('download_last_modified'));
        expect(transferColumnNames, contains('broker_profile_id'));
        expect(outboxColumnNames, contains('broker_profile_id'));

        final repository = DriftAttentionRepository(database);
        expect(await repository.loadCursor('profile-old'), 0);
        expect(await repository.loadUnreadCount('profile-old'), 0);

        await database.close();
      });

      test('migrates 6 to the current schema adding later columns', () async {
        final database = _seedV6Database();

        final eventColumnNames = await _columnNames(
          database,
          'attention_event_rows',
        );
        final cursorColumnNames = await _columnNames(
          database,
          'attention_cursor_rows',
        );
        final transferColumnNames = await _columnNames(
          database,
          'artifact_transfer_rows',
        );

        expect(
          eventColumnNames,
          containsAll(<String>[
            'broker_read_at',
            'broker_dismissed_at',
            'historical_baseline',
          ]),
        );
        expect(
          cursorColumnNames,
          containsAll(<String>[
            'initial_sync_complete',
            'baseline_through_cursor',
          ]),
        );
        expect(transferColumnNames, contains('upload_id'));

        await database.close();
      });
    });

    group('durable persistence', () {
      late AppDatabase database;
      late DriftAttentionRepository repository;

      setUp(() {
        database = AppDatabase(NativeDatabase.memory());
        repository = DriftAttentionRepository(database);
      });

      tearDown(() async {
        await database.close();
      });

      test('persists page atomically with cursor', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'p1',
          page: AttentionEventsPage(
            events: [
              _event(id: 'evt-1', cursor: 5),
              _event(id: 'evt-2', cursor: 6),
            ],
            cursor: 6,
            reset: false,
            hasMore: false,
          ),
        );

        final rows = await repository.loadEvents('p1');
        final cursor = await repository.loadCursor('p1');

        expect(rows.map((row) => row.id), ['evt-2', 'evt-1']);
        expect(cursor, 6);
        expect(await repository.loadUnreadCount('p1'), 2);
      });

      test('does not advance cursor if event persistence fails', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'p1',
          page: const AttentionEventsPage(
            events: [],
            cursor: 5,
            reset: false,
            hasMore: false,
          ),
        );

        expect(
          repository.persistAttentionEventsPage(
            brokerProfileId: 'p1',
            page: AttentionEventsPage(
              events: [_event(id: 'evt-1', cursor: 7)],
              cursor: -1,
              reset: false,
              hasMore: false,
            ),
          ),
          throwsArgumentError,
        );

        expect(await repository.loadCursor('p1'), 5);
        expect(await repository.loadEvents('p1'), isEmpty);
      });

      test(
        'does not regress an incremental cursor but accepts reset cursor',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'p1',
            page: const AttentionEventsPage(
              events: [],
              cursor: 9,
              reset: false,
              hasMore: false,
            ),
          );
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'p1',
            page: const AttentionEventsPage(
              events: [],
              cursor: 7,
              reset: false,
              hasMore: false,
            ),
          );
          expect(await repository.loadCursor('p1'), 9);

          await repository.persistAttentionEventsPage(
            brokerProfileId: 'p1',
            page: const AttentionEventsPage(
              events: [],
              cursor: 2,
              reset: true,
              hasMore: false,
            ),
          );
          expect(await repository.loadCursor('p1'), 2);
        },
      );

      test(
        'reset starts a new baseline epoch and later rows stay fresh',
        () async {
          const profileId = 'profile-reset-baseline';
          await repository.persistAttentionEventsPage(
            brokerProfileId: profileId,
            page: AttentionEventsPage(
              events: [_event(id: 'old-history', cursor: 100)],
              cursor: 100,
              baselineThroughCursor: 100,
              reset: false,
              hasMore: false,
            ),
          );

          await repository.persistAttentionEventsPage(
            brokerProfileId: profileId,
            page: AttentionEventsPage(
              events: [_event(id: 'reset-history', cursor: 5)],
              cursor: 5,
              baselineThroughCursor: 5,
              reset: true,
              hasMore: true,
            ),
          );

          final resetCursor = await (database.select(
            database.attentionCursorRows,
          )..where((row) => row.brokerProfileId.equals(profileId))).getSingle();
          expect(resetCursor.cursor, 5);
          expect(resetCursor.baselineThroughCursor, 5);
          expect(resetCursor.initialSyncComplete, isFalse);

          await repository.persistAttentionEventsPage(
            brokerProfileId: profileId,
            page: AttentionEventsPage(
              events: [_event(id: 'new-after-reset', cursor: 6)],
              cursor: 6,
              baselineThroughCursor: 6,
              reset: false,
              hasMore: false,
            ),
          );

          final states = await repository.loadDeliveryStates(profileId);
          bool historical(String id) => states
              .singleWhere((item) => item.event.id == id)
              .event
              .historicalBaseline;
          expect(historical('reset-history'), isTrue);
          expect(historical('new-after-reset'), isFalse);
          expect(await repository.loadUnreadCount(profileId), 1);
          expect(
            (await repository.loadPendingPresentations(
              profileId,
            )).map((item) => item.event.id),
            ['new-after-reset'],
          );

          final completedCursor = await (database.select(
            database.attentionCursorRows,
          )..where((row) => row.brokerProfileId.equals(profileId))).getSingle();
          expect(completedCursor.baselineThroughCursor, 5);
          expect(completedCursor.initialSyncComplete, isTrue);
        },
      );

      test('isolates rows and cursor by broker profile', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-a',
          page: AttentionEventsPage(
            events: [_event(id: 'evt-a', cursor: 1)],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-b',
          page: AttentionEventsPage(
            events: [_event(id: 'evt-b', cursor: 2)],
            cursor: 2,
            reset: false,
            hasMore: false,
          ),
        );

        expect(
          (await repository.loadEvents('profile-a')).map((event) => event.id),
          ['evt-a'],
        );
        expect(
          (await repository.loadEvents('profile-b')).map((event) => event.id),
          ['evt-b'],
        );
        expect(await repository.loadCursor('profile-a'), 1);
        expect(await repository.loadCursor('profile-b'), 2);

        await repository.markRead('profile-b', 'evt-b');

        expect(await repository.loadUnreadCount('profile-a'), 1);
        expect(await repository.loadUnreadCount('profile-b'), 0);
      });

      test(
        'preserves local state on reset and replaces retained slice',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-reset',
            page: AttentionEventsPage(
              events: [
                _event(id: 'keep', cursor: 1),
                _event(id: 'drop', cursor: 1),
              ],
              cursor: 2,
              reset: false,
              hasMore: false,
            ),
          );

          final keepReadAt = DateTime(2026, 7, 11, 9);
          await repository.markRead(
            'profile-reset',
            'keep',
            readAt: keepReadAt,
          );
          await repository.advancePresentedRevision(
            brokerProfileId: 'profile-reset',
            eventId: 'keep',
            presentedRevision: 11,
          );

          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-reset',
            page: AttentionEventsPage(
              events: [
                _event(
                  id: 'keep',
                  cursor: 3,
                  presentationRevision: 2,
                  kind: 'future-kind',
                ),
                _event(id: 'new', cursor: 3),
              ],
              cursor: 3,
              reset: true,
              hasMore: false,
            ),
          );

          final rows = await repository.loadEvents('profile-reset');
          final ids = rows.map((row) => row.id).toSet();

          expect(ids, {'keep', 'new'});
          final kept = rows.firstWhere((row) => row.id == 'keep');

          expect(kept.readAt, keepReadAt.millisecondsSinceEpoch);
          expect(
            await repository.advancePresentedRevision(
              brokerProfileId: 'profile-reset',
              eventId: 'keep',
              presentedRevision: 3,
            ),
            isFalse,
          );
          expect(await repository.loadUnreadCount('profile-reset'), 1);
        },
      );

      test('advances local presentation revision only forward', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-presentation',
          page: AttentionEventsPage(
            events: [_event(id: 'evt', cursor: 1, presentationRevision: 4)],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );

        expect(
          await repository.advancePresentedRevision(
            brokerProfileId: 'profile-presentation',
            eventId: 'evt',
            presentedRevision: 3,
          ),
          isTrue,
        );
        expect(
          await repository.advancePresentedRevision(
            brokerProfileId: 'profile-presentation',
            eventId: 'evt',
            presentedRevision: 5,
          ),
          isTrue,
        );
        expect(
          await repository.advancePresentedRevision(
            brokerProfileId: 'profile-presentation',
            eventId: 'evt',
            presentedRevision: 1,
          ),
          isFalse,
        );
      });

      test(
        'uses a durable baseline cursor across initial catch-up pages',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-baseline',
            page: AttentionEventsPage(
              events: [
                _event(
                  id: 'page-1-historical',
                  cursor: 1,
                  presentationRevision: 3,
                ),
                _event(
                  id: 'page-1-fresh',
                  cursor: 4,
                  presentationRevision: 4,
                ),
              ],
              cursor: 4,
              baselineThroughCursor: 2,
              reset: false,
              hasMore: true,
            ),
          );
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-baseline',
            page: AttentionEventsPage(
              events: [
                _event(
                  id: 'page-2-historical',
                  cursor: 2,
                  presentationRevision: 5,
                ),
                _event(
                  id: 'page-2-fresh',
                  cursor: 5,
                  presentationRevision: 7,
                ),
              ],
              cursor: 5,
              baselineThroughCursor: 99,
              reset: false,
              hasMore: false,
            ),
          );

          final states = await repository.loadDeliveryStates(
            'profile-baseline',
          );
          bool historical(String id) => states
              .singleWhere((item) => item.event.id == id)
              .event
              .historicalBaseline;
          expect(historical('page-1-historical'), isTrue);
          expect(historical('page-2-historical'), isTrue);
          expect(historical('page-1-fresh'), isFalse);
          expect(historical('page-2-fresh'), isFalse);
          expect(await repository.loadUnreadCount('profile-baseline'), 2);
        },
      );

      test(
        'reclassifies historical row to fresh when its cursor advances '
        'past the baseline',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-baseline-refresh',
            page: AttentionEventsPage(
              events: [
                _event(
                  id: 'moving-historical',
                  cursor: 1,
                  summary: 'baseline',
                ),
              ],
              cursor: 1,
              baselineThroughCursor: 1,
              reset: false,
              hasMore: false,
            ),
          );
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-baseline-refresh',
            page: AttentionEventsPage(
              events: [
                _event(
                  id: 'moving-historical',
                  cursor: 3,
                  presentationRevision: 2,
                  summary: 'refreshed',
                ),
              ],
              cursor: 3,
              reset: false,
              hasMore: false,
            ),
          );

          final states = await repository.loadDeliveryStates(
            'profile-baseline-refresh',
          );
          final state = states.singleWhere(
            (item) => item.event.id == 'moving-historical',
          );
          expect(state.event.historicalBaseline, isFalse);
          expect(state.event.summary, 'refreshed');
          expect(
            await repository.loadUnreadCount('profile-baseline-refresh'),
            1,
          );

          final pendingPresentations = await repository
              .loadPendingPresentations(
                'profile-baseline-refresh',
              );
          expect(
            pendingPresentations.map((item) => item.event.id),
            ['moving-historical'],
          );
        },
      );

      test('unread count does not materialize unused event payloads', () async {
        await database.close();
        var payloadReads = 0;
        database = AppDatabase(
          NativeDatabase.memory(
            setup: (executor) {
              executor.createFunction(
                functionName: 'track_raw_event_json',
                directOnly: false,
                function: (arguments) {
                  payloadReads += 1;
                  return arguments[0];
                },
              );
            },
          ),
        );
        repository = DriftAttentionRepository(database);
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-count-only',
          page: AttentionEventsPage(
            events: [_event(id: 'unread', cursor: 1)],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );

        final columns = await database
            .customSelect('PRAGMA table_info(attention_event_rows)')
            .get();
        final projection = columns
            .map((column) {
              final name = column.data['name'] as String;
              if (name == 'raw_event_json') {
                return 'track_raw_event_json(raw_event_json) AS raw_event_json';
              }
              return name;
            })
            .join(', ');
        await database.customStatement(
          'ALTER TABLE attention_event_rows '
          'RENAME TO attention_event_rows_backing',
        );
        await database.customStatement(
          'CREATE VIEW attention_event_rows AS '
          'SELECT $projection FROM attention_event_rows_backing',
        );

        expect(await repository.loadUnreadCount('profile-count-only'), 1);
        expect(payloadReads, 0);
      });

      test(
        'rejects stale duplicate rows by cursor and revision',
        () async {
          const profileId = 'profile-stale-rows';
          const eventId = 'evt-stale';
          await repository.persistAttentionEventsPage(
            brokerProfileId: profileId,
            page: AttentionEventsPage(
              events: [
                _event(
                  id: eventId,
                  cursor: 10,
                  revision: 3,
                  presentationRevision: 8,
                  summary: 'fresh',
                ),
              ],
              cursor: 10,
              reset: false,
              hasMore: false,
            ),
          );
          final readAt = DateTime(2026, 7, 11, 9);
          await repository.markRead(profileId, eventId, readAt: readAt);
          await repository.advancePresentedRevision(
            brokerProfileId: profileId,
            eventId: eventId,
            presentedRevision: 7,
          );

          await repository.persistAttentionEventsPage(
            brokerProfileId: profileId,
            page: AttentionEventsPage(
              events: [
                _event(
                  id: eventId,
                  cursor: 11,
                  revision: 2,
                  presentationRevision: 7,
                  summary: 'stale',
                ),
                _event(id: 'other-new-event', cursor: 12),
              ],
              cursor: 12,
              reset: false,
              hasMore: false,
            ),
          );

          final states = await repository.loadDeliveryStates(profileId);
          final state = states.singleWhere((item) => item.event.id == eventId);
          expect(state.event.cursor, 10);
          expect(state.event.revision, 3);
          expect(state.event.presentationRevision, 8);
          expect(state.event.summary, 'fresh');
          expect(state.localReadAt, readAt.millisecondsSinceEpoch);
          expect(state.localPresentedRevision, 7);
          expect(await repository.loadCursor(profileId), 12);
        },
      );

      test(
        'loads explicit pending mutations for fresh and historical rows',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-pending',
            page: AttentionEventsPage(
              events: [
                _event(id: 'history-pending-read', cursor: 1),
                _event(id: 'fresh-pending-read', cursor: 3),
              ],
              cursor: 3,
              baselineThroughCursor: 2,
              reset: false,
              hasMore: false,
            ),
          );
          await repository.markRead(
            'profile-pending',
            'history-pending-read',
            readAt: DateTime(2026, 7, 11, 8),
          );
          await repository.markRead(
            'profile-pending',
            'fresh-pending-read',
            readAt: DateTime(2026, 7, 11, 8),
          );

          final pendingMutations = await repository.loadPendingMutations(
            'profile-pending',
          );
          expect(
            pendingMutations.map((state) => state.event.id),
            ['fresh-pending-read', 'history-pending-read'],
          );
        },
      );

      test('loads only non-historical pending presentations', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-presentation',
          page: AttentionEventsPage(
            events: [
              _event(
                id: 'historical-presentation',
                cursor: 1,
                presentationRevision: 4,
              ),
              _event(
                id: 'fresh-presentation',
                cursor: 3,
                presentationRevision: 4,
              ),
            ],
            cursor: 3,
            baselineThroughCursor: 1,
            reset: false,
            hasMore: false,
          ),
        );

        final pendingPresentations = await repository.loadPendingPresentations(
          'profile-presentation',
        );
        expect(
          pendingPresentations.map((state) => state.event.id),
          ['fresh-presentation'],
        );
      });

      test(
        'preserves unknown event kinds and actions in raw payload',
        () async {
          final rawEvent = AttentionEventView.fromJson(<String, dynamic>{
            'id': 'evt-unknown',
            'cursor': 3,
            'revision': 1,
            'presentationRevision': 1,
            'kind': 'future-kind',
            'state': 'active',
            'severity': 'informational',
            'dedupeKey': 'dedupe-unknown',
            'createdAt': 1,
            'updatedAt': 2,
            'title': 'Unknown event',
            'summary': 'unknown',
            'action': {
              'kind': 'future-action',
              'tool': 'test-tool',
              'sessionId': 'session-x',
              'agent': 'agent-x',
              'customActionField': 'kept',
            },
            'scopeKey': 'scope-value',
          });

          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-unknown',
            page: AttentionEventsPage(
              events: [rawEvent],
              cursor: 3,
              reset: false,
              hasMore: false,
            ),
          );

          final events = await repository.loadEvents('profile-unknown');
          final loaded = events.single;

          expect(loaded.kind, 'future-kind');
          expect(loaded.action.kind, 'future-action');
          expect(
            (loaded.raw['action'] as Map<String, dynamic>)['customActionField'],
            'kept',
          );
          expect(loaded.raw['scopeKey'], 'scope-value');
        },
      );

      test('tracks local read and dismiss timestamps', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-states',
          page: AttentionEventsPage(
            events: [
              _event(id: 'read-later', cursor: 1),
              _event(id: 'dismissed', cursor: 1),
              _event(id: 'idle', cursor: 1),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );

        final readAt = DateTime(2026, 7, 11, 8);
        final dismissedAt = DateTime(2026, 7, 11, 9);

        await repository.markRead(
          'profile-states',
          'read-later',
          readAt: readAt,
        );
        await repository.markDismissed(
          'profile-states',
          'dismissed',
          dismissedAt: dismissedAt,
        );

        final rows = await repository.loadEvents('profile-states');
        final readRow = rows.firstWhere((row) => row.id == 'read-later');
        final dismissedRow = rows.firstWhere((row) => row.id == 'dismissed');
        final idleRow = rows.firstWhere((row) => row.id == 'idle');

        expect(readRow.readAt, readAt.millisecondsSinceEpoch);
        expect(dismissedRow.dismissedAt, dismissedAt.millisecondsSinceEpoch);
        expect(idleRow.readAt, isNull);
        expect(idleRow.dismissedAt, isNull);
        expect(await repository.loadUnreadCount('profile-states'), 1);
      });

      test('exposes delivery-state metadata and broker sync markers', () async {
        const eventId = 'evt-delivery';
        const pageCursor = 4;
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-delivery',
          page: AttentionEventsPage(
            events: [_event(id: eventId, cursor: pageCursor)],
            cursor: pageCursor,
            reset: false,
            hasMore: false,
          ),
        );

        final localReadAt = DateTime(2026, 7, 11, 10);
        final localDismissedAt = DateTime(2026, 7, 11, 11);
        await repository.markRead(
          'profile-delivery',
          eventId,
          readAt: localReadAt,
        );
        await repository.markDismissed(
          'profile-delivery',
          eventId,
          dismissedAt: localDismissedAt,
        );

        final statesBefore = await repository.loadDeliveryStates(
          'profile-delivery',
        );
        expect(statesBefore, hasLength(1));
        final stateBefore = statesBefore.single;
        expect(stateBefore.localReadAt, localReadAt.millisecondsSinceEpoch);
        expect(
          stateBefore.localDismissedAt,
          localDismissedAt.millisecondsSinceEpoch,
        );
        expect(stateBefore.brokerReadAt, isNull);
        expect(stateBefore.brokerDismissedAt, isNull);

        final brokerReadAt = DateTime(2026, 7, 11, 12);
        final brokerDismissedAt = DateTime(2026, 7, 11, 13);
        await repository.markBrokerReadSynced(
          brokerProfileId: 'profile-delivery',
          eventId: eventId,
          brokerReadAt: brokerReadAt,
        );
        await repository.markBrokerDismissedSynced(
          brokerProfileId: 'profile-delivery',
          eventId: eventId,
          brokerDismissedAt: brokerDismissedAt,
        );

        final statesAfter = await repository.loadDeliveryStates(
          'profile-delivery',
        );
        final stateAfter = statesAfter.single;
        expect(stateAfter.brokerReadAt, brokerReadAt.millisecondsSinceEpoch);
        expect(
          stateAfter.brokerDismissedAt,
          brokerDismissedAt.millisecondsSinceEpoch,
        );
      });

      test(
        'persists structured session titles with unknown raw fields',
        () async {
          final event = AttentionEventView.fromJson(<String, dynamic>{
            ..._event(
              id: 'session-title',
              cursor: 1,
              sessionTitle: 'Release verification',
            ).toJson(),
            'futureField': {'keep': true},
          });
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-title',
            page: AttentionEventsPage(
              events: [event],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          );

          final loaded = (await repository.loadEvents('profile-title')).single;
          expect(loaded.sessionTitle, 'Release verification');
          expect(loaded.raw['futureField'], {'keep': true});
        },
      );

      test(
        'snapshot dismissal ignores a concurrent insert and newer revision',
        () async {
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-snapshot',
            page: AttentionEventsPage(
              events: [
                _event(id: 'changed', cursor: 1),
                _event(id: 'unchanged', cursor: 1),
              ],
              cursor: 1,
              reset: false,
              hasMore: false,
            ),
          );
          await repository.persistAttentionEventsPage(
            brokerProfileId: 'profile-snapshot',
            page: AttentionEventsPage(
              events: [
                _event(id: 'changed', cursor: 2, revision: 2),
                _event(id: 'inserted', cursor: 2),
              ],
              cursor: 2,
              reset: false,
              hasMore: false,
            ),
          );

          final accepted = await repository.markSnapshotDismissed(
            const [
              AttentionEventSnapshot(
                brokerProfileId: 'profile-snapshot',
                eventId: 'changed',
                revision: 1,
              ),
              AttentionEventSnapshot(
                brokerProfileId: 'profile-snapshot',
                eventId: 'unchanged',
                revision: 1,
              ),
            ],
            dismissedAt: DateTime(2026, 7, 26),
          );

          expect(
            accepted.map((item) => (item.eventId, item.revision)),
            [('unchanged', 1)],
          );
          final events = await repository.loadEvents('profile-snapshot');
          expect(
            events
                .where((event) => event.dismissedAt == null)
                .map((event) => (event.id, event.revision))
                .toSet(),
            {('changed', 2), ('inserted', 1)},
          );
          final pending = await repository.loadPendingMutations(
            'profile-snapshot',
          );
          expect(pending, hasLength(1));
          expect(pending.single.event.id, 'unchanged');
          expect(pending.single.localDismissedRevision, 1);
        },
      );

      test('bulk stale releases only its exact obsolete dismissal', () async {
        await repository.persistAttentionEventsPage(
          brokerProfileId: 'profile-stale',
          page: AttentionEventsPage(
            events: [
              _event(id: 'stale', cursor: 1),
              _event(id: 'accepted', cursor: 1),
            ],
            cursor: 1,
            reset: false,
            hasMore: false,
          ),
        );
        await repository.markSnapshotDismissed(
          const [
            AttentionEventSnapshot(
              brokerProfileId: 'profile-stale',
              eventId: 'stale',
              revision: 1,
            ),
            AttentionEventSnapshot(
              brokerProfileId: 'profile-stale',
              eventId: 'accepted',
              revision: 1,
            ),
          ],
        );

        final released = await repository.reconcileBulkDismissResult(
          brokerProfileId: 'profile-stale',
          result: const AttentionBulkDismissResponse(
            accepted: [
              AttentionBulkDismissAccepted(
                eventId: 'accepted',
                revision: 1,
                dismissedAt: 99,
              ),
            ],
            stale: [
              AttentionBulkDismissStale(
                eventId: 'stale',
                revision: 1,
                currentRevision: 2,
              ),
            ],
            notFound: [],
          ),
        );

        expect(released, 1);
        final events = await repository.loadEvents('profile-stale');
        expect(
          events.singleWhere((event) => event.id == 'stale').dismissedAt,
          isNull,
        );
        expect(
          events.singleWhere((event) => event.id == 'accepted').dismissedAt,
          isNotNull,
        );
        expect(await repository.loadPendingMutations('profile-stale'), isEmpty);
      });
    });
  });
}

AppDatabase _seedV4Database() {
  return AppDatabase(
    NativeDatabase.memory(
      setup: (executor) {
        executor
          ..execute('PRAGMA user_version = 4')
          ..execute('''
          CREATE TABLE artifact_transfer_rows (
            id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_key TEXT NOT NULL,
            file_name TEXT NOT NULL,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            artifact_key TEXT,
            source_url TEXT,
            cached_file_path TEXT,
            exported_path TEXT,
            content_type TEXT,
            content_hash TEXT,
            byte_length INTEGER,
            bytes_transferred INTEGER,
            total_bytes INTEGER,
            error TEXT,
            message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          CREATE TABLE broker_profile_rows (
            id TEXT NOT NULL PRIMARY KEY,
            display_name TEXT NOT NULL,
            base_uri TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER,
            last_used_at INTEGER,
            credential_key TEXT
          );
        ''')
          ..execute('''
          CREATE TABLE app_setting_rows (
            key TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''');
      },
    ),
  );
}

AppDatabase _seedV5Database() {
  return AppDatabase(
    NativeDatabase.memory(
      setup: (executor) {
        executor
          ..execute('PRAGMA user_version = 5')
          ..execute('''
          CREATE TABLE artifact_transfer_rows (
            id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_key TEXT NOT NULL,
            file_name TEXT NOT NULL,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            artifact_key TEXT,
            source_url TEXT,
            cached_file_path TEXT,
            exported_path TEXT,
            content_type TEXT,
            content_hash TEXT,
            byte_length INTEGER,
            bytes_transferred INTEGER,
            total_bytes INTEGER,
            error TEXT,
            message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          CREATE TABLE broker_profile_rows (
            id TEXT NOT NULL PRIMARY KEY,
            display_name TEXT NOT NULL,
            base_uri TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER,
            last_used_at INTEGER,
            credential_key TEXT
          );
        ''')
          ..execute('''
          CREATE TABLE app_setting_rows (
            key TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          CREATE TABLE session_outbox_rows (
            client_message_id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''');
      },
    ),
  );
}

AppDatabase _seedV6Database() {
  return AppDatabase(
    NativeDatabase.memory(
      setup: (executor) {
        executor
          ..execute('PRAGMA user_version = 6')
          ..execute('''
          CREATE TABLE artifact_transfer_rows (
            id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_key TEXT NOT NULL,
            file_name TEXT NOT NULL,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            artifact_key TEXT,
            source_url TEXT,
            cached_file_path TEXT,
            exported_path TEXT,
            content_type TEXT,
            content_hash TEXT,
            byte_length INTEGER,
            bytes_transferred INTEGER,
            total_bytes INTEGER,
            error TEXT,
            message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          CREATE TABLE attention_event_rows (
            broker_profile_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            PRIMARY KEY (broker_profile_id, event_id)
          );
        ''')
          ..execute('''
          CREATE TABLE attention_cursor_rows (
            broker_profile_id TEXT NOT NULL PRIMARY KEY,
            cursor INTEGER NOT NULL,
            persisted_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          CREATE TABLE session_outbox_rows (
            client_message_id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''');
      },
    ),
  );
}

Future<List<String>> _columnNames(
  AppDatabase database,
  String tableName,
) async {
  final pragmaRows = await database
      .customSelect(
        'PRAGMA table_info($tableName)',
      )
      .get();
  return pragmaRows
      .map((row) => row.data['name'] as String)
      .toList(growable: false);
}

AttentionEventView _event({
  required String id,
  required int cursor,
  int revision = 1,
  String kind = 'run-finished',
  int presentationRevision = 1,
  String state = 'active',
  String severity = 'informational',
  String title = 'test',
  String summary = 'summary',
  String? sessionTitle,
}) {
  return AttentionEventView.fromJson(<String, dynamic>{
    'id': id,
    'cursor': cursor,
    'revision': revision,
    'presentationRevision': presentationRevision,
    'kind': kind,
    'state': state,
    'severity': severity,
    'dedupeKey': '$id-de-dupe',
    'createdAt': 1,
    'updatedAt': 2,
    'title': title,
    'summary': summary,
    'sessionId': 'session-id',
    if (sessionTitle != null) 'sessionTitle': sessionTitle,
    'action': {'kind': 'open-attention-inbox'},
  });
}
