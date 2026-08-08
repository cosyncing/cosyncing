/// Coarse broker reachability/authorization outcome.
///
/// These three states are deliberately distinct because each needs different
/// UX. Conflating "broker is down" with "broker rejected your credential"
/// trains users to re-paste a credential that was never the problem.
enum BrokerGateStatus {
  /// The broker answered an authenticated request successfully.
  connected,

  /// The broker could not be reached at all (down, bad URL, DNS/network).
  ///
  /// Credentials must never be requested in this state.
  unreachable,

  /// The broker was reached and returned HTTP 401.
  unauthorized,
}

/// Why an authenticated request was rejected with HTTP 401.
///
/// The distinction matters: a missing credential is a first-run/bootstrap
/// condition, while a rejected credential means the stored secret is revoked,
/// rotated, or simply wrong and must be replaced.
enum BrokerGateCredentialIssue {
  /// No credential is stored for the active profile, but the broker wants one.
  missing,

  /// A credential was stored and sent, and the broker refused it.
  rejected,
}

/// Immutable result of a broker connection-gate probe.
///
/// See `docs/architecture/client-ui.md`.
class BrokerGateState {
  /// Creates a [BrokerGateState] directly.
  const BrokerGateState({
    required this.status,
    this.credentialIssue,
    this.machine,
    this.detail,
    this.brokerUrl,
  });

  /// The broker answered an authenticated request.
  const BrokerGateState.connected({String? machine, Uri? brokerUrl})
    : this(
        status: BrokerGateStatus.connected,
        machine: machine,
        brokerUrl: brokerUrl,
      );

  /// The broker could not be reached.
  ///
  /// [detail] carries transport diagnostics and never contains secrets.
  const BrokerGateState.unreachable({String? detail, Uri? brokerUrl})
    : this(
        status: BrokerGateStatus.unreachable,
        detail: detail,
        brokerUrl: brokerUrl,
      );

  /// The broker rejected the request with HTTP 401.
  const BrokerGateState.unauthorized({
    required BrokerGateCredentialIssue credentialIssue,
    String? detail,
    Uri? brokerUrl,
  }) : this(
         status: BrokerGateStatus.unauthorized,
         credentialIssue: credentialIssue,
         detail: detail,
         brokerUrl: brokerUrl,
       );

  /// The current gate status.
  final BrokerGateStatus status;

  /// Set only when [status] is [BrokerGateStatus.unauthorized].
  final BrokerGateCredentialIssue? credentialIssue;

  /// Machine name reported by a successful authenticated probe.
  final String? machine;

  /// Non-secret diagnostic detail for failure states.
  final String? detail;

  /// The broker endpoint the probe targeted, when known.
  final Uri? brokerUrl;

  /// Whether the app may operate normally.
  bool get isConnected => status == BrokerGateStatus.connected;

  /// Whether credential entry should be offered.
  ///
  /// Only ever true for [BrokerGateStatus.unauthorized]; an unreachable broker
  /// must not prompt for a credential.
  bool get shouldRequestCredential => status == BrokerGateStatus.unauthorized;

  /// Whether a stored credential was sent and refused.
  bool get hasRejectedCredential =>
      credentialIssue == BrokerGateCredentialIssue.rejected;

  @override
  String toString() =>
      'BrokerGateState(status: $status, credentialIssue: $credentialIssue, '
      'machine: $machine, detail: $detail, brokerUrl: $brokerUrl)';
}
