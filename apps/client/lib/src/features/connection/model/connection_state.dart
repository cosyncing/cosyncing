import 'package:cosyncing_client/src/errors/user_facing_error.dart';

/// Connection lifecycle states for the broker connection flow.
enum ConnectionStatus {
  /// No connection attempt has been made yet.
  idle,

  /// A health probe is in progress.
  validating,

  /// The health probe succeeded — broker is reachable.
  success,

  /// The health probe failed.
  failure,
}

/// User-relevant reason a connection attempt failed.
enum ConnectionFailureKind {
  /// The entered address could not be normalized or validated.
  invalidAddress,

  /// The broker answered but reported an unhealthy state.
  brokerUnhealthy,

  /// No usable broker response was received.
  unreachable,
}

/// Immutable state for the broker connection flow.
class ConnectionStateModel {
  /// Creates a [ConnectionStateModel].
  ConnectionStateModel({
    this.status = ConnectionStatus.idle,
    this.brokerUrl,
    this.machine,
    this.failureKind,
    String? technicalDetail,
  }) : technicalDetail = boundedTechnicalDetail(technicalDetail);

  /// The current connection status.
  final ConnectionStatus status;

  /// The normalized broker URL being tested, if any.
  final Uri? brokerUrl;

  /// The machine name from a successful health probe.
  final String? machine;

  /// Typed failure used to choose localized primary copy.
  final ConnectionFailureKind? failureKind;

  /// Bounded raw diagnostic for an explicit technical-details disclosure.
  final String? technicalDetail;

  /// Returns a copy with optional overrides.
  ConnectionStateModel copyWith({
    ConnectionStatus? status,
    Uri? brokerUrl,
    String? machine,
    ConnectionFailureKind? failureKind,
    String? technicalDetail,
  }) {
    return ConnectionStateModel(
      status: status ?? this.status,
      brokerUrl: brokerUrl ?? this.brokerUrl,
      machine: machine ?? this.machine,
      failureKind: failureKind ?? this.failureKind,
      technicalDetail: technicalDetail ?? this.technicalDetail,
    );
  }

  @override
  String toString() =>
      'ConnectionStateModel(status: $status, brokerUrl: $brokerUrl, '
      'machine: $machine, failureKind: $failureKind)';
}
