/// URL normalization and validation for broker endpoints.
///
/// Converts raw user input (full URL, host:port, or bare host) into a
/// normalized [Uri] suitable for storage in a broker profile.
library;

/// Normalizes a broker endpoint string into a canonical [Uri].
///
/// Accepts:
/// - Full URL: `http://192.168.1.10:7734`
/// - Host and port: `192.168.1.10:7734`
/// - Bare host: `192.168.1.10` (defaults to port 7734, scheme http)
/// - Localhost shorthand: `localhost` → `http://127.0.0.1:7734`
///
/// Throws [FormatException] if the input cannot be parsed into a valid
/// broker URL.
Uri normalizeBrokerUrl(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) {
    throw const FormatException('Broker URL cannot be empty');
  }

  // Handle bare localhost shorthand.
  if (trimmed == 'localhost' || trimmed == '127.0.0.1' || trimmed == '::1') {
    return Uri(scheme: 'http', host: '127.0.0.1', port: _defaultPort);
  }

  // Try parsing as a full URL first.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final uri = Uri.parse(trimmed);
    if (uri.host.isEmpty) {
      throw FormatException('Invalid URL: no host in "$trimmed"');
    }
    // Check if the user explicitly provided a port. Dart's Uri.port returns
    // the scheme default (80/443) even when no port was specified, so we
    // inspect the raw string.
    final hasExplicitPort = _urlHasExplicitPort(trimmed);
    // Build a clean base URI: scheme + host + port only.
    // Strip path, query, and fragment — broker base URL is host:port only.
    return Uri(
      scheme: uri.scheme,
      host: uri.host,
      port: hasExplicitPort ? uri.port : _defaultPort,
    );
  }

  // Try host:port format.
  final hostPortMatch = _hostPortPattern.matchAsPrefix(trimmed);
  if (hostPortMatch != null && hostPortMatch.end == trimmed.length) {
    final host = hostPortMatch.group(1)!;
    final port = int.parse(hostPortMatch.group(2)!);
    return Uri(scheme: 'http', host: host, port: port);
  }

  // Try bare host (IP or hostname).
  if (_bareHostPattern.hasMatch(trimmed)) {
    return Uri(scheme: 'http', host: trimmed, port: _defaultPort);
  }

  throw FormatException(
    'Cannot parse "$trimmed" as a broker URL. '
    'Expected: http://host:port, host:port, or host',
  );
}

/// Derives a canonical broker base [Uri] from a page/origin [uri].
///
/// Used for the web same-origin default: when the Flutter app is served by the
/// broker itself (e.g. from `http://127.0.0.1:7734/cosy/`), the broker base URL
/// is simply the page's origin. This strips path, query, and fragment while
/// preserving the real scheme and any explicit port.
///
/// Unlike [normalizeBrokerUrl], this does NOT force the default broker port
/// (7734) when no port is present: a portless `https://host` origin must stay
/// portless so downstream WebSocket derivation resolves to `wss://host`
/// (implicit 443) rather than `wss://host:7734`.
Uri brokerBaseFromOrigin(Uri uri) {
  return Uri(
    scheme: uri.scheme,
    host: uri.host,
    // Preserve an explicit port only; a null port keeps the scheme default
    // (80/443) implicit so it is not serialized into the base URL.
    port: uri.hasPort ? uri.port : null,
  );
}

/// Validates that [uri] is a plausible broker endpoint.
///
/// Returns a list of validation error messages. An empty list means valid.
List<String> validateBrokerUrl(Uri uri) {
  final errors = <String>[];

  if (uri.host.isEmpty) {
    errors.add('Host is required');
  }

  if (uri.port < 1 || uri.port > 65535) {
    errors.add('Port must be between 1 and 65535');
  }

  if (uri.scheme != 'http' && uri.scheme != 'https') {
    errors.add('Scheme must be http or https');
  }

  return errors;
}

/// The default broker port.
const _defaultPort = 7734;

/// Matches `host:port` where host is an IP or hostname.
final _hostPortPattern = RegExp(r'^([^:]+):(\d+)$');

/// Matches a bare host (IPv4, IPv6 bracket notation, or hostname).
final _bareHostPattern = RegExp(
  r'^(\[?[a-zA-Z0-9\.\-]+\]?|(\d{1,3}\.){3}\d{1,3}|[a-fA-F0-9:]+)$',
);

/// Returns `true` if [url] (a string starting with `http://` or `https://`)
/// contains an explicit port in the authority section.
///
/// This is needed because Dart's [Uri.port] returns the scheme default
/// (80 for http, 443 for https) even when no port was specified.
bool _urlHasExplicitPort(String url) {
  // Strip scheme.
  final schemeEnd = url.indexOf('://');
  if (schemeEnd == -1) return false;
  final afterScheme = url.substring(schemeEnd + 3);

  // Find the end of the authority (first /, ?, or #, or end of string).
  final authorityEnd = RegExp(r'[/\?#]').firstMatch(afterScheme);
  final authority = authorityEnd != null
      ? afterScheme.substring(0, authorityEnd.start)
      : afterScheme;

  // If there's a @, the part after it is the host:port.
  final hostPort = authority.contains('@')
      ? authority.substring(authority.lastIndexOf('@') + 1)
      : authority;

  // IPv6 addresses are in brackets — find the last ] and look for : after.
  if (hostPort.startsWith('[')) {
    final closingBracket = hostPort.indexOf(']');
    if (closingBracket == -1) return false;
    return closingBracket + 1 < hostPort.length &&
        hostPort[closingBracket + 1] == ':';
  }

  // For IPv4/hostname: if there's a colon, there's an explicit port.
  return hostPort.contains(':');
}
