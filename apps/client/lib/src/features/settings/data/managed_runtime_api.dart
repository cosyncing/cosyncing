import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Broker-facing operations used by managed-runtime Settings.
abstract interface class ManagedRuntimeApi {
  /// Reads managed runtime freshness state.
  Future<RuntimeUpdatesResponse> getRuntimeUpdates({bool fresh = false});

  /// Reads the Codex automatic-update policy.
  Future<CodexUpdatePolicyResponse> getPolicy();

  /// Writes the Codex automatic-update policy.
  Future<CodexUpdatePolicyResponse> setPolicy(String value);

  /// Reads authenticated broker health.
  Future<BrokerHealthResponse> getHealth();

  /// Reads public broker version and contract identity.
  Future<HealthResponse> getProductHealth();

  /// Reads the signed broker release channel.
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false});

  /// Requests an update through the broker's isolated signed updater.
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate();

  /// Reads the separate cosyncing quota-warning preference.
  Future<TokdashQuotaPreferenceResponse> getQuotaPreference();

  /// Writes the separate cosyncing quota-warning preference.
  Future<TokdashQuotaPreferenceResponse> setQuotaPreference({
    required bool enabled,
  });

  /// Reads Tokdash quota through the broker's read-only proxy.
  Future<TokdashQuotaResponse> getQuota();

  /// Performs one explicitly confirmed targeted runtime restart.
  Future<RuntimeUpdateRestartResponse> restartRuntime(String agent);

  /// Performs one explicitly confirmed global recovery restart.
  Future<BrokerRestartAllResponse> restartAll();
}

/// Synchronous dependency-injection seam used by tests.
final managedRuntimeApiProvider = Provider<ManagedRuntimeApi?>((_) => null);

/// Identity-bound API context for managed-runtime settings.
final managedRuntimeApiContextProvider =
    FutureProvider<ManagedRuntimeApiContext?>((ref) async {
      final injected = ref.watch(managedRuntimeApiProvider);
      // The exact broker SOURCE — (profile, endpoint, incarnation) — not the
      // profile id.
      // This handle restarts runtimes and triggers signed updates: re-pointing
      // the profile at another machine keeps the id, so an id-stamped context
      // let a rendered snapshot of A be treated as B's and sent B's actions.
      final scopeKey = ref.watch(
        activeBrokerProfileProvider.select(
          (profile) => RosterSource.of(profile)?.storageKey,
        ),
      );
      if (injected != null) {
        return ManagedRuntimeApiContext(
          api: injected,
          brokerScopeKey: scopeKey,
          admissionGeneration: Object(),
        );
      }

      final client = await ref.watch(brokerClientProvider.future);
      if (client == null) return null;

      return ManagedRuntimeApiContext(
        api: _BrokerManagedRuntimeApi(client),
        brokerScopeKey: scopeKey,
        admissionGeneration: Object(),
      );
    });

/// Context snapshot of managed-runtime API identity and broker selection.
final class ManagedRuntimeApiContext {
  /// Creates a context snapshot for a managed-runtime API handle.
  const ManagedRuntimeApiContext({
    required this.api,
    required this.brokerScopeKey,
    required this.admissionGeneration,
  });

  /// Client used for this snapshot.
  final ManagedRuntimeApi api;

  /// `RosterSource.storageKey` of the broker this API talks to.
  final String? brokerScopeKey;

  /// Unique generation of the provider admission that produced this handle.
  ///
  /// Source keys can repeat after A → B → A. Identity comparison on this token
  /// still rejects work admitted by the first A incarnation.
  final Object admissionGeneration;
}

/// Latest quota snapshot for the admitted broker.
///
/// The quota read is deliberately separate from the managed-runtime
/// controller's core Settings snapshot: viewing usage is independent of the
/// warnings opt-in, and a slow local read must not hold the whole Settings
/// section in its loading state. Watching the api context scopes the result
/// to the exact broker admission — a broker switch rebuilds this provider
/// instead of letting one broker's snapshot land on another's.
///
/// `null` means unavailable: either no broker is connected or the read-only
/// proxy call failed with a [BrokerException] (Tokdash down, broker 502).
/// Programming/decoding errors are not swallowed.
///
/// Auto-disposed: once Settings is closed, the last listener leaves and the
/// subscription drops, so later broker switches trigger no off-screen reads.
final AutoDisposeFutureProvider<TokdashQuotaResponse?>
managedRuntimeQuotaProvider = FutureProvider.autoDispose<TokdashQuotaResponse?>(
  (ref) async {
    final context = await ref.watch(managedRuntimeApiContextProvider.future);
    if (context == null) return null;
    try {
      return await context.api.getQuota();
    } on BrokerException {
      return null;
    }
  },
);

final class _BrokerManagedRuntimeApi implements ManagedRuntimeApi {
  const _BrokerManagedRuntimeApi(this.client);

  final BrokerClient client;

  @override
  Future<RuntimeUpdatesResponse> getRuntimeUpdates({bool fresh = false}) =>
      client.getAgentRuntimeUpdates(fresh: fresh);

  @override
  Future<CodexUpdatePolicyResponse> getPolicy() =>
      client.getCodexUpdatePolicy();

  @override
  Future<CodexUpdatePolicyResponse> setPolicy(String value) =>
      client.setCodexUpdatePolicy(
        SetCodexUpdatePolicyRequest(codexUpdatePolicy: value),
      );

  @override
  Future<BrokerHealthResponse> getHealth() => client.getBrokerHealth();

  @override
  Future<HealthResponse> getProductHealth() => client.getHealth();

  @override
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false}) =>
      client.getBrokerUpdate(refresh: refresh);

  @override
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate() =>
      client.triggerBrokerUpdate();

  @override
  Future<TokdashQuotaPreferenceResponse> getQuotaPreference() =>
      client.getTokdashQuotaPreference();

  @override
  Future<TokdashQuotaPreferenceResponse> setQuotaPreference({
    required bool enabled,
  }) => client.setTokdashQuotaPreference(
    TokdashQuotaPreferenceRequest(enabled: enabled),
  );

  @override
  Future<TokdashQuotaResponse> getQuota() => client.getTokdashQuota();

  @override
  Future<RuntimeUpdateRestartResponse> restartRuntime(String agent) =>
      client.restartAgentRuntime(agent: agent, confirmRestart: true);

  @override
  Future<BrokerRestartAllResponse> restartAll() =>
      client.restartEverything(confirmRestart: true);
}
