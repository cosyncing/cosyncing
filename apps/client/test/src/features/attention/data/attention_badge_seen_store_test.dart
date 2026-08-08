import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_badge_seen_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftAttentionRepository repository;
  late AttentionBadgeSeenStore store;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = DriftAttentionRepository(database);
    store = DriftAttentionBadgeSeenStore(database);
  });

  tearDown(() => database.close());

  test('badge watermark is durable, profile-scoped, and monotonic', () async {
    await repository.persistAttentionEventsPage(
      brokerProfileId: 'profile-a',
      page: AttentionEventsPage(
        events: [_event('a-1', 1), _event('a-2', 2)],
        cursor: 2,
        reset: false,
        hasMore: false,
      ),
    );
    await repository.persistAttentionEventsPage(
      brokerProfileId: 'profile-b',
      page: AttentionEventsPage(
        events: [_event('b-1', 1)],
        cursor: 1,
        reset: false,
        hasMore: false,
      ),
    );

    expect(await store.loadUnseenCount('profile-a'), 2);
    expect(await store.loadUnseenCount('profile-b'), 1);
    expect(await store.markSeenThroughCursor('profile-a', 2), isTrue);
    expect(await store.markSeenThroughCursor('profile-a', 1), isFalse);
    expect(
      await DriftAttentionBadgeSeenStore(
        database,
      ).loadUnseenCount('profile-a'),
      0,
    );
    expect(await store.loadUnseenCount('profile-b'), 1);
  });

  test(
    'new arrivals count once and explicit read also removes the badge',
    () async {
      await repository.persistAttentionEventsPage(
        brokerProfileId: 'profile',
        page: AttentionEventsPage(
          events: [_event('seen', 1)],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      await store.markSeenThroughCursor('profile', 1);

      final arrival = _event('arrival', 2);
      await repository.persistAttentionEventsPage(
        brokerProfileId: 'profile',
        page: AttentionEventsPage(
          events: [arrival],
          cursor: 2,
          reset: false,
          hasMore: false,
        ),
      );
      await repository.persistAttentionEventsPage(
        brokerProfileId: 'profile',
        page: AttentionEventsPage(
          events: [arrival],
          cursor: 2,
          reset: false,
          hasMore: false,
        ),
      );

      expect(await store.loadUnseenCount('profile'), 1);
      await repository.markRead('profile', 'arrival');
      expect(await store.loadUnseenCount('profile'), 0);
    },
  );

  test(
    'historical baseline and dismissed rows never inflate the badge',
    () async {
      await repository.persistAttentionEventsPage(
        brokerProfileId: 'profile',
        page: AttentionEventsPage(
          events: [
            _event('historical', 1, historicalBaseline: true),
            _event('dismissed', 2),
          ],
          cursor: 2,
          reset: false,
          hasMore: false,
          baselineThroughCursor: 1,
        ),
      );
      await repository.markDismissed('profile', 'dismissed');

      expect(await store.loadUnseenCount('profile'), 0);
    },
  );

  test('broker cursor reset starts a fresh badge epoch', () async {
    await repository.persistAttentionEventsPage(
      brokerProfileId: 'profile',
      page: AttentionEventsPage(
        events: [_event('old', 50)],
        cursor: 50,
        reset: false,
        hasMore: false,
      ),
    );
    await store.markSeenThroughCursor('profile', 50);

    await repository.persistAttentionEventsPage(
      brokerProfileId: 'profile',
      page: AttentionEventsPage(
        events: [_event('new-baseline', 2)],
        cursor: 2,
        reset: true,
        hasMore: false,
        baselineThroughCursor: 2,
      ),
    );
    expect(await store.loadUnseenCount('profile'), 0);

    await repository.persistAttentionEventsPage(
      brokerProfileId: 'profile',
      page: AttentionEventsPage(
        events: [_event('new-arrival', 3)],
        cursor: 3,
        reset: false,
        hasMore: false,
      ),
    );
    expect(await store.loadUnseenCount('profile'), 1);
    expect(await store.markSeenThroughCursor('profile', 3), isTrue);
    expect(await store.loadUnseenCount('profile'), 0);
  });
}

AttentionEventView _event(
  String id,
  int cursor, {
  bool historicalBaseline = false,
}) {
  return AttentionEventView(
    id: id,
    cursor: cursor,
    revision: 1,
    presentationRevision: 1,
    kind: 'runtime-update-ready',
    state: 'active',
    severity: 'maintenance',
    dedupeKey: id,
    createdAt: cursor,
    updatedAt: cursor,
    title: 'Runtime update ready',
    action: const AttentionEventAction(kind: 'open-runtime-settings'),
    historicalBaseline: historicalBaseline,
  );
}
