import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';

import 'package:cosyncing_client/src/features/connection/model/broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/health_probe_result.dart';

/// Real health probe implementation backed by [BrokerClient].
///
/// A small adapter from UI contract (`Uri`) to pure-Dart transport.
/// This preserves a clean seam for fake-first testing while keeping
/// transport in the package boundary.
/// See `docs/protocol/contract-sync.md`.
class RealBrokerHealthProbe implements BrokerHealthProbe {
  /// Creates a [RealBrokerHealthProbe].
  ///
  /// [clientFactory] is optional for testing and defaults to constructing
  /// a real client with the provided broker URL.
  RealBrokerHealthProbe({BrokerClient Function(String baseUrl)? clientFactory})
    : _clientFactory = clientFactory ?? _defaultClientFactory;

  final BrokerClient Function(String baseUrl) _clientFactory;

  static BrokerClient _defaultClientFactory(String baseUrl) {
    return BrokerClient(baseUrl: baseUrl);
  }

  @override
  Future<HealthProbeResult> probe(Uri baseUrl) async {
    final client = _clientFactory(baseUrl.toString());
    try {
      final response = await client.getHealth();
      if (!response.ok) {
        return const HealthProbeResult.failure(
          error:
              'The server answered but reported itself unhealthy. Check '
              'the server host, then try again.',
          unhealthy: true,
        );
      }
      return HealthProbeResult.success(machine: response.machine);
    } on Object catch (e) {
      // Classified rather than dumped, matching the sibling
      // `RealBrokerAuthProbe`. A dropped connection used to surface here as
      // raw SocketException/ClientException text in the Connection screen's
      // status card.
      return HealthProbeResult.failure(
        error: userFacingMessage(e, lead: "Couldn't reach the server."),
        detail: failureDetail(e),
      );
    } finally {
      client.close();
    }
  }
}
