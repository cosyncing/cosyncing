import 'package:path/path.dart' as path;

/// Restrictive CSP for broker-independent HTML preview hardening.
///
/// This policy intentionally prioritizes runtime safety over permissiveness:
/// scripts are disabled, most navigation/cross-document primitives are disabled,
/// and only static assets needed for local previews are allowed from local/data
/// schemes.
const String sessionArtifactPreviewRestrictiveContentSecurityPolicy =
    "default-src 'none'; script-src 'none'; form-action 'none'; "
    "object-src 'none'; frame-ancestors 'none'; frame-src 'none'; "
    "child-src 'none'; worker-src 'none'; connect-src 'none'; "
    "media-src 'self' data: file:; img-src 'self' data: file:; "
    "style-src 'self' 'unsafe-inline' data: file:; "
    "font-src 'self' data: file:; "
    "manifest-src 'none'; base-uri 'none';";

/// Helpers for detecting and hardening cached HTML artifact previews.
///
/// Rendering behavior for preview hardening is documented in:
/// docs/architecture/client-ui.md
final class SessionArtifactPreviewHtmlPolicy {
  SessionArtifactPreviewHtmlPolicy._();

  /// Returns true when an artifact should be treated as HTML preview content.
  static bool isHtmlArtifactPreview({
    required String fileName,
    String? contentType,
  }) {
    final normalizedContentType = contentType?.toLowerCase();
    if (normalizedContentType != null) {
      final mimeType = normalizedContentType.split(';').first.trim();
      if (mimeType == 'text/html' || mimeType == 'application/xhtml+xml') {
        return true;
      }
    }

    final normalizedFileName = fileName
        .split('?')
        .first
        .split('#')
        .first
        .toLowerCase();
    final extension = path.extension(normalizedFileName);
    return extension == '.html' || extension == '.htm' || extension == '.xhtml';
  }

  /// Returns the hardened HTML with a restrictive CSP meta tag injected.
  ///
  /// Existing CSP tags are removed so broker/artifact content cannot relax the
  /// app policy.
  static String injectRestrictiveContentSecurityPolicy(
    String html, {
    String policy = sessionArtifactPreviewRestrictiveContentSecurityPolicy,
  }) {
    final sanitizedContentType = _removeExistingContentSecurityPolicyMetaTags(
      html,
    );
    final sanitizedPopupAndDownloadAttributes =
        _stripPopupAndDownloadAttributesFromTags(sanitizedContentType);
    if (policy.isEmpty) {
      return sanitizedPopupAndDownloadAttributes;
    }

    final cspTag = _buildContentSecurityPolicyTag(policy);
    return _injectPolicyTag(
      sanitizedPopupAndDownloadAttributes,
      cspTag,
    );
  }

  static final _metaTagPattern = RegExp(
    r'<meta\b[^>]*>',
    caseSensitive: false,
    dotAll: true,
  );
  static final _cspMetaAttributePattern = RegExp(
    r'''(?:http-equiv|name)\s*=\s*(?:"\s*content-security-policy\s*"|'\s*content-security-policy\s*'|content-security-policy)''',
    caseSensitive: false,
  );

  static final _headOpenPattern = RegExp(
    r'<head\b[^>]*>',
    caseSensitive: false,
    dotAll: true,
  );
  static final _htmlOpenPattern = RegExp(
    r'<html\b[^>]*>',
    caseSensitive: false,
    dotAll: true,
  );
  static final _bodyOpenPattern = RegExp(
    r'<body\b[^>]*>',
    caseSensitive: false,
    dotAll: true,
  );
  static final _doctypePattern = RegExp(
    r'^\s*<!doctype\b[^>]*>',
    caseSensitive: false,
    dotAll: true,
  );
  static final _tagPattern = RegExp(
    '<[^>]+>',
    caseSensitive: false,
    dotAll: true,
  );

  static String _buildContentSecurityPolicyTag(String policy) {
    return '<meta http-equiv="Content-Security-Policy" content="$policy" />';
  }

  static String _removeExistingContentSecurityPolicyMetaTags(String html) {
    return html.replaceAllMapped(_metaTagPattern, (match) {
      final metaTag = match.group(0)!;
      if (_cspMetaAttributePattern.hasMatch(metaTag)) {
        return '';
      }

      return metaTag;
    });
  }

  static String _stripPopupAndDownloadAttributesFromTags(String html) {
    return html.replaceAllMapped(_tagPattern, (match) {
      final tag = match.group(0)!;
      if (tag.startsWith('</')) {
        return tag;
      }
      if (tag.startsWith('<!')) {
        return tag;
      }

      return _removePopupAndDownloadAttributesFromTag(tag);
    });
  }

  static String _removePopupAndDownloadAttributesFromTag(String tag) {
    final output = StringBuffer();
    var index = 0;

    while (index < tag.length) {
      final char = tag[index];
      if (!_isHtmlAttributeNameStart(char)) {
        output.write(char);
        index++;
        continue;
      }

      final nameStart = index;
      while (index < tag.length && _isHtmlAttributeNameChar(tag[index])) {
        index++;
      }
      final attributeName = tag.substring(nameStart, index);
      final valueEnd = _skipHtmlAttributeValue(tag, index);
      if (!_isPopupOrDownloadAttributeName(attributeName)) {
        output.write(tag.substring(nameStart, valueEnd));
        index = valueEnd;
        continue;
      }

      index = valueEnd;
      if (output.isNotEmpty &&
          output.toString().endsWith(' ') &&
          index < tag.length &&
          tag[index] == ' ') {
        index++;
      }
    }

    return output
        .toString()
        .replaceAll(RegExp(r'\s+>'), '>')
        .replaceAll(RegExp(r'\s+/>'), '/>')
        .replaceAll(RegExp(r'\s{2,}'), ' ')
        .trimLeft();
  }

  static bool _isPopupOrDownloadAttributeName(String attributeName) {
    final normalized = attributeName.toLowerCase();
    return normalized == 'target' || normalized == 'download';
  }

  static int _skipHtmlAttributeValue(String tag, int index) {
    var cursor = index;
    while (cursor < tag.length && _isHtmlWhitespace(tag[cursor])) {
      cursor++;
    }
    if (cursor >= tag.length || tag[cursor] != '=') {
      return cursor;
    }

    cursor++;
    while (cursor < tag.length && _isHtmlWhitespace(tag[cursor])) {
      cursor++;
    }
    if (cursor >= tag.length) {
      return cursor;
    }

    final quote = tag[cursor];
    if (quote == '"' || quote == "'") {
      cursor++;
      while (cursor < tag.length && tag[cursor] != quote) {
        cursor++;
      }
      return cursor < tag.length ? cursor + 1 : cursor;
    }

    while (cursor < tag.length &&
        !_isHtmlWhitespace(tag[cursor]) &&
        tag[cursor] != '>' &&
        tag[cursor] != '/') {
      cursor++;
    }
    return cursor;
  }

  static bool _isHtmlWhitespace(String char) => char.trim().isEmpty;

  static bool _isHtmlAttributeNameStart(String char) {
    final codeUnit = char.codeUnitAt(0);
    return (codeUnit >= 65 && codeUnit <= 90) ||
        (codeUnit >= 97 && codeUnit <= 122) ||
        char == '_' ||
        char == ':';
  }

  static bool _isHtmlAttributeNameChar(String char) {
    final codeUnit = char.codeUnitAt(0);
    return _isHtmlAttributeNameStart(char) ||
        (codeUnit >= 48 && codeUnit <= 57) ||
        char == '-' ||
        char == '.';
  }

  static String _injectPolicyTag(String html, String policyTag) {
    final headBlock = '<head>\n$policyTag\n</head>\n';
    final headOpen = _headOpenPattern.firstMatch(html);
    if (headOpen != null) {
      return html.replaceRange(
        headOpen.end,
        headOpen.end,
        '\n$policyTag',
      );
    }

    final htmlOpen = _htmlOpenPattern.firstMatch(html);
    if (htmlOpen != null) {
      return '${html.substring(0, htmlOpen.end)}\n'
          '$headBlock'
          '${html.substring(htmlOpen.end)}';
    }

    final bodyOpen = _bodyOpenPattern.firstMatch(html);
    if (bodyOpen != null) {
      return '${html.substring(0, bodyOpen.start)}'
          '$headBlock'
          '${html.substring(bodyOpen.start)}';
    }

    final doctypeMatch = _doctypePattern.firstMatch(html);
    if (doctypeMatch != null) {
      return '${html.substring(0, doctypeMatch.end)}\n'
          '$headBlock'
          '${html.substring(doctypeMatch.end)}';
    }

    return headBlock + html;
  }
}
