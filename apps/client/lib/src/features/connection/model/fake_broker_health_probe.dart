import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/health_probe_result.dart';

/// A fake [BrokerHealthProbe] for testing and development.
///
/// Configurable to return success or failure, with an optional delay
/// to simulate network latency.
class FakeBrokerHealthProbe implements BrokerHealthProbe {
  /// Creates a [FakeBrokerHealthProbe].
  ///
  /// [shouldSucceed] controls whether the probe returns success or failure.
  /// [delay] simulates network latency (defaults to 300ms).
  /// [machineName] is the machine name returned on success.
  FakeBrokerHealthProbe({
    this.shouldSucceed = true,
    this.delay = const Duration(milliseconds: 300),
    this.machineName = 'dev-machine',
  });

  /// Whether the probe should succeed.
  bool shouldSucceed;

  /// Simulated network latency.
  Duration delay;

  /// Machine name returned on success.
  String machineName;

  /// Number of times [probe] has been called.
  int probeCount = 0;

  @override
  Future<HealthProbeResult> probe(Uri baseUrl) async {
    probeCount++;
    await Future<void>.delayed(delay);
    if (shouldSucceed) {
      return HealthProbeResult.success(machine: machineName);
    }
    return const HealthProbeResult.failure(
      error: LocalizedFailure.notice(FailureLead.reachServer),
      detail: 'Connection refused — is the server running?',
    );
  }
}
