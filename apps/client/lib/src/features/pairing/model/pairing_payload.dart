import 'dart:convert';

import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';

/// Parsed payload for pairing inputs.
///
/// Supports:
/// - JSON object: `{"brokerUrl": "https://host:9443", "token": "abc"}`
/// - JSON aliases: `brokerUrl`, `baseUrl`, `url`
/// - URI form: `cosyncing://pair?brokerUrl=...&token=...`
/// - Raw broker URL input (for direct paste)
class PairingPayload {
  /// Creates a parsed and normalized pairing payload.
  const PairingPayload({
    required this.brokerUrl,
    this.token,
    this.displayName,
  });

  /// Parses a free-form scanner/pairing payload.
  factory PairingPayload.parse(String rawInput) {
    final trimmedInput = rawInput.trim();
    if (trimmedInput.isEmpty) {
      throw const PairingPayloadParseException(
        'Pairing payload cannot be empty.',
      );
    }

    if (trimmedInput.startsWith('{')) {
      try {
        final decoded = jsonDecode(trimmedInput);
        if (decoded is! Map<String, Object?>) {
          throw const PairingPayloadParseException(
            'Pairing payload JSON must be an object with brokerUrl fields.',
          );
        }
        return PairingPayload._fromMap(decoded);
      } on PairingPayloadParseException {
        rethrow;
      } on FormatException {
        throw const PairingPayloadParseException(
          'Invalid pairing JSON payload.',
        );
      }
    }

    final uri = Uri.tryParse(trimmedInput);
    if (uri == null) {
      throw const PairingPayloadParseException('Invalid pairing text.');
    }

    if (uri.scheme == 'cosyncing' && uri.host == 'pair') {
      return PairingPayload._fromMap(uri.queryParameters);
    }

    return PairingPayload._fromBrokerUrl(trimmedInput);
  }

  factory PairingPayload._fromMap(Map<String, Object?> map) {
    final brokerUrl = _readBrokerUrl(map);
    if (brokerUrl == null) {
      throw const PairingPayloadParseException(
        'Missing brokerUrl, baseUrl, or url in pairing payload.',
      );
    }

    final token = _readString(map, 'token');
    final tokenValue = token?.trim();
    final displayName = _readString(map, 'displayName');

    return PairingPayload(
      brokerUrl: brokerUrl,
      token: tokenValue != null && tokenValue.isNotEmpty ? tokenValue : null,
      displayName: displayName == null || displayName.trim().isEmpty
          ? null
          : displayName.trim(),
    );
  }

  factory PairingPayload._fromBrokerUrl(String value) {
    final normalized = _normalizeBrokerUrl(value);
    return PairingPayload(brokerUrl: normalized);
  }

  /// Canonicalized broker URL.
  final Uri brokerUrl;

  /// Optional token from pairing payload.
  final String? token;

  /// Optional display name from pairing payload.
  final String? displayName;

  /// True when a non-blank token exists in the payload.
  bool get hasToken => token != null && token!.trim().isNotEmpty;
}

/// A parse-time failure for pairing payloads.
///
/// Carries a short human-readable message suitable for parser users.
class PairingPayloadParseException implements Exception {
  /// Creates a [PairingPayloadParseException].
  const PairingPayloadParseException(this.message);

  /// Human-readable parse error.
  final String message;

  @override
  String toString() => message;
}

Uri _normalizeBrokerUrl(String input) {
  final Uri uri;
  try {
    uri = normalizeBrokerUrl(input);
  } on FormatException catch (error) {
    throw PairingPayloadParseException(error.message);
  }

  final errors = validateBrokerUrl(uri);
  if (errors.isNotEmpty) {
    throw PairingPayloadParseException(errors.join('; '));
  }
  return uri;
}

String? _readString(Map<String, Object?> map, String key) {
  final value = map[key];
  if (value == null) {
    return null;
  }
  if (value is String) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return null;
    }
    return trimmed;
  }

  throw PairingPayloadParseException('Expected "$key" to be a string.');
}

Uri? _readBrokerUrl(Map<String, Object?> map) {
  final candidate =
      _readString(map, 'brokerUrl') ??
      _readString(map, 'baseUrl') ??
      _readString(map, 'url');
  if (candidate == null) {
    return null;
  }

  return _normalizeBrokerUrl(candidate);
}
