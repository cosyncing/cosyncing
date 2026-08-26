import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// New-session request phase.
enum NewSessionPhase {
  /// Waiting for input.
  idle,

  /// Loading capability-bearing agents.
  loadingAgents,

  /// Creating a session.
  creating,
}

/// Pre-session model catalog state for the selected tool.
enum NewSessionModelCatalogPhase {
  /// No tool/catalog request yet, or the adapter exposes no choices.
  unavailable,

  /// A catalog request is active.
  loading,

  /// A fresh catalog was loaded, including a legitimate empty catalog.
  ready,

  /// Refresh failed. Retained options, if any, are stale.
  failed,
}

/// Defense-in-depth bound matching the broker's pre-session catalog ceiling.
const newSessionModelCatalogMaxOptions = 2048;

/// Immutable admission identity for one async New Session read.
///
/// A response may publish only while all three dimensions still match: the
/// exact broker source, the selected tool (null for the agent roster), and the
/// latest request generation for that lane.
@immutable
final class _NewSessionAdmission {
  const _NewSessionAdmission({
    required this.source,
    required this.tool,
    required this.generation,
  });

  final RosterSource? source;
  final String? tool;
  final int generation;
}

/// Capability-driven state for the New Session flow.
@immutable
final class NewSessionState {
  /// Creates New Session state.
  const NewSessionState({
    this.phase = NewSessionPhase.idle,
    this.agents = const [],
    this.modelCatalogPhase = NewSessionModelCatalogPhase.unavailable,
    this.modelTool,
    this.models = const [],
    this.modelCatalogSource,
    this.modelRefreshedAt,
    this.modelError,
    this.error,
  });

  /// Current network phase.
  final NewSessionPhase phase;

  /// Registered adapters that explicitly expose `createSession`.
  final List<AgentInfo> agents;

  /// Freshness of [models].
  final NewSessionModelCatalogPhase modelCatalogPhase;

  /// Tool that owns [models].
  final String? modelTool;

  /// Exact adapter-owned model identities for [modelTool].
  final List<ModelOption> models;

  /// Exact profile/endpoint/incarnation that supplied [models].
  final RosterSource? modelCatalogSource;

  /// Broker observation time.
  final int? modelRefreshedAt;

  /// Honest refresh error. Retained [models] are stale when this is non-null.
  final LocalizedFailure? modelError;

  /// Last honest load/create error.
  final LocalizedFailure? error;

  /// Whether a request is active.
  bool get isBusy => phase != NewSessionPhase.idle;

  /// Returns a copy with selected fields replaced.
  NewSessionState copyWith({
    NewSessionPhase? phase,
    List<AgentInfo>? agents,
    NewSessionModelCatalogPhase? modelCatalogPhase,
    String? modelTool,
    List<ModelOption>? models,
    RosterSource? modelCatalogSource,
    int? modelRefreshedAt,
    LocalizedFailure? modelError,
    LocalizedFailure? error,
    bool clearError = false,
    bool clearModelError = false,
  }) => NewSessionState(
    phase: phase ?? this.phase,
    agents: agents ?? this.agents,
    modelCatalogPhase: modelCatalogPhase ?? this.modelCatalogPhase,
    modelTool: modelTool ?? this.modelTool,
    models: models ?? this.models,
    modelCatalogSource: modelCatalogSource ?? this.modelCatalogSource,
    modelRefreshedAt: modelRefreshedAt ?? this.modelRefreshedAt,
    modelError: clearModelError ? null : modelError ?? this.modelError,
    error: clearError ? null : error ?? this.error,
  );
}

/// Controller for capability discovery and immediate session creation.
final newSessionControllerProvider =
    AutoDisposeNotifierProvider<NewSessionController, NewSessionState>(
      NewSessionController.new,
    );

/// Whether the active server exposes at least one creation-ready agent.
///
/// Session creation is a server capability, not a consequence of being
/// connected. Until this read succeeds, creation controls fail closed.
final sessionCreationReadyProvider =
    AutoDisposeNotifierProvider<
      SessionCreationReadinessController,
      SessionCreationReadinessState
    >(SessionCreationReadinessController.new);

/// User-facing interpretation of creation capability for the active server.
enum SessionCreationAvailability {
  /// Capability has not been confirmed yet, or a read is in flight.
  checking,

  /// At least one registered agent can create sessions.
  available,

  /// A successful read confirmed that no registered agent can create sessions.
  unavailable,

  /// The most recent capability read failed.
  failed,
}

/// Source-qualified creation capability for the Sessions surfaces.
///
/// [canCreateSession] is meaningful only for [source]. Keeping the source in
/// the state prevents a completed read from server A from enabling creation
/// after the active profile has switched to server B.
@immutable
final class SessionCreationReadinessState {
  /// Creates a creation-readiness snapshot.
  const SessionCreationReadinessState({
    required this.source,
    this.canCreateSession = false,
    this.isRefreshing = false,
    this.failed = false,
  });

  /// Exact server source evaluated by this state.
  final RosterSource? source;

  /// Whether that source has at least one creation-ready agent.
  final bool canCreateSession;

  /// Whether a newer read for the same source is in flight.
  final bool isRefreshing;

  /// Whether the most recent read failed.
  final bool failed;

  /// Returns readiness only when this state belongs to [activeSource].
  bool isReadyFor(RosterSource? activeSource) =>
      availabilityFor(activeSource) == SessionCreationAvailability.available;

  /// Interprets this snapshot only for the exact [activeSource].
  ///
  /// A retained positive result remains usable while its refresh is in flight.
  /// Without a positive result, loading and failure stay distinct from a
  /// successful read that confirmed no creation-ready agents.
  SessionCreationAvailability availabilityFor(RosterSource? activeSource) {
    if (source != activeSource || activeSource == null) {
      return SessionCreationAvailability.checking;
    }
    if (canCreateSession) return SessionCreationAvailability.available;
    if (isRefreshing) return SessionCreationAvailability.checking;
    if (failed) return SessionCreationAvailability.failed;
    return SessionCreationAvailability.unavailable;
  }
}

@immutable
final class _SessionCreationReadinessAdmission {
  const _SessionCreationReadinessAdmission({
    required this.source,
    required this.generation,
  });

  final RosterSource? source;
  final int generation;
}

/// Refreshable, source-fenced creation capability discovery.
final class SessionCreationReadinessController
    extends AutoDisposeNotifier<SessionCreationReadinessState> {
  int _generation = 0;
  var _disposed = false;

  @override
  SessionCreationReadinessState build() {
    _disposed = false;
    ref.onDispose(() => _disposed = true);
    final source = ref.watch(
      activeBrokerProfileProvider.select(RosterSource.of),
    );
    final agents = ref
        .watch(brokerClientProvider.future)
        .then<List<AgentInfo>?>((client) async {
          if (client == null) return null;
          return client.listAgents();
        });
    final admission = _SessionCreationReadinessAdmission(
      source: source,
      generation: ++_generation,
    );
    unawaited(_load(admission, agents));
    return SessionCreationReadinessState(
      source: source,
      isRefreshing: source != null,
    );
  }

  /// Re-reads creation capability for the exact active server.
  Future<void> refresh() async {
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    final admission = _SessionCreationReadinessAdmission(
      source: source,
      generation: ++_generation,
    );
    final retained = state.source == source && state.canCreateSession;
    state = SessionCreationReadinessState(
      source: source,
      canCreateSession: retained,
      isRefreshing: source != null,
    );
    final agents = ref.read(brokerClientProvider.future).then<List<AgentInfo>?>(
      (client) async {
        if (client == null) return null;
        return client.listAgents();
      },
    );
    await _load(admission, agents);
  }

  Future<void> _load(
    _SessionCreationReadinessAdmission admission,
    Future<List<AgentInfo>?> agentsFuture,
  ) async {
    final source = admission.source;
    if (source == null) {
      if (_canPublish(admission)) {
        state = const SessionCreationReadinessState(source: null);
      }
      return;
    }

    try {
      final agents = await agentsFuture;
      if (!_canPublish(admission)) return;
      if (agents == null) {
        state = SessionCreationReadinessState(source: source);
        return;
      }
      state = SessionCreationReadinessState(
        source: source,
        canCreateSession: agents.any((agent) => agent.canCreateSession),
      );
    } on Object {
      if (!_canPublish(admission)) return;
      // Capability discovery fails closed, but remains retryable through the
      // normal Sessions refresh and connection-recovery paths.
      state = SessionCreationReadinessState(source: source, failed: true);
    }
  }

  bool _canPublish(_SessionCreationReadinessAdmission admission) =>
      !_disposed &&
      admission.generation == _generation &&
      admission.source ==
          RosterSource.of(ref.read(activeBrokerProfileProvider));
}

/// Owns the New Session REST lifecycle; the sheet only renders and dispatches.
final class NewSessionController extends AutoDisposeNotifier<NewSessionState> {
  int _agentGeneration = 0;
  int _modelGeneration = 0;
  RosterSource? _activeSource;

  @override
  NewSessionState build() {
    _activeSource = ref.watch(
      activeBrokerProfileProvider.select(RosterSource.of),
    );
    // A source change invalidates both lanes even when no replacement request
    // has started yet. This prevents the old broker from publishing into the
    // freshly rebuilt state.
    _agentGeneration += 1;
    _modelGeneration += 1;
    return const NewSessionState();
  }

  /// Loads only adapters that authoritatively advertise session creation.
  Future<void> loadAgents() async {
    final keepAlive = ref.keepAlive();
    final admission = _NewSessionAdmission(
      source: _activeSource,
      tool: null,
      generation: ++_agentGeneration,
    );
    state = state.copyWith(
      phase: NewSessionPhase.loadingAgents,
      clearError: true,
    );
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError('Connect to a server before creating a session.');
      }
      final agents = (await client.listAgents())
          .where((agent) => agent.canCreateSession)
          .toList(growable: false);
      if (!_canAdmitAgents(admission)) return;
      state = NewSessionState(agents: agents);
    } on Object catch (error) {
      if (!_canAdmitAgents(admission)) return;
      state = NewSessionState(
        error: LocalizedFailure.from(error, lead: FailureLead.loadAgents),
      );
    } finally {
      keepAlive.close();
    }
  }

  /// Loads the selected adapter's pre-session model catalog.
  Future<void> loadModels(String tool) async {
    final keepAlive = ref.keepAlive();
    try {
      await _loadModels(tool);
    } finally {
      keepAlive.close();
    }
  }

  Future<void> _loadModels(String tool) async {
    final profile = ref.read(activeBrokerProfileProvider);
    final admission = _NewSessionAdmission(
      source: RosterSource.of(profile),
      tool: tool,
      generation: ++_modelGeneration,
    );
    if (profile == null) {
      state = state.copyWith(
        modelCatalogPhase: NewSessionModelCatalogPhase.failed,
        modelTool: tool,
        modelError: const LocalizedFailure.notice(
          FailureLead.modelsRequireServer,
        ),
      );
      return;
    }
    final source = RosterSource.ofProfile(profile);
    final agent = state.agents
        .where((candidate) => candidate.id == tool)
        .firstOrNull;
    if (agent == null || !agent.canSelectModelAtCreation) {
      state = state.copyWith(
        modelCatalogPhase: NewSessionModelCatalogPhase.unavailable,
        modelTool: tool,
        models: const [],
        modelCatalogSource: source,
        clearModelError: true,
      );
      return;
    }
    final retained =
        state.modelTool == tool && state.modelCatalogSource == source
        ? state.models
        : const <ModelOption>[];
    state = state.copyWith(
      modelCatalogPhase: NewSessionModelCatalogPhase.loading,
      modelTool: tool,
      models: retained,
      modelCatalogSource: source,
      clearModelError: true,
    );
    try {
      final response = await (() async {
        final client = await ref.read(brokerClientFactoryProvider)(profile);
        try {
          return await client.listAgentModels(tool);
        } finally {
          client.close();
        }
      })();
      if (!_canAdmitModels(admission)) return;
      state = state.copyWith(
        modelCatalogPhase: NewSessionModelCatalogPhase.ready,
        modelTool: tool,
        models: response.models
            .take(newSessionModelCatalogMaxOptions)
            .toList(growable: false),
        modelCatalogSource: source,
        modelRefreshedAt: response.refreshedAt,
        clearModelError: true,
      );
    } on Object catch (error) {
      if (!_canAdmitModels(admission)) return;
      state = state.copyWith(
        modelCatalogPhase: NewSessionModelCatalogPhase.failed,
        modelTool: tool,
        models: retained,
        modelCatalogSource: source,
        modelError: LocalizedFailure.from(
          error,
          lead: FailureLead.refreshModelCatalog,
        ),
      );
    }
  }

  bool _canAdmitAgents(_NewSessionAdmission admission) =>
      admission.generation == _agentGeneration &&
      admission.tool == null &&
      admission.source == _activeSource;

  bool _canAdmitModels(_NewSessionAdmission admission) =>
      admission.generation == _modelGeneration &&
      admission.tool != null &&
      admission.tool == state.modelTool &&
      admission.source == _activeSource;

  /// Creates and returns one session, omitting blank optional fields.
  Future<SessionInfo?> create({
    required String tool,
    required String directory,
    required String title,
    SessionCurrentModel? model,
    RosterSource? modelSource,
  }) async {
    if (!state.agents.any((agent) => agent.id == tool)) {
      state = state.copyWith(
        error: const LocalizedFailure.notice(FailureLead.chooseCreatableAgent),
      );
      return null;
    }
    state = state.copyWith(phase: NewSessionPhase.creating, clearError: true);
    try {
      final session = await ref
          .read(newSessionLaunchServiceProvider)
          .create(
            NewSessionLaunchRequest(
              tool: tool,
              directory: directory,
              title: title,
              model: model,
              modelSource: modelSource,
            ),
          );
      state = state.copyWith(phase: NewSessionPhase.idle, clearError: true);
      return session;
    } on Object catch (error) {
      state = state.copyWith(
        phase: NewSessionPhase.idle,
        error: LocalizedFailure.from(error, lead: FailureLead.createSession),
      );
      return null;
    }
  }
}
