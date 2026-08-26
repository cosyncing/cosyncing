/// The provider-independent file-reference model for transcript tool rows.
///
/// A transcript file mention is derived from **structured contract fields
/// only** — the same fields `tool_presentation.dart` already reads. Nothing
/// here scans prose, and nothing here guesses from a provider argument name:
///
/// * a path that arrives as `ToolFileReadSemantic.path` is *known* to be a file
///   the agent read;
/// * a path scraped out of a sentence is a string that looks path-ish.
///
/// Linking the first is provenance; linking the second is a guess that produces
/// dead links, and a link that silently does nothing is worse than plain text.
///
/// One deliberate trap this file preserves: a search's `scope` is a *directory
/// the search ran in*, not a file it found (`Grep`'s `path` argument, and its
/// equivalents in every other adapter). It is never turned into a reference —
/// only `ToolSearchGroup.path`, which is a file that actually matched, is.
///
/// Everything here is pure and synchronous so it unit-tests without a widget
/// tree. Governing doc: `docs/architecture/client-ui.md`.
library;

import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// What a reference is known to point at *before* the broker stats it.
///
/// This is a render hint (which glyph to draw), never a resolution decision:
/// the broker's `/fs?path=` stat is the only authority on what a path is.
enum SessionFileReferenceKind {
  /// A file the agent read, edited, searched, or produced.
  file,

  /// A directory: a command's working directory, or a link's parent folder.
  directory,
}

/// The largest number of references one tool row may contribute.
///
/// A multi-file change set is already bounded by the adapters, but the render
/// bound is applied independently so a future looser adapter cannot make one
/// row derive an unbounded list.
const int sessionFileReferencesPerRowLimit = 40;

/// Anchored `path:line[:column]` suffix rule.
///
/// Applied ONLY to a path already taken from a structured field (§3.3 of the
/// spec), never to prose. Anchoring at both ends is what keeps `C:\a\b.ts` and
/// `a:b/c.ts` intact — neither ends in `:<digits>` — while `foo.ts:42:7` splits.
final RegExp _lineAnchorPattern = RegExp(r'^(.*?):(\d+)(?::(\d+))?$');

/// One resolvable workspace reference carried beside a displayed path.
///
/// [rawPath] is the **unclipped** path exactly as the adapter recorded it. The
/// collapsed summary line clips paths for display
/// (`ToolPresentationBounds.collapsedTitleChars`), so a link built from
/// displayed text would open the wrong file; the reference is always built from
/// the contract field, never from the string on screen.
///
/// An absolute path and a `~` prefix are passed through untouched: since the
/// broker's `toWorkspaceRelative` pre-step, only the session's host can decide
/// what either means (realpath, case, and `homedir()` are all host facts). A
/// client-side prefix strip would fail on a workspace reached through a symlink
/// that the host resolves fine.
@immutable
final class SessionFileReference {
  /// Creates a reference. Prefer [parse], which also applies the anchor rule.
  const SessionFileReference({
    required this.rawPath,
    this.line,
    this.column,
    this.kind = SessionFileReferenceKind.file,
  });

  /// The workspace root of the session this reference belongs to.
  static const SessionFileReference workspaceRoot = SessionFileReference(
    rawPath: '',
    kind: SessionFileReferenceKind.directory,
  );

  /// Unclipped path as recorded: workspace-relative, absolute, or `~`-prefixed.
  final String rawPath;

  /// 1-based source line to anchor on, when one was published or suffixed.
  final int? line;

  /// 1-based column to highlight within [line], when one was published.
  final int? column;

  /// Render hint for the glyph; the broker's stat remains authoritative.
  final SessionFileReferenceKind kind;

  /// Whether this reference points at the workspace root itself.
  bool get isWorkspaceRoot => rawPath.isEmpty;

  /// The containing directory, or the workspace root for a top-level name.
  ///
  /// Derived lexically because that is all a parent *is* — the broker still
  /// resolves and contains the result, so a wrong guess fails closed with the
  /// existing `PATH_ESCAPE` / `NOT_FOUND` copy rather than reading anything.
  SessionFileReference get parent {
    final normalized = rawPath.replaceAll(r'\', '/');
    final trimmed = normalized.length > 1 && normalized.endsWith('/')
        ? normalized.substring(0, normalized.length - 1)
        : normalized;
    final index = trimmed.lastIndexOf('/');
    if (index < 0) return workspaceRoot;
    if (index == 0) {
      return const SessionFileReference(
        rawPath: '/',
        kind: SessionFileReferenceKind.directory,
      );
    }
    return SessionFileReference(
      rawPath: trimmed.substring(0, index),
      kind: SessionFileReferenceKind.directory,
    );
  }

  /// The trailing segment, used for a preview title when the broker's own
  /// resolved name is not in hand yet.
  String get displayName {
    final normalized = rawPath.replaceAll(r'\', '/');
    final trimmed = normalized.length > 1 && normalized.endsWith('/')
        ? normalized.substring(0, normalized.length - 1)
        : normalized;
    final index = trimmed.lastIndexOf('/');
    final name = index < 0 ? trimmed : trimmed.substring(index + 1);
    return name.isEmpty ? rawPath : name;
  }

  /// `path`, `path:line`, or `path:line:column` — the form a human copies.
  String get displayPath {
    if (line == null) return rawPath;
    if (column == null) return '$rawPath:$line';
    return '$rawPath:$line:$column';
  }

  /// Returns a copy anchored at [line]/[column] when this one carries none.
  SessionFileReference withAnchor({int? line, int? column}) {
    final nextLine = this.line ?? _positive(line);
    final nextColumn = this.column ?? _positive(column);
    if (nextLine == this.line && nextColumn == this.column) return this;
    return SessionFileReference(
      rawPath: rawPath,
      line: nextLine,
      column: nextColumn,
      kind: kind,
    );
  }

  /// Parses [raw] into a reference, applying the `path:line[:column]` rule.
  ///
  /// Returns null for anything that cannot address a path at all: null, empty,
  /// whitespace-only, or a string carrying a newline or NUL (a control byte in
  /// a path is a malformed payload, not a file).
  ///
  /// A structured [line]/[column] wins over a suffix, because a dedicated
  /// contract field is a stronger statement than a colon in a string.
  static SessionFileReference? parse(
    String? raw, {
    int? line,
    int? column,
    SessionFileReferenceKind kind = SessionFileReferenceKind.file,
  }) {
    if (raw == null) return null;
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    if (trimmed.contains('\n') ||
        trimmed.contains('\r') ||
        trimmed.contains('\u0000')) {
      return null;
    }
    var path = trimmed;
    var resolvedLine = _positive(line);
    var resolvedColumn = _positive(column);
    final match = _lineAnchorPattern.firstMatch(trimmed);
    final head = match?.group(1);
    if (match != null && head != null && head.isNotEmpty) {
      path = head;
      resolvedLine ??= _positive(int.tryParse(match.group(2)!));
      final rawColumn = match.group(3);
      if (rawColumn != null) {
        resolvedColumn ??= _positive(int.tryParse(rawColumn));
      }
    }
    if (path.isEmpty) return null;
    return SessionFileReference(
      rawPath: path,
      line: resolvedLine,
      column: resolvedLine == null ? null : resolvedColumn,
      kind: kind,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SessionFileReference &&
          other.rawPath == rawPath &&
          other.line == line &&
          other.column == column &&
          other.kind == kind;

  @override
  int get hashCode => Object.hash(rawPath, line, column, kind);

  @override
  String toString() => 'SessionFileReference($displayPath, ${kind.name})';
}

/// Every file reference one tool row carries, in a deterministic order.
///
/// Reads exactly the contract fields that already carry a real path, and
/// nothing else:
///
/// | Source | Carries |
/// |---|---|
/// | `ToolFileReadSemantic.path` (+ `startLine`) | the read file |
/// | `ToolSearchGroup.path` (+ first `ToolSearchMatch.line`) | a matched file |
/// | `tool-result.path` | the file an edit/write/read acted on |
/// | `FileChange.path` / `previousPath` | every file in a change set |
/// | `ToolCommandSemantic.cwd` | where a command ran (a directory) |
///
/// `ToolSearchSemantic.scope` is deliberately absent: it is a search *scope
/// directory*, and treating it as a file would turn every grep into a bogus
/// link.
///
/// `fs-edit.path` and `file-artifact.path` are separate `AgentMessage` types
/// rather than tool rows, so they are outside this (call, result) pair.
List<SessionFileReference> fileReferencesForToolRow({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final out = <SessionFileReference>[];
  final seen = <SessionFileReference>{};

  void add(SessionFileReference? reference) {
    if (reference == null) return;
    if (out.length >= sessionFileReferencesPerRowLimit) return;
    if (!seen.add(reference)) return;
    out.add(reference);
  }

  final semantic = result?.toolSemantic ?? call?.toolSemantic;
  add(fileReadReference(semantic?.fileRead));
  for (final group in semantic?.search?.groups ?? const <ToolSearchGroup>[]) {
    add(searchGroupReference(group));
  }
  add(
    SessionFileReference.parse(_stringOrNull(result?.raw['path'])),
  );
  for (final reference in fileChangeReferences(result?.raw['fileChanges'])) {
    add(reference);
  }
  add(commandCwdReference(semantic?.command));

  return List.unmodifiable(out);
}

/// The reference for a file-read semantic, anchored at its first preview line.
SessionFileReference? fileReadReference(ToolFileReadSemantic? semantic) {
  if (semantic == null) return null;
  return SessionFileReference.parse(semantic.path, line: semantic.startLine);
}

/// The reference for one search group, anchored at its first published match.
///
/// The group header answers "which file matched"; the natural landing spot is
/// the first hit in it, so a tap lands on evidence rather than on line 1.
SessionFileReference? searchGroupReference(ToolSearchGroup? group) {
  if (group == null) return null;
  int? line;
  for (final match in group.matches) {
    if (match.line != null) {
      line = match.line;
      break;
    }
  }
  return SessionFileReference.parse(group.path, line: line);
}

/// The working directory a command ran in, as a directory reference.
SessionFileReference? commandCwdReference(ToolCommandSemantic? semantic) {
  if (semantic == null) return null;
  return SessionFileReference.parse(
    semantic.cwd,
    kind: SessionFileReferenceKind.directory,
  );
}

/// Every path in a canonical `fileChanges` payload, new path before old.
///
/// A rename carries two real files; both are linkable, and the new one leads
/// because that is the file that exists now.
List<SessionFileReference> fileChangeReferences(Object? raw) {
  if (raw is! Iterable) return const [];
  final out = <SessionFileReference>[];
  for (final entry in raw) {
    if (out.length >= sessionFileReferencesPerRowLimit) break;
    if (entry is! Map) continue;
    final path = SessionFileReference.parse(_stringOrNull(entry['path']));
    if (path != null) out.add(path);
    final previous = SessionFileReference.parse(
      _stringOrNull(entry['previousPath']),
    );
    if (previous != null && previous != path) out.add(previous);
  }
  return List.unmodifiable(out);
}

int? _positive(int? value) => value != null && value > 0 ? value : null;

String? _stringOrNull(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}
