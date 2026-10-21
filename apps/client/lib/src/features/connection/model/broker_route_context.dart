import 'package:flutter/foundation.dart';

/// A device-local path to a broker. SOCKS destination names resolve remotely.
enum BrokerProxyProtocol {
  /// HTTP forwarding, with CONNECT for TLS destinations.
  http,

  /// SOCKS5 tunneling with destination DNS resolved by the proxy.
  socks5,
}

/// Non-secret proxy metadata. Passwords never enter this object or its JSON.
@immutable
final class BrokerProxyProfile {
  /// Captures one non-secret device-local proxy configuration.
  const BrokerProxyProfile({
    required this.id,
    required this.name,
    required this.protocol,
    required this.host,
    required this.port,
    required this.generation,
    this.credentialKey,
  });

  /// Decodes versioned local metadata without reading secure material.
  factory BrokerProxyProfile.fromJson(Map<String, Object?> json) =>
      BrokerProxyProfile(
        id: json['id']! as String,
        name: json['name']! as String,
        protocol: BrokerProxyProtocol.values.byName(
          json['protocol']! as String,
        ),
        host: json['host']! as String,
        port: json['port']! as int,
        generation: json['generation']! as int,
        credentialKey: json['credentialKey'] as String?,
      );

  /// Opaque device-local identifier, independent of the destination URL.
  final String id;

  /// Display name chosen on this device; contains no authentication material.
  final String name;

  /// Protocol used only for the saved proxy endpoint.
  final BrokerProxyProtocol protocol;

  /// Proxy hostname or IP literal, without URL credentials or a scheme.
  final String host;

  /// Explicit TCP port of the proxy.
  final int port;

  /// Monotone configuration revision used to reject stale edits.
  final int generation;

  /// Opaque secure-store reference; the secret is never serialized here.
  final String? credentialKey;

  /// Serializes non-secret metadata; credentials remain secure-store
  /// references.
  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'protocol': protocol.name,
    'host': host,
    'port': port,
    'generation': generation,
    'credentialKey': credentialKey,
  };
}

/// Transient secure-store material; diagnostics cannot stringify its contents.
@immutable
final class BrokerProxyCredentials {
  /// Captures secure proxy material for one connection generation.
  const BrokerProxyCredentials(this.username, this.password);

  /// Transient proxy username, read from secure storage.
  final String username;

  /// Transient proxy password, excluded from diagnostics and persistence.
  final String password;
  @override
  String toString() => 'BrokerProxyCredentials([redacted])';
}

/// Immutable authority and network configuration captured for one generation.
/// Transport pools never cross this boundary, even for equal destination URLs.
@immutable
final class BrokerRouteContext {
  /// Captures all destination and authority constraints before I/O.
  const BrokerRouteContext({
    required this.profileId,
    required this.incarnation,
    required this.origin,
    required this.routeId,
    required this.routeGeneration,
    required this.networkGeneration,
    this.identityPublicKey,
    this.principalId,
    this.authGeneration,
    this.proxyId,
    this.proxy,
    this.proxyCredentials,
  });

  /// Saved local profile that owns this connection or access binding.
  final String profileId;

  /// Opaque lifetime of that profile; deletion/readdition changes it.
  final String incarnation;

  /// Exact approved HTTP(S) origin for this destination.
  final Uri origin;

  /// Opaque saved-address identifier within this profile.
  final String routeId;

  /// Saved-address revision captured before opening any transport.
  final int routeGeneration;

  /// Network revision; observations from earlier networks cannot win.
  final int networkGeneration;

  /// Pinned or verified broker identity, never a URL-derived identity.
  final String? identityPublicKey;

  /// Authenticated account/peer identity; different peers remain separate.
  final String? principalId;

  /// Authorization revision captured for this observation or context.
  final int? authGeneration;

  /// Non-null is a requirement, including when its profile is missing.
  final String? proxyId;

  /// Non-secret proxy configuration captured with the address binding.
  final BrokerProxyProfile? proxy;

  /// Secure-store material held only by this immutable transport context.
  final BrokerProxyCredentials? proxyCredentials;

  /// Whether this address explicitly requires a native proxy path.
  bool get requiresProxy => proxyId != null;

  /// Refuses missing bindings and credentials without choosing Direct.
  void validatePath({required bool native}) {
    if (requiresProxy && !native) {
      throw const BrokerRouteException('PROXY_UNSUPPORTED');
    }
    if (!requiresProxy) {
      if (proxy != null || proxyCredentials != null) {
        throw const BrokerRouteException('PROXY_INVALID');
      }
      return;
    }
    if (proxy == null || proxy!.id != proxyId) {
      throw const BrokerRouteException('PROXY_SETUP_REQUIRED');
    }
    validateProxyEndpoint(proxy!.host, proxy!.port);
    if (proxy!.credentialKey != null && proxyCredentials == null) {
      throw const BrokerRouteException('PROXY_CREDENTIAL_REQUIRED');
    }
  }

  /// Broker credentials may only reach the origin verified for this context.
  void requireDestination(Uri target) {
    final scheme = switch (target.scheme) {
      'ws' => 'http',
      'wss' => 'https',
      final value => value,
    };
    final port = target.hasPort
        ? target.port
        : switch (scheme) {
            'https' => 443,
            'http' => 80,
            _ => target.port,
          };
    if (target.userInfo.isNotEmpty ||
        scheme != origin.scheme ||
        target.host != origin.host ||
        port != origin.port) {
      throw const BrokerRouteException('DESTINATION_NOT_VERIFIED');
    }
  }

  @override
  String toString() =>
      'BrokerRouteContext($profileId, $routeId, generation $routeGeneration)';
}

/// An observed connection stage, suitable for localized guidance.
final class BrokerRouteException implements Exception {
  /// Records an observed failure stage without embedding a secret.
  const BrokerRouteException(this.code);

  /// Stable observed-stage code, translated by the connection UI.
  final String code;
  @override
  String toString() => 'BrokerRouteException: $code';
}

/// Proxy editors accept a host and explicit port, never a pasted URL/password.
void validateProxyEndpoint(String host, int port) {
  if (host.isEmpty ||
      host != host.trim() ||
      port < 1 ||
      port > 65535 ||
      host.contains(RegExp(r'[\s/@?#\\]')) ||
      host.contains('://')) {
    throw const BrokerRouteException('PROXY_INVALID');
  }
  final parsed = Uri.tryParse(
    'http://${host.contains(':') && !host.startsWith('[') ? '[$host]' : host}:$port',
  );
  if (parsed == null ||
      parsed.host.isEmpty ||
      parsed.userInfo.isNotEmpty ||
      parsed.path.isNotEmpty) {
    throw const BrokerRouteException('PROXY_INVALID');
  }
}
