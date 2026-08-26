import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _FakeManagedRuntimeApi apiA;
  late _FakeManagedRuntimeApi apiB;
  late ProviderContainer container;

  final brokerA = BrokerProfile(
    id: 'broker-a',
    displayName: 'Broker A',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026),
  );
  final brokerB = BrokerProfile(
    id: 'broker-b',
    displayName: 'Broker B',
    baseUri: Uri.parse('http://127.0.0.1:7744'),
    createdAt: DateTime(2026),
  );

  setUp(() {
    apiA = _FakeManagedRuntimeApi(initialPolicy: 'when-detached');
    apiB = _FakeManagedRuntimeApi(initialPolicy: 'when-idle');

    container = ProviderContainer(
      overrides: [
        managedRuntimeApiProvider.overrideWith((ref) {
          final active = ref.watch(activeBrokerProfileProvider);
          if (active?.id == 'broker-b') {
            return apiB;
          }
          return apiA;
        }),
      ],
    );

    container.read(activeBrokerProfileProvider.notifier).state = brokerA;
  });

  tearDown(() => container.dispose());

  test(
    'loads runtime policy health and default-off quota preference',
    () async {
      final state = await container.read(
        managedRuntimeControllerProvider.future,
      );

      expect(state.updates.single.agent, 'codex');
      expect(state.codexUpdatePolicy, 'when-detached');
      expect(state.health?.status, 'healthy');
      expect(state.quotaWarningsEnabled, isFalse);
      expect(state.brokerScopeKey, RosterSource.ofProfile(brokerA).storageKey);
      expect(
        apiA.quotaReads,
        0,
        reason:
            'the core snapshot publishes without waiting on the optional '
            'quota read, which lives in managedRuntimeQuotaProvider',
      );
    },
  );

  test('reacts when active profile changes without manual reload', () async {
    await container.read(managedRuntimeControllerProvider.future);
    expect(
      container
          .read(managedRuntimeControllerProvider)
          .valueOrNull
          ?.brokerScopeKey,
      RosterSource.ofProfile(brokerA).storageKey,
    );

    container.read(activeBrokerProfileProvider.notifier).state = brokerB;

    final updated = await container.read(
      managedRuntimeControllerProvider.future,
    );
    expect(updated.brokerScopeKey, RosterSource.ofProfile(brokerB).storageKey);
    expect(updated.codexUpdatePolicy, 'when-idle');
  });

  test('updates policy through broker and refreshes state', () async {
    await container
        .read(managedRuntimeControllerProvider.notifier)
        .setCodexUpdatePolicy('when-idle');

    expect(apiA.policyWrites, ['when-idle']);
    expect(
      (await container.read(
        managedRuntimeControllerProvider.future,
      )).codexUpdatePolicy,
      'when-idle',
    );
  });

  test(
    'mutation is scoped to active profile after a profile change',
    () async {
      await container
          .read(managedRuntimeControllerProvider.notifier)
          .setQuotaWarningsEnabled(enabled: true);
      expect(apiA.quotaPreferenceWrites, [true]);
      expect(apiB.quotaPreferenceWrites, isEmpty);

      container.read(activeBrokerProfileProvider.notifier).state = brokerB;

      await container
          .read(managedRuntimeControllerProvider.notifier)
          .setQuotaWarningsEnabled(enabled: false);
      expect(apiA.quotaPreferenceWrites, [true]);
      expect(apiB.quotaPreferenceWrites, [false]);
    },
  );

  test(
    'enables quota warning separately without touching the quota read',
    () async {
      await container.read(managedRuntimeControllerProvider.future);
      await container
          .read(managedRuntimeControllerProvider.notifier)
          .setQuotaWarningsEnabled(enabled: true);

      final state = await container.read(
        managedRuntimeControllerProvider.future,
      );
      expect(apiA.quotaPreferenceWrites, [true]);
      expect(state.quotaWarningsEnabled, isTrue);
      expect(
        apiA.quotaReads,
        0,
        reason:
            'the warnings opt-in only drives broker-side warning delivery; '
            'viewing reads quota through managedRuntimeQuotaProvider',
      );
    },
  );

  test('quota provider reads the snapshot for the admitted broker', () async {
    final quota = await container.read(managedRuntimeQuotaProvider.future);

    expect(apiA.quotaReads, 1);
    expect(quota?.data?.providers['codex']?.estimated, isTrue);
  });

  test('quota provider is scoped to the exact broker admission', () async {
    await container.read(managedRuntimeQuotaProvider.future);
    expect(apiA.quotaReads, 1);

    container.read(activeBrokerProfileProvider.notifier).state = brokerB;

    final quota = await container.read(managedRuntimeQuotaProvider.future);
    expect(apiB.quotaReads, 1);
    expect(quota, isNotNull);
  });

  test(
    'a held A quota read released after the switch cannot land on B',
    () async {
      final held = Completer<void>();
      final started = Completer<void>();
      apiA
        ..holdQuota = held
        ..quotaStarted = started
        ..quotaProviderId = 'codex';
      apiB.quotaProviderId = 'claude';
      final subscription = container.listen(
        managedRuntimeQuotaProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);

      // A's read starts and is held in flight.
      final pendingA = container.read(managedRuntimeQuotaProvider.future);
      await started.future;
      expect(apiA.quotaReads, 1);

      // Switching brokers mid-read rebuilds the provider against B.
      container.read(activeBrokerProfileProvider.notifier).state = brokerB;
      final quotaB = await container.read(managedRuntimeQuotaProvider.future);
      expect(apiB.quotaReads, 1);
      expect(quotaB?.data?.providers.keys, contains('claude'));

      // Releasing A late must not publish A's snapshot over B's.
      held.complete();
      await pendingA;
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      final current = container.read(managedRuntimeQuotaProvider).valueOrNull;
      expect(current?.data?.providers.keys, contains('claude'));
      expect(
        current?.data?.providers.keys,
        isNot(contains('codex')),
        reason: "A's late quota result must not land on B's admission",
      );
    },
  );

  test(
    'closing the last listener stops quota reads on later broker switches',
    () async {
      final subscription = container.listen(
        managedRuntimeQuotaProvider,
        (_, _) {},
      );
      await container.read(managedRuntimeQuotaProvider.future);
      expect(apiA.quotaReads, 1);

      // Leaving Settings: the last listener goes away and the auto-disposed
      // provider drops its subscription before the switch happens.
      subscription.close();
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      container.read(activeBrokerProfileProvider.notifier).state = brokerB;
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(
        apiB.quotaReads,
        0,
        reason: 'no off-screen quota read may fire once Settings is gone',
      );
      expect(apiA.quotaReads, 1);
    },
  );

  test(
    'a failed quota read degrades to null without failing Settings',
    () async {
      apiA.quotaThrows = true;

      final state = await container.read(
        managedRuntimeControllerProvider.future,
      );
      final quota = await container.read(managedRuntimeQuotaProvider.future);

      expect(quota, isNull);
      expect(state.connected, isTrue);
      expect(state.updates.single.agent, 'codex');
    },
  );

  test(
    'an endpoint edit never lets an A snapshot authorize a B action',
    () async {
      final alphaProfile = _profileAt('one-profile', 'http://alpha.test');
      final betaProfile = _profileAt('one-profile', 'http://beta.test');
      final held = Completer<void>();
      final alpha = _FakeManagedRuntimeApi(initialPolicy: 'when-detached');
      final beta = _FakeManagedRuntimeApi(initialPolicy: 'when-idle')
        ..holdRuntimeUpdates = held;
      final scoped = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith((ref) => alphaProfile),
          // One profile id, two machines: the handle follows the endpoint the
          // profile currently points at, exactly as production does.
          managedRuntimeApiProvider.overrideWith((ref) {
            final active = ref.watch(activeBrokerProfileProvider);
            return active?.baseUri.host == 'beta.test' ? beta : alpha;
          }),
        ],
      );
      addTearDown(scoped.dispose);
      final subscription = scoped.listen(
        managedRuntimeControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);

      final loaded = await scoped.read(managedRuntimeControllerProvider.future);
      expect(loaded.codexUpdatePolicy, 'when-detached');
      expect(
        loaded.brokerScopeKey,
        RosterSource.ofProfile(alphaProfile).storageKey,
      );

      // The SAME profile id, re-pointed at another machine. B's first read is
      // held open, so what stays on screen is A's snapshot.
      scoped.read(activeBrokerProfileProvider.notifier).state = betaProfile;
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(
        scoped
            .read(managedRuntimeControllerProvider)
            .valueOrNull
            ?.codexUpdatePolicy,
        'when-detached',
        reason: "B's own snapshot has not arrived yet",
      );

      final action = scoped
          .read(managedRuntimeControllerProvider.notifier)
          .setCodexUpdatePolicy('when-idle');
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(
        beta.policyWrites,
        isEmpty,
        reason: "an A-era snapshot cannot authorize a write to B's runtime",
      );
      expect(alpha.policyWrites, isEmpty);

      held.complete();
      await action;
      expect(beta.policyWrites, ['when-idle']);
      expect(alpha.policyWrites, isEmpty);
      expect(
        scoped
            .read(managedRuntimeControllerProvider)
            .valueOrNull
            ?.brokerScopeKey,
        RosterSource.ofProfile(betaProfile).storageKey,
      );
    },
  );

  test(
    'an A action released after B loads cannot publish into B state',
    () async {
      await container.read(managedRuntimeControllerProvider.future);
      final held = Completer<void>();
      final started = Completer<void>();
      apiA
        ..holdRestartEverything = held
        ..restartEverythingStarted = started;

      final action = container
          .read(managedRuntimeControllerProvider.notifier)
          .restartEverything();
      await started.future;

      container.read(activeBrokerProfileProvider.notifier).state = brokerB;
      final brokerBState = await container.read(
        managedRuntimeControllerProvider.future,
      );
      expect(
        brokerBState.brokerScopeKey,
        RosterSource.ofProfile(brokerB).storageKey,
      );
      expect(brokerBState.codexUpdatePolicy, 'when-idle');
      expect(brokerBState.actionMessage, isNull);

      held.complete();
      await action;

      final unchanged = container
          .read(managedRuntimeControllerProvider)
          .requireValue;
      expect(
        unchanged.brokerScopeKey,
        RosterSource.ofProfile(brokerB).storageKey,
      );
      expect(unchanged.codexUpdatePolicy, 'when-idle');
      expect(
        unchanged.actionMessage,
        isNull,
        reason: "A's restart result must not be attached to B's snapshot",
      );
    },
  );

  test('confirmed targeted and global restart calls stay explicit', () async {
    await container
        .read(managedRuntimeControllerProvider.notifier)
        .restartRuntime('codex');
    final result = await container
        .read(managedRuntimeControllerProvider.notifier)
        .restartEverything();

    expect(apiA.restartedAgents, ['codex']);
    expect(apiA.restartEverythingCalls, 1);
    expect(result.message, 'Recovery scheduled');
  });

  test('targeted restart failure preserves the last valid snapshot', () async {
    final before = await container.read(
      managedRuntimeControllerProvider.future,
    );
    apiA.restartError = const BrokerException(
      message: 'Restart failed',
      statusCode: 502,
      error: BrokerError(
        error: 'The running Codex app server is unmanaged.',
        code: 'runtime_restart_failed',
      ),
    );

    await container
        .read(managedRuntimeControllerProvider.notifier)
        .restartRuntime('codex');

    final after = container.read(managedRuntimeControllerProvider).requireValue;
    expect(after.updates, same(before.updates));
    expect(after.codexUpdatePolicy, before.codexUpdatePolicy);
    expect(after.actionError, contains('unmanaged'));
  });

  test(
    'peer capability omits owner reads and blocks owner mutations',
    () async {
      apiA.principalKind = 'peer';
      final snapshot = await container.read(
        managedRuntimeControllerProvider.future,
      );
      expect(snapshot.ownerOperationsAvailable, isFalse);
      expect(snapshot.brokerUpdate, isNull);
      expect(apiA.brokerUpdateReads, 0);
      await expectLater(
        container
            .read(managedRuntimeControllerProvider.notifier)
            .restartEverything(),
        throwsA(isA<StateError>()),
      );
      expect(apiA.restartEverythingCalls, 0);
    },
  );
}

final class _FakeManagedRuntimeApi implements ManagedRuntimeApi {
  _FakeManagedRuntimeApi({required String initialPolicy})
    : policy = initialPolicy;

  /// Holds every runtime probe open until completed, so a snapshot for this
  /// broker can be kept off screen while an action is attempted.
  Completer<void>? holdRuntimeUpdates;
  Completer<void>? holdRestartEverything;
  Completer<void>? restartEverythingStarted;

  /// Holds the quota read open until completed, so an in-flight read for this
  /// broker can be released only after a broker switch.
  Completer<void>? holdQuota;
  Completer<void>? quotaStarted;

  /// Provider key used in the fake quota payload, so A's and B's snapshots
  /// are distinguishable.
  String quotaProviderId = 'codex';

  String policy;
  bool quotaEnabled = false;
  bool quotaThrows = false;
  BrokerException? restartError;
  int quotaReads = 0;
  int restartEverythingCalls = 0;
  int brokerUpdateReads = 0;
  String? principalKind;
  final List<String> policyWrites = [];
  final List<bool> quotaPreferenceWrites = [];
  final List<String> restartedAgents = [];

  @override
  Future<RuntimeUpdatesResponse> getRuntimeUpdates({bool fresh = false}) async {
    final held = holdRuntimeUpdates;
    if (held != null) await held.future;
    return const RuntimeUpdatesResponse(
      ok: true,
      updates: [
        AgentRuntimeUpdateStatus(
          agent: 'codex',
          displayName: 'Codex',
          managed: true,
          state: 'pending',
          updateAvailable: true,
          autoRestartReady: false,
          checkedAt: 1,
          runningVersion: '0.1',
          installedVersion: '0.2',
        ),
      ],
    );
  }

  @override
  Future<CodexUpdatePolicyResponse> getPolicy() async {
    return CodexUpdatePolicyResponse(
      codexUpdatePolicy: policy,
      ok: true,
    );
  }

  @override
  Future<BrokerHealthResponse> getHealth() async {
    return BrokerHealthResponse(
      status: 'healthy',
      checkedAt: 1,
      principalKind: principalKind,
    );
  }

  @override
  Future<WorkspaceBrowsingSettingsResponse> setWorkspaceBrowsing({
    required bool enabled,
    required bool confirmRemoteFileAccess,
  }) async => WorkspaceBrowsingSettingsResponse(enabled: enabled, ok: true);

  @override
  Future<HealthResponse> getProductHealth() async =>
      const HealthResponse(ok: true, version: '1.0.0');

  @override
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false}) async {
    brokerUpdateReads++;
    return const BrokerUpdateResponse(
      ok: true,
      update: BrokerUpdateSnapshot(
        status: 'current',
        currentVersion: '1.0.0',
        checkedAt: '2026-07-18T00:00:00Z',
        detailCode: 'current',
      ),
    );
  }

  @override
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate() async =>
      const BrokerUpdateTriggerResponse(
        ok: true,
        accepted: false,
        message: 'Already current',
        update: BrokerUpdateSnapshot(
          status: 'current',
          currentVersion: '1.0.0',
          checkedAt: '2026-07-18T00:00:00Z',
          detailCode: 'current',
        ),
      );

  @override
  Future<TokdashQuotaPreferenceResponse> getQuotaPreference() async {
    return TokdashQuotaPreferenceResponse(ok: true, enabled: quotaEnabled);
  }

  @override
  Future<TokdashQuotaResponse> getQuota() async {
    quotaReads += 1;
    final started = quotaStarted;
    if (started != null && !started.isCompleted) started.complete();
    final held = holdQuota;
    if (held != null) await held.future;
    if (quotaThrows) {
      throw const BrokerException(message: 'Tokdash unreachable');
    }
    return TokdashQuotaResponse(
      ok: true,
      data: TokdashQuotaData(
        enabled: true,
        timestamp: 1,
        providers: {
          quotaProviderId: TokdashQuotaProvider(
            provider: quotaProviderId,
            networkEnabled: false,
            buckets: const [],
            status: 'ok',
            sources: const ['codex_session'],
            estimated: true,
            raw: const {},
          ),
        },
      ),
    );
  }

  @override
  Future<CodexUpdatePolicyResponse> setPolicy(String value) async {
    policyWrites.add(value);
    policy = value;
    return CodexUpdatePolicyResponse(codexUpdatePolicy: value, ok: true);
  }

  @override
  Future<TokdashQuotaPreferenceResponse> setQuotaPreference({
    required bool enabled,
  }) async {
    quotaPreferenceWrites.add(enabled);
    quotaEnabled = enabled;
    return TokdashQuotaPreferenceResponse(ok: true, enabled: enabled);
  }

  @override
  Future<RuntimeUpdateRestartResponse> restartRuntime(String agent) async {
    restartedAgents.add(agent);
    final error = restartError;
    if (error != null) throw error;
    return const RuntimeUpdateRestartResponse(ok: true);
  }

  @override
  Future<BrokerRestartAllResponse> restartAll() async {
    restartEverythingCalls += 1;
    final started = restartEverythingStarted;
    if (started != null && !started.isCompleted) started.complete();
    final held = holdRestartEverything;
    if (held != null) await held.future;
    return const BrokerRestartAllResponse(
      ok: true,
      message: 'Recovery scheduled',
    );
  }
}

/// A profile whose id says nothing about which machine it points at.
BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime(2026),
);
