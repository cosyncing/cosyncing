import 'package:cosyncing_client/src/errors/user_facing_error.dart';

/// Result of a broker health probe.
///
/// The health probe is the first step in verifying a broker is reachable.
/// Real implementations call `BrokerClient.getHealth()`;
/// fake implementations support offline and unit-test flows.
class HealthProbeResult {
  /// Creates a [HealthProbeResult].
  const HealthProbeResult({
    required this.isSuccess,
    this.machine,
    this.error,
    this.detail,
    this.unhealthy = false,
  });

  /// Creates a successful result.
  const HealthProbeResult.success({this.machine})
    : isSuccess = true,
      error = null,
      detail = null,
      unhealthy = false;

  /// Creates a failure result.
  const HealthProbeResult.failure({
    required this.error,
    this.detail,
    this.unhealthy = false,
  }) : isSuccess = false,
       machine = null;

  /// Whether the probe succeeded.
  final bool isSuccess;

  /// The machine name reported by the broker, if available.
  final String? machine;

  /// Classified failure if the probe failed.
  ///
  /// Typed rather than a finished sentence so the Connection screen renders it
  /// in the active locale. Raw exception text stays in [detail] and in
  /// [LocalizedFailure.detail]; it is never the primary copy.
  final LocalizedFailure? error;

  /// Raw, untranslated diagnostic for a "Technical details" disclosure.
  final String? detail;

  /// Whether the broker answered but failed its own health check.
  final bool unhealthy;

  @override
  String toString() => isSuccess
      ? 'HealthProbeResult.success(machine: $machine)'
      : 'HealthProbeResult.failure(error: $error)';
}
