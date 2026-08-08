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

  /// Plain-language error message if the probe failed.
  ///
  /// Safe to render directly: it names what happened and what to do next, and
  /// never contains exception text.
  final String? error;

  /// Raw, untranslated diagnostic for a "Technical details" disclosure.
  final String? detail;

  /// Whether the broker answered but failed its own health check.
  final bool unhealthy;

  @override
  String toString() => isSuccess
      ? 'HealthProbeResult.success(machine: $machine)'
      : 'HealthProbeResult.failure(error: $error)';
}
