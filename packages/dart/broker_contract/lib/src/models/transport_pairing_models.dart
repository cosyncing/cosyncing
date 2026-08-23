/// Typed models for broker transport pairing accept responses.
///
/// Mirrors the broker W11 accept route in
/// `packages/typescript/broker/src/transport/transport-pairing.ts`:
/// `POST /api/transport/pairings/:id/accept`.
///
/// Governing doc: docs/protocol/contract-sync.md
library;

/// Request body for accepting a one-time transport pairing.
class TransportPairingAcceptRequest {
  /// Creates a pairing accept request.
  const TransportPairingAcceptRequest({
    required this.peerId,
    required this.peerToken,
    required this.identityPublicKey,
    required this.exchangePublicKey,
  });

  /// Local client peer id.
  final String peerId;

  /// Local random peer token.
  final String peerToken;

  /// Local Ed25519 identity public key, DER SPKI base64url.
  final String identityPublicKey;

  /// Local X25519 exchange public key, DER SPKI base64url.
  final String exchangePublicKey;

  /// Converts this request to broker JSON.
  Map<String, dynamic> toJson() => {
    'peerId': peerId,
    'peerToken': peerToken,
    'identityPublicKey': identityPublicKey,
    'exchangePublicKey': exchangePublicKey,
  };
}

/// Peer descriptor returned by transport pairing accept.
class TransportPairingPeer {
  /// Creates a peer descriptor.
  const TransportPairingPeer({
    required this.peerId,
    required this.identityPublicKey,
    this.label,
    this.peerToken,
  });

  /// Parses broker JSON, tolerating additive fields.
  factory TransportPairingPeer.fromJson(Map<String, dynamic> json) {
    return TransportPairingPeer(
      peerId: json['peerId'] as String? ?? '',
      identityPublicKey: json['identityPublicKey'] as String? ?? '',
      label: json['label'] as String?,
      peerToken: json['peerToken'] as String?,
    );
  }

  /// Peer id.
  final String peerId;

  /// Public Ed25519 identity key.
  final String identityPublicKey;

  /// Optional user-facing label.
  final String? label;

  /// Plaintext peer token, returned only for the broker endpoint.
  final String? peerToken;
}

/// Wrapped DataKey returned by transport pairing accept.
class TransportWrappedDataKey {
  /// Creates a wrapped DataKey.
  const TransportWrappedDataKey({
    required this.version,
    required this.algorithm,
    required this.ephemeralPublicKey,
    required this.nonce,
    required this.ciphertext,
    required this.tag,
  });

  /// Parses broker JSON, tolerating additive fields.
  factory TransportWrappedDataKey.fromJson(Map<String, dynamic> json) {
    return TransportWrappedDataKey(
      version: json['version'] as int? ?? 0,
      algorithm: json['algorithm'] as String? ?? '',
      ephemeralPublicKey: json['ephemeralPublicKey'] as String? ?? '',
      nonce: json['nonce'] as String? ?? '',
      ciphertext: json['ciphertext'] as String? ?? '',
      tag: json['tag'] as String? ?? '',
    );
  }

  /// Wrap format version.
  final int version;

  /// Wrap algorithm.
  final String algorithm;

  /// Ephemeral X25519 public key, DER SPKI base64url.
  final String ephemeralPublicKey;

  /// AES-GCM nonce, base64url.
  final String nonce;

  /// AES-GCM ciphertext, base64url.
  final String ciphertext;

  /// AES-GCM tag, base64url.
  final String tag;
}

/// Broker proof that the answering endpoint owns the QR identity key.
class TransportPairingProof {
  /// Creates a broker acceptance proof.
  const TransportPairingProof({
    required this.version,
    required this.algorithm,
    required this.signature,
  });

  /// Parses broker JSON.
  factory TransportPairingProof.fromJson(Map<String, dynamic> json) {
    return TransportPairingProof(
      version: json['version'] as int? ?? 0,
      algorithm: json['algorithm'] as String? ?? '',
      signature: json['signature'] as String? ?? '',
    );
  }

  /// Proof format version.
  final int version;

  /// Signature algorithm.
  final String algorithm;

  /// Base64url Ed25519 signature.
  final String signature;
}

/// Response body for accepting a one-time transport pairing.
class TransportPairingAcceptResponse {
  /// Creates a pairing accept response.
  const TransportPairingAcceptResponse({
    required this.peer,
    required this.broker,
    required this.wrappedDataKey,
    required this.brokerProof,
  });

  /// Parses broker JSON, tolerating the wrapper `ok` key and additive fields.
  factory TransportPairingAcceptResponse.fromJson(Map<String, dynamic> json) {
    return TransportPairingAcceptResponse(
      peer: TransportPairingPeer.fromJson(
        json['peer'] as Map<String, dynamic>? ?? const <String, dynamic>{},
      ),
      broker: TransportPairingPeer.fromJson(
        json['broker'] as Map<String, dynamic>? ?? const <String, dynamic>{},
      ),
      wrappedDataKey: TransportWrappedDataKey.fromJson(
        json['wrappedDataKey'] as Map<String, dynamic>? ??
            const <String, dynamic>{},
      ),
      brokerProof: TransportPairingProof.fromJson(
        json['brokerProof'] as Map<String, dynamic>? ??
            const <String, dynamic>{},
      ),
    );
  }

  /// Local client peer as persisted by the broker.
  final TransportPairingPeer peer;

  /// Broker endpoint peer, including the one-time returned peer token.
  final TransportPairingPeer broker;

  /// DataKey wrapped to the client's exchange public key.
  final TransportWrappedDataKey wrappedDataKey;

  /// Proof signed by the identity public key committed in the QR.
  final TransportPairingProof brokerProof;
}
