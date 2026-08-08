import 'package:broker_contract/src/models/contract_identity.dart';
import 'package:json_annotation/json_annotation.dart';

part 'health_response.g.dart';

/// Response from the broker's `/api/health` endpoint.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable(explicitToJson: true)
class HealthResponse {
  /// Creates a [HealthResponse].
  const HealthResponse({
    required this.ok,
    this.product,
    this.version,
    this.contract,
    this.machine,
    this.controlMode,
    this.codexSyncServer,
    this.healthStatus,
    this.healthCheckedAt,
  });

  /// Creates a [HealthResponse] from a JSON map.
  factory HealthResponse.fromJson(Map<String, dynamic> json) =>
      _$HealthResponseFromJson(json);

  /// Whether the broker is healthy.
  final bool ok;

  /// Public broker product identity.
  final String? product;

  /// Running broker semantic version.
  final String? version;

  /// Broker-owned wire-contract identity.
  final BrokerContractIdentity? contract;

  /// The machine hostname the broker is running on.
  final String? machine;

  /// Legacy derived control mode label.
  final String? controlMode;

  /// Whether Codex sync server is enabled.
  @JsonKey(name: 'codexSyncServer')
  final bool? codexSyncServer;

  /// Broker health status from `/api/health` for this broker host.
  @JsonKey(name: 'healthStatus')
  final String? healthStatus;

  /// Broker health check timestamp from `/api/health` in epoch ms.
  @JsonKey(name: 'healthCheckedAt')
  final int? healthCheckedAt;

  /// Converts this [HealthResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$HealthResponseToJson(this);
}
