import 'dart:convert';
import 'dart:math';

import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:flutter/foundation.dart';

/// A random local identifier, never derived from a URL or a credential.
String newConnectionId() {
  final random = Random.secure();
  return base64Url
      .encode(List<int>.generate(18, (_) => random.nextInt(256)))
      .replaceAll('=', '');
}

/// Canonical broker origin, preserving established host/default-port shorthand.
/// Unlike the legacy normalizer this never silently discards pasted authority.
Uri canonicalBrokerOrigin(String input) {
  final raw = input.trim();
  final parsed = Uri.tryParse(raw.contains('://') ? raw : 'http://$raw');
  if (parsed == null ||
      !['http', 'https'].contains(parsed.scheme) ||
      parsed.host.isEmpty ||
      parsed.userInfo.isNotEmpty ||
      parsed.hasQuery ||
      parsed.hasFragment ||
      (parsed.path.isNotEmpty && parsed.path != '/') ||
      parsed.port < 1 ||
      parsed.port > 65535) {
    throw const FormatException(
      'Use an HTTP or HTTPS address without credentials, a path, query or '
      'fragment.',
    );
  }
  final normalized = normalizeBrokerUrl(raw);
  return Uri(
    scheme: normalized.scheme,
    host: normalized.host.toLowerCase(),
    port: normalized.port,
  );
}

/// Saved route selection policy.
enum BrokerRouteMode {
  /// Choose among enabled, verified paths using readiness and hysteresis.
  automatic,

  /// Use only the selected address, including while it is unavailable.
  fixed,
}

/// One approved destination and its device-local connection binding.
@immutable
final class BrokerAddress {
  /// Creates one explicit saved destination and its device-local path.
  const BrokerAddress({
    required this.id,
    required this.origin,
    required this.label,
    required this.order,
    this.enabled = true,
    this.generation = 1,
    this.proxyId,
    this.verifiedIdentity,
    this.legacyTrusted = false,
  });

  /// Decodes versioned local metadata without reading secure material.
  factory BrokerAddress.fromJson(Map<String, dynamic> json) => BrokerAddress(
    id: json['id'] as String,
    origin: Uri.parse(json['origin'] as String),
    label: json['label'] as String,
    order: json['order'] as int,
    enabled: json['enabled'] as bool,
    generation: json['generation'] as int,
    proxyId: json['proxyId'] as String?,
    verifiedIdentity: json['verifiedIdentity'] as String?,
    legacyTrusted: json['legacyTrusted'] as bool? ?? false,
  );

  /// Opaque device-local identifier, independent of the destination URL.
  final String id;

  /// Exact approved HTTP(S) origin for this destination.
  final Uri origin;

  /// User-facing address name, independent of routing and ownership.
  final String label;

  /// Stable tie-break order among saved addresses.
  final int order;

  /// Whether automatic or fixed selection may use this address.
  final bool enabled;

  /// Monotone configuration revision used to reject stale edits.
  final int generation;

  /// Required device-local proxy binding; null explicitly means Direct.
  final String? proxyId;

  /// Identity last verified at this exact configured origin/path.
  final String? verifiedIdentity;

  /// The previously approved single destination may keep its legacy trust.
  final bool legacyTrusted;

  /// Returns an edited address without mutating an in-flight context.
  BrokerAddress copyWith({
    String? label,
    bool? enabled,
    Uri? origin,
    String? proxyId,
    bool direct = false,
    String? verifiedIdentity,
    bool clearVerification = false,
    bool? legacyTrusted,
    int? generation,
  }) => BrokerAddress(
    id: id,
    origin: origin ?? this.origin,
    label: label ?? this.label,
    order: order,
    enabled: enabled ?? this.enabled,
    generation: generation ?? this.generation,
    proxyId: direct ? null : proxyId ?? this.proxyId,
    verifiedIdentity: clearVerification
        ? null
        : verifiedIdentity ?? this.verifiedIdentity,
    legacyTrusted: legacyTrusted ?? this.legacyTrusted,
  );

  /// Serializes non-secret metadata; credentials remain secure-store
  /// references.
  Map<String, Object?> toJson() => {
    'id': id,
    'origin': origin.toString(),
    'label': label,
    'order': order,
    'enabled': enabled,
    'generation': generation,
    'proxyId': proxyId,
    'verifiedIdentity': verifiedIdentity,
    'legacyTrusted': legacyTrusted,
  };
}

/// One logical server/access binding; routes never own drafts or messages.
@immutable
final class BrokerRouteServer {
  /// Captures one logical server/account and its immutable route list.
  BrokerRouteServer({
    required this.profileId,
    required this.incarnation,
    required this.legacyOrigin,
    required List<BrokerAddress> addresses,
    this.identityPublicKey,
    this.principalId,
    this.credentialReference,
    this.pairingReference,
    this.mode = BrokerRouteMode.automatic,
    this.fixedRouteId,
    this.lastSuccessfulRouteId,
    this.generation = 1,
  }) : addresses = List.unmodifiable(addresses);

  /// The approved original address of a newly saved or legacy server. Creating
  /// this metadata does not probe the destination or read secure credentials.
  factory BrokerRouteServer.initial({
    required String profileId,
    required String incarnation,
    required Uri origin,
    String? credentialReference,
  }) {
    final address = BrokerAddress(
      id: newConnectionId(),
      origin: Uri.parse(origin.origin),
      label: origin.host,
      order: 0,
      legacyTrusted: true,
    );
    return BrokerRouteServer(
      profileId: profileId,
      incarnation: incarnation,
      legacyOrigin: origin,
      addresses: [address],
      credentialReference: credentialReference,
      lastSuccessfulRouteId: address.id,
    );
  }

  /// Decodes versioned local metadata without reading secure material.
  factory BrokerRouteServer.fromJson(Map<String, dynamic> json) {
    if (json['version'] != 1) {
      throw StateError('A newer client is required for these addresses.');
    }
    return BrokerRouteServer(
      profileId: json['profileId'] as String,
      incarnation: json['incarnation'] as String,
      legacyOrigin: Uri.parse(json['legacyOrigin'] as String),
      addresses: (json['addresses'] as List)
          .map((a) => BrokerAddress.fromJson(a as Map<String, dynamic>))
          .toList(),
      identityPublicKey: json['identityPublicKey'] as String?,
      principalId: json['principalId'] as String?,
      credentialReference: json['credentialReference'] as String?,
      pairingReference: json['pairingReference'] as String?,
      mode: BrokerRouteMode.values.byName(json['mode'] as String),
      fixedRouteId: json['fixedRouteId'] as String?,
      lastSuccessfulRouteId: json['lastSuccessfulRouteId'] as String?,
      generation: json['generation'] as int,
    );
  }

  /// Saved local profile that owns this connection or access binding.
  final String profileId;

  /// Opaque lifetime of that profile; deletion/readdition changes it.
  final String incarnation;

  /// The previously trusted single origin retained for old-broker access.
  final Uri legacyOrigin;

  /// Immutable approved destination list; addresses do not own session data.
  final List<BrokerAddress> addresses;

  /// Pinned or verified broker identity, never a URL-derived identity.
  final String? identityPublicKey;

  /// Authenticated account/peer identity; different peers remain separate.
  final String? principalId;

  /// Stable reference to this access binding’s secure credential.
  final String? credentialReference;

  /// Opaque reference to the existing secure pairing/encryption material.
  final String? pairingReference;

  /// Automatic selection or an explicit fixed address.
  final BrokerRouteMode mode;

  /// Only permitted address in Fixed mode, even while it is unavailable.
  final String? fixedRouteId;

  /// Last committed working address, preferred during recovery.
  final String? lastSuccessfulRouteId;

  /// Monotone configuration revision used to reject stale edits.
  final int generation;

  /// Stable verified broker/account scope, independent of all address URLs.
  String? get sourceIdentity => identityPublicKey == null || principalId == null
      ? null
      : 'server:${Uri.encodeComponent(identityPublicKey!)}:'
            '${Uri.encodeComponent(principalId!)}';

  /// Returns revised metadata while keeping stable profile/source ownership.
  BrokerRouteServer copyWith({
    List<BrokerAddress>? addresses,
    String? identityPublicKey,
    String? principalId,
    String? credentialReference,
    String? pairingReference,
    BrokerRouteMode? mode,
    String? fixedRouteId,
    String? lastSuccessfulRouteId,
    int? generation,
  }) => BrokerRouteServer(
    profileId: profileId,
    incarnation: incarnation,
    legacyOrigin: legacyOrigin,
    addresses: addresses ?? this.addresses,
    identityPublicKey: identityPublicKey ?? this.identityPublicKey,
    principalId: principalId ?? this.principalId,
    credentialReference: credentialReference ?? this.credentialReference,
    pairingReference: pairingReference ?? this.pairingReference,
    mode: mode ?? this.mode,
    fixedRouteId: fixedRouteId ?? this.fixedRouteId,
    lastSuccessfulRouteId: lastSuccessfulRouteId ?? this.lastSuccessfulRouteId,
    generation: generation ?? this.generation,
  );

  /// Serializes non-secret metadata; credentials remain secure-store
  /// references.
  Map<String, Object?> toJson() => {
    'version': 1,
    'profileId': profileId,
    'incarnation': incarnation,
    'legacyOrigin': legacyOrigin.toString(),
    'addresses': addresses.map((a) => a.toJson()).toList(),
    'identityPublicKey': identityPublicKey,
    'principalId': principalId,
    'credentialReference': credentialReference,
    'pairingReference': pairingReference,
    'mode': mode.name,
    'fixedRouteId': fixedRouteId,
    'lastSuccessfulRouteId': lastSuccessfulRouteId,
    'generation': generation,
  };
}
