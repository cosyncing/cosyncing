import 'package:json_annotation/json_annotation.dart';

part 'error_model.g.dart';

/// Error response from the broker.
///
/// The broker returns `{ error: string }` for error responses.
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class BrokerError {
  /// Creates a [BrokerError].
  const BrokerError({
    required this.error,
    this.code,
  });

  /// Creates a [BrokerError] from a JSON map.
  factory BrokerError.fromJson(Map<String, dynamic> json) =>
      _$BrokerErrorFromJson(json);

  /// The error message.
  final String error;

  /// Optional machine-readable error code.
  ///
  /// Some broker responses include short uppercase reason codes such as
  /// `R2_DISABLED`, `CONFIRMATION_STALE`, `BAD_PARAM`, etc.
  final String? code;

  /// Converts this [BrokerError] to a JSON map.
  Map<String, dynamic> toJson() => _$BrokerErrorToJson(this);
}

/// Exception thrown when a broker REST request fails.
class BrokerException implements Exception {
  /// Creates a [BrokerException].
  const BrokerException({
    required this.message,
    this.statusCode,
    this.error,
  });

  /// The error message.
  final String message;

  /// The HTTP status code (if available).
  final int? statusCode;

  /// The broker error model (if available).
  final BrokerError? error;

  @override
  String toString() {
    final buffer = StringBuffer('BrokerException: $message');
    if (statusCode != null) buffer.write(' (status: $statusCode)');
    if (error?.code != null) buffer.write(' [${error!.code}]');
    if (error != null) buffer.write(' - ${error!.error}');
    return buffer.toString();
  }
}
