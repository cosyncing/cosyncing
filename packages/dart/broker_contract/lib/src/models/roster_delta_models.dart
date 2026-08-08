import 'package:broker_contract/src/models/session_info.dart';

/// One transcript-free roster mutation from the broker revision journal.
class SessionRosterDelta {
  const SessionRosterDelta({
    required this.revision,
    required this.machine,
    required this.tool,
    required this.sessionId,
    required this.changedFields,
    this.session,
    this.removed = false,
  });

  factory SessionRosterDelta.fromJson(Map<String, dynamic> json) =>
      SessionRosterDelta(
        revision: (json['revision'] as num).toInt(),
        machine: json['machine'] as String,
        tool: json['tool'] as String,
        sessionId: json['sessionId'] as String,
        changedFields: (json['changedFields'] as List<dynamic>? ?? const [])
            .map((value) => value as String)
            .toList(growable: false),
        session: json['session'] == null
            ? null
            : SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
        removed: json['removed'] as bool? ?? false,
      );

  final int revision;
  final String machine;
  final String tool;
  final String sessionId;
  final List<String> changedFields;
  final SessionInfo? session;
  final bool removed;
}

/// Long-poll response for lightweight roster changes after a revision.
class SessionRosterDeltaBatch {
  const SessionRosterDeltaBatch({
    required this.revision,
    required this.deltas,
    this.resetRequired = false,
  });

  factory SessionRosterDeltaBatch.fromJson(Map<String, dynamic> json) =>
      SessionRosterDeltaBatch(
        revision: (json['revision'] as num).toInt(),
        deltas: (json['deltas'] as List<dynamic>? ?? const [])
            .map(
              (value) => SessionRosterDelta.fromJson(
                value as Map<String, dynamic>,
              ),
            )
            .toList(growable: false),
        resetRequired: json['resetRequired'] as bool? ?? false,
      );

  final int revision;
  final List<SessionRosterDelta> deltas;
  final bool resetRequired;
}
