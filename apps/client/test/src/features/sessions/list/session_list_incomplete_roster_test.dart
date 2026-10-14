import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_roster_snapshot_repository.dart';

/// What the client does with a roster the broker calls incomplete.
///
/// Broker contract 23. The broker bounds how long a caller waits for a slow
/// discovery leg and answers with the legs that have landed, so a roster can
/// now arrive that is not the whole roster. The client used to read every
/// response as an authoritative replacement, which turns a shortfall into
/// sessions that appear to have been deleted — and then undeleted a moment
/// later, with nothing on screen to account for either.
void main() {
  late _FakeRepository repository;
  late ProviderContainer container;

  setUp(() {
    repository = _FakeRepository();
    container = ProviderContainer(
      overrides: [
        sessionListRepositoryProvider.overrideWith((ref) async => repository),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        sessionRosterWindowProvider.overrideWith(_FixedWindow.new),
        rosterSnapshotRepositoryProvider.overrideWithValue(
          InMemoryRosterSnapshotRepository(),
        ),
      ],
    );
  });

  tearDown(() => container.dispose());

  Future<void> load() =>
      container.read(sessionListControllerProvider.notifier).load();

  test('an incomplete roster for a DIFFERENT window stands alone', () async {
    // Merging across a window boundary would not preserve knowledge, it would
    // import rows the new question excludes: a seven-day roster inheriting the
    // year-old sessions an all-time one had.
    repository.response = _roster(revision: 4, ids: ['old-1', 'old-2']);
    await load();

    container.read(sessionRosterWindowProvider.notifier).state =
        const AsyncData(SessionRosterQueryWindow.any);
    repository.response = _roster(
      revision: 1,
      ids: ['recent-1'],
      complete: false,
    );
    await load();
    expect(_ids(container), ['recent-1']);
    expect(
      container.read(sessionListControllerProvider).rosterComplete,
      isFalse,
    );
  });

  test('an empty incomplete roster is not an empty state', () async {
    repository.response = _roster(revision: 1, ids: [], complete: false);
    await load();
    final state = container.read(sessionListControllerProvider);
    expect(state.sessions, isEmpty);
    expect(
      state.isEmpty,
      isFalse,
      reason: '"no sessions" is a claim the broker explicitly did not make',
    );
  });

  test('a broker that omits the flag is treated as complete', () async {
    repository.response = ListSessionsResponse(
      machine: 'host-a',
      revision: 1,
      sessions: _sessions(['a', 'b']),
    );
    await load();
    repository.response = ListSessionsResponse(
      machine: 'host-a',
      revision: 2,
      sessions: _sessions(['a']),
    );
    await load();
    expect(
      _ids(container),
      ['a'],
      reason: 'a pre-revision-23 broker never served a partial roster',
    );
  });
}

List<String> _ids(ProviderContainer container) =>
    container
        .read(sessionListControllerProvider)
        .sessions
        .map((session) => session.id)
        .toList()
      ..sort();

List<SessionInfo> _sessions(
  List<String> ids, {
  SessionStatus status = SessionStatus.idle,
}) => [
  for (final id in ids)
    SessionInfo(
      id: id,
      machine: 'host-a',
      tool: 'codex',
      title: 'Session $id',
      status: status,
      attachMode: AttachMode.observe,
    ),
];

ListSessionsResponse _roster({
  required int revision,
  required List<String> ids,
  bool complete = true,
  SessionStatus status = SessionStatus.idle,
}) => ListSessionsResponse(
  machine: 'host-a',
  revision: revision,
  sessions: _sessions(ids, status: status),
  complete: complete,
);

class _FakeRepository
    implements SessionListRepository, WindowedSessionListRepository {
  ListSessionsResponse response = const ListSessionsResponse(
    machine: 'host-a',
    revision: 0,
    sessions: [],
  );

  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) async =>
      response;

  @override
  Future<ListSessionsResponse> fetchSessionsWindowed({
    required String window,
    bool force = false,
  }) async => response;
}

class _FixedWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.last7Days;
}
