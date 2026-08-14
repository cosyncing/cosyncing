import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('loads broker order and creates both checked union variants', () async {
    final fake = _FakeBrokerClient(rows: [_row(id: 'existing', at: 1000)]);
    final container = _container(fake);
    addTearDown(container.dispose);
    final subscription = _keepScheduleStateAlive(container);
    addTearDown(subscription.close);
    final controller = container.read(scheduleControllerProvider.notifier);

    await controller.load();
    expect(
      container.read(scheduleControllerProvider).schedules.first.id,
      'existing',
    );

    await controller.create(
      const MessageScheduleCreate(
        tool: 'codex',
        sessionId: 's1',
        sessionTitle: 'One',
        text: 'later',
        at: 1000,
      ),
    );
    expect(fake.created.single, isA<MessageScheduleCreate>());
    expect(
      container.read(scheduleControllerProvider).schedules.map((row) => row.id),
      ['existing', 'created-1'],
    );

    await controller.create(
      const NewSessionScheduleCreate(
        tool: 'codex',
        directory: '/edited',
        text: 'start',
        at: 2000,
        repeat: ScheduleRepeat.weekdays,
        timeZone: 'Europe/London',
      ),
    );
    final created = fake.created.last as NewSessionScheduleCreate;
    expect(created.directory, '/edited');
    expect(created.timeZone, 'Europe/London');
  });

  test('explicit model scheduling uses its source-qualified client', () async {
    final shared = _FakeBrokerClient(rows: const []);
    final operation = _FakeBrokerClient(rows: const []);
    final profile = _profile('profile-a');
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith((ref) => profile),
        brokerClientProvider.overrideWith((ref) async => shared),
        brokerClientFactoryProvider.overrideWith(
          (ref) => (captured) async {
            expect(captured, same(profile));
            return operation;
          },
        ),
      ],
    );
    addTearDown(container.dispose);
    final subscription = _keepScheduleStateAlive(container);
    addTearDown(subscription.close);

    await container
        .read(scheduleControllerProvider.notifier)
        .create(
          const NewSessionScheduleCreate(
            tool: 'codex',
            text: 'selected model later',
            at: 2000,
            model: SessionCurrentModel(
              providerID: 'azure-openai',
              modelID: 'gpt-selected',
            ),
          ),
          expectedSource: RosterSource.ofProfile(profile),
        );

    expect(shared.created, isEmpty);
    final request = operation.created.single as NewSessionScheduleCreate;
    expect(request.model?.providerID, 'azure-openai');
    expect(request.model?.modelID, 'gpt-selected');
    expect(operation.closeCalls, 1);
  });

  test(
    'model source mismatch is retained as a typed presentation issue',
    () async {
      final fake = _FakeBrokerClient(rows: const []);
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith(
            (ref) => _profile('profile-b'),
          ),
          brokerClientProvider.overrideWith((ref) async => fake),
        ],
      );
      addTearDown(container.dispose);
      final subscription = _keepScheduleStateAlive(container);
      addTearDown(subscription.close);

      final result = await container
          .read(scheduleControllerProvider.notifier)
          .create(
            const NewSessionScheduleCreate(
              tool: 'codex',
              text: 'wrong source',
              at: 2000,
            ),
            expectedSource: RosterSource.ofProfile(_profile('profile-a')),
          );

      final state = container.read(scheduleControllerProvider);
      expect(result, isNull);
      expect(
        state.presentationIssue,
        SchedulePresentationIssue.modelSourceMismatch,
      );
      expect(state.error, isNull);
      expect(fake.created, isEmpty);
    },
  );

  test('revision-free delete first cancels then removes the row', () async {
    final fake = _FakeBrokerClient(
      rows: [
        _row(id: 'live', at: 1000, revision: 7),
        _row(
          id: 'finished',
          state: ScheduleState.delivered,
          updatedAt: 2000,
        ),
      ],
    );
    final container = _container(fake);
    addTearDown(container.dispose);
    final subscription = _keepScheduleStateAlive(container);
    addTearDown(subscription.close);
    final controller = container.read(scheduleControllerProvider.notifier);
    await controller.load();

    expect(await controller.delete('live'), isTrue);
    expect(fake.deletedIds, ['live']);
    expect(
      container.read(scheduleControllerProvider).schedules.map((row) => row.id),
      ['finished', 'live'],
    );
    expect(await controller.delete('live'), isTrue);
    expect(fake.deletedIds, ['live', 'live']);
    expect(
      container.read(scheduleControllerProvider).schedules.single.id,
      'finished',
    );
  });

  test('edits and actions advance the latest rendered revision', () async {
    final fake = _FakeBrokerClient(rows: [_row(id: 'live', revision: 4)]);
    final container = _container(fake, profile: _profile('profile-a'));
    addTearDown(container.dispose);
    final subscription = _keepScheduleStateAlive(container);
    addTearDown(subscription.close);
    final controller = container.read(scheduleControllerProvider.notifier);
    await controller.load();

    expect(
      await controller.update(
        'live',
        const ScheduleUpdate(expectedRevision: 4, text: 'edited prompt'),
      ),
      isTrue,
    );
    expect(fake.updated.single.expectedRevision, 4);
    expect(
      container.read(scheduleControllerProvider).schedules.single.revision,
      5,
    );
    expect(
      container.read(scheduleControllerProvider).schedules.single.text,
      'edited prompt',
    );

    expect(await controller.action('live', ScheduleAction.pause), isTrue);
    expect(fake.actions.single.expectedRevision, 5);
    expect(fake.actions.single.action, ScheduleAction.pause);
    expect(
      container.read(scheduleControllerProvider).schedules.single.state,
      ScheduleState.paused,
    );
  });

  test('stale mutation refreshes rows and surfaces typed conflict', () async {
    final fake = _FakeBrokerClient(rows: [_row(id: 'live', revision: 2)])
      ..failNextMutationWithStale = true;
    final container = _container(fake, profile: _profile('profile-a'));
    addTearDown(container.dispose);
    final subscription = _keepScheduleStateAlive(container);
    addTearDown(subscription.close);
    final controller = container.read(scheduleControllerProvider.notifier);
    await controller.load();

    expect(await controller.action('live', ScheduleAction.pause), isFalse);

    final state = container.read(scheduleControllerProvider);
    expect(state.error, contains('changed on another client'));
    expect(fake.listCount, 2);
    expect(state.mutatingIds, isEmpty);
  });

  test(
    'broker switch clears rows and ignores the stale list response',
    () async {
      final pending = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(rows: const [], pendingList: pending);
      final container = _container(fake, profile: _profile('profile-a'));
      addTearDown(container.dispose);
      final subscription = _keepScheduleStateAlive(container);
      addTearDown(subscription.close);
      final controller = container.read(scheduleControllerProvider.notifier);

      final load = controller.load();
      await Future<void>.delayed(Duration.zero);
      container.read(activeBrokerProfileProvider.notifier).state = _profile(
        'profile-b',
      );
      expect(container.read(scheduleControllerProvider).schedules, isEmpty);

      pending.complete(
        ScheduleListResponse(schedules: [_row(id: 'profile-a-secret')]),
      );
      await load;

      expect(container.read(scheduleControllerProvider).schedules, isEmpty);
    },
  );

  test(
    'an endpoint edit clears rows, retires A, and mutates only B',
    () async {
      final held = Completer<ScheduleListResponse>();
      final alpha = _FakeBrokerClient(rows: const [], pendingList: held);
      final beta = _FakeBrokerClient(rows: [_row(id: 'owned-by-beta')]);
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith(
            (ref) => _profileAt('one-profile', 'http://alpha.test'),
          ),
          // One profile id, two machines: the client follows the endpoint the
          // profile currently points at, exactly as production does.
          brokerClientProvider.overrideWith((ref) async {
            final active = ref.watch(activeBrokerProfileProvider);
            return active?.baseUri.host == 'beta.test' ? beta : alpha;
          }),
        ],
      );
      addTearDown(container.dispose);
      final subscription = _keepScheduleStateAlive(container);
      addTearDown(subscription.close);
      final controller = container.read(scheduleControllerProvider.notifier);

      final heldLoad = controller.load();
      await Future<void>.delayed(Duration.zero);

      // The SAME profile id, re-pointed at another machine.
      container.read(activeBrokerProfileProvider.notifier).state = _profileAt(
        'one-profile',
        'http://beta.test',
      );
      expect(
        container.read(scheduleControllerProvider).schedules,
        isEmpty,
        reason: "A's prompt-bearing rows go the moment the source changes",
      );

      held.complete(
        ScheduleListResponse(schedules: [_row(id: 'private-to-alpha')]),
      );
      await heldLoad;
      expect(
        container.read(scheduleControllerProvider).schedules,
        isEmpty,
        reason: "A's late answer is inert under B",
      );

      await controller.load();
      expect(
        container.read(scheduleControllerProvider).schedules.map((r) => r.id),
        ['owned-by-beta'],
      );
      expect(await controller.delete('owned-by-beta'), isTrue);
      expect(beta.deletedIds, ['owned-by-beta']);
      expect(alpha.deletedIds, isEmpty);
    },
  );
}

ProviderContainer _container(
  _FakeBrokerClient fake, {
  BrokerProfile? profile,
}) => ProviderContainer(
  overrides: [
    brokerClientProvider.overrideWith((ref) async => fake),
    activeBrokerProfileProvider.overrideWith((ref) => profile),
  ],
);

ProviderSubscription<ScheduleStateModel> _keepScheduleStateAlive(
  ProviderContainer container,
) => container.listen(scheduleControllerProvider, (_, _) {});

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://$id.test'),
  createdAt: DateTime(2026, 7, 16),
);

/// A profile whose id says nothing about which machine it points at.
BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime(2026, 7, 16),
);

ScheduleRecord _row({
  required String id,
  ScheduleState state = ScheduleState.scheduled,
  int at = 2000,
  int updatedAt = 1000,
  int revision = 1,
  String text = 'prompt',
}) => ScheduleRecord(
  id: id,
  revision: revision,
  kind: ScheduleKind.message,
  tool: 'codex',
  sessionId: 's1',
  text: text,
  at: at,
  state: state,
  createdAt: 1000,
  updatedAt: updatedAt,
);

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient({required this.rows, this.pendingList})
    : super(baseUrl: 'http://test');

  List<ScheduleRecord> rows;
  final Completer<ScheduleListResponse>? pendingList;
  final List<ScheduleCreate> created = [];
  final List<ScheduleUpdate> updated = [];
  final List<ScheduleActionRequest> actions = [];
  final List<String> deletedIds = [];
  int listCount = 0;
  bool failNextMutationWithStale = false;
  int closeCalls = 0;

  @override
  void close() {
    closeCalls += 1;
    super.close();
  }

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async {
    listCount += 1;
    final pending = pendingList;
    if (pending != null) return pending.future;
    return ScheduleListResponse(schedules: rows);
  }

  @override
  Future<ScheduleMutationResponse> updateSchedule(
    String id,
    ScheduleUpdate request,
  ) async {
    _throwStaleIfRequested();
    updated.add(request);
    final index = rows.indexWhere((row) => row.id == id);
    final current = rows[index];
    final next = _row(
      id: id,
      state: current.state,
      at: request.at ?? current.at,
      updatedAt: current.updatedAt + 1,
      revision: current.revision + 1,
      text: request.text ?? current.text,
    );
    rows = [...rows]..[index] = next;
    return ScheduleMutationResponse(schedule: next);
  }

  @override
  Future<ScheduleMutationResponse> applyScheduleAction(
    String id,
    ScheduleActionRequest request,
  ) async {
    _throwStaleIfRequested();
    actions.add(request);
    final index = rows.indexWhere((row) => row.id == id);
    final current = rows[index];
    final next = _row(
      id: id,
      state: request.action == ScheduleAction.pause
          ? ScheduleState.paused
          : ScheduleState.scheduled,
      at: current.at,
      updatedAt: current.updatedAt + 1,
      revision: current.revision + 1,
      text: current.text,
    );
    rows = [...rows]..[index] = next;
    return ScheduleMutationResponse(schedule: next);
  }

  void _throwStaleIfRequested() {
    if (!failNextMutationWithStale) return;
    failNextMutationWithStale = false;
    throw const BrokerException(
      message: 'Schedule mutation failed',
      statusCode: 409,
      error: BrokerError(
        error: 'stale revision',
        code: 'SCHEDULE_STALE',
      ),
    );
  }

  @override
  Future<ScheduleCreateResponse> createSchedule(ScheduleCreate request) async {
    created.add(request);
    final row = _row(id: 'created-${created.length}');
    rows = [row, ...rows];
    return ScheduleCreateResponse(schedule: row);
  }

  @override
  Future<ScheduleDeleteResponse> deleteSchedule(String id) async {
    final index = rows.indexWhere((row) => row.id == id);
    final current = rows[index];
    deletedIds.add(id);
    if (current.state.isLive) {
      final canceled = _row(
        id: id,
        state: ScheduleState.canceled,
        revision: current.revision + 1,
      );
      rows = [...rows]..[index] = canceled;
      return ScheduleCanceledResponse(schedule: canceled);
    }
    rows = [...rows]..removeAt(index);
    return const ScheduleRemovedResponse();
  }
}
