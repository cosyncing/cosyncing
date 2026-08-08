import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:meta/meta.dart';

const _wrapInfo = 'cosyncing-datakey-wrap-v1';
const _wrapAad = 'cosyncing-datakey';

const _ed25519SpkiPrefix = <int>[
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
];
const _ed25519Pkcs8Prefix = <int>[
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
];
const _x25519SpkiPrefix = <int>[
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x6e,
  0x03,
  0x21,
  0x00,
];
const _x25519Pkcs8Prefix = <int>[
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x6e,
  0x04,
  0x22,
  0x04,
  0x20,
];

/// Base64url encodes bytes without padding, matching Node's `base64url`.
String base64UrlNoPadding(List<int> bytes) {
  return base64UrlEncode(bytes).replaceAll('=', '');
}

/// Base64url decodes padded or unpadded input.
Uint8List base64UrlDecodeNoPadding(String value) {
  final normalized = value.padRight(
    value.length + ((4 - value.length % 4) % 4),
    '=',
  );
  return Uint8List.fromList(base64Url.decode(normalized));
}

/// QR pairing transport descriptor.
@immutable
class PairingTransport {
  /// Creates a transport descriptor.
  const PairingTransport({required this.kind, required this.url, this.mailbox});

  /// Parses broker JSON.
  factory PairingTransport.fromJson(Map<String, Object?> json) {
    final kind = json['kind'] as String?;
    final rawUrl = json['url'] as String?;
    if (kind == null || kind.isEmpty) {
      throw const PairingCryptoException('pairing transport kind is required');
    }
    if (rawUrl == null || rawUrl.isEmpty) {
      throw const PairingCryptoException('pairing transport URL is required');
    }
    final url = Uri.tryParse(rawUrl);
    if (url == null || !url.hasScheme || url.host.isEmpty) {
      throw const PairingCryptoException('pairing transport URL is invalid');
    }
    if (kind == 'relay') {
      final mailbox = json['mailbox'] as String?;
      if (mailbox == null || mailbox.isEmpty) {
        throw const PairingCryptoException('relay pairing mailbox is required');
      }
      return PairingTransport(kind: kind, url: url, mailbox: mailbox);
    }
    if (kind != 'tailscale-direct') {
      throw const PairingCryptoException('unsupported pairing transport');
    }
    return PairingTransport(kind: kind, url: url);
  }

  /// Transport kind.
  final String kind;

  /// Transport base URL.
  final Uri url;

  /// Relay mailbox id, when kind is `relay`.
  final String? mailbox;
}

/// Broker QR pairing payload.
@immutable
class QrPairingPayload {
  /// Creates a QR payload.
  const QrPairingPayload({
    required this.version,
    required this.brokerId,
    required this.publicKey,
    required this.transport,
    this.pairingId,
  });

  /// Parses `cosyncing://pair?payload=<base64url(JSON)>`.
  factory QrPairingPayload.parse(String input) {
    final uri = Uri.tryParse(input.trim());
    if (uri == null || uri.scheme != 'cosyncing' || uri.host != 'pair') {
      throw const PairingCryptoException('not a cosyncing pairing payload');
    }
    final encoded = uri.queryParameters['payload'];
    if (encoded == null || encoded.isEmpty) {
      throw const PairingCryptoException('pairing payload is missing');
    }
    final decoded = jsonDecode(utf8.decode(base64UrlDecodeNoPadding(encoded)));
    if (decoded is! Map<String, Object?>) {
      throw const PairingCryptoException('pairing payload must be an object');
    }
    return QrPairingPayload.fromJson(decoded);
  }

  /// Parses broker JSON.
  factory QrPairingPayload.fromJson(Map<String, Object?> json) {
    final version = json['version'];
    final brokerId = json['brokerId'] as String?;
    final publicKey = json['publicKey'] as String?;
    final transport = json['transport'];
    final pairingId = json['pairingId'] as String?;
    if (version is! int || (version != 1 && version != 2)) {
      throw const PairingCryptoException('unsupported pairing payload version');
    }
    if (brokerId == null || brokerId.isEmpty) {
      throw const PairingCryptoException(
        'pairing payload brokerId is required',
      );
    }
    if (publicKey == null || publicKey.isEmpty) {
      throw const PairingCryptoException(
        'pairing payload publicKey is required',
      );
    }
    if (transport is! Map<String, Object?>) {
      throw const PairingCryptoException(
        'pairing payload transport is required',
      );
    }
    if (version == 2 && (pairingId == null || pairingId.isEmpty)) {
      throw const PairingCryptoException(
        'pairing payload pairingId is required',
      );
    }
    return QrPairingPayload(
      version: version,
      brokerId: brokerId,
      publicKey: publicKey,
      transport: PairingTransport.fromJson(transport),
      pairingId: pairingId,
    );
  }

  /// Payload version.
  final int version;

  /// Broker identity.
  final String brokerId;

  /// Broker public X25519 key.
  final String publicKey;

  /// Transport descriptor.
  final PairingTransport transport;

  /// One-time pairing id for v2 payloads.
  final String? pairingId;

  /// Whether this payload can be accepted without the legacy token path.
  bool get canAccept =>
      version == 2 && pairingId != null && pairingId!.isNotEmpty;
}

/// Ed25519 identity keypair exported as DER base64url.
@immutable
class IdentityKeyPair {
  /// Creates an identity keypair.
  const IdentityKeyPair({
    required this.publicKey,
    required this.privateKey,
    this.algorithm = 'Ed25519',
  });

  /// Algorithm label.
  final String algorithm;

  /// SPKI DER, base64url without padding.
  final String publicKey;

  /// PKCS8 DER, base64url without padding.
  final String privateKey;
}

/// X25519 exchange keypair exported as DER base64url.
@immutable
class X25519KeyPair {
  /// Creates an X25519 keypair.
  const X25519KeyPair({required this.publicKey, required this.privateKey});

  /// SPKI DER, base64url without padding.
  final String publicKey;

  /// PKCS8 DER, base64url without padding.
  final String privateKey;
}

/// Broker wrapped DataKey.
@immutable
class WrappedDataKey {
  /// Creates a wrapped data key.
  const WrappedDataKey({
    required this.version,
    required this.algorithm,
    required this.ephemeralPublicKey,
    required this.nonce,
    required this.ciphertext,
    required this.tag,
  });

  /// Parses broker JSON.
  factory WrappedDataKey.fromJson(Map<String, Object?> json) {
    return WrappedDataKey(
      version: json['version'] as int? ?? 0,
      algorithm: json['algorithm'] as String? ?? '',
      ephemeralPublicKey: json['ephemeralPublicKey'] as String? ?? '',
      nonce: json['nonce'] as String? ?? '',
      ciphertext: json['ciphertext'] as String? ?? '',
      tag: json['tag'] as String? ?? '',
    );
  }

  /// Version.
  final int version;

  /// Algorithm.
  final String algorithm;

  /// Ephemeral X25519 public key, SPKI DER base64url.
  final String ephemeralPublicKey;

  /// AES-GCM nonce, base64url.
  final String nonce;

  /// AES-GCM ciphertext, base64url.
  final String ciphertext;

  /// AES-GCM tag, base64url.
  final String tag;
}

/// Pairing crypto helpers.
abstract final class PairingCrypto {
  static final _ed25519 = Ed25519();
  static final _x25519 = X25519();
  static final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  static final _aesGcm = AesGcm.with256bits();
  static final _random = Random.secure();

  /// Generates an Ed25519 identity keypair.
  static Future<IdentityKeyPair> generateIdentityKeyPair() async {
    final keyPair = await _ed25519.newKeyPair();
    final data = await keyPair.extract();
    final publicKey = await keyPair.extractPublicKey();
    return IdentityKeyPair(
      publicKey: base64UrlNoPadding(
        _wrapDer(_ed25519SpkiPrefix, publicKey.bytes),
      ),
      privateKey: base64UrlNoPadding(_wrapDer(_ed25519Pkcs8Prefix, data.bytes)),
    );
  }

  /// Generates an X25519 exchange keypair.
  static Future<X25519KeyPair> generateExchangeKeyPair() async {
    final keyPair = await _x25519.newKeyPair();
    final data = await keyPair.extract();
    final publicKey = await keyPair.extractPublicKey();
    return X25519KeyPair(
      publicKey: base64UrlNoPadding(
        _wrapDer(_x25519SpkiPrefix, publicKey.bytes),
      ),
      privateKey: base64UrlNoPadding(_wrapDer(_x25519Pkcs8Prefix, data.bytes)),
    );
  }

  /// Wraps a 32-byte data key for a peer.
  ///
  /// The app's production QR accept flow only needs [unwrapDataKey]; this
  /// helper exists to keep broker-compatible round-trip/reference tests local
  /// to the Dart package.
  static Future<WrappedDataKey> wrapDataKeyForPeer({
    required List<int> dataKey,
    required String recipientPublicKey,
  }) async {
    _checkDataKey(dataKey);
    final ephemeral = await _x25519.newKeyPair();
    final ephemeralData = await ephemeral.extract();
    final ephemeralPublic = await ephemeral.extractPublicKey();
    final remotePublic = SimplePublicKey(
      _unwrapDer(recipientPublicKey, _x25519SpkiPrefix),
      type: KeyPairType.x25519,
    );
    final shared = await _x25519.sharedSecretKey(
      keyPair: SimpleKeyPairData(
        ephemeralData.bytes,
        publicKey: ephemeralPublic,
        type: KeyPairType.x25519,
      ),
      remotePublicKey: remotePublic,
    );
    final wrapKey = await _deriveWrapKey(shared);
    final nonce = _randomBytes(12);
    final box = await _aesGcm.encrypt(
      dataKey,
      secretKey: SecretKey(wrapKey),
      nonce: nonce,
      aad: utf8.encode(_wrapAad),
    );
    return WrappedDataKey(
      version: 1,
      algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
      ephemeralPublicKey: base64UrlNoPadding(
        _wrapDer(_x25519SpkiPrefix, ephemeralPublic.bytes),
      ),
      nonce: base64UrlNoPadding(box.nonce),
      ciphertext: base64UrlNoPadding(box.cipherText),
      tag: base64UrlNoPadding(box.mac.bytes),
    );
  }

  /// Unwraps a broker `WrappedDataKey`.
  static Future<List<int>> unwrapDataKey(
    WrappedDataKey wrapped, {
    required String recipientPrivateKey,
  }) async {
    if (wrapped.version != 1) {
      throw const PairingCryptoException('unsupported wrapped key version');
    }
    if (wrapped.algorithm != 'X25519-HKDF-SHA256-AES-256-GCM') {
      throw const PairingCryptoException('unsupported wrapped key algorithm');
    }
    final privateBytes = _unwrapDer(recipientPrivateKey, _x25519Pkcs8Prefix);
    final keyPair = await _x25519.newKeyPairFromSeed(privateBytes);
    final publicKey = await keyPair.extractPublicKey();
    final shared = await _x25519.sharedSecretKey(
      keyPair: SimpleKeyPairData(
        privateBytes,
        publicKey: publicKey,
        type: KeyPairType.x25519,
      ),
      remotePublicKey: SimplePublicKey(
        _unwrapDer(wrapped.ephemeralPublicKey, _x25519SpkiPrefix),
        type: KeyPairType.x25519,
      ),
    );
    final wrapKey = await _deriveWrapKey(shared);
    final plaintext = await _aesGcm.decrypt(
      SecretBox(
        base64UrlDecodeNoPadding(wrapped.ciphertext),
        nonce: base64UrlDecodeNoPadding(wrapped.nonce),
        mac: Mac(base64UrlDecodeNoPadding(wrapped.tag)),
      ),
      secretKey: SecretKey(wrapKey),
      aad: utf8.encode(_wrapAad),
    );
    _checkDataKey(plaintext);
    return plaintext;
  }

  static Future<List<int>> _deriveWrapKey(SecretKey shared) async {
    final key = await _hkdf.deriveKey(
      secretKey: shared,
      // The broker reference uses HKDF salt = empty bytes.
      // ignore: avoid_redundant_argument_values
      nonce: const <int>[],
      info: utf8.encode(_wrapInfo),
    );
    return key.extractBytes();
  }

  static Uint8List _randomBytes(int length) {
    return Uint8List.fromList(
      List<int>.generate(length, (_) => _random.nextInt(256)),
    );
  }
}

/// Pairing crypto parse/validation failure.
class PairingCryptoException implements Exception {
  /// Creates a failure.
  const PairingCryptoException(this.message);

  /// Human-readable message.
  final String message;

  @override
  String toString() => message;
}

Uint8List _wrapDer(List<int> prefix, List<int> raw) {
  return Uint8List.fromList([...prefix, ...raw]);
}

Uint8List _unwrapDer(String encoded, List<int> expectedPrefix) {
  final bytes = base64UrlDecodeNoPadding(encoded);
  if (bytes.length != expectedPrefix.length + 32) {
    throw const PairingCryptoException('DER key has invalid length');
  }
  for (var index = 0; index < expectedPrefix.length; index += 1) {
    if (bytes[index] != expectedPrefix[index]) {
      throw const PairingCryptoException('DER key has invalid prefix');
    }
  }
  return Uint8List.sublistView(bytes, expectedPrefix.length);
}

void _checkDataKey(List<int> dataKey) {
  if (dataKey.length != 32) {
    throw const PairingCryptoException('AES-256-GCM data key must be 32 bytes');
  }
}
