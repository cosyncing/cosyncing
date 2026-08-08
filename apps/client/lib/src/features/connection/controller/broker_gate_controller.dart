import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
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
  @override
  Future<BrokerGateState> build() => _evaluate();

  Future<BrokerGateState> _evaluate() async {
    final profile = ref.watch(activeBrokerProfileProvider);
    if (profile == null) {
      return const BrokerGateState.unreachable(
        detail: 'No broker is selected yet. Connect to a broker to continue.',
      );
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

    return ref
        .read(brokerAuthProbeProvider)
        .probe(
          baseUrl: profile.baseUri,
          credential: credential,
          credentialKind: credentialKey == null
              ? BrokerCredentialKind.sharedToken
              : brokerCredentialKindForKey(credentialKey),
        );
  }

  /// Re-runs the gate probe, surfacing progress as [AsyncValue.loading].
  Future<void> refresh() async {
    state = const AsyncValue<BrokerGateState>.loading();
    state = await AsyncValue.guard(_evaluate);
  }
}

/// Provider for the [BrokerGateController].
final AsyncNotifierProvider<BrokerGateController, BrokerGateState>
brokerGateControllerProvider =
    AsyncNotifierProvider<BrokerGateController, BrokerGateState>(
      BrokerGateController.new,
    );
