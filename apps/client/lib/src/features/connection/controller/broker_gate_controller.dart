import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Provides the [BrokerAuthProbe] singleton.
///
/// Override this in tests to inject a fake implementation.
final brokerAuthProbeProvider = Provider<BrokerAuthProbe>(
  (ref) => RealBrokerAuthProbe(),
);

/// Evaluates whether the app may talk to the active broker.
///
/// Resolves the active profile and its stored credential, then delegates the
/// reachable/authorized decision to [BrokerAuthProbe]. Re-runs whenever the
/// active profile changes so saving a token or pairing a device immediately
/// re-opens the gate.
///
/// See `docs/architecture/client-ui.md`.
class BrokerGateController extends AsyncNotifier<BrokerGateState> {
  int _generation = 0;

  @override
  Future<BrokerGateState> build() {
    final profile = ref.watch(activeBrokerProfileProvider);
    _generation += 1;
    return _evaluate(profile);
  }

  Future<BrokerGateState> _evaluate(BrokerProfile? profile) async {
    if (profile == null) {
      return const BrokerGateState.unselected();
    }

    final credentialKey = profile.credentialKey;
    String? credential;
    if (credentialKey != null) {
      try {
        credential = await ref
            .read(credentialStoreProvider)
            .readBrokerToken(credentialKey);
      } on Object {
        // Secure storage could not return the secret. Continue with no
        // credential rather than failing closed: the probe then reports the
        // broker's own verdict, which is what the user must act on.
        credential = null;
      }
    }

    final result = await ref
        .read(brokerAuthProbeProvider)
        .probe(
          baseUrl: profile.baseUri,
          credential: credential,
          credentialKind: credentialKey == null
              ? BrokerCredentialKind.sharedToken
              : brokerCredentialKindForKey(credentialKey),
        );
    return result.bindProfile(
      id: profile.id,
      displayName: profile.displayName,
      baseUri: profile.baseUri,
    );
  }

  /// Re-runs the gate probe, surfacing progress as [AsyncValue.loading].
  Future<void> refresh() async {
    final previous = state.valueOrNull;
    final profile = ref.read(activeBrokerProfileProvider);
    final source = _BrokerGateSource.of(profile);
    final generation = ++_generation;
    state = const AsyncValue<BrokerGateState>.loading();
    final result = await AsyncValue.guard(() => _evaluate(profile));
    if (!_canPublish(source, generation)) return;
    state = result;

    // A successful recovery on the same selected server must also rebuild the
    // authenticated client. Capability readers such as Sessions readiness
    // depend on that provider and therefore retry without a profile switch.
    if (!(previous?.isConnected ?? false) &&
        (result.valueOrNull?.isConnected ?? false)) {
      ref.invalidate(brokerClientProvider);
    }
  }

  bool _canPublish(_BrokerGateSource? source, int generation) =>
      generation == _generation &&
      source == _BrokerGateSource.of(ref.read(activeBrokerProfileProvider));
}

@immutable
final class _BrokerGateSource {
  const _BrokerGateSource({
    required this.profileId,
    required this.endpoint,
    required this.incarnationId,
  });

  factory _BrokerGateSource.ofProfile(BrokerProfile profile) =>
      _BrokerGateSource(
        profileId: profile.id,
        endpoint: profile.baseUri.toString(),
        incarnationId: profile.incarnationId,
      );

  static _BrokerGateSource? of(BrokerProfile? profile) =>
      profile == null ? null : _BrokerGateSource.ofProfile(profile);

  final String profileId;
  final String endpoint;
  final String? incarnationId;

  @override
  bool operator ==(Object other) =>
      other is _BrokerGateSource &&
      other.profileId == profileId &&
      other.endpoint == endpoint &&
      other.incarnationId == incarnationId;

  @override
  int get hashCode => Object.hash(profileId, endpoint, incarnationId);
}

/// Provider for the [BrokerGateController].
final AsyncNotifierProvider<BrokerGateController, BrokerGateState>
brokerGateControllerProvider =
    AsyncNotifierProvider<BrokerGateController, BrokerGateState>(
      BrokerGateController.new,
    );
