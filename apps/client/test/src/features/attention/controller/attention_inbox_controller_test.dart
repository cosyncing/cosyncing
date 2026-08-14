import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftAttentionRepository repository;
  late _AttentionMutationBrokerClient brokerClient;
  late _AttentionMutationBrokerClient secondBrokerClient;
  late _RecordingNotificationSink notificationSink;
  late ProviderContainer container;

  final profile = BrokerProfile(
    id: 'profile-1',
    displayName: 'Local',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026, 7, 16),
  );
  final secondProfile = BrokerProfile(
    id: 'profile-2',
    displayName: 'Remote',
    baseUri: Uri.parse('http://127.0.0.1:7735'),
    createdAt: DateTime(2026, 7, 16),
  );

  AttentionInboxEntry entry(
    String id, {
    BrokerProfile? owner,
    int revision = 1,
    int presentationRevision = 1,
  }) => AttentionInboxEntry(
    profile: owner ?? profile,
    event: AttentionEventView.fromJson({
      'id': id,
      'cursor': 1,
      'revision': revision,
      'presentationRevision': presentationRevision,
      'kind': 'question-required',
      'state': 'active',
      'severity': 'action-required',
      'dedupeKey': id,
      'createdAt': 1,
      'updatedAt': 1,
      'title': 'Question',
      'action': {'kind': 'open-attention-inbox'},
    }),
  );

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftAttentionRepository(database);
    brokerClient = _AttentionMutationBrokerClient();
    secondBrokerClient = _AttentionMutationBrokerClient();
    notificationSink = _RecordingNotificationSink();
    container = ProviderContainer(
      overrides: [
        attentionRepositoryProvider.overrideWithValue(repository),
        attentionProfileClientProvider.overrideWith(
          (ref, requestedProfile) async => requestedProfile.id == profile.id
              ? brokerClient
              : secondBrokerClient,
        ),
        attentionClientIdProvider.overrideWith((ref) async => 'device-1'),
        sessionLocalNotificationSinkProvider.overrideWithValue(
          notificationSink,
        ),
      ],
    );
  });

  tearDown(() async {
    container.dispose();
    await database.close();
  });

  test('read and dismiss clear their visible OS notifications', () async {
    final actions = container.read(attentionInboxActionsProvider);

    await actions.acknowledge(entry('event-read'));
    await actions.dismiss(entry('event-dismiss'));

    expect(notificationSink.cleared.toSet(), {
      ...attentionNotificationIdsForEvent(
        brokerProfileId: profile.id,
        event: entry('event-read').event,
      ),
      ...attentionNotificationIdsForEvent(
        brokerProfileId: profile.id,
        event: entry('event-dismiss').event,
      ),
    });
    expect(brokerClient.acknowledged, ['event-read']);
    expect(brokerClient.dismissed, ['event-dismiss']);
  });

  test(
    'refreshes durable local state before platform clear completes',
    () async {
      final clearBlock = Completer<void>();
      notificationSink.clearBlock = clearBlock;
      final revisionBefore = container.read(attentionInboxRevisionProvider);

      final operation = container
          .read(attentionInboxActionsProvider)
          .acknowledge(entry('event-slow-clear'));
      await notificationSink.clearStarted.future;

      expect(
        container.read(attentionInboxRevisionProvider),
        revisionBefore + 1,
      );
      expect(brokerClient.acknowledged, isEmpty);

      clearBlock.complete();
      await operation;
      expect(brokerClient.acknowledged, ['event-slow-clear']);
    },
  );

  test(
    'Clear all dismisses one exact snapshot, invalidates once, '
    'and posts one bulk request',
    () async {
      final entries = [
        entry('event-a'),
        entry('event-b'),
        entry('event-c'),
      ];
      await _persist(repository, entries);
      final revisionBefore = container.read(attentionInboxRevisionProvider);

      final result = await container
          .read(attentionInboxActionsProvider)
          .clearAll(AttentionInboxSections.fromEntries(entries));

      expect(result.locallyDismissed, 3);
      expect(result.pendingProfiles, 0);
      expect(
        container.read(attentionInboxRevisionProvider),
        revisionBefore + 1,
      );
      expect(notificationSink.clearManyCallCount, 1);
      expect(notificationSink.clearAllCallCount, 0);
      expect(
        notificationSink.cleared,
        isNot(contains('session-notification:unrelated')),
      );
      expect(brokerClient.bulkRequests, hasLength(1));
      expect(
        brokerClient.bulkRequests.single.map((item) => item.eventId).toSet(),
        {'event-a', 'event-b', 'event-c'},
      );
      expect(
        AttentionInboxSections.fromEntries(
          (await repository.loadEvents(_scope(profile))).map(
            (event) => AttentionInboxEntry(profile: profile, event: event),
          ),
        ).all,
        isEmpty,
      );
      expect(await repository.loadPendingMutations(_scope(profile)), isEmpty);
    },
  );

  test(
    'Clear all leaves concurrent inserts and newer revisions visible',
    () async {
      final oldA = entry('event-a');
      final oldB = entry('event-b');
      await _persist(repository, [oldA, oldB]);
      final snapshot = AttentionInboxSections.fromEntries([oldA, oldB]);

      final newerA = entry('event-a', revision: 2);
      final inserted = entry('event-new');
      await _persist(repository, [newerA, inserted], cursor: 2);

      final result = await container
          .read(attentionInboxActionsProvider)
          .clearAll(snapshot);

      expect(result.locallyDismissed, 1);
      expect(
        brokerClient.bulkRequests.single
            .map((item) => (item.eventId, item.revision))
            .toList(),
        [('event-b', 1)],
      );
      final visible = AttentionInboxSections.fromEntries(
        (await repository.loadEvents(_scope(profile))).map(
          (event) => AttentionInboxEntry(profile: profile, event: event),
        ),
      );
      expect(visible.all.map((item) => item.event.id).toSet(), {
        'event-a',
        'event-new',
      });
      expect(
        visible.all
            .singleWhere((item) => item.event.id == 'event-a')
            .event
            .revision,
        2,
      );
      expect(
        notificationSink.cleared,
        isNot(
          contains(
            attentionNotificationId(
              brokerProfileId: profile.id,
              eventId: newerA.event.id,
              dedupeKey: attentionNotificationCoalescingKey(newerA.event),
              presentationRevision: newerA.event.presentationRevision,
            ),
          ),
        ),
      );
      expect(notificationSink.clearAllCallCount, 0);
      expect(
        notificationSink.cleared,
        isNot(
          contains(
            attentionNotificationId(
              brokerProfileId: profile.id,
              eventId: inserted.event.id,
              dedupeKey: attentionNotificationCoalescingKey(inserted.event),
              presentationRevision: inserted.event.presentationRevision,
            ),
          ),
        ),
      );
    },
  );

  test(
    'Clear all platform clearing preserves arrivals and newer presentations',
    () async {
      final oldA = entry('event-a');
      final oldB = entry('event-b');
      final newerA = entry(
        'event-a',
        revision: 2,
        presentationRevision: 2,
      );
      final inserted = entry('event-new');
      await _persist(repository, [oldA, oldB]);
      notificationSink.beforeClearMany = () =>
          _persist(repository, [newerA, inserted], cursor: 2);

      await container
          .read(attentionInboxActionsProvider)
          .clearAll(AttentionInboxSections.fromEntries([oldA, oldB]));

      expect(notificationSink.clearManyCallCount, 1);
      expect(
        notificationSink.cleared,
        contains(
          attentionNotificationId(
            brokerProfileId: profile.id,
            eventId: oldA.event.id,
            dedupeKey: attentionNotificationCoalescingKey(oldA.event),
            presentationRevision: oldA.event.presentationRevision,
          ),
        ),
      );
      expect(
        notificationSink.cleared,
        isNot(
          contains(
            attentionNotificationId(
              brokerProfileId: profile.id,
              eventId: newerA.event.id,
              dedupeKey: attentionNotificationCoalescingKey(newerA.event),
              presentationRevision: newerA.event.presentationRevision,
            ),
          ),
        ),
      );
      expect(
        notificationSink.cleared,
        isNot(
          contains(
            attentionNotificationId(
              brokerProfileId: profile.id,
              eventId: inserted.event.id,
              dedupeKey: attentionNotificationCoalescingKey(inserted.event),
              presentationRevision: inserted.event.presentationRevision,
            ),
          ),
        ),
      );
      final visible = AttentionInboxSections.fromEntries(
        (await repository.loadEvents(_scope(profile))).map(
          (event) => AttentionInboxEntry(profile: profile, event: event),
        ),
      );
      expect(visible.all.map((item) => item.event.id).toSet(), {
        'event-a',
        'event-new',
      });
    },
  );

  test(
    'Clear all isolates profiles and keeps only the offline profile pending',
    () async {
      final local = entry('local-event');
      final remote = entry('remote-event', owner: secondProfile);
      await _persist(repository, [local, remote]);
      secondBrokerClient.failBulk = true;

      final result = await container
          .read(attentionInboxActionsProvider)
          .clearAll(AttentionInboxSections.fromEntries([local, remote]));

      expect(result.locallyDismissed, 2);
      expect(result.pendingProfiles, 1);
      expect(brokerClient.bulkRequests, hasLength(1));
      expect(secondBrokerClient.bulkRequests, hasLength(1));
      expect(await repository.loadPendingMutations(_scope(profile)), isEmpty);
      expect(
        await repository.loadPendingMutations(_scope(secondProfile)),
        hasLength(1),
      );
      expect(notificationSink.clearManyCallCount, 1);
    },
  );

  test('broker stale result releases the obsolete local dismissal', () async {
    final staleEntry = entry('changed-event');
    await _persist(repository, [staleEntry]);
    brokerClient.bulkResult = const AttentionBulkDismissResponse(
      accepted: [],
      stale: [
        AttentionBulkDismissStale(
          eventId: 'changed-event',
          revision: 1,
          currentRevision: 2,
        ),
      ],
      notFound: [],
    );
    final revisionBefore = container.read(attentionInboxRevisionProvider);

    final result = await container
        .read(attentionInboxActionsProvider)
        .clearAll(AttentionInboxSections.fromEntries([staleEntry]));

    expect(result.staleEvents, 1);
    expect(
      container.read(attentionInboxRevisionProvider),
      revisionBefore + 2,
    );
    final visible = AttentionInboxSections.fromEntries([
      AttentionInboxEntry(
        profile: profile,
        event: (await repository.loadEvents(_scope(profile))).single,
      ),
    ]);
    expect(visible.all.single.event.id, 'changed-event');
    expect(visible.all.single.event.action.kind, 'open-attention-inbox');
    expect(await repository.loadPendingMutations(_scope(profile)), isEmpty);
  });

  test(
    'repeated Clear all is a no-op and OS clear failure cannot '
    'roll back local state',
    () async {
      final snapshotEntry = entry('repeat-event');
      await _persist(repository, [snapshotEntry]);
      notificationSink.failClearMany = true;
      final snapshot = AttentionInboxSections.fromEntries([snapshotEntry]);

      final first = await container
          .read(attentionInboxActionsProvider)
          .clearAll(snapshot);
      final revisionAfterFirst = container.read(attentionInboxRevisionProvider);
      final second = await container
          .read(attentionInboxActionsProvider)
          .clearAll(snapshot);

      expect(first.locallyDismissed, 1);
      expect(second.locallyDismissed, 0);
      expect(
        container.read(attentionInboxRevisionProvider),
        revisionAfterFirst,
      );
      expect(notificationSink.clearManyCallCount, 1);
      expect(brokerClient.bulkRequests, hasLength(1));
      expect(
        AttentionInboxSections.fromEntries(
          (await repository.loadEvents(_scope(profile))).map(
            (event) => AttentionInboxEntry(profile: profile, event: event),
          ),
        ).all,
        isEmpty,
      );
    },
  );

  test(
    'Clear all chunks a valid profile snapshot above the wire cap',
    () async {
      final entries = [
        for (var index = 0; index < attentionBulkDismissMax + 1; index += 1)
          entry('event-$index'),
      ];
      await _persist(repository, entries, cursor: entries.length);

      final result = await container
          .read(attentionInboxActionsProvider)
          .clearAll(AttentionInboxSections.fromEntries(entries));

      expect(result.locallyDismissed, attentionBulkDismissMax + 1);
      expect(result.pendingProfiles, 0);
      expect(brokerClient.bulkRequests, hasLength(2));
      expect(
        brokerClient.bulkRequests.first,
        hasLength(attentionBulkDismissMax),
      );
      expect(brokerClient.bulkRequests.last, hasLength(1));
      expect(notificationSink.clearManyCallCount, 1);
    },
  );
}

Future<void> _persist(
  DriftAttentionRepository repository,
  List<AttentionInboxEntry> entries, {
  int cursor = 1,
}) async {
  final byProfile = <String, List<AttentionEventView>>{};
  for (final entry in entries) {
    byProfile.putIfAbsent(_scope(entry.profile), () => []).add(entry.event);
  }
  for (final profileEntries in byProfile.entries) {
    await repository.persistAttentionEventsPage(
      brokerProfileId: profileEntries.key,
      page: AttentionEventsPage(
        events: profileEntries.value,
        cursor: cursor,
        reset: false,
        hasMore: false,
      ),
    );
  }
}

String _scope(BrokerProfile profile) =>
    RosterSource.ofProfile(profile).storageKey;

final class _AttentionMutationBrokerClient extends BrokerClient {
  _AttentionMutationBrokerClient() : super(baseUrl: 'http://127.0.0.1:7734');

  final acknowledged = <String>[];
  final dismissed = <String>[];
  final bulkRequests = <List<AttentionBulkDismissItem>>[];
  bool failBulk = false;
  AttentionBulkDismissResponse? bulkResult;

  @override
  Future<Map<String, dynamic>> acknowledgeAttentionEvent(
    String eventId, {
    required String clientId,
  }) async {
    acknowledged.add(eventId);
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> dismissAttentionEvent(
    String eventId, {
    required String clientId,
  }) async {
    dismissed.add(eventId);
    return {'ok': true};
  }

  @override
  Future<AttentionBulkDismissResponse> dismissAttentionEvents(
    List<AttentionBulkDismissItem> events, {
    required String clientId,
  }) async {
    bulkRequests.add(List.unmodifiable(events));
    if (failBulk) throw StateError('offline');
    return bulkResult ??
        AttentionBulkDismissResponse(
          accepted: [
            for (final event in events)
              AttentionBulkDismissAccepted(
                eventId: event.eventId,
                revision: event.revision,
                dismissedAt: DateTime(2026, 7, 26).millisecondsSinceEpoch,
              ),
          ],
          stale: const [],
          notFound: const [],
        );
  }
}

final class _RecordingNotificationSink implements BrokerNotificationSink {
  final cleared = <String>[];
  final clearStarted = Completer<void>();
  Completer<void>? clearBlock;
  Future<void> Function()? beforeClearMany;
  int clearManyCallCount = 0;
  int clearAllCallCount = 0;
  bool failClearMany = false;

  @override
  Future<void> clear(String id) async {
    cleared.add(id);
    if (!clearStarted.isCompleted) clearStarted.complete();
    await clearBlock?.future;
  }

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    clearManyCallCount += 1;
    await beforeClearMany?.call();
    cleared.addAll(ids);
    if (!clearStarted.isCompleted) clearStarted.complete();
    await clearBlock?.future;
    if (failClearMany) throw StateError('notification center unavailable');
  }

  @override
  Future<void> clearAll() async {
    clearAllCallCount += 1;
  }

  @override
  Future<void> show(BrokerNotificationRequest request) async {}
}
