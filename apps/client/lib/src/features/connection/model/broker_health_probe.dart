import 'package:cosyncing_client/src/features/connection/model/health_probe_result.dart';

/// How long a connection probe (the Connect health check, the gate's
/// authenticated check) waits for the server's answer.
///
/// A server that accepts the connection and never answers used to leave the
/// probe, and the screen showing it, waiting forever. Past this the probe
/// reports that the server did not answer, and the screen offers Retry.
const Duration brokerProbeTimeout = Duration(seconds: 10);

/// Interface for probing a broker's health endpoint.
///
/// Implementations can be fake (for tests) or real (via
/// `BrokerClient.getHealth()`).
///
/// Deliberately an abstract class (not a typedef) so it can be used as a
/// Riverpod provider type and overridden in tests with a fake implementation.
// ignore: one_member_abstracts
abstract class BrokerHealthProbe {
  /// Probes the broker at [baseUrl] and returns a [HealthProbeResult].
  ///
  /// The [baseUrl] should be a normalized broker URL (scheme + host + port).
  Future<HealthProbeResult> probe(Uri baseUrl);
}
