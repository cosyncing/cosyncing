import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/roster/machine_roster_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('loads composite rosters and resolves their direct owner', () async {
    final fake = _FakeMachineBrokerClient();
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith((ref) => _profile('local')),
        brokerClientProvider.overrideWith((ref) async => fake),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      machineRosterControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(machineRosterControllerProvider.notifier);

    await controller.load();
    final state = container.read(machineRosterControllerProvider);
    expect(state.error, isNull);
    final roster = state.machines.single;
    expect(roster.sessions.single.identity.key, 'opaque-key');

    final resolution = await controller.resolve(
      roster.sessions.single.identity,
    );
    expect(resolution?.canConnect, isTrue);
    expect(fake.resolvedMachineId, 'peer-a');
    expect(fake.resolvedTool, 'codex');
    expect(fake.resolvedSessionId, 'session-1');
  });

  test('profile switch clears prompt-bearing machine state', () async {
    final fake = _FakeMachineBrokerClient();
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith((ref) => _profile('a')),
        brokerClientProvider.overrideWith((ref) async => fake),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      machineRosterControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);
    await container.read(machineRosterControllerProvider.notifier).load();
    final loaded = container.read(machineRosterControllerProvider);
    expect(loaded.error, isNull);
    expect(loaded.machines, isNotEmpty);

    container.read(activeBrokerProfileProvider.notifier).state = _profile('b');

    expect(container.read(machineRosterControllerProvider).machines, isEmpty);
  });

  test('an endpoint edit clears the roster and retires the A answer', () async {
    final held = Completer<AggregatedMachinesResponse>();
    final alpha = _FakeMachineBrokerClient(
      machineId: 'peer-alpha',
      heldList: held,
    );
    final beta = _FakeMachineBrokerClient(machineId: 'peer-beta');
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileProvider.overrideWith(
          (ref) => _profileAt('one-profile', 'http://alpha.test'),
        ),
        // One profile id, two aggregators: the client follows the endpoint the
        // profile currently points at, exactly as production does.
        brokerClientProvider.overrideWith((ref) async {
          final active = ref.watch(activeBrokerProfileProvider);
          return active?.baseUri.host == 'beta.test' ? beta : alpha;
        }),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      machineRosterControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(machineRosterControllerProvider.notifier);

    final heldLoad = controller.load();
    await Future<void>.delayed(Duration.zero);

    // The SAME profile id, re-pointed at another aggregator.
    container.read(activeBrokerProfileProvider.notifier).state = _profileAt(
      'one-profile',
      'http://beta.test',
    );
    expect(container.read(machineRosterControllerProvider).machines, isEmpty);

    held.complete(alpha.roster);
    await heldLoad;
    final afterLateAnswer = container.read(machineRosterControllerProvider);
    expect(
      afterLateAnswer.machines,
      isEmpty,
      reason: "A's late roster is inert under B",
    );
    expect(afterLateAnswer.error, isNull);

    await controller.load();
    expect(
      container.read(machineRosterControllerProvider).machines.single.machineId,
      'peer-beta',
    );
    final resolution = await controller.resolve(beta.identity);
    expect(resolution?.identity.machineId, 'peer-beta');
    expect(alpha.resolveCalls, 0);
  });
}

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://$id.test'),
  createdAt: DateTime.utc(2026, 7, 17),
);

/// A profile whose id says nothing about which machine it points at.
BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime.utc(2026, 7, 17),
);

final class _FakeMachineBrokerClient extends BrokerClient {
  _FakeMachineBrokerClient({this.machineId = 'peer-a', this.heldList})
    : super(baseUrl: 'http://local.test');

  /// Held answer for the first `listMachines()`, for retirement tests.
  final Completer<AggregatedMachinesResponse>? heldList;

  /// Which peer this aggregator knows about.
  final String machineId;

  String? resolvedMachineId;
  String? resolvedTool;
  String? resolvedSessionId;
  int listCalls = 0;
  int resolveCalls = 0;

  MachineSessionIdentity get identity => MachineSessionIdentity(
    machineId: machineId,
    tool: 'codex',
    sessionId: 'session-1',
    key: 'opaque-key',
  );

  MachineSessionOwner get owner => MachineSessionOwner(
    machineId: machineId,
    machine: 'Peer A',
    role: MachineRosterRole.peer,
    route: MachineSessionRouteState.direct,
    authoritative: true,
    baseUrl: 'https://peer-a.example',
    requiresIndependentAuthentication: true,
  );

  MachineSessionInfo get machineSession => MachineSessionInfo(
    session: SessionInfo.fromJson(const {
      'id': 'session-1',
      'tool': 'codex',
      'title': 'Peer work',
      'status': 'idle',
      'attachMode': 'observe',
    }),
    identity: identity,
    owner: owner,
  );

  @override
  Future<AggregatedMachinesResponse> listMachines() async {
    listCalls += 1;
    final held = heldList;
    if (held != null && listCalls == 1) return held.future;
    return roster;
  }

  AggregatedMachinesResponse get roster {
    return AggregatedMachinesResponse(
      ok: true,
      version: 2,
      machine: 'Local',
      machineId: 'local',
      generatedAt: 1,
      machines: [
        MachineRoster(
          machineId: machineId,
          machine: 'Peer A',
          role: MachineRosterRole.peer,
          status: MachineRosterStatus.ok,
          sessions: [machineSession],
          sessionCount: 1,
          checkedAt: 1,
          freshness: MachineRosterFreshness.fresh,
        ),
      ],
    );
  }

  @override
  Future<MachineSessionResolution> resolveMachineSession({
    required String machineId,
    required String tool,
    required String sessionId,
  }) async {
    resolveCalls += 1;
    resolvedMachineId = machineId;
    resolvedTool = tool;
    resolvedSessionId = sessionId;
    return MachineSessionResolution(
      ok: true,
      identity: identity,
      status: MachineSessionResolutionStatus.resolved,
      session: machineSession,
      owner: owner,
    );
  }
}
