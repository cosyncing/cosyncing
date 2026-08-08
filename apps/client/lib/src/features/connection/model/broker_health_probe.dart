import 'package:cosyncing_client/src/features/connection/model/health_probe_result.dart';

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
