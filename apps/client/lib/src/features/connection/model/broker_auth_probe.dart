import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';

/// Probes an *authenticated* broker endpoint to classify the connection gate.
///
/// This is deliberately separate from `BrokerHealthProbe`. That probe calls
/// `GET /api/health`, which the broker serves without authentication, so it
/// returns 200 even when the stored credential is wrong — it can never observe
/// a 401. Classifying credentials requires an auth-gated endpoint.
///
/// Deliberately an abstract class (not a typedef) so it can be used as a
/// Riverpod provider type and overridden in tests with a fake implementation,
/// matching `BrokerHealthProbe`.
// ignore: one_member_abstracts
abstract interface class BrokerAuthProbe {
  /// Probes [baseUrl] using [credential], returning the resulting gate state.
  ///
  /// [credential] is null when the active profile has no stored secret. That
  /// is not itself an error: brokers with no token configured (the loopback
  /// baseline) answer authenticated routes anonymously, and must report
  /// [BrokerGateStatus.connected].
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind,
  });
}

/// Real [BrokerAuthProbe] backed by `GET /api/broker/health`.
///
/// That route is listed in the broker's default-deny auth gate, so it answers
/// 401 for an absent or invalid credential and 200 for a valid one.
class RealBrokerAuthProbe implements BrokerAuthProbe {
  /// Creates a [RealBrokerAuthProbe].
  ///
  /// [clientFactory] is injectable for tests and defaults to building a real
  /// client carrying the credential under the scheme its key selects.
  RealBrokerAuthProbe({
    BrokerClient Function({
      required String baseUrl,
      String? token,
      String? peerToken,
    })?
    clientFactory,
  }) : _clientFactory = clientFactory ?? _defaultClientFactory;

  final BrokerClient Function({
    required String baseUrl,
    String? token,
    String? peerToken,
  })
  _clientFactory;

  static BrokerClient _defaultClientFactory({
    required String baseUrl,
    String? token,
    String? peerToken,
  }) {
    return BrokerClient(
      baseUrl: baseUrl,
      token: token,
      peerToken: peerToken,
    );
  }

  @override
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind = BrokerCredentialKind.sharedToken,
  }) async {
    final secret = credential?.trim();
    final hasCredential = secret != null && secret.isNotEmpty;

    final client = _clientFactory(
      baseUrl: baseUrl.toString(),
      token: hasCredential && credentialKind == BrokerCredentialKind.sharedToken
          ? secret
          : null,
      peerToken:
          hasCredential && credentialKind == BrokerCredentialKind.peerToken
          ? secret
          : null,
    );

    try {
      final response = await client.getBrokerHealth();
      return BrokerGateState.connected(
        machine: response.machine,
        brokerUrl: baseUrl,
      );
    } on BrokerException catch (e) {
      // The sole discriminator: the broker answered, and the answer was 401.
      // Any other BrokerException (5xx, timeout, connection refused — which
      // arrives with a null statusCode) means we never got an auth verdict and
      // must be reported as unreachable rather than as a credential problem.
      if (e.statusCode == 401) {
        return BrokerGateState.unauthorized(
          credentialIssue: hasCredential
              ? BrokerGateCredentialIssue.rejected
              : BrokerGateCredentialIssue.missing,
          detail: e.error?.error ?? e.message,
          brokerUrl: baseUrl,
        );
      }
      return BrokerGateState.unreachable(
        detail: e.error?.error ?? e.message,
        brokerUrl: baseUrl,
      );
    } on Object catch (e) {
      return BrokerGateState.unreachable(
        detail: e.toString(),
        brokerUrl: baseUrl,
      );
    } finally {
      client.close();
    }
  }
}
