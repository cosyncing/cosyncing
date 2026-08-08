import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Client state for configured local/peer machine rosters.
@immutable
final class MachineRosterState {
  /// Creates machine-roster state.
  const MachineRosterState({
    this.machines = const [],
    this.loading = false,
    this.error,
  });

  /// Configured machine rosters from the active aggregator.
  final List<MachineRoster> machines;

  /// Whether a roster refresh is in flight.
  final bool loading;

  /// Honest aggregator failure, if any.
  final Object? error;
}

/// Loads machine rosters without mixing composite identities into `/sessions`.
final machineRosterControllerProvider =
    AutoDisposeNotifierProvider<MachineRosterController, MachineRosterState>(
      MachineRosterController.new,
    );

/// Owns aggregator reads and authoritative owner resolution.
final class MachineRosterController
    extends AutoDisposeNotifier<MachineRosterState> {
  int _generation = 0;

  @override
  MachineRosterState build() {
    // The exact broker SOURCE — (profile, endpoint) — not the profile id. A
    // roster names other machines the aggregator can reach, and re-pointing the
    // profile at a different aggregator keeps the id: an id-keyed rebuild left
    // the previous aggregator's machines on screen and let its late answer
    // land, so the next resolve() targeted a machine B never listed.
    ref.watch(activeBrokerProfileProvider.select(RosterSource.of));
    _generation += 1;
    return const MachineRosterState();
  }

  /// Loads every configured roster from the active broker.
  Future<void> load() async {
    final generation = ++_generation;
    final source = _activeSource;
    state = MachineRosterState(machines: state.machines, loading: true);
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError('Connect to a broker to load machine sessions.');
      }
      final response = await client.listMachines();
      if (!_isCurrent(source, generation)) return;
      state = MachineRosterState(machines: response.machines);
    } on Object catch (error) {
      if (!_isCurrent(source, generation)) return;
      state = MachineRosterState(machines: state.machines, error: error);
    }
  }

  /// Resolves the current direct owner for one composite session identity.
  Future<MachineSessionResolution?> resolve(
    MachineSessionIdentity identity,
  ) async {
    final source = _activeSource;
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError(
          'Connect to the aggregator before resolving an owner.',
        );
      }
      final result = await client.resolveMachineSession(
        machineId: identity.machineId,
        tool: identity.tool,
        sessionId: identity.sessionId,
      );
      if (_activeSource != source) return null;
      return result;
    } on Object catch (error) {
      if (_activeSource == source) {
        state = MachineRosterState(machines: state.machines, error: error);
      }
      return null;
    }
  }

  /// The broker this controller is currently allowed to speak for.
  RosterSource? get _activeSource =>
      RosterSource.of(ref.read(activeBrokerProfileProvider));

  bool _isCurrent(RosterSource? source, int generation) =>
      _activeSource == source && generation == _generation;
}
