import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter/foundation.dart';

/// A pane the workspace can open.
///
/// A sealed union rather than a session key with a nullable path: the two
/// kinds are addressed, persisted and presented differently, and a nullable
/// field makes "a session pane" and "a file pane whose path went missing"
/// indistinguishable at every call site.
@immutable
sealed class WorkspacePaneKey {
  const WorkspacePaneKey({required this.session});

  /// Decodes one persisted pane, or null when the row is unusable.
  ///
  /// Returns null rather than throwing for an unrecognised `kind`, so a client
  /// reading rows written by a newer one drops what it does not understand and
  /// keeps the rest of the working set.
  static WorkspacePaneKey? fromJson(Map<String, dynamic> json) {
    final tool = json['tool'];
    final id = json['id'];
    if (tool is! String || id is! String || tool.isEmpty || id.isEmpty) {
      return null;
    }
    final session = SessionDetailKey(tool: tool, sessionId: id);
    // An absent kind is a session pane: rows written before this union existed
    // carry no discriminator, and every one of them was a session.
    switch (json['kind']) {
      case null:
      case 'session':
        return SessionPaneKey(session: session);
      case 'file':
        final path = json['path'];
        if (path is! String || path.isEmpty) return null;
        return FilePaneKey(session: session, path: path);
      default:
        return null;
    }
  }

  /// The session whose workspace this pane belongs to.
  final SessionDetailKey session;

  /// Stable identity within the working set.
  String get key;

  /// The persisted form, always carrying its discriminator.
  Map<String, dynamic> toJson();
}

/// A session's own detail pane.
final class SessionPaneKey extends WorkspacePaneKey {
  /// Creates a session pane key.
  const SessionPaneKey({required super.session});

  @override
  String get key => '${session.tool}/${session.sessionId}';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': 'session',
    'tool': session.tool,
    'id': session.sessionId,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SessionPaneKey && other.session == session;

  @override
  int get hashCode => Object.hash('session', session);
}

/// One file from a session's workspace.
final class FilePaneKey extends WorkspacePaneKey {
  /// Creates a file pane key.
  const FilePaneKey({required super.session, required this.path});

  /// Workspace-relative path.
  final String path;

  /// The `#` is safe as a separator because a workspace-relative path is a
  /// path, and the key is only ever compared against other keys built here.
  @override
  String get key => '${session.tool}/${session.sessionId}#$path';

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': 'file',
    'tool': session.tool,
    'id': session.sessionId,
    'path': path,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is FilePaneKey && other.session == session && other.path == path;

  @override
  int get hashCode => Object.hash('file', session, path);
}
