import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// A lightweight reference to a session in the opened-sessions working set.
///
/// The session list shows *every* session on the broker; the working set is the
/// handful the user is actively driving (the VS Code-style open-editor model).
/// [SessionRef] carries only what a tab needs — identity, a display title, and
/// the current status — so the working set stays cheap to persist and restore.
///
/// See `docs/architecture/client-ui.md`.
@immutable
class SessionRef {
  /// Creates a session reference.
  const SessionRef({
    required this.tool,
    required this.id,
    required this.title,
    required this.status,
  });

  /// Derives a reference from a full [SessionInfo], falling back to the id when
  /// the session has no title.
  factory SessionRef.fromSession(SessionInfo session) => SessionRef(
    tool: session.tool,
    id: session.id,
    title: session.title.isNotEmpty ? session.title : session.id,
    status: session.status,
  );

  /// Creates a reference from cached identity, with the status still UNKNOWN.
  ///
  /// A row opened from the bounded local snapshot (N3) has identity but no
  /// activity: the snapshot deliberately stores none. Passing
  /// [SessionStatus.idle] here would persist a claim the client never received
  /// — invisible in today's tab strip, which emphasises only needs-input, but a
  /// lie to every future consumer of the working set. [status] stays null until
  /// `refreshMetadata` supplies the authoritative value.
  const SessionRef.cachedIdentity({
    required this.tool,
    required this.id,
    required this.title,
  }) : status = null;

  /// Rebuilds a reference from its persisted JSON map.
  factory SessionRef.fromJson(Map<String, dynamic> json) => SessionRef(
    tool: json['tool'] as String,
    id: json['id'] as String,
    title: json['title'] as String? ?? json['id'] as String,
    status: _statusFromToken(json['status'] as String?),
  );

  /// Backend id (e.g. `opencode`, `codex`, `claude`, `pi`).
  final String tool;

  /// Stable session id within the tool.
  final String id;

  /// Display title (never empty — falls back to [id]).
  final String title;

  /// Current session status, or null while it is genuinely unknown.
  ///
  /// Null means "this client has never received an authoritative status for
  /// this session" — a tab opened from cached identity before the roster
  /// loaded. It is NOT a status value and must never be defaulted into one:
  /// rendering treats null as "make no claim", which is what the cache can
  /// honestly support.
  final SessionStatus? status;

  /// Stable identity within the working set: `tool/id`.
  ///
  /// Used for dedup, activation and close operations; distinct from value
  /// equality, which also compares [title] and [status].
  String get key => '$tool/$id';

  // Deliberately no `copyWith`. With a nullable [status] the usual
  // `status ?? this.status` shape cannot express "the status is no longer
  // known" — it silently keeps the previous value — and that is precisely the
  // transition a tab makes when it is reopened from cached identity. Callers
  // build the whole reference instead, which forces the question to be
  // answered rather than defaulted.

  /// Serializes to a JSON map for persistence.
  ///
  /// An unknown status is OMITTED rather than written as a value, so a restart
  /// restores "not known yet" instead of inheriting a status this client never
  /// received.
  Map<String, dynamic> toJson() => <String, dynamic>{
    'tool': tool,
    'id': id,
    'title': title,
    if (status != null) 'status': status!.name,
  };

  /// Maps a persisted status token, or null when it is absent or unrecognised.
  ///
  /// Deliberately no `idle` fallback: an absent token means this tab was opened
  /// from cached identity and never reconciled, and an unrecognised one comes
  /// from a broker newer than this client. Guessing either into `idle` is how a
  /// working session ends up drawn as finished.
  static SessionStatus? _statusFromToken(String? token) {
    if (token == null) return null;
    for (final value in SessionStatus.values) {
      if (value.name == token) return value;
    }
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is SessionRef &&
      other.tool == tool &&
      other.id == id &&
      other.title == title &&
      other.status == status;

  @override
  int get hashCode => Object.hash(tool, id, title, status);

  @override
  String toString() =>
      'SessionRef($key, "$title", ${status?.name ?? 'unknown'})';
}
