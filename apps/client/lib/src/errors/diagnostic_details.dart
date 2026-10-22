/// A bounded, sanitized snapshot suitable for both display and clipboard.
final class DiagnosticDetails {
  /// Captures a diagnostic at invocation. No live values are read afterward.
  factory DiagnosticDetails.capture({
    required String label,
    required String detail,
    String? code,
    DateTime? at,
  }) {
    final text = sanitizeDiagnosticText(
      [
        (at ?? DateTime.now()).toUtc().toIso8601String(),
        label,
        if (code != null) code,
        detail,
      ].join('\n'),
    );
    return DiagnosticDetails._(sanitizeDiagnosticText(label), text);
  }

  const DiagnosticDetails._(this.label, this.text);

  /// Human context, also sanitized.
  final String label;

  /// The exact displayed and copied value.
  final String text;
}

/// Removes credential-bearing fields before limiting the retained text.
///
/// Queries/fragments are dropped in full: an unfamiliar signed-URL parameter
/// must not evade a list of known token names. Header values are removed to the
/// line boundary, and quoted/unquoted nested exception fields are redacted too.
String sanitizeDiagnosticText(String input) {
  var text = input.replaceAllMapped(
    RegExp(r'''(?:https?|wss?|cosyncing)://[^\s<>"']+''', caseSensitive: false),
    (match) {
      final uri = Uri.tryParse(match[0]!);
      if (uri == null) return '[redacted URL]';
      if (uri.scheme == 'cosyncing') return 'cosyncing://pair/[redacted]';
      // Media paths and decoder relay paths are bearer capabilities too.
      // The latter are device-local, single-segment random identifiers.
      final path = uri.path;
      final relay =
          ['127.0.0.1', 'localhost', '::1'].contains(uri.host) &&
          RegExp(r'^/[A-Za-z0-9_-]{24}$').hasMatch(path);
      return uri
          .replace(
            userInfo: '',
            path: relay ? '/[redacted]' : path,
            query: '',
            fragment: '',
          )
          .toString();
    },
  );
  // Match relative URLs as well as absolute URLs from transport exceptions.
  text = text.replaceAll(
    RegExp(r'''(/api/media-previews/)[^\s<>"'/?#]+'''),
    '/api/media-previews/[redacted]',
  );
  text = text.replaceAll(
    RegExp(
      r'''\b(?:proxy-authorization|authorization|set-cookie|cookie)\s*[:=]\s*[^\r\n]+''',
      caseSensitive: false,
    ),
    '[redacted header]',
  );
  text = text.replaceAll(
    RegExp(
      r'''\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\.\-]+''',
      caseSensitive: false,
    ),
    '[redacted credential]',
  );
  text = text.replaceAllMapped(
    RegExp(
      r'''(["']?(?:[\w-]*(?:token|ticket|capability|secret|password|credential|signature|private[_-]?key|data[_-]?key|api[_-]?key|pairing[_-]?payload)|authorization|cookies?)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)''',
      caseSensitive: false,
    ),
    (match) => '${match[1]}[redacted]',
  );
  const maximum = 8192;
  const truncated = '\n[… truncated]';
  return text.length <= maximum
      ? text
      : '${text.substring(0, maximum - truncated.length)}$truncated';
}
