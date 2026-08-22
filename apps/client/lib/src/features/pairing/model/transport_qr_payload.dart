import 'package:broker_crypto/broker_crypto.dart';

/// Parsed secure-transport QR payload.
///
/// See `docs/architecture/client-ui.md`.
class TransportQrPayload {
  /// Creates a parsed transport QR payload.
  const TransportQrPayload({
    required this.version,
    required this.brokerId,
    required this.publicKey,
    required this.transportKind,
    required this.transportUrl,
    this.pairingId,
  });

  /// Parses `cosyncing://pair?payload=<base64url(JSON)>`.
  factory TransportQrPayload.parse(String input) {
    final parsed = QrPairingPayload.parse(input);
    return TransportQrPayload(
      version: parsed.version,
      brokerId: parsed.brokerId,
      publicKey: parsed.publicKey,
      transportKind: parsed.transport.kind,
      transportUrl: parsed.transport.url,
      pairingId: parsed.pairingId,
    );
  }

  /// QR payload version.
  final int version;

  /// Broker identity.
  final String brokerId;

  /// Broker X25519 public key.
  final String publicKey;

  /// Transport kind.
  final String transportKind;

  /// Transport URL.
  final Uri? transportUrl;

  /// One-time pairing id for v2 and v3 payloads.
  final String? pairingId;

  /// Whether this QR can be accepted without the legacy token path.
  bool get canAccept =>
      (version == 2 || version == 3) &&
      pairingId != null &&
      pairingId!.isNotEmpty;
}
