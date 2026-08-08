import 'dart:convert';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Dedicated secure-storage namespace for encrypted transport pairing.
const String transportPairingStorageKeyPrefix =
    'cosyncing_client.transport_pairing:';

/// Stored credentials from a successful QR v2 transport pairing.
class TransportPairingCredentials {
  /// Creates stored transport pairing credentials.
  const TransportPairingCredentials({
    required this.id,
    required this.brokerId,
    required this.brokerUrl,
    required this.localPeerId,
    required this.localPeerToken,
    required this.identityPublicKey,
    required this.identityPrivateKey,
    required this.exchangePublicKey,
    required this.exchangePrivateKey,
    required this.brokerPeerId,
    required this.brokerPeerToken,
    required this.brokerIdentityPublicKey,
    required this.dataKey,
    required this.createdAt,
  });

  /// Parses stored JSON.
  factory TransportPairingCredentials.fromJson(Map<String, dynamic> json) {
    return TransportPairingCredentials(
      id: json['id'] as String? ?? '',
      brokerId: json['brokerId'] as String? ?? '',
      brokerUrl: Uri.parse(json['brokerUrl'] as String? ?? ''),
      localPeerId: json['localPeerId'] as String? ?? '',
      localPeerToken: json['localPeerToken'] as String? ?? '',
      identityPublicKey: json['identityPublicKey'] as String? ?? '',
      identityPrivateKey: json['identityPrivateKey'] as String? ?? '',
      exchangePublicKey: json['exchangePublicKey'] as String? ?? '',
      exchangePrivateKey: json['exchangePrivateKey'] as String? ?? '',
      brokerPeerId: json['brokerPeerId'] as String? ?? '',
      brokerPeerToken: json['brokerPeerToken'] as String? ?? '',
      brokerIdentityPublicKey: json['brokerIdentityPublicKey'] as String? ?? '',
      dataKey: json['dataKey'] as String? ?? '',
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  /// Stable local storage id.
  final String id;

  /// Broker endpoint identity from the QR payload.
  final String brokerId;

  /// Pairing transport URL.
  final Uri brokerUrl;

  /// Local device peer id.
  final String localPeerId;

  /// Local device peer token.
  final String localPeerToken;

  /// Local Ed25519 public key.
  final String identityPublicKey;

  /// Local Ed25519 private key.
  final String identityPrivateKey;

  /// Local X25519 public key.
  final String exchangePublicKey;

  /// Local X25519 private key.
  final String exchangePrivateKey;

  /// Broker endpoint peer id.
  final String brokerPeerId;

  /// Broker endpoint peer token returned once from accept.
  final String brokerPeerToken;

  /// Broker Ed25519 identity public key.
  final String brokerIdentityPublicKey;

  /// Unwrapped AES-256-GCM DataKey, base64url.
  final String dataKey;

  /// Creation timestamp.
  final DateTime createdAt;

  /// Converts credentials to JSON for secure storage.
  Map<String, dynamic> toJson() => {
    'id': id,
    'brokerId': brokerId,
    'brokerUrl': brokerUrl.toString(),
    'localPeerId': localPeerId,
    'localPeerToken': localPeerToken,
    'identityPublicKey': identityPublicKey,
    'identityPrivateKey': identityPrivateKey,
    'exchangePublicKey': exchangePublicKey,
    'exchangePrivateKey': exchangePrivateKey,
    'brokerPeerId': brokerPeerId,
    'brokerPeerToken': brokerPeerToken,
    'brokerIdentityPublicKey': brokerIdentityPublicKey,
    'dataKey': dataKey,
    'createdAt': createdAt.toUtc().toIso8601String(),
  };
}

/// Storage API for transport pairing credentials.
abstract interface class TransportPairingStore {
  /// Writes [credentials] to the dedicated transport namespace.
  Future<void> write(TransportPairingCredentials credentials);

  /// Reads credentials by [id].
  Future<TransportPairingCredentials?> read(String id);

  /// Deletes credentials by [id].
  Future<void> delete(String id);
}

/// Secure-storage-backed transport pairing store.
final class SecureTransportPairingStore implements TransportPairingStore {
  /// Creates a secure transport pairing store.
  SecureTransportPairingStore({
    SecureBrokerCredentialBackend? backend,
  }) : _backend = backend ?? FlutterSecureStorageBrokerCredentialBackend();

  final SecureBrokerCredentialBackend _backend;

  static String _storageKey(String id) =>
      '$transportPairingStorageKeyPrefix${id.trim()}';

  @override
  Future<void> write(TransportPairingCredentials credentials) async {
    final id = credentials.id.trim();
    if (id.isEmpty) return;
    await _backend.write(_storageKey(id), jsonEncode(credentials.toJson()));
  }

  @override
  Future<TransportPairingCredentials?> read(String id) async {
    final normalizedId = id.trim();
    if (normalizedId.isEmpty) return null;
    final raw = await _backend.read(_storageKey(normalizedId));
    if (raw == null || raw.trim().isEmpty) return null;
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return null;
    return TransportPairingCredentials.fromJson(decoded);
  }

  @override
  Future<void> delete(String id) async {
    final normalizedId = id.trim();
    if (normalizedId.isEmpty) return;
    await _backend.delete(_storageKey(normalizedId));
  }
}

/// Provider for transport pairing storage.
final transportPairingStoreProvider = Provider<TransportPairingStore>(
  (ref) => SecureTransportPairingStore(),
);
