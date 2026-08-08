import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final class _FixedRosterWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.last7Days;
}

/// A repository whose response the test releases by hand, so the window in
/// which cached identity is on screen can be observed rather than raced.
final class _HeldSessionListRepository implements SessionListRepository {
  List<SessionInfo> sessions = const [];
  bool shouldFail = false;
  int fetchCount = 0;
  Completer<void>? gate;

  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) async {
    fetchCount++;
    final pending = gate;
    if (pending != null) await pending.future;
    if (shouldFail) throw Exception('Broker unreachable');
    return ListSessionsResponse(sessions: sessions, revision: revision);
  }

  /// Revision the fetch reports, so a delta feed can continue from it.
  int revision = 0;
}

/// A repository that also serves roster deltas, so the feed path — the only
/// thing that moves the roster once it is healthy — can be driven directly.
final class _LiveHeldSessionListRepository extends _HeldSessionListRepository
    implements LiveSessionListRepository {
  final List<Completer<SessionRosterDeltaBatch>> _waits = [];
  int deltaWaitCount = 0;

  @override
  Future<SessionRosterDeltaBatch> waitForDeltas({
    required int after,
    Duration wait = const Duration(seconds: 25),
  }) {
    deltaWaitCount++;
    final completer = Completer<SessionRosterDeltaBatch>();
    _waits.add(completer);
    return completer.future;
  }

  @override
  void cancelDeltaWait() {
    for (final completer in _waits) {
      if (!completer.isCompleted) {
        completer.completeError(
          const SessionRosterDeltaWaitCancelledException(),
        );
      }
    }
    _waits.clear();
  }

  /// Delivers one delta batch to the controller's live feed.
  void emit(SessionRosterDeltaBatch batch) {
    final pending = _waits.isEmpty ? null : _waits.removeAt(0);
    pending?.complete(batch);
  }
}

/// An in-memory snapshot repository that records every call, so "exactly one
/// read" and "no cross-profile write" are assertions rather than hopes.
final class _RecordingRosterSnapshotRepository
    implements RosterSnapshotRepository {
  final Map<String, SessionRosterSnapshot> stored = {};
  final Map<String, String> endpoints = {};
  final List<String> loads = [];
  final List<String> saves = [];
  final List<String> savedEndpoints = [];
  final List<String> deletes = [];
  Completer<void>? loadGate;

  /// Save gates, keyed by profile, so one profile's write can be held in flight
  /// while another profile's work proceeds.
  final Map<String, Completer<void>> saveGates = {};

  /// Holds only the NEXT save, whichever it is. Lets a test open the first
  /// write and let every later one through, which is the shape that catches an
  /// older write finishing last.
  Completer<void>? nextSaveGate;

  /// Optional production-shaped ordering boundary for controller race tests.
  SessionCacheWriteFence? writeFence;

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async {
    loads.add(brokerProfileId);
    final pending = loadGate;
    if (pending != null) await pending.future;
    // Same provenance rule as the Drift store: a row captured from a different
    // broker is refused and deleted rather than returned.
    final owner = endpoints[brokerProfileId];
    if (owner != null && owner != endpoint) {
      deletes.add(brokerProfileId);
      stored.remove(brokerProfileId);
      endpoints.remove(brokerProfileId);
      return null;
    }
    return stored[brokerProfileId];
  }

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) {
    Future<SessionRosterSnapshot> operation() async {
      saves.add(brokerProfileId);
      savedEndpoints.add(endpoint);
      final once = nextSaveGate;
      if (once != null) {
        nextSaveGate = null;
        await once.future;
      }
      final gate = saveGates[brokerProfileId];
      if (gate != null) await gate.future;
      endpoints[brokerProfileId] = endpoint;
      final bounded = boundRosterSnapshotPayload(sessions);
      final snapshot = SessionRosterSnapshot(
        brokerProfileId: brokerProfileId,
        rows: bounded.rows,
        capturedAt: now ?? DateTime.now(),
        omittedRowCount: bounded.omittedRowCount,
        newestSessionUpdatedAt: bounded.newestSessionUpdatedAt,
      );
      stored[brokerProfileId] = snapshot;
      return snapshot;
    }

    return writeFence?.write(operation) ?? operation();
  }

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {
    deletes.add(brokerProfileId);
    stored.remove(brokerProfileId);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  BrokerProfile profile(String id) => BrokerProfile(
    id: id,
    displayName: id,
    baseUri: Uri.parse('http://$id.example'),
    createdAt: DateTime.utc(2026, 7),
  );

  SessionInfo session({
    String id = 's1',
    String title = 'Live session',
    SessionStatus status = SessionStatus.working,
  }) => SessionInfo(
    id: id,
    tool: 'codex',
    title: title,
    status: status,
    attachMode: AttachMode.live,
    machine: 'mac',
    cwd: '/work/app',
    updatedAt: 5000,
  );

  SessionRosterSnapshot snapshotOf(
    String profileId,
    List<SessionInfo> sessions,
  ) {
    final bounded = boundRosterSnapshotPayload(sessions);
    return SessionRosterSnapshot(
      brokerProfileId: profileId,
      rows: bounded.rows,
      capturedAt: DateTime.now(),
      omittedRowCount: bounded.omittedRowCount,
      newestSessionUpdatedAt: bounded.newestSessionUpdatedAt,
    );
  }

  late _HeldSessionListRepository broker;
  late _RecordingRosterSnapshotRepository snapshots;

  ProviderContainer makeContainer(BrokerProfile? active) {
    final container = ProviderContainer(
      overrides: [
        sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        sessionListRepositoryProvider.overrideWith((ref) async => broker),
        rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        if (active != null)
          activeBrokerProfileProvider.overrideWith((ref) => active),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  /// A container whose active profile the test can change, so a real switch can
  /// be observed rather than simulated with two containers.
  ProviderContainer makeContainerWithMutableProfile() {
    final container = ProviderContainer(
      overrides: [
        sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        sessionListRepositoryProvider.overrideWith((ref) async => broker),
        rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  setUp(() {
    broker = _HeldSessionListRepository();
    snapshots = _RecordingRosterSnapshotRepository();
  });

  test(
    'empty cache: real chrome plus loading, exactly one broker request',
    () async {
      final container = makeContainer(profile('profile-a'));
      broker.sessions = [session()];

      await container.read(sessionListControllerProvider.notifier).load();

      final state = container.read(sessionListControllerProvider);
      expect(state.status, SessionListStatus.loaded);
      expect(state.cachedRoster, isNull);
      expect(broker.fetchCount, 1, reason: 'no second roster request');
      expect(snapshots.loads, ['profile-a']);
    },
  );

  test(
    'valid cache publishes stale rows before a held broker response',
    () async {
      snapshots.stored['profile-a'] = snapshotOf('profile-a', [
        session(id: 'cached-1', title: 'Cached one'),
        session(id: 'cached-2', title: 'Cached two'),
      ]);
      final container = makeContainer(profile('profile-a'));
      broker
        ..sessions = [session(id: 'live-1')]
        ..gate = Completer<void>();

      final load = container
          .read(sessionListControllerProvider.notifier)
          .load();
      // Let the local read resolve while the broker response is still held.
      await pumpEventQueue();

      final pending = container.read(sessionListControllerProvider);
      expect(pending.sessions, isEmpty);
      expect(pending.cachedRoster, isNotNull);
      expect(pending.cachedRoster!.reason, CachedRosterReason.hydrating);
      expect(
        pending.cachedRoster!.snapshot.rows.map((row) => row.sessionId),
        ['cached-1', 'cached-2'],
      );
      expect(broker.fetchCount, 1, reason: 'cached rows add no roster request');

      broker.gate!.complete();
      await load;

      final loaded = container.read(sessionListControllerProvider);
      expect(loaded.status, SessionListStatus.loaded);
      expect(loaded.sessions.map((s) => s.id), ['live-1']);
      expect(
        loaded.cachedRoster,
        isNull,
        reason: 'authoritative rows and cached rows are never both live',
      );
      expect(broker.fetchCount, 1);
    },
  );

  test(
    'a successful response refreshes the snapshot for that profile',
    () async {
      final container = makeContainer(profile('profile-a'));
      broker.sessions = [session(id: 'live-1')];

      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();

      expect(snapshots.saves, ['profile-a']);
      expect(
        snapshots.stored['profile-a']!.rows.map((row) => row.sessionId),
        ['live-1'],
      );
    },
  );

  test(
    'a failed load keeps cached rows and relabels them unreachable',
    () async {
      snapshots.stored['profile-a'] = snapshotOf('profile-a', [
        session(id: 'cached-1'),
      ]);
      final container = makeContainer(profile('profile-a'));
      broker
        ..shouldFail = true
        ..gate = Completer<void>();

      final load = container
          .read(sessionListControllerProvider.notifier)
          .load();
      await pumpEventQueue();
      expect(
        container.read(sessionListControllerProvider).cachedRoster!.reason,
        CachedRosterReason.hydrating,
      );

      broker.gate!.complete();
      await load;

      final state = container.read(sessionListControllerProvider);
      expect(state.status, SessionListStatus.error);
      expect(state.error, isNotNull);
      expect(state.cachedRoster, isNotNull);
      expect(state.cachedRoster!.reason, CachedRosterReason.unreachable);
      expect(
        state.cachedRoster!.snapshot.rows.map((row) => row.sessionId),
        ['cached-1'],
      );
      expect(
        snapshots.saves,
        isEmpty,
        reason: 'a failed response must not rewrite the snapshot',
      );
    },
  );

  test(
    "profile A's snapshot cannot flash during profile B's startup",
    () async {
      snapshots.stored['profile-a'] = snapshotOf('profile-a', [
        session(id: 'a-cached'),
      ]);
      final active = profile('profile-a');
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async => broker),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        ],
      );
      addTearDown(container.dispose);
      container.read(activeBrokerProfileProvider.notifier).state = active;

      broker.gate = Completer<void>();
      snapshots.loadGate = Completer<void>();
      final load = container
          .read(sessionListControllerProvider.notifier)
          .load();
      await pumpEventQueue();

      // The user switches broker while A's snapshot read is still outstanding.
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      snapshots.loadGate!.complete();
      await pumpEventQueue();

      expect(
        container.read(sessionListControllerProvider).cachedRoster,
        isNull,
        reason: "another profile's identities must never reach the screen",
      );

      broker.gate!.complete();
      await load;
    },
  );

  test('a snapshot write is never attributed to the new profile', () async {
    final container = ProviderContainer(
      overrides: [
        sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        sessionListRepositoryProvider.overrideWith((ref) async => broker),
        rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
      ],
    );
    addTearDown(container.dispose);
    container.read(activeBrokerProfileProvider.notifier).state = profile(
      'profile-a',
    );
    broker
      ..sessions = [session(id: 'a-live')]
      ..gate = Completer<void>();

    final load = container.read(sessionListControllerProvider.notifier).load();
    await pumpEventQueue();
    container.read(activeBrokerProfileProvider.notifier).state = profile(
      'profile-b',
    );
    broker.gate!.complete();
    await load;

    expect(snapshots.saves, isEmpty);
    expect(snapshots.stored, isEmpty);
  });

  test('disposal during a held cache read publishes nothing', () async {
    snapshots
      ..stored['profile-a'] = snapshotOf('profile-a', [session(id: 'cached')])
      ..loadGate = Completer<void>();
    final container = makeContainer(profile('profile-a'));
    broker.gate = Completer<void>();

    final load = container.read(sessionListControllerProvider.notifier).load();
    await pumpEventQueue();
    container.dispose();
    snapshots.loadGate!.complete();
    broker.gate!.complete();

    // The load's own error handling may or may not run after disposal; what
    // matters is that nothing throws out of the guarded publish path.
    await load.catchError((Object _) {});
    await pumpEventQueue();
  });

  test('the snapshot is read once per profile, not once per load', () async {
    snapshots.stored['profile-a'] = snapshotOf('profile-a', [
      session(id: 'cached'),
    ]);
    final container = makeContainer(profile('profile-a'));
    broker.sessions = [session(id: 'live')];

    final controller = container.read(sessionListControllerProvider.notifier);
    await controller.load();
    await controller.load();
    await controller.load();

    expect(snapshots.loads, ['profile-a']);
    expect(
      broker.fetchCount,
      3,
      reason: 'refreshes still hit the broker once each',
    );
  });

  test('no timer, poll or extra request is introduced by the cache', () async {
    snapshots.stored['profile-a'] = snapshotOf('profile-a', [
      session(id: 'cached'),
    ]);
    final container = makeContainer(profile('profile-a'));
    broker.sessions = [session(id: 'live')];

    await container.read(sessionListControllerProvider.notifier).load();
    final fetchesAfterLoad = broker.fetchCount;
    final savesAfterLoad = snapshots.saves.length;

    // Nothing schedules further work: draining the queue repeatedly changes
    // neither counter.
    await pumpEventQueue();
    await pumpEventQueue();

    expect(broker.fetchCount, fetchesAfterLoad);
    expect(snapshots.saves.length, savesAfterLoad);
    expect(snapshots.loads, hasLength(1));
  });

  group('local-first hydration', () {
    test(
      'cached rows appear while the broker client is still being built',
      () async {
        // The repository future stands in for everything behind it: the
        // broker-client construction, the credential read from secure
        // storage and socket setup. The cached roster exists to fill exactly
        // this window, so it must not be gated on the window closing.
        final clientGate = Completer<void>();
        snapshots.stored['profile-a'] = snapshotOf('profile-a', [
          session(id: 'cached-1', title: 'Cached one'),
        ]);
        final container = ProviderContainer(
          overrides: [
            sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
            sessionListRepositoryProvider.overrideWith((ref) async {
              await clientGate.future;
              return broker;
            }),
            rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
            activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
            activeBrokerProfileProvider.overrideWith(
              (ref) => profile('profile-a'),
            ),
          ],
        );
        addTearDown(container.dispose);
        broker.sessions = [session(id: 'live-1')];

        final load = container
            .read(sessionListControllerProvider.notifier)
            .load();
        await pumpEventQueue();

        final pending = container.read(sessionListControllerProvider);
        expect(
          pending.cachedRoster,
          isNotNull,
          reason: 'the cache must be readable before the broker client exists',
        );
        expect(
          pending.cachedRoster!.snapshot.rows.single.sessionId,
          'cached-1',
        );
        expect(
          broker.fetchCount,
          0,
          reason: 'nothing has been asked of the broker yet',
        );

        clientGate.complete();
        await load;
        expect(
          container.read(sessionListControllerProvider).cachedRoster,
          isNull,
        );
        expect(broker.fetchCount, 1);
      },
    );

    test('switching to B shows no A row while B is unresolved', () async {
      snapshots.stored['profile-a'] = snapshotOf('profile-a', [
        session(id: 'a-cached'),
      ]);
      snapshots.stored['profile-b'] = snapshotOf('profile-b', [
        session(id: 'b-cached', title: 'B cached'),
      ]);
      final clientGate = Completer<void>();
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async {
            final profileId = ref.watch(activeBrokerProfileProvider)?.id;
            if (profileId == 'profile-b') await clientGate.future;
            return broker;
          }),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        ],
      );
      addTearDown(container.dispose);
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-a',
      );
      broker.sessions = [session(id: 'a-live', title: 'A live')];

      final controller = container.read(sessionListControllerProvider.notifier);
      await controller.load();
      expect(
        container.read(sessionListControllerProvider).sessions.single.id,
        'a-live',
      );

      // Switch. B's client cannot resolve yet.
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      final loadB = controller.load();
      await pumpEventQueue();

      final duringSwitch = container.read(sessionListControllerProvider);
      expect(
        duringSwitch.sessions,
        isEmpty,
        reason: "A's sessions must not survive under B's name",
      );
      expect(duringSwitch.profileId, 'profile-b');
      expect(
        duringSwitch.cachedRoster?.snapshot.rows.map((row) => row.sessionId),
        ['b-cached'],
        reason: "B's own cache fills the wait, before B's authoritative reply",
      );
      expect(
        duringSwitch.cachedRoster!.snapshot.brokerProfileId,
        'profile-b',
      );

      broker.sessions = [session(id: 'b-live', title: 'B live')];
      clientGate.complete();
      await loadB;

      final afterB = container.read(sessionListControllerProvider);
      expect(afterB.sessions.single.id, 'b-live');
      expect(afterB.cachedRoster, isNull);
      expect(
        broker.fetchCount,
        2,
        reason: 'one authoritative request per profile, and no more',
      );
      expect(snapshots.loads, ['profile-a', 'profile-b']);
    });

    test(
      'a profile switch invalidates the roster before any load runs',
      () async {
        final container = makeContainerWithMutableProfile();
        container.read(activeBrokerProfileProvider.notifier).state = profile(
          'profile-a',
        );
        broker.sessions = [session(id: 'a-live')];
        await container.read(sessionListControllerProvider.notifier).load();
        expect(
          container.read(sessionListControllerProvider).sessions,
          hasLength(1),
        );

        container.read(activeBrokerProfileProvider.notifier).state = profile(
          'profile-b',
        );

        final state = container.read(sessionListControllerProvider);
        expect(
          state.sessions,
          isEmpty,
          reason: 'invalidation is immediate, not deferred to the next load',
        );
        expect(state.cachedRoster, isNull);
        expect(state.profileId, 'profile-b');
        expect(state.status, SessionListStatus.loading);
      },
    );
  });

  test('concurrent loads share one snapshot read and still publish', () async {
    // Startup really does run two loads: the workspace mounts one, and the
    // broker client resolving can start another. "Read once" therefore cannot
    // be a flag set before the await — the second load would skip the read,
    // and the first load's result would then be dropped as stale, leaving the
    // cache unpublished by both.
    snapshots
      ..stored['profile-a'] = snapshotOf('profile-a', [
        session(id: 'cached-1', title: 'Cached one'),
      ])
      ..loadGate = Completer<void>();
    final container = makeContainer(profile('profile-a'));
    broker
      ..sessions = [session(id: 'live-1')]
      ..gate = Completer<void>();
    final controller = container.read(sessionListControllerProvider.notifier);

    final first = controller.load();
    await pumpEventQueue();
    final second = controller.load();
    await pumpEventQueue();

    snapshots.loadGate!.complete();
    await pumpEventQueue();

    final pending = container.read(sessionListControllerProvider);
    expect(
      pending.cachedRoster?.snapshot.rows.map((row) => row.sessionId),
      ['cached-1'],
      reason: 'the second load must publish what the first load read',
    );
    expect(
      snapshots.loads,
      ['profile-a'],
      reason: 'shared, not repeated: the database is still read once',
    );

    broker.gate!.complete();
    await Future.wait([first, second]);
    expect(container.read(sessionListControllerProvider).cachedRoster, isNull);
  });

  group('a superseded response cannot publish', () {
    /// Two brokers behind one provider, chosen the way production chooses:
    /// by watching the active profile.
    ProviderContainer twoBrokerContainer(
      _HeldSessionListRepository brokerA,
      _HeldSessionListRepository brokerB,
    ) {
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async {
            final id = ref.watch(activeBrokerProfileProvider)?.id;
            return id == 'profile-b' ? brokerB : brokerA;
          }),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        ],
      );
      addTearDown(container.dispose);
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-a',
      );
      return container;
    }

    test("a held A response cannot restore A's rows over B", () async {
      // The fetch is the longest await in a load, and the user can switch
      // broker part-way through it. Nothing after the response may be published
      // without revalidating who asked for it.
      final brokerA = _HeldSessionListRepository()
        ..sessions = [session(id: 'a-live', title: 'A live')]
        ..gate = Completer<void>();
      final brokerB = _HeldSessionListRepository()
        ..sessions = [session(id: 'b-live', title: 'B live')];
      final container = twoBrokerContainer(brokerA, brokerB);
      final controller = container.read(sessionListControllerProvider.notifier);

      final loadA = controller.load();
      await pumpEventQueue();
      expect(brokerA.fetchCount, 1, reason: "A's request is outstanding");

      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      await controller.load();
      expect(
        container.read(sessionListControllerProvider).sessions.single.id,
        'b-live',
      );

      // A's response finally arrives, long after the user moved on.
      brokerA.gate!.complete();
      await loadA;
      await pumpEventQueue();

      final state = container.read(sessionListControllerProvider);
      expect(
        state.sessions.map((s) => s.id),
        ['b-live'],
        reason: "A's rows must not reappear under B",
      );
      expect(state.profileId, 'profile-b');
      expect(
        snapshots.saves,
        ['profile-b'],
        reason: "A's late response must not rewrite any snapshot",
      );
    });

    test("a held A failure cannot show an error over B's roster", () async {
      // A broker that fails slowly is the one most likely to be abandoned
      // mid-request; blaming the newly chosen broker for it replaces a healthy
      // roster with an error pane.
      final brokerA = _HeldSessionListRepository()
        ..shouldFail = true
        ..gate = Completer<void>();
      final brokerB = _HeldSessionListRepository()
        ..sessions = [session(id: 'b-live', title: 'B live')];
      final container = twoBrokerContainer(brokerA, brokerB);
      final controller = container.read(sessionListControllerProvider.notifier);

      final loadA = controller.load();
      await pumpEventQueue();
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      await controller.load();

      brokerA.gate!.complete();
      await loadA;
      await pumpEventQueue();

      final state = container.read(sessionListControllerProvider);
      expect(state.status, SessionListStatus.loaded);
      expect(state.error, isNull, reason: "A's outage is not B's");
      expect(state.sessions.map((s) => s.id), ['b-live']);
      expect(state.cachedRoster, isNull);
    });
  });

  group('endpoint provenance', () {
    BrokerProfile pointedAt(Uri uri) => BrokerProfile(
      id: 'profile-a',
      displayName: 'A',
      baseUri: uri,
      createdAt: DateTime.utc(2026, 7),
    );

    test(
      'repointing the active profile shows no row from the old URL',
      () async {
        // Editing a profile's broker URL keeps its id. An id-only comparison
        // leaves the previous broker's roster on screen — and its identities in
        // the cache — under a profile that now points somewhere else.
        final urlOne = Uri.parse('http://one.example:8787');
        final urlTwo = Uri.parse('http://two.example:8787');
        snapshots
          ..stored['profile-a'] = snapshotOf('profile-a', [
            session(id: 'url1-cached', title: 'URL1 cached'),
          ])
          ..endpoints['profile-a'] = RosterSource.normalizedBrokerEndpoint(
            urlOne,
          );

        final hydrateTwo = Completer<void>();
        final container = ProviderContainer(
          overrides: [
            sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
            sessionListRepositoryProvider.overrideWith((ref) async {
              final uri = ref.watch(activeBrokerProfileProvider)?.baseUri;
              if (uri == urlTwo) await hydrateTwo.future;
              return broker;
            }),
            rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
            activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          ],
        );
        addTearDown(container.dispose);
        container.read(activeBrokerProfileProvider.notifier).state = pointedAt(
          urlOne,
        );
        broker.sessions = [session(id: 'url1-live', title: 'URL1 live')];

        final controller = container.read(
          sessionListControllerProvider.notifier,
        );
        await controller.load();
        expect(
          container.read(sessionListControllerProvider).sessions.single.id,
          'url1-live',
        );

        // The user edits the same profile to point at a different broker.
        container.read(activeBrokerProfileProvider.notifier).state = pointedAt(
          urlTwo,
        );
        final loadTwo = controller.load();
        await pumpEventQueue();

        final during = container.read(sessionListControllerProvider);
        expect(
          during.sessions,
          isEmpty,
          reason: "the previous broker's rows are not this broker's",
        );
        expect(
          during.cachedRoster,
          isNull,
          reason:
              'a snapshot captured from the old URL must not hydrate the new',
        );
        expect(
          snapshots.deletes,
          contains('profile-a'),
          reason: 'the foreign snapshot is discarded, not left to be re-read',
        );

        broker.sessions = [session(id: 'url2-live', title: 'URL2 live')];
        hydrateTwo.complete();
        await loadTwo;

        final after = container.read(sessionListControllerProvider);
        expect(after.sessions.map((s) => s.id), ['url2-live']);
        expect(
          snapshots.savedEndpoints.last,
          '${RosterSource.normalizedBrokerEndpoint(urlTwo)}'
          '#roster-window=7d',
          reason: 'the refreshed snapshot records its broker and query window',
        );
      },
    );
  });

  group('delta feed keeps the durable snapshot current', () {
    late _LiveHeldSessionListRepository live;

    ProviderContainer liveContainer() {
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async => live),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          activeBrokerProfileProvider.overrideWith(
            (ref) => profile('profile-a'),
          ),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    setUp(() {
      live = _LiveHeldSessionListRepository();
    });

    test('a renamed session is persisted, not left at its old title', () async {
      live
        ..sessions = [session(title: 'Original title')]
        ..revision = 1;
      final container = liveContainer();
      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();
      expect(
        snapshots.stored['profile-a']!.rows.single.title,
        'Original title',
      );

      live.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'Renamed'),
            ),
          ],
        ),
      );
      await pumpEventQueue();

      expect(
        snapshots.stored['profile-a']!.rows.single.title,
        'Renamed',
        reason: 'a restart must not resurrect the title from first connect',
      );
      expect(
        live.fetchCount,
        1,
        reason: 'persisting delta state adds no broker request',
      );
    });

    test('a removed session leaves the snapshot', () async {
      live
        ..sessions = [
          session(),
          session(id: 's2', title: 'Second'),
        ]
        ..revision = 1;
      final container = liveContainer();
      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();
      expect(snapshots.stored['profile-a']!.rows, hasLength(2));

      live.emit(
        const SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's2',
              changedFields: [],
              removed: true,
            ),
          ],
        ),
      );
      await pumpEventQueue();

      expect(
        snapshots.stored['profile-a']!.rows.map((row) => row.sessionId),
        ['s1'],
      );
      expect(live.fetchCount, 1);
    });

    test(
      'a burst of deltas coalesces into a bounded number of writes',
      () async {
        live
          ..sessions = [session()]
          ..revision = 1;
        final container = liveContainer();
        await container.read(sessionListControllerProvider.notifier).load();
        await pumpEventQueue();
        final afterLoad = snapshots.saves.length;

        for (var revision = 2; revision <= 6; revision++) {
          live.emit(
            SessionRosterDeltaBatch(
              revision: revision,
              deltas: [
                SessionRosterDelta(
                  revision: revision,
                  machine: 'mac',
                  tool: 'codex',
                  sessionId: 's1',
                  changedFields: const ['title'],
                  session: session(title: 'Title $revision'),
                ),
              ],
            ),
          );
          await pumpEventQueue();
        }

        final writes = snapshots.saves.length - afterLoad;
        expect(writes, lessThanOrEqualTo(5));
        expect(
          snapshots.stored['profile-a']!.rows.single.title,
          'Title 6',
          reason: 'coalescing must still land the final roster',
        );
        expect(live.fetchCount, 1, reason: 'the feed replaced the full fetch');
      },
    );

    test(
      'a snapshot written from deltas survives disposal and reopen',
      () async {
        live
          ..sessions = [session(title: 'Before')]
          ..revision = 1;
        final first = liveContainer();
        await first.read(sessionListControllerProvider.notifier).load();
        await pumpEventQueue();
        live.emit(
          SessionRosterDeltaBatch(
            revision: 2,
            deltas: [
              SessionRosterDelta(
                revision: 2,
                machine: 'mac',
                tool: 'codex',
                sessionId: 's1',
                changedFields: const ['title'],
                session: session(title: 'After'),
              ),
            ],
          ),
        );
        await pumpEventQueue();
        first.dispose();
        await pumpEventQueue();

        // A fresh app run over the same durable store: the reopened roster
        // shows the delta identity, not the one captured at first connect.
        final reopened = liveContainer();
        live.gate = Completer<void>();
        final load = reopened
            .read(sessionListControllerProvider.notifier)
            .load();
        await pumpEventQueue();

        expect(
          reopened
              .read(sessionListControllerProvider)
              .cachedRoster
              ?.snapshot
              .rows
              .single
              .title,
          'After',
        );
        live.gate!.complete();
        await load;
      },
    );

    test('a delta during the first save is not overwritten by it', () async {
      // The authoritative response and the feed must share one writer. With
      // two, a quick delta save lands revision 2 while the slower full-response
      // save is still open, and that older save then finishes last and puts
      // revision 1 back.
      live
        ..sessions = [session(title: 'Original title')]
        ..revision = 1;
      final container = liveContainer();
      final firstSave = Completer<void>();
      snapshots.nextSaveGate = firstSave;

      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();
      expect(
        snapshots.saves,
        ['profile-a'],
        reason: 'the full-response save is open and waiting',
      );

      live.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'Renamed'),
            ),
          ],
        ),
      );
      await pumpEventQueue();

      firstSave.complete();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(
        snapshots.stored['profile-a']!.rows.single.title,
        'Renamed',
        reason: 'the older write must never put the earlier roster back',
      );
      expect(live.fetchCount, 1);
    });

    test('clear invalidates a controller-pending roster snapshot', () async {
      live
        ..sessions = [session(title: 'held A')]
        ..revision = 1;
      final container = liveContainer();
      final fence = container.read(sessionCacheWriteFenceProvider);
      final firstSave = Completer<void>();
      snapshots
        ..writeFence = fence
        ..nextSaveGate = firstSave;

      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();
      expect(snapshots.saves, ['profile-a']);

      // B dirties the controller while A is still inside repository.save.
      live.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'pending B'),
            ),
          ],
        ),
      );
      await pumpEventQueue();
      expect(snapshots.saves, ['profile-a']);

      final clearing = fence.clearAll(() async {
        snapshots
          ..stored.clear()
          ..endpoints.clear();
      });
      firstSave.complete();
      await clearing;
      await pumpEventQueue();
      await pumpEventQueue();

      expect(
        snapshots.saves,
        ['profile-a'],
        reason: 'pre-clear pending B must never enter the repository',
      );
      expect(snapshots.stored, isEmpty);

      live.emit(
        SessionRosterDeltaBatch(
          revision: 3,
          deltas: [
            SessionRosterDelta(
              revision: 3,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'post-clear C'),
            ),
          ],
        ),
      );
      await pumpEventQueue();
      await pumpEventQueue();

      expect(snapshots.saves, ['profile-a', 'profile-a']);
      expect(
        snapshots.stored['profile-a']!.rows.single.title,
        'post-clear C',
      );
    });

    test("a B delta is persisted even while A's write is in flight", () async {
      // The snapshot writer is serialized, so a delta arriving during another
      // write only marks the roster dirty. If the writer belonged to the
      // profile that started it, the in-flight A write would finish, notice it
      // is stale and stop — leaving B's delta unwritten until some later delta
      // happened to arrive.
      final liveB = _LiveHeldSessionListRepository()
        ..sessions = [session(id: 'b1', title: 'B row')]
        ..revision = 1;
      live
        ..sessions = [session(title: 'A row')]
        ..revision = 1;
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async {
            final id = ref.watch(activeBrokerProfileProvider)?.id;
            return id == 'profile-b' ? liveB : live;
          }),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        ],
      );
      addTearDown(container.dispose);
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-a',
      );
      final controller = container.read(sessionListControllerProvider.notifier);
      await controller.load();

      // Hold A's snapshot write open, then move the roster with an A delta.
      snapshots.saveGates['profile-a'] = Completer<void>();
      live.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'A renamed'),
            ),
          ],
        ),
      );
      await pumpEventQueue();

      // The user switches to B while that write is still open.
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      await controller.load();
      await pumpEventQueue();
      expect(
        snapshots.stored.containsKey('profile-b'),
        isFalse,
        reason:
            "B's own write is queued behind the open A write, not racing it",
      );

      liveB.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 'b1',
              changedFields: const ['title'],
              session: session(id: 'b1', title: 'B renamed'),
            ),
          ],
        ),
      );
      await pumpEventQueue();

      // A's write finally lands. The writer must pick the pending B work up.
      snapshots.saveGates['profile-a']!.complete();
      await pumpEventQueue();
      await pumpEventQueue();

      expect(
        snapshots.stored['profile-b']!.rows.single.title,
        'B renamed',
        reason: "a stale writer must not swallow the current source's work",
      );
      expect(snapshots.saves.last, 'profile-b');
    });

    test('deltas for a profile the user left are not written', () async {
      live
        ..sessions = [session(title: 'A row')]
        ..revision = 1;
      final container = ProviderContainer(
        overrides: [
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          sessionListRepositoryProvider.overrideWith((ref) async => live),
          rosterSnapshotRepositoryProvider.overrideWithValue(snapshots),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        ],
      );
      addTearDown(container.dispose);
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-a',
      );
      await container.read(sessionListControllerProvider.notifier).load();
      await pumpEventQueue();
      final savesForA = snapshots.saves.length;

      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'profile-b',
      );
      live.emit(
        SessionRosterDeltaBatch(
          revision: 2,
          deltas: [
            SessionRosterDelta(
              revision: 2,
              machine: 'mac',
              tool: 'codex',
              sessionId: 's1',
              changedFields: const ['title'],
              session: session(title: 'Late A rename'),
            ),
          ],
        ),
      );
      await pumpEventQueue();

      expect(
        snapshots.saves.length,
        savesForA,
        reason: "a late delta must not write under the new profile's id",
      );
      expect(snapshots.saves, everyElement('profile-a'));
      expect(snapshots.stored.containsKey('profile-b'), isFalse);
    });
  });
}
