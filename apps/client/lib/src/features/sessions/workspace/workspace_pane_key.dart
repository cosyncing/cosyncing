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
      case 'artifact':
        final identity = json['artifact'];
        final name = json['name'];
        if (identity is! String || identity.isEmpty || name is! String) {
          return null;
        }
        return ArtifactPaneKey(
          session: session,
          artifactId: identity,
          name: name,
        );
      case 'status':
        return SessionPanelKey(session: session, kind: SessionPanelKind.status);
      case 'files':
        return SessionPanelKey(session: session, kind: SessionPanelKind.files);
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
final class FilePaneKey extends SidePaneKey {
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

/// The session-pane key underlying [paneKey], whichever kind it addresses.
///
/// A file pane's key is its session's key, a `#`, and the workspace-relative
/// path, so this is how a caller asks "which session does this pane belong
/// to?" without having to know which kind it is holding — the question both
/// prompt-target signals ask, and the answer that keeps input visibly bound to
/// a session while the reader's focus is inside one of its files.
String workspacePaneSessionKey(String paneKey) {
  final qualified = paneKey.startsWith('artifact:')
      ? paneKey.substring(9)
      : paneKey.startsWith('panel:')
      ? paneKey.substring(6)
      : paneKey;
  final separator = qualified.indexOf('#');
  return separator < 0 ? qualified : qualified.substring(0, separator);
}

/// Whether [paneKey] addresses a file pane rather than a session pane.
bool isWorkspaceFilePaneKey(String paneKey) => paneKey.contains('#');

/// Content that can occupy a tab in a session's right panel.
sealed class SidePaneKey extends WorkspacePaneKey {
  const SidePaneKey({required super.session});
}

/// A delivered artifact, resolved from an opened descriptor or session history.
/// Signed URLs and file bytes are deliberately never persisted with tabs.
final class ArtifactPaneKey extends SidePaneKey {
  /// Creates a delivered-file tab.
  const ArtifactPaneKey({
    required super.session,
    required this.artifactId,
    required this.name,
  });

  /// Stable descriptor identity.
  final String artifactId;

  /// File name used for the tab and renderer selection.
  final String name;
  @override
  String get key => 'artifact:${session.tool}/${session.sessionId}#$artifactId';
  @override
  Map<String, dynamic> toJson() => {
    'kind': 'artifact',
    'tool': session.tool,
    'id': session.sessionId,
    'artifact': artifactId,
    'name': name,
  };
  @override
  bool operator ==(Object other) =>
      other is ArtifactPaneKey &&
      other.session == session &&
      other.artifactId == artifactId;
  @override
  int get hashCode => Object.hash('artifact', session, artifactId);
}

/// Session views available beside the transcript.
enum SessionPanelKind {
  /// Live status and session actions.
  status,

  /// Delivered files and workspace browser.
  files,
}

/// A session's Status or Files tab.
final class SessionPanelKey extends SidePaneKey {
  /// Creates a session view tab.
  const SessionPanelKey({required super.session, required this.kind});

  /// Which session view to show.
  final SessionPanelKind kind;
  @override
  String get key => 'panel:${session.tool}/${session.sessionId}#${kind.name}';
  @override
  Map<String, dynamic> toJson() => {
    'kind': kind.name,
    'tool': session.tool,
    'id': session.sessionId,
  };
  @override
  bool operator ==(Object other) =>
      other is SessionPanelKey &&
      other.session == session &&
      other.kind == kind;
  @override
  int get hashCode => Object.hash('panel', session, kind);
}
