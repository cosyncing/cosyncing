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
