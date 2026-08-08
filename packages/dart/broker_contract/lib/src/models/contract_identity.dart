export 'package:broker_contract/src/models/generated_contract_identity.dart';

/// Client semantic version advertised on broker WebSocket connections.
const String cosyncingClientVersion = String.fromEnvironment(
  'COSYNCING_CLIENT_VERSION',
  defaultValue: '0.0.0-dev',
);

/// Broker-owned contract identity advertised on health, pairing, and streams.
class BrokerContractIdentity {
  /// Creates a broker contract identity.
  const BrokerContractIdentity({
    required this.revision,
    required this.minimumClientRevision,
    required this.surfaceHash,
  });

  /// Decodes a broker identity.
  factory BrokerContractIdentity.fromJson(Map<String, dynamic> json) =>
      BrokerContractIdentity(
        revision: json['revision'] as int? ?? -1,
        minimumClientRevision: json['minimumClientRevision'] as int? ?? -1,
        surfaceHash: json['surfaceHash'] as String? ?? '',
      );

  /// Broker contract revision.
  final int revision;

  /// Oldest client revision accepted by the broker.
  final int minimumClientRevision;

  /// Deterministic route/frame/message/error registry hash.
  final String surfaceHash;

  /// Converts this identity to JSON.
  Map<String, dynamic> toJson() => {
    'revision': revision,
    'minimumClientRevision': minimumClientRevision,
    'surfaceHash': surfaceHash,
  };
}

/// Client identity echoed in compatibility results.
class ClientContractIdentity {
  /// Creates a client contract identity.
  const ClientContractIdentity({
    required this.revision,
    required this.minimumBrokerRevision,
    this.surfaceHash,
  });

  /// Decodes a client identity.
  factory ClientContractIdentity.fromJson(Map<String, dynamic> json) =>
      ClientContractIdentity(
        revision: json['revision'] as int? ?? -1,
        minimumBrokerRevision: json['minimumBrokerRevision'] as int? ?? -1,
        surfaceHash: json['surfaceHash'] as String?,
      );

  /// Client contract revision.
  final int revision;

  /// Oldest broker revision the client can safely drive.
  final int minimumBrokerRevision;

  /// Optional deterministic route/frame/message/error registry hash.
  final String? surfaceHash;

  /// Converts this identity to JSON.
  Map<String, dynamic> toJson() => {
    'revision': revision,
    'minimumBrokerRevision': minimumBrokerRevision,
    if (surfaceHash != null) 'surfaceHash': surfaceHash,
  };
}

/// Negotiated broker/client compatibility state.
enum BrokerClientCompatibilityStatus {
  /// Revisions and surfaces match.
  compatible('compatible'),

  /// The client is within the supported overlap but should update.
  clientBehind('client-behind'),

  /// The broker is within the supported overlap and may be updated.
  brokerBehind('broker-behind'),

  /// The pair may only be used read-only.
  hardIncompatible('hard-incompatible'),

  /// A legacy client did not advertise contract metadata.
  unknown('unknown');

  const BrokerClientCompatibilityStatus(this.wireValue);

  /// Wire value.
  final String wireValue;

  /// Parses a forward-compatible wire value.
  static BrokerClientCompatibilityStatus parse(String? value) =>
      values.where((status) => status.wireValue == value).firstOrNull ??
      unknown;
}

/// Compatibility decision sent in the first WebSocket frame.
class BrokerClientCompatibility {
  /// Creates a compatibility decision.
  const BrokerClientCompatibility({
    required this.status,
    required this.readOnly,
    required this.reason,
    required this.broker,
    this.client,
  });

  /// Decodes a compatibility decision.
  factory BrokerClientCompatibility.fromJson(Map<String, dynamic> json) {
    final broker = json['broker'];
    final client = json['client'];
    if (broker is! Map<Object?, Object?>) {
      throw const FormatException('compatibility broker identity is required');
    }
    return BrokerClientCompatibility(
      status: BrokerClientCompatibilityStatus.parse(json['status'] as String?),
      readOnly: json['readOnly'] as bool? ?? false,
      reason: json['reason'] as String? ?? '',
      broker: BrokerContractIdentity.fromJson(
        Map<String, dynamic>.from(broker),
      ),
      client: client is Map<Object?, Object?>
          ? ClientContractIdentity.fromJson(Map<String, dynamic>.from(client))
          : null,
    );
  }

  /// Negotiated state.
  final BrokerClientCompatibilityStatus status;

  /// Whether mutating controls must be disabled.
  final bool readOnly;

  /// Human-readable broker rationale.
  final String reason;

  /// Broker identity used for the decision.
  final BrokerContractIdentity broker;

  /// Echoed client identity, absent for legacy clients.
  final ClientContractIdentity? client;

  /// Converts this decision to JSON.
  Map<String, dynamic> toJson() => {
    'status': status.wireValue,
    'readOnly': readOnly,
    'reason': reason,
    'broker': broker.toJson(),
    if (client != null) 'client': client!.toJson(),
  };
}

extension<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
