import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/settings/data/managed_runtime_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:cosyncing_client/src/features/settings/data/managed_runtime_api.dart'
    show
        ManagedRuntimeApi,
        managedRuntimeApiProvider,
        managedRuntimeQuotaProvider;

/// Immutable managed-runtime Settings snapshot.
class ManagedRuntimeSettingsState {
  /// Creates a Settings snapshot.
  const ManagedRuntimeSettingsState({
    required this.connected,
    required this.updates,
    required this.codexUpdatePolicy,
    required this.quotaWarningsEnabled,
    this.health,
    this.productHealth,
    this.brokerUpdate,
    this.actionMessage,
    this.brokerScopeKey,
  });

  /// Whether an active broker client is available.
  final bool connected;

  /// Current managed runtime statuses.
  final List<AgentRuntimeUpdateStatus> updates;

  /// Current Codex automatic update policy.
  final String? codexUpdatePolicy;

  /// Separate cosyncing quota-warning opt-in.
  final bool quotaWarningsEnabled;

  /// Authenticated broker health snapshot.
  final BrokerHealthResponse? health;

  /// Public broker version and contract identity.
  final HealthResponse? productHealth;

  /// Signed stable release-channel status.
  final BrokerUpdateSnapshot? brokerUpdate;

  /// Last explicit recovery result shown to the user.
  final String? actionMessage;

  /// `RosterSource.storageKey` of the broker this snapshot was read from.
  ///
  /// The exact source, not the profile id: a profile re-pointed at another
  /// machine keeps its id, and an id-stamped snapshot would be reused as the
  /// new machine's — showing A's runtime state while an action runs on B.
  final String? brokerScopeKey;

  /// Whether this connection may invoke owner-only broker operations.
  bool get ownerOperationsAvailable => health?.ownerOperationsAvailable ?? true;

  /// Returns a copy with an updated action message.
  ManagedRuntimeSettingsState withActionMessage(String? message) {
    return ManagedRuntimeSettingsState(
      connected: connected,
      updates: updates,
      codexUpdatePolicy: codexUpdatePolicy,
      quotaWarningsEnabled: quotaWarningsEnabled,
      health: health,
      productHealth: productHealth,
      brokerUpdate: brokerUpdate,
      actionMessage: message,
      brokerScopeKey: brokerScopeKey,
    );
  }
}

/// Loads and mutates managed-runtime recovery Settings.
final managedRuntimeControllerProvider =
    AsyncNotifierProvider<
      ManagedRuntimeController,
      ManagedRuntimeSettingsState
    >(ManagedRuntimeController.new);

/// Controller for runtime policy, broker health, quota, and recovery actions.
class ManagedRuntimeController
    extends AsyncNotifier<ManagedRuntimeSettingsState> {
  @override
  Future<ManagedRuntimeSettingsState> build() async {
    final context = await _resolveApiContext(watch: true);
    if (context == null) {
      return const ManagedRuntimeSettingsState(
        connected: false,
        updates: [],
        codexUpdatePolicy: null,
        quotaWarningsEnabled: false,
      );
    }
    return _load(_ManagedRuntimeAdmissionScope(context));
  }

  /// Refreshes all Settings state from the broker.
  Future<void> refresh({bool freshRuntimeProbe = false}) async {
    final context = await _resolveApiContext();
    if (context == null) return;
    final admission = _ManagedRuntimeAdmissionScope(context);
    if (!_isCurrent(admission)) return;
    state = const AsyncValue.loading();
    final next = await AsyncValue.guard(
      () => _load(admission, freshRuntimeProbe: freshRuntimeProbe),
    );
    if (_isCurrent(admission)) state = next;
    // The quota snapshot lives outside this controller so a slow local read
    // never blocks the section; a manual refresh re-reads it too.
    ref.invalidate(managedRuntimeQuotaProvider);
  }

  /// Changes the Codex auto-update gate after UI confirmation.
  Future<void> setCodexUpdatePolicy(String value) async {
    if (!knownCodexUpdatePolicies.contains(value)) {
      throw ArgumentError.value(value, 'value', 'Unsupported update policy');
    }
    final admission = await _requireOwnerApiContext();
    state = const AsyncValue.loading();
    final next = await AsyncValue.guard(() async {
      await admission.context.api.setPolicy(value);
      _ensureCurrent(admission);
      return _load(admission);
    });
    if (_isCurrent(admission)) state = next;
  }

  /// Changes the quota-warning opt-in without changing Tokdash consent.
  Future<void> setQuotaWarningsEnabled({required bool enabled}) async {
    final admission = await _requireOwnerApiContext();
    state = const AsyncValue.loading();
    final next = await AsyncValue.guard(() async {
      await admission.context.api.setQuotaPreference(enabled: enabled);
      _ensureCurrent(admission);
      return _load(admission);
    });
    if (_isCurrent(admission)) state = next;
  }

  /// Restarts one runtime after the view obtains explicit confirmation.
  Future<void> restartRuntime(String agent) async {
    final admission = await _requireOwnerApiContext();
    state = const AsyncValue.loading();
    final next = await AsyncValue.guard(() async {
      await admission.context.api.restartRuntime(agent);
      _ensureCurrent(admission);
      return _load(admission, freshRuntimeProbe: true);
    });
    if (_isCurrent(admission)) state = next;
  }

  /// Restarts all managed components after explicit view confirmation.
  Future<BrokerRestartAllResponse> restartEverything() async {
    final admission = await _requireOwnerApiContext();
    final result = await admission.context.api.restartAll();
    if (!_isCurrent(admission)) return result;
    final current = state.valueOrNull;
    if (current != null && current.brokerScopeKey == admission.brokerScopeKey) {
      state = AsyncValue.data(current.withActionMessage(result.message));
    }
    return result;
  }

  /// Confirms and queues the signed stable broker update.
  Future<BrokerUpdateTriggerResponse> updateBroker() async {
    final admission = await _requireOwnerApiContext();
    final result = await admission.context.api.triggerBrokerUpdate();
    if (!_isCurrent(admission)) return result;
    try {
      final refreshed = await _load(admission, freshBrokerUpdate: true);
      if (_isCurrent(admission)) {
        state = AsyncValue.data(
          refreshed.withActionMessage(result.outcomeMessage),
        );
      }
    } on _StaleManagedRuntimeAdmission {
      // The update was requested from the admitted broker, but its result no
      // longer belongs on the newly selected broker's Settings state.
    }
    return result;
  }

  Future<ManagedRuntimeSettingsState> _load(
    _ManagedRuntimeAdmissionScope admission, {
    bool freshRuntimeProbe = false,
    bool freshBrokerUpdate = false,
  }) async {
    final context = admission.context;
    final health = await context.api.getHealth();
    _ensureCurrent(admission);
    final updates = await context.api.getRuntimeUpdates(
      fresh: freshRuntimeProbe,
    );
    _ensureCurrent(admission);
    final policy = await context.api.getPolicy();
    _ensureCurrent(admission);
    final productHealth = await context.api.getProductHealth();
    _ensureCurrent(admission);
    final brokerUpdate = health.ownerOperationsAvailable
        ? await context.api.getBrokerUpdate(refresh: freshBrokerUpdate)
        : null;
    _ensureCurrent(admission);
    final scopeKey = context.brokerScopeKey;
    if (scopeKey != null && productHealth.contract != null) {
      // Scope-keyed, matching every other writer of this store: the identity
      // describes the machine that answered, not the profile row.
      await ref
          .read(brokerIdentityStoreProvider)
          .write(scopeKey, productHealth);
      _ensureCurrent(admission);
    }
    final quotaPreference = await context.api.getQuotaPreference();
    _ensureCurrent(admission);
    return ManagedRuntimeSettingsState(
      connected: true,
      updates: updates.updates,
      codexUpdatePolicy: policy.codexUpdatePolicy,
      quotaWarningsEnabled: quotaPreference.enabled ?? false,
      health: health,
      productHealth: productHealth,
      brokerUpdate: brokerUpdate?.update,
      brokerScopeKey: context.brokerScopeKey,
    );
  }

  Future<ManagedRuntimeApiContext?> _resolveApiContext({
    bool watch = false,
  }) async {
    if (watch) {
      return ref.watch(managedRuntimeApiContextProvider.future);
    }
    return ref.read(managedRuntimeApiContextProvider.future);
  }

  Future<_ManagedRuntimeAdmissionScope> _requireApiContext() async {
    final context = await _resolveApiContext();
    if (context == null) {
      throw StateError('Connect to a server first');
    }
    final admission = _ManagedRuntimeAdmissionScope(context);
    _ensureCurrent(admission);

    if (state.valueOrNull?.brokerScopeKey != context.brokerScopeKey) {
      // The rendered snapshot belongs to a different broker than the handle
      // this action would run against. Reload before letting it proceed.
      state = const AsyncValue.loading();
      final next = await AsyncValue.guard(() => _load(admission));
      if (_isCurrent(admission)) state = next;
      _ensureCurrent(admission);
      final refreshed = state.valueOrNull;
      if (refreshed?.brokerScopeKey != context.brokerScopeKey) {
        throw StateError('Managed runtime settings changed while reloading');
      }
    }

    return admission;
  }

  Future<_ManagedRuntimeAdmissionScope> _requireOwnerApiContext() async {
    final admission = await _requireApiContext();
    if (state.valueOrNull?.ownerOperationsAvailable == false) {
      throw StateError('Owner credential required');
    }
    return admission;
  }

  bool _isCurrent(_ManagedRuntimeAdmissionScope admission) {
    final current = ref.read(managedRuntimeApiContextProvider);
    if (current.isLoading || !current.hasValue) return false;
    final context = current.valueOrNull;
    return context != null &&
        identical(context.admissionGeneration, admission.admissionGeneration) &&
        context.brokerScopeKey == admission.brokerScopeKey;
  }

  void _ensureCurrent(_ManagedRuntimeAdmissionScope admission) {
    if (!_isCurrent(admission)) {
      throw const _StaleManagedRuntimeAdmission();
    }
  }
}

/// Immutable authority captured before one broker-bound operation.
final class _ManagedRuntimeAdmissionScope {
  const _ManagedRuntimeAdmissionScope(this.context);

  final ManagedRuntimeApiContext context;

  Object get admissionGeneration => context.admissionGeneration;

  String? get brokerScopeKey => context.brokerScopeKey;
}

final class _StaleManagedRuntimeAdmission implements Exception {
  const _StaleManagedRuntimeAdmission();
}
