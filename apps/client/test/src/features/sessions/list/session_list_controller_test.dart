import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_roster_snapshot_repository.dart';

void main() {
  late InMemorySessionListRepository fakeRepo;
  late ProviderContainer container;

  setUp(() {
    fakeRepo = InMemorySessionListRepository();
    container = ProviderContainer(
      overrides: [
        sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('SessionListController', () {
    test('accepted rename patches only the matching roster title', () async {
      fakeRepo.sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'codex',
          title: 'Before',
          status: SessionStatus.working,
          attachMode: AttachMode.live,
          model: 'gpt-control',
        ),
      ];
      await container.read(sessionListControllerProvider.notifier).load();

      container
          .read(sessionListControllerProvider.notifier)
          .renameSessionTitle('codex', 's1', 'After');

      final session = container
          .read(sessionListControllerProvider)
          .sessions
          .single;
      expect(session.title, 'After');
      expect(session.status, SessionStatus.working);
      expect(session.attachMode, AttachMode.live);
      expect(session.model, 'gpt-control');
    });

    test('project rename contains broker-client resolution failures', () async {
      fakeRepo.sessions = const [
        SessionInfo(
          id: 's1',
          tool: 'codex',
          title: 'Original',
          cwd: '/repo/shared',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];
      container.dispose();
      container = ProviderContainer(
        overrides: [
          sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          activeBrokerProfileProvider.overrideWith((ref) => _profile),
          brokerClientProvider.overrideWith(
            (ref) async => throw StateError('client resolution failed'),
          ),
          rosterSnapshotRepositoryProvider.overrideWithValue(
            InMemoryRosterSnapshotRepository(),
          ),
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        ],
      );
      await container.read(sessionListControllerProvider.notifier).load();

      final renamed = await container
          .read(sessionListControllerProvider.notifier)
          .renameProject(cwd: '/repo/shared', name: 'Unpublished');

      expect(renamed, isFalse);
      expect(
        container.read(sessionListControllerProvider).sessions.single.title,
        'Original',
      );
    });

    test('project rename rejects a same-cwd overlap', () async {
      final client = _RenameProjectClient();
      fakeRepo.sessions = const [
        SessionInfo(
          id: 's1',
          tool: 'codex',
          title: 'Original',
          cwd: '/repo/shared',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];
      container.dispose();
      container = ProviderContainer(
        overrides: [
          sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          activeBrokerProfileProvider.overrideWith((ref) => _profile),
          brokerClientProvider.overrideWith((ref) async => client),
          rosterSnapshotRepositoryProvider.overrideWithValue(
            InMemoryRosterSnapshotRepository(),
          ),
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        ],
      );
      await container.read(sessionListControllerProvider.notifier).load();
      final controller = container.read(sessionListControllerProvider.notifier);

      final first = controller.renameProject(
        cwd: '/repo/shared',
        name: 'First',
      );
      await _drainUntil(() => client.renameProjectCount == 1);
      final second = await controller.renameProject(
        cwd: '/repo/shared',
        name: 'Second',
      );

      expect(second, isFalse);
      expect(client.renameProjectCount, 1);
      client.complete(
        const RenameProjectResponse(
          ok: true,
          cwd: '/repo/shared',
          projectName: 'First',
        ),
      );
      expect(await first, isTrue);
      expect(client.renameProjectCount, 1);
    });

    test('loading status is true during initial load', () async {
      // Use a slow repo to catch loading state.
      fakeRepo
        ..sessions = []
        ..delay = const Duration(seconds: 5);

      unawaited(
        container.read(sessionListControllerProvider.notifier).load(),
      );
      // Allow the microtask to run.
      await Future<void>.delayed(Duration.zero);

      final state = container.read(sessionListControllerProvider);
      expect(state.isLoading, isTrue);
      expect(state.status, SessionListStatus.loading);

      // Clean up by disposing.
      container.dispose();
      container = ProviderContainer(
        overrides: [
          sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        ],
      );
    });

    // The first load has nothing to show yet, so a silent call must still
    // surface loading rather than leaving a blank pane with no explanation.
    test('a silent first load still shows loading', () async {
      final seen = <SessionListStatus>[];
      container.listen(
        sessionListControllerProvider,
        (_, next) => seen.add(next.status),
      );

      await container
          .read(sessionListControllerProvider.notifier)
          .load(silent: true);

      expect(seen, contains(SessionListStatus.loading));
    });

    test('broker profile switch accepts the new revision namespace', () async {
      final first = _LiveSessionListRepository(
        _response(8, SessionStatus.working),
      );
      final second = _LiveSessionListRepository(
        _response(1, SessionStatus.idle),
      );
      SessionListRepository selected = first;
      container.dispose();
      container = ProviderContainer(
        overrides: [
          sessionListRepositoryProvider.overrideWith((ref) async => selected),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        ],
      );
      await container.read(sessionListControllerProvider.notifier).load();
      await Future<void>.delayed(Duration.zero);
      expect(container.read(sessionListControllerProvider).revision, 8);

      selected = second;
      container.invalidate(sessionListRepositoryProvider);
      await container.read(sessionListControllerProvider.notifier).load();

      final state = container.read(sessionListControllerProvider);
      expect(first.cancelCount, greaterThanOrEqualTo(1));
      expect(state.revision, 1);
      expect(state.sessions.single.status, SessionStatus.idle);
    });

    test('query-window switch accepts a lower revision namespace', () async {
      final live = _LiveSessionListRepository(
        _response(8, SessionStatus.working),
      );
      container.dispose();
      container = ProviderContainer(
        overrides: [
          sessionListRepositoryProvider.overrideWith((ref) async => live),
          activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
          sessionRosterWindowProvider.overrideWith(_MutableRosterWindow.new),
        ],
      );
      await container.read(sessionListControllerProvider.notifier).load();
      await Future<void>.delayed(Duration.zero);
      expect(container.read(sessionListControllerProvider).revision, 8);

      live.response = _response(1, SessionStatus.idle);
      (container.read(sessionRosterWindowProvider.notifier)
              as _MutableRosterWindow)
          .publish(SessionRosterQueryWindow.any);
      for (var attempt = 0; attempt < 5 && live.fetchCount < 2; attempt++) {
        await Future<void>.delayed(Duration.zero);
      }

      final state = container.read(sessionListControllerProvider);
      expect(live.snapshotWindows, ['7d', 'all']);
      expect(live.deltaWindows.last, 'all');
      expect(state.revision, 1);
      expect(state.sessions.single.status, SessionStatus.idle);
    });

    test(
      'live status during a held window request survives '
      'and a newer delta wins',
      () async {
        final live = _LiveSessionListRepository(
          _response(8, SessionStatus.idle),
        );
        container.dispose();
        container = ProviderContainer(
          overrides: [
            sessionListRepositoryProvider.overrideWith((ref) async => live),
            activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
            activeBrokerProfileProvider.overrideWith((ref) => _profile),
            rosterSnapshotRepositoryProvider.overrideWithValue(
              InMemoryRosterSnapshotRepository(),
            ),
            sessionRosterWindowProvider.overrideWith(
              _MutableAnyRosterWindow.new,
            ),
          ],
        );
        await container.read(sessionListControllerProvider.notifier).load();
        await _drainUntil(() => live.deltaWaitCount == 1);

        final held = Completer<ListSessionsResponse>();
        live.nextSnapshot = held;
        (container.read(sessionRosterWindowProvider.notifier)
                as _MutableAnyRosterWindow)
            .publish(SessionRosterQueryWindow.last7Days);
        await _drainUntil(() => live.fetchCount == 2);

        final source = container.read(sessionListControllerProvider).source;
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: source,
              tool: 'codex',
              sessionId: 's1',
              status: SessionStatus.working,
              rosterRevisionFloor: 8,
            );
        held.complete(_response(1, SessionStatus.idle));
        await _drainUntil(
          () =>
              container.read(sessionListControllerProvider).revision == 1 &&
              live.deltaWaitCount == 2,
        );

        expect(live.snapshotWindows, ['all', '7d']);
        expect(
          container.read(rosterSessionsProvider).single.status,
          SessionStatus.working,
        );

        live.completeDelta(_batch(2, SessionStatus.idle));
        await _drainUntil(
          () => container.read(sessionListControllerProvider).revision == 2,
        );
        expect(
          container.read(rosterSessionsProvider).single.status,
          SessionStatus.idle,
        );
      },
    );

    test(
      'live status during held cursor recovery survives and a newer delta wins',
      () async {
        final live = _LiveSessionListRepository(
          _response(8, SessionStatus.idle),
        );
        container.dispose();
        container = ProviderContainer(
          overrides: [
            sessionListRepositoryProvider.overrideWith((ref) async => live),
            activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
            activeBrokerProfileProvider.overrideWith((ref) => _profile),
            rosterSnapshotRepositoryProvider.overrideWithValue(
              InMemoryRosterSnapshotRepository(),
            ),
            sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          ],
        );
        await container.read(sessionListControllerProvider.notifier).load();
        await _drainUntil(() => live.deltaWaitCount == 1);

        final held = Completer<ListSessionsResponse>();
        live
          ..nextSnapshot = held
          ..completeDelta(
            const SessionRosterDeltaBatch(
              revision: 0,
              deltas: [],
              resetRequired: true,
            ),
          );
        await _drainUntil(() => live.fetchCount == 2);

        final source = container.read(sessionListControllerProvider).source;
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: source,
              tool: 'codex',
              sessionId: 's1',
              status: SessionStatus.working,
              rosterRevisionFloor: 8,
            );
        held.complete(_response(1, SessionStatus.idle));
        await _drainUntil(
          () =>
              container.read(sessionListControllerProvider).revision == 1 &&
              live.deltaWaitCount == 2,
        );

        expect(
          container.read(rosterSessionsProvider).single.status,
          SessionStatus.working,
        );

        live.completeDelta(_batch(2, SessionStatus.idle));
        await _drainUntil(
          () => container.read(sessionListControllerProvider).revision == 2,
        );
        expect(
          container.read(rosterSessionsProvider).single.status,
          SessionStatus.idle,
        );
      },
    );

    test(
      'a live status flip re-orders in the same frame the registry applies it',
      () async {
        // w1 is working with an OLDER creation anchor; i1 is settled and more
        // recently touched, so it sits below the working band.
        fakeRepo.sessions = const [
          SessionInfo(
            id: 'w1',
            tool: 'codex',
            title: 'Working',
            status: SessionStatus.working,
            createdAt: 100,
            updatedAt: 100,
            attachMode: AttachMode.live,
          ),
          SessionInfo(
            id: 'i1',
            tool: 'codex',
            title: 'Settled',
            status: SessionStatus.idle,
            createdAt: 200,
            updatedAt: 900,
            attachMode: AttachMode.live,
          ),
        ];
        // The registry only adopts observations for a real roster source, so
        // this needs the active profile the default container leaves unset.
        container.dispose();
        container = ProviderContainer(
          overrides: [
            sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
            activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
            activeBrokerProfileProvider.overrideWith((ref) => _profile),
            rosterSnapshotRepositoryProvider.overrideWithValue(
              InMemoryRosterSnapshotRepository(),
            ),
            sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
          ],
        );
        await container.read(sessionListControllerProvider.notifier).load();
        expect(container.read(rosterSessionsProvider).map((s) => s.id), [
          'w1',
          'i1',
        ]);

        final state = container.read(sessionListControllerProvider);
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: state.source,
              tool: 'codex',
              sessionId: 'i1',
              status: SessionStatus.working,
              rosterRevisionFloor: state.revision,
            );

        // No roster publish happened: the controller's own rows are untouched.
        expect(
          container
              .read(sessionListControllerProvider)
              .sessions
              .map((s) => s.id),
          ['w1', 'i1'],
        );
        // The roster every surface reads has already moved i1 into the working
        // band on its newer anchor, instead of leaving a working pill in a
        // settled slot until the next publish.
        expect(container.read(rosterSessionsProvider).map((s) => s.id), [
          'i1',
          'w1',
        ]);
        expect(
          container.read(rosterSessionsProvider).first.status,
          SessionStatus.working,
        );
      },
    );
  });
}

class _FixedRosterWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.last7Days;
}

class _MutableRosterWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.last7Days;

  void publish(SessionRosterQueryWindow window) {
    state = AsyncData(window);
  }
}

class _MutableAnyRosterWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.any;

  void publish(SessionRosterQueryWindow window) {
    state = AsyncData(window);
  }
}

final _profile = BrokerProfile(
  id: 'local',
  displayName: 'Local',
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026, 7, 29),
);

Future<void> _drainUntil(bool Function() condition) async {
  for (var attempt = 0; attempt < 20 && !condition(); attempt++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(condition(), isTrue);
}

class _RenameProjectClient extends BrokerClient {
  _RenameProjectClient() : super(baseUrl: 'http://127.0.0.1:7734');

  final _response = Completer<RenameProjectResponse>();
  int renameProjectCount = 0;

  void complete(RenameProjectResponse response) => _response.complete(response);

  @override
  Future<RenameProjectResponse> renameProject(String cwd, String? name) {
    renameProjectCount++;
    return _response.future;
  }

  @override
  void close() {}
}

ListSessionsResponse _response(int revision, SessionStatus status) =>
    ListSessionsResponse(
      machine: 'host-a',
      revision: revision,
      sessions: [
        SessionInfo(
          id: 's1',
          machine: 'host-a',
          tool: 'codex',
          title: 'Session',
          status: status,
          attachMode: AttachMode.observe,
        ),
      ],
    );

SessionRosterDeltaBatch _batch(int revision, SessionStatus status) =>
    SessionRosterDeltaBatch(
      revision: revision,
      deltas: [
        SessionRosterDelta(
          revision: revision,
          machine: 'host-a',
          tool: 'codex',
          sessionId: 's1',
          changedFields: const ['status'],
          session: _response(revision, status).sessions.single,
        ),
      ],
    );

class _LiveSessionListRepository
    implements
        SessionListRepository,
        WindowedSessionListRepository,
        LiveSessionListRepository,
        WindowedLiveSessionListRepository {
  _LiveSessionListRepository(this.response);

  ListSessionsResponse response;
  Completer<ListSessionsResponse>? nextSnapshot;
  final List<Completer<SessionRosterDeltaBatch>> _deltaWaits = [];
  int fetchCount = 0;
  int deltaWaitCount = 0;
  int cancelCount = 0;
  final List<String> snapshotWindows = [];
  final List<String> deltaWindows = [];

  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) async {
    fetchCount++;
    final pending = nextSnapshot;
    nextSnapshot = null;
    return pending == null ? response : pending.future;
  }

  @override
  Future<ListSessionsResponse> fetchSessionsWindowed({
    required String window,
    bool force = false,
  }) {
    snapshotWindows.add(window);
    return fetchSessions(force: force);
  }

  @override
  Future<SessionRosterDeltaBatch> waitForDeltas({
    required int after,
    Duration wait = const Duration(seconds: 25),
  }) {
    deltaWaitCount++;
    final pending = Completer<SessionRosterDeltaBatch>();
    _deltaWaits.add(pending);
    return pending.future;
  }

  @override
  Future<SessionRosterDeltaBatch> waitForDeltasWindowed({
    required int after,
    required String window,
    Duration wait = const Duration(seconds: 25),
  }) {
    deltaWindows.add(window);
    return waitForDeltas(after: after, wait: wait);
  }

  void completeDelta(SessionRosterDeltaBatch batch) {
    _deltaWaits.removeAt(0).complete(batch);
  }

  @override
  void cancelDeltaWait() {
    cancelCount++;
    if (_deltaWaits.isNotEmpty) {
      final pending = _deltaWaits.removeAt(0);
      if (!pending.isCompleted) {
        pending.completeError(
          const SessionRosterDeltaWaitCancelledException(),
        );
      }
    }
  }
}
