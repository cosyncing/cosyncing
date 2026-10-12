import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';

/// Markdown hrefs are URI references; code and selections are literal paths.
SessionFileReference? transcriptMarkdownFileReference(String href) {
  // Drive-letter paths are authored as host paths, not URI schemes.
  if (RegExp(r'^[a-zA-Z]:[/\\]').hasMatch(href)) {
    return transcriptFileReference(href, explicit: true);
  }
  // A filename with a source suffix is not a URI scheme (`notes.md:12`).
  if (RegExp(r'^[^/:]+\.[a-zA-Z][a-zA-Z0-9_-]*:\d+(?::\d+)?$').hasMatch(href)) {
    return transcriptFileReference(href, explicit: true);
  }
  final uri = Uri.tryParse(href.trim());
  if (uri == null ||
      uri.hasQuery ||
      (uri.hasScheme && uri.scheme != 'file') ||
      (uri.host.isNotEmpty && uri.host != 'localhost')) {
    return null;
  }
  try {
    var path = Uri.decodeComponent(uri.path);
    if (uri.scheme == 'file' && RegExp('^/[a-zA-Z]:/').hasMatch(path)) {
      path = path.substring(1);
    }
    // File viewers understand source-line anchors. Other Markdown fragments
    // still open their file, without treating the heading id as a filename.
    if (RegExp(r'^L\d+(?:C\d+)?$').hasMatch(uri.fragment)) {
      path += '#${uri.fragment}';
    }
    return transcriptFileReference(path, explicit: true);
  } on FormatException {
    return null;
  }
}

/// Parses a Markdown target, an inline code path, or one selected filename.
/// Ordinary inline code must look like a path; explicit links/selections may
/// name extensionless files. Resolution always belongs to the broker host.
SessionFileReference? transcriptFileReference(
  String text, {
  bool explicit = false,
}) {
  var path = text.trim();
  if (path.length > 4096 || path.isEmpty) return null;
  for (final quote in ['`', '"', "'"]) {
    if (path.length > 1 && path.startsWith(quote) && path.endsWith(quote)) {
      path = path.substring(1, path.length - 1);
      break;
    }
  }
  if (RegExp(r'[\x00-\x1f<>|?*]').hasMatch(path)) return null;
  if (path.startsWith('file:')) {
    final uri = Uri.tryParse(path);
    if (uri == null ||
        (uri.host.isNotEmpty && uri.host != 'localhost') ||
        uri.hasQuery) {
      return null;
    }
    try {
      path =
          Uri.decodeComponent(uri.path) +
          (uri.hasFragment ? '#${uri.fragment}' : '');
      if (RegExp('^/[a-zA-Z]:/').hasMatch(path)) path = path.substring(1);
    } on FormatException {
      return null;
    }
  } else if (RegExp('^[a-zA-Z][a-zA-Z0-9+.-]*:').hasMatch(path) &&
      !RegExp(r'^[a-zA-Z]:[/\\]').hasMatch(path) &&
      !RegExp(r':\d+(?::\d+)?$').hasMatch(path)) {
    return null;
  }
  final anchor = RegExp(r'#L(\d+)(?:C(\d+))?$').firstMatch(path);
  final reference = SessionFileReference.parse(
    anchor == null ? path : path.substring(0, anchor.start),
    line: anchor == null ? null : int.tryParse(anchor.group(1)!),
    column: anchor?.group(2) == null ? null : int.tryParse(anchor!.group(2)!),
  );
  if (reference == null || reference.rawPath.startsWith('#')) return null;
  final raw = reference.rawPath;
  if (!explicit &&
      !raw.contains('/') &&
      !raw.contains(r'\') &&
      !RegExp(r'\.[a-zA-Z][a-zA-Z0-9_-]{0,15}$').hasMatch(raw)) {
    return null;
  }
  return reference;
}

/// Exact path first, then paths already published by the session, then a
/// bounded broker search. A partial search does not claim a match is unique.
Future<FsSearchResult> resolveTranscriptFile({
  required SessionFileReference reference,
  required Iterable<SessionFileReference> knownReferences,
  required Future<FsDirectoryResult> Function(String path) stat,
  required Future<FsSearchResult> Function(String query) search,
}) async {
  final query = reference.rawPath;
  try {
    final exact = await stat(query);
    return FsSearchResult(query: query, matches: [exact.stat]);
  } on BrokerException catch (error) {
    if (error.error?.code != 'NOT_FOUND') rethrow;
  }
  final suffix = query.replaceAll(r'\', '/');
  // Never reinterpret an absolute/outside-workspace path as a different file.
  if (suffix.startsWith('/') ||
      suffix.startsWith('~') ||
      RegExp('^[a-zA-Z]:').hasMatch(suffix) ||
      suffix.split('/').contains('..')) {
    return FsSearchResult(query: query, matches: const []);
  }
  final normalized = suffix.startsWith('./') ? suffix.substring(2) : suffix;
  final matches = <String, FsNodeInfo>{};
  final seen = <String>{};
  var examined = 0;
  for (final known in knownReferences) {
    final path = known.rawPath.replaceAll(r'\', '/');
    if (known.kind != SessionFileReferenceKind.file ||
        !seen.add(path) ||
        !(path == normalized || path.endsWith('/$normalized'))) {
      continue;
    }
    if (++examined > 64) {
      return FsSearchResult(
        query: query,
        matches: matches.values.toList(),
        truncated: true,
      );
    }
    try {
      final found = (await stat(known.rawPath)).stat;
      if (found.isRegularFile) matches[found.path] = found;
    } on BrokerException catch (error) {
      if (!const [
        'NOT_FOUND',
        'PATH_ESCAPE',
        'PATH_SYMLINK',
      ].contains(error.error?.code)) {
        rethrow;
      }
    }
    if (matches.length >= 50) {
      return FsSearchResult(
        query: query,
        matches: matches.values.toList(),
        truncated: true,
      );
    }
  }
  if (matches.isNotEmpty) {
    return FsSearchResult(query: query, matches: matches.values.toList());
  }
  return search(normalized);
}
