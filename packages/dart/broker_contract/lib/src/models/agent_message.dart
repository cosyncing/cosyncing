import 'package:broker_contract/src/models/policy_token.dart';

/// Event name for agent-visible material the user never typed.
///
/// Adapters map system reminders, runtime snapshots and host context
/// injections onto this one name so the transcript can give them a single
/// collapsible presentation instead of one shape per provider. Mirrors
/// `CONTEXT_INJECTION_EVENT` in the broker's
/// `packages/typescript/protocol/src/index.ts`; event names are free-form on
/// the wire, so this is a shared convention rather than a hashed contract
/// field, and an unrecognized name simply renders as an ordinary event.
const String kContextInjectionEvent = 'context.injection';

/// Canonical `AgentMessage.type` values emitted by the broker.
///
/// See `docs/protocol/contract-sync.md`.
/// The broker's `packages/typescript/protocol/src/index.ts` lists 23 canonical types.
/// An [AgentMessage] with an unrecognized type is decoded as
/// [AgentMessageType.unknown] and its raw JSON is preserved.
enum AgentMessageType {
  modelOutput('model-output'),
  thinking('thinking'),
  status('status'),
  toolCall('tool-call'),
  toolResult('tool-result'),
  fsEdit('fs-edit'),
  fileArtifact('file-artifact'),
  permissionRequest('permission-request'),
  permissionResolved('permission-resolved'),
  questionRequest('question-request'),
  questionResolved('question-resolved'),
  terminalOutput('terminal-output'),
  notice('notice'),
  metadataUpdate('metadata-update'),
  tokenCount('token-count'),
  runSummary('run-summary'),
  userMessage('user-message'),
  event('event'),
  goalState('goal-state'),
  taskListState('task-list-state'),
  agentActivity('agent-activity'),
  historyReset('history-reset'),
  error('error'),

  /// Catch-all for types the broker adds in the future.
  unknown('unknown');

  const AgentMessageType(this.wireValue);

  /// The wire string the broker uses for this type.
  final String wireValue;

  static final Map<String, AgentMessageType> _byWire = {
    for (final t in values) t.wireValue: t,
  };

  /// Parse a wire string to an [AgentMessageType].
  ///
  /// Returns [AgentMessageType.unknown] for unrecognized values.
  static AgentMessageType fromWire(String? wire) {
    if (wire == null) return AgentMessageType.unknown;
    return _byWire[wire] ?? AgentMessageType.unknown;
  }
}

/// Structured meaning attached to a canonical `notice`.
enum TranscriptNoticeSemanticKind {
  interruption('interruption'),
  unknown('unknown');

  const TranscriptNoticeSemanticKind(this.wireValue);
  final String wireValue;

  static TranscriptNoticeSemanticKind fromWire(Object? value) =>
      value == 'interruption'
      ? TranscriptNoticeSemanticKind.interruption
      : TranscriptNoticeSemanticKind.unknown;
}

/// Structured reason for a canonical turn interruption.
enum TranscriptInterruptionReason {
  generic('generic'),
  user('user'),
  automaticApprovalDeniedRepeatedly(
    'automatic-approval-denied-repeatedly',
  ),
  unknown('unknown');

  const TranscriptInterruptionReason(this.wireValue);
  final String wireValue;

  static TranscriptInterruptionReason fromWire(Object? value) =>
      switch (value) {
        'generic' => TranscriptInterruptionReason.generic,
        'user' => TranscriptInterruptionReason.user,
        'automatic-approval-denied-repeatedly' =>
          TranscriptInterruptionReason.automaticApprovalDeniedRepeatedly,
        _ => TranscriptInterruptionReason.unknown,
      };
}

/// Structured display meaning attached to a canonical `history-reset`.
enum HistoryResetSemanticKind {
  compaction('compaction'),
  rollback('rollback'),
  unknown('unknown');

  const HistoryResetSemanticKind(this.wireValue);
  final String wireValue;

  static HistoryResetSemanticKind fromWire(Object? value) => switch (value) {
    'compaction' => HistoryResetSemanticKind.compaction,
    'rollback' => HistoryResetSemanticKind.rollback,
    _ => HistoryResetSemanticKind.unknown,
  };
}

/// Adapter-owned semantic class for tool display policy.
///
/// Shared client code uses this value for expansion and grouping. It must not
/// classify tools by their native names.
enum ToolDisplayClass {
  /// Commands and other executable work.
  execute('execute'),

  /// File edits and writes.
  edit('edit'),

  /// Reads, searches, and other lookup work.
  lookup('lookup'),

  /// A known tool that does not fit another display class.
  other('other'),

  /// A future broker value unknown to this client.
  unknown('unknown');

  const ToolDisplayClass(this.wireValue);

  /// The value carried on the broker wire.
  final String wireValue;

  /// Parses a broker value without rejecting future classes.
  static ToolDisplayClass fromWire(String? wire) {
    return switch (wire) {
      'execute' => ToolDisplayClass.execute,
      'edit' => ToolDisplayClass.edit,
      'lookup' => ToolDisplayClass.lookup,
      'other' => ToolDisplayClass.other,
      _ => ToolDisplayClass.unknown,
    };
  }
}

/// Normalized presentation family for one tool invocation.
///
/// Presence of an exact kind — never a native tool name — selects the client's
/// dedicated presentation. A future broker family decodes as [unknown], which
/// keeps the tool on the bounded structured fallback instead of guessing.
enum ToolSemanticKind {
  command('command'),
  fileRead('file-read'),
  search('search'),
  web('web'),
  unknown('unknown');

  const ToolSemanticKind(this.wireValue);

  /// The value carried on the broker wire.
  final String wireValue;

  /// Parses a broker value without rejecting future families.
  static ToolSemanticKind fromWire(Object? value) => switch (value) {
    'command' => ToolSemanticKind.command,
    'file-read' => ToolSemanticKind.fileRead,
    'search' => ToolSemanticKind.search,
    'web' => ToolSemanticKind.web,
    _ => ToolSemanticKind.unknown,
  };
}

/// Authoritative lifecycle of a command execution.
enum ToolCommandState {
  running('running'),
  completed('completed'),
  failed('failed'),
  interrupted('interrupted'),

  /// The native source published no lifecycle, or published a future one.
  unknown('unknown');

  const ToolCommandState(this.wireValue);

  /// The value carried on the broker wire.
  final String wireValue;

  /// Parses a broker value, failing closed to [unknown].
  static ToolCommandState fromWire(Object? value) => switch (value) {
    'running' => ToolCommandState.running,
    'completed' => ToolCommandState.completed,
    'failed' => ToolCommandState.failed,
    'interrupted' => ToolCommandState.interrupted,
    _ => ToolCommandState.unknown,
  };
}

/// One separately identifiable output stream, retained tail-first.
final class ToolOutputStream {
  /// Creates a bounded output stream.
  const ToolOutputStream({
    required this.text,
    this.truncated = false,
    this.totalBytes,
  });

  /// Decodes a stream, returning null when absent or malformed.
  static ToolOutputStream? fromJson(Object? value) {
    if (value is! Map) return null;
    final text = value['text'];
    if (text is! String) return null;
    return ToolOutputStream(
      text: text,
      truncated: value['truncated'] == true,
      totalBytes: _nonNegativeInt(value['totalBytes']),
    );
  }

  /// Bounded stream body; leading bytes are dropped first.
  final String text;

  /// Whether leading bytes were dropped. Never presentable as complete output.
  final bool truncated;

  /// Total bytes the native source produced, when it reported one.
  final int? totalBytes;
}

/// A command execution: the exact command line, where it ran, and how it ended.
final class ToolCommandSemantic {
  /// Creates a command semantic.
  const ToolCommandSemantic({
    required this.command,
    required this.state,
    this.cwd,
    this.stdout,
    this.stderr,
  });

  /// Exact command line as the agent ran it.
  final String command;

  /// Working directory, when the native event recorded one.
  final String? cwd;

  /// Authoritative lifecycle.
  final ToolCommandState state;

  /// Separated stdout, when the native source distinguishes the streams.
  final ToolOutputStream? stdout;

  /// Separated stderr, when the native source distinguishes the streams.
  final ToolOutputStream? stderr;
}

/// Why a file preview is absent or partial.
enum ToolReadUnavailableReason {
  missing('missing'),
  unreadable('unreadable'),
  binary('binary'),
  empty('empty'),
  unknown('unknown');

  const ToolReadUnavailableReason(this.wireValue);

  /// The value carried on the broker wire.
  final String wireValue;

  /// Parses a broker value without rejecting future reasons.
  static ToolReadUnavailableReason fromWire(Object? value) => switch (value) {
    'missing' => ToolReadUnavailableReason.missing,
    'unreadable' => ToolReadUnavailableReason.unreadable,
    'binary' => ToolReadUnavailableReason.binary,
    'empty' => ToolReadUnavailableReason.empty,
    _ => ToolReadUnavailableReason.unknown,
  };
}

/// A file read: the path plus a bounded, line-numbered preview.
final class ToolFileReadSemantic {
  /// Creates a file-read semantic.
  const ToolFileReadSemantic({
    required this.path,
    this.startLine,
    this.preview,
    this.totalLines,
    this.previewTruncated = false,
    this.unavailable,
  });

  /// Read file path.
  final String path;

  /// 1-based line number of [preview]'s first line; null means unknown, and the
  /// client then renders no gutter numbers rather than counting from a guess.
  final int? startLine;

  /// Bounded newline-separated preview body.
  final String? preview;

  /// Total lines in the source file, when the native source reported it.
  final int? totalLines;

  /// Whether [preview] omits part of the read range.
  final bool previewTruncated;

  /// Honest unavailability; [preview] is then absent.
  final ToolReadUnavailableReason? unavailable;
}

/// Wire-decode ceilings for the tool-semantic envelope.
///
/// The broker bounds what it sends, but a decoder that *relies* on that is a
/// decoder that will happily materialize whatever a buggy or hostile sender
/// supplies. These mirror the broker's retention bounds and are applied while
/// decoding — before any presentation bound gets a chance to run — so an
/// oversized frame costs the same as an honest one. Dropping is always recorded
/// on the enclosing `truncated` flag.
abstract final class ToolSemanticDecodeBounds {
  /// Per-file groups decoded from one search.
  static const int searchGroups = 20;

  /// Matches decoded inside one group.
  static const int searchMatchesPerGroup = 10;

  /// Results decoded from one web lookup.
  static const int webResults = 10;
}

/// One match inside a search group.
final class ToolSearchMatch {
  /// Creates a bounded match snippet.
  const ToolSearchMatch({
    required this.text,
    this.line,
    this.truncated = false,
  });

  /// Decodes a match, returning null when malformed.
  static ToolSearchMatch? fromJson(Object? value) {
    if (value is! Map) return null;
    final text = value['text'];
    if (text is! String) return null;
    return ToolSearchMatch(
      text: text,
      line: _positiveInt(value['line']),
      truncated: value['truncated'] == true,
    );
  }

  /// 1-based line number, when the native source reported one.
  final int? line;

  /// Bounded snippet body.
  final String text;

  /// Whether the snippet was clipped.
  final bool truncated;
}

/// Matches grouped under one file.
final class ToolSearchGroup {
  /// Creates a per-file group.
  const ToolSearchGroup({
    required this.path,
    required this.matches,
    this.matchCount,
    this.truncated = false,
  });

  /// Decodes a group, returning null without a usable path.
  static ToolSearchGroup? fromJson(Object? value) {
    if (value is! Map) return null;
    final path = _trimmedString(value['path']);
    if (path == null) return null;
    final rawMatches = value['matches'];
    final matches = <ToolSearchMatch>[];
    var dropped = false;
    if (rawMatches is Iterable) {
      for (final raw in rawMatches) {
        if (matches.length >= ToolSemanticDecodeBounds.searchMatchesPerGroup) {
          dropped = true;
          break;
        }
        final match = ToolSearchMatch.fromJson(raw);
        if (match != null) matches.add(match);
      }
    }
    return ToolSearchGroup(
      path: path,
      matchCount: _nonNegativeInt(value['matchCount']),
      truncated: value['truncated'] == true || dropped,
      matches: List.unmodifiable(matches),
    );
  }

  /// File the matches belong to.
  final String path;

  /// Authoritative match count, which may exceed `matches.length`.
  final int? matchCount;

  /// Bounded matches for this file.
  final List<ToolSearchMatch> matches;

  /// Whether matches were dropped from this group.
  final bool truncated;
}

/// A search or lookup over the workspace.
final class ToolSearchSemantic {
  /// Creates a search semantic.
  const ToolSearchSemantic({
    required this.groups,
    this.query,
    this.scope,
    this.matchCount,
    this.fileCount,
    this.truncated = false,
  });

  /// Literal pattern or glob the agent searched for.
  final String? query;

  /// Directory, glob, or other scope the search ran against.
  final String? scope;

  /// Authoritative total match count, when reported.
  final int? matchCount;

  /// Authoritative count of files with at least one match.
  final int? fileCount;

  /// Bounded per-file groups.
  final List<ToolSearchGroup> groups;

  /// Whether groups were dropped.
  final bool truncated;
}

/// One web result. The URL is presented as selectable text, never a live link.
final class ToolWebResult {
  /// Creates a web result.
  const ToolWebResult({
    required this.url,
    this.title,
    this.snippet,
    this.truncated = false,
  });

  /// Decodes a result, returning null without a URL.
  static ToolWebResult? fromJson(Object? value) {
    if (value is! Map) return null;
    final url = _trimmedString(value['url']);
    if (url == null) return null;
    return ToolWebResult(
      url: url,
      title: _trimmedString(value['title']),
      snippet: _trimmedString(value['snippet']),
      truncated: value['truncated'] == true,
    );
  }

  /// Result URL.
  final String url;

  /// Human-readable result title, when published.
  final String? title;

  /// Bounded result snippet.
  final String? snippet;

  /// Whether any of this result's text was clipped by the sender.
  final bool truncated;
}

/// A web search or single-page fetch.
final class ToolWebSemantic {
  /// Creates a web semantic.
  const ToolWebSemantic({
    required this.results,
    this.query,
    this.url,
    this.truncated = false,
  });

  /// Search query, when this was a search.
  final String? query;

  /// Fetched page, when this was a single-URL lookup.
  final String? url;

  /// Bounded results.
  final List<ToolWebResult> results;

  /// Whether results were dropped.
  final bool truncated;
}

/// Adapter-normalized structured detail for one tool invocation.
///
/// Exactly one family field is non-null, matching [kind]. An absent or
/// unrecognized envelope decodes to null so the caller falls back to the
/// bounded structured presentation.
final class ToolSemantic {
  const ToolSemantic._({
    required this.kind,
    this.command,
    this.fileRead,
    this.search,
    this.web,
  });

  /// Decodes a semantic envelope, returning null when absent or unusable.
  static ToolSemantic? fromJson(Object? value) {
    if (value is! Map) return null;
    switch (ToolSemanticKind.fromWire(value['kind'])) {
      case ToolSemanticKind.command:
        final command = _trimmedString(value['command']);
        if (command == null) return null;
        return ToolSemantic._(
          kind: ToolSemanticKind.command,
          command: ToolCommandSemantic(
            command: command,
            cwd: _trimmedString(value['cwd']),
            state: ToolCommandState.fromWire(value['state']),
            stdout: ToolOutputStream.fromJson(value['stdout']),
            stderr: ToolOutputStream.fromJson(value['stderr']),
          ),
        );
      case ToolSemanticKind.fileRead:
        final path = _trimmedString(value['path']);
        if (path == null) return null;
        final preview = value['preview'];
        final unavailable = value['unavailable'];
        return ToolSemantic._(
          kind: ToolSemanticKind.fileRead,
          fileRead: ToolFileReadSemantic(
            path: path,
            startLine: _positiveInt(value['startLine']),
            preview: preview is String ? preview : null,
            totalLines: _nonNegativeInt(value['totalLines']),
            previewTruncated: value['previewTruncated'] == true,
            unavailable: unavailable == null
                ? null
                : ToolReadUnavailableReason.fromWire(unavailable),
          ),
        );
      case ToolSemanticKind.search:
        final rawGroups = value['groups'];
        final groups = <ToolSearchGroup>[];
        var groupsDropped = false;
        if (rawGroups is Iterable) {
          for (final raw in rawGroups) {
            if (groups.length >= ToolSemanticDecodeBounds.searchGroups) {
              groupsDropped = true;
              break;
            }
            final group = ToolSearchGroup.fromJson(raw);
            if (group != null) groups.add(group);
          }
        }
        return ToolSemantic._(
          kind: ToolSemanticKind.search,
          search: ToolSearchSemantic(
            query: _trimmedString(value['query']),
            scope: _trimmedString(value['scope']),
            matchCount: _nonNegativeInt(value['matchCount']),
            fileCount: _nonNegativeInt(value['fileCount']),
            truncated: value['truncated'] == true || groupsDropped,
            groups: List.unmodifiable(groups),
          ),
        );
      case ToolSemanticKind.web:
        final rawResults = value['results'];
        final results = <ToolWebResult>[];
        var resultsDropped = false;
        if (rawResults is Iterable) {
          for (final raw in rawResults) {
            if (results.length >= ToolSemanticDecodeBounds.webResults) {
              resultsDropped = true;
              break;
            }
            final result = ToolWebResult.fromJson(raw);
            if (result != null) results.add(result);
          }
        }
        return ToolSemantic._(
          kind: ToolSemanticKind.web,
          web: ToolWebSemantic(
            query: _trimmedString(value['query']),
            url: _trimmedString(value['url']),
            truncated: value['truncated'] == true || resultsDropped,
            results: List.unmodifiable(results),
          ),
        );
      case ToolSemanticKind.unknown:
        return null;
    }
  }

  /// Decoded family.
  final ToolSemanticKind kind;

  /// Command detail; non-null exactly when [kind] is `command`.
  final ToolCommandSemantic? command;

  /// File-read detail; non-null exactly when [kind] is `file-read`.
  final ToolFileReadSemantic? fileRead;

  /// Search detail; non-null exactly when [kind] is `search`.
  final ToolSearchSemantic? search;

  /// Web detail; non-null exactly when [kind] is `web`.
  final ToolWebSemantic? web;
}

/// Broker-owned interaction mode for an HTML artifact.
enum ArtifactInteractionMode {
  /// Artifact content may be displayed but cannot send app actions.
  displayOnly('display-only'),

  /// A versioned structured bridge may send allow-listed actions.
  structured('structured'),

  /// A future mode that this client must treat as display-only.
  unknown('unknown');

  const ArtifactInteractionMode(this.wireValue);
  final String wireValue;

  static ArtifactInteractionMode fromWire(Object? value) => switch (value) {
    'display-only' => ArtifactInteractionMode.displayOnly,
    'structured' => ArtifactInteractionMode.structured,
    _ => ArtifactInteractionMode.unknown,
  };
}

/// Structured action classes an artifact bridge may emit.
enum ArtifactInteractionAction {
  formSubmit('form-submit'),
  action('action'),
  unknown('unknown');

  const ArtifactInteractionAction(this.wireValue);
  final String wireValue;

  static ArtifactInteractionAction fromWire(Object? value) => switch (value) {
    'form-submit' => ArtifactInteractionAction.formSubmit,
    'action' => ArtifactInteractionAction.action,
    _ => ArtifactInteractionAction.unknown,
  };
}

/// Typed policy attached to a canonical `file-artifact` message.
final class ArtifactInteractionPolicy {
  const ArtifactInteractionPolicy({
    required this.mode,
    required this.bridgeVersion,
    required this.schemaVersion,
    required this.allowedActions,
    this.interactionRef,
    this.expiresAt,
  });

  /// Decodes a policy, returning null for malformed/future versions.
  static ArtifactInteractionPolicy? fromJson(Object? value) {
    if (value is! Map) return null;
    final mode = ArtifactInteractionMode.fromWire(value['mode']);
    final bridgeVersion = _nonNegativeInt(value['bridgeVersion']);
    final schemaVersion = _nonNegativeInt(value['schemaVersion']);
    final rawActions = value['allowedActions'];
    if (mode == ArtifactInteractionMode.unknown ||
        bridgeVersion != 1 ||
        schemaVersion != 1 ||
        rawActions is! Iterable) {
      return null;
    }
    return ArtifactInteractionPolicy(
      mode: mode,
      bridgeVersion: bridgeVersion!,
      schemaVersion: schemaVersion!,
      allowedActions: List.unmodifiable(
        rawActions.map(ArtifactInteractionAction.fromWire),
      ),
      interactionRef: _trimmedString(value['interactionRef']),
      expiresAt: _nonNegativeInt(value['expiresAt']),
    );
  }

  final ArtifactInteractionMode mode;
  final int bridgeVersion;
  final int schemaVersion;
  final List<ArtifactInteractionAction> allowedActions;
  final String? interactionRef;
  final int? expiresAt;

  /// Whether a supported, signed structured bridge is currently available.
  bool get canInteract =>
      mode == ArtifactInteractionMode.structured &&
      interactionRef != null &&
      allowedActions.isNotEmpty &&
      !allowedActions.contains(ArtifactInteractionAction.unknown);
}

/// Resolution values carried by a broker `permission-resolved` message.
///
/// `external` means another client of the shared owner settled the request;
/// the broker deliberately does not reveal that client's approve/reject choice.
enum PermissionResolutionDecision {
  approve('approve'),
  approveSession('approve-session'),
  reject('reject'),
  external('external'),
  unknown('unknown');

  const PermissionResolutionDecision(this.wireValue);

  /// The value emitted on the broker wire.
  final String wireValue;

  /// Parses a broker decision without throwing on future values.
  static PermissionResolutionDecision fromWire(String? wire) {
    return switch (wire) {
      'approve' => PermissionResolutionDecision.approve,
      'approve-session' => PermissionResolutionDecision.approveSession,
      'reject' => PermissionResolutionDecision.reject,
      'external' => PermissionResolutionDecision.external,
      _ => PermissionResolutionDecision.unknown,
    };
  }
}

/// A single message in a session stream.
///
/// Decoded tolerantly: unknown JSON fields are preserved in [raw] and do not
/// cause a decode failure. Downstream renderers access type-specific fields
/// through [raw].
///
/// See `docs/protocol/contract-sync.md` for the
/// full list of canonical message types.
class AgentMessage {
  const AgentMessage({
    required this.type,
    this.id,
    this.seq,
    this.parentId,
    this.timestamp,
    this.raw = const {},
  });

  /// Decode from a JSON map, tolerantly preserving all fields in [raw].
  ///
  /// Unknown top-level fields do not cause a decode failure.
  factory AgentMessage.fromJson(Map<String, dynamic> json) {
    return AgentMessage(
      type: AgentMessageType.fromWire(json['type'] as String?),
      id: json['id'] as String?,
      seq: (json['seq'] as num?)?.toInt(),
      parentId: json['parentId'] as String?,
      timestamp: (json['timestamp'] as num?)?.toInt(),
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// The canonical message type.
  final AgentMessageType type;

  /// Message ID, if the broker assigns one.
  final String? id;

  /// Sequence number within the session, if applicable.
  ///
  /// Replay frames use `seq: 0`; live frames have incrementing seq values.
  final int? seq;

  /// Parent message ID for threaded messages.
  final String? parentId;

  /// Broker-assigned timestamp (milliseconds since epoch).
  final int? timestamp;

  /// The full raw JSON of this message, preserving all fields.
  ///
  /// Downstream code accesses type-specific fields through this map.
  /// Unknown or additive broker fields are preserved without crashing.
  final Map<String, dynamic> raw;

  Map<String, dynamic> toJson() => Map<String, dynamic>.of(raw);

  @override
  String toString() => 'AgentMessage(type: ${type.wireValue})';
}

/// Typed accessors for additive transcript notice/reset semantics.
extension TranscriptSemanticAgentMessage on AgentMessage {
  Map<Object?, Object?>? get _transcriptSemantic {
    final value = raw['semantic'];
    return value is Map ? value : null;
  }

  /// Structured notice kind, null when this is not a notice or has no semantic.
  TranscriptNoticeSemanticKind? get transcriptNoticeSemanticKind {
    if (type != AgentMessageType.notice) return null;
    final semantic = _transcriptSemantic;
    if (semantic == null) return null;
    return TranscriptNoticeSemanticKind.fromWire(semantic['kind']);
  }

  /// Structured interruption reason, null for a generic/unstructured notice.
  TranscriptInterruptionReason? get transcriptInterruptionReason {
    if (transcriptNoticeSemanticKind !=
        TranscriptNoticeSemanticKind.interruption) {
      return null;
    }
    return TranscriptInterruptionReason.fromWire(
      _transcriptSemantic?['reason'],
    );
  }

  /// Exact native turn ownership supplied by the adapter, when available.
  String? get transcriptInterruptionTurnId {
    if (transcriptNoticeSemanticKind !=
        TranscriptNoticeSemanticKind.interruption) {
      return null;
    }
    return _trimmedString(_transcriptSemantic?['turnId']);
  }

  /// Structured history-reset kind, null when absent or on another message.
  HistoryResetSemanticKind? get historyResetSemanticKind {
    if (type != AgentMessageType.historyReset) return null;
    final semantic = _transcriptSemantic;
    if (semantic == null) return null;
    return HistoryResetSemanticKind.fromWire(semantic['kind']);
  }
}

/// Canonical lifecycle values carried by a broker `status` message.
enum AgentMessageStatus {
  /// A turn is actively running.
  running('running'),

  /// The session reached an authoritative idle turn boundary.
  idle('idle'),

  /// A future or malformed status value.
  unknown('unknown');

  const AgentMessageStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses current and future broker values without throwing.
  static AgentMessageStatus fromWire(String? value) => switch (value) {
    'running' => AgentMessageStatus.running,
    'idle' => AgentMessageStatus.idle,
    _ => AgentMessageStatus.unknown,
  };
}

/// Typed accessors for canonical broker `status` messages.
extension StatusAgentMessage on AgentMessage {
  /// The published turn status, or `null` for another message type.
  ///
  /// Missing, wrongly typed, and future values fail closed to
  /// [AgentMessageStatus.unknown].
  AgentMessageStatus? get agentMessageStatus {
    if (type != AgentMessageType.status) return null;
    final value = raw['status'];
    return AgentMessageStatus.fromWire(value is String ? value : null);
  }

  /// Opaque provider detail for a canonical status message.
  ///
  /// Missing, wrongly typed, empty, and non-status values fail closed.
  String? get statusDetail {
    if (type != AgentMessageType.status) return null;
    final value = raw['detail'];
    if (value is! String) return null;
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }
}

/// Typed accessors for `permission-resolved` message fields.
extension PermissionResolvedAgentMessage on AgentMessage {
  /// The resolution decision, or `null` for another message type.
  ///
  /// Missing, wrongly typed, and future values map to
  /// [PermissionResolutionDecision.unknown].
  PermissionResolutionDecision? get permissionResolutionDecision {
    if (type != AgentMessageType.permissionResolved) return null;
    final value = raw['decision'];
    return PermissionResolutionDecision.fromWire(
      value is String ? value : null,
    );
  }
}

/// One selectable answer advertised by a canonical `question-request`.
final class AgentQuestionOption {
  /// Creates a selectable answer.
  const AgentQuestionOption({required this.label, this.description});

  /// User-visible value sent back to the broker when selected.
  final String label;

  /// Optional explanation supplied by the agent.
  final String? description;
}

/// One question in a canonical `question-request`.
final class AgentQuestion {
  /// Creates a structured agent question.
  const AgentQuestion({
    required this.question,
    required this.options,
    this.header,
    this.multiple = false,
  });

  /// The question body.
  final String question;

  /// Optional short heading for this question.
  final String? header;

  /// Selectable answer choices.
  final List<AgentQuestionOption> options;

  /// Whether more than one advertised option may be selected.
  final bool multiple;
}

/// Typed accessors for canonical permission and question requests.
extension RequestAgentMessage on AgentMessage {
  /// Whether the broker surfaced this request for display only.
  bool get requestIsReadOnly =>
      (type == AgentMessageType.permissionRequest ||
          type == AgentMessageType.questionRequest) &&
      raw['readOnly'] == true;

  /// Canonical permission title, if supplied.
  String? get permissionRequestTitle =>
      type == AgentMessageType.permissionRequest
      ? _trimmedString(raw['title'])
      : null;

  /// Canonical permission detail/resource summary, if supplied.
  String? get permissionRequestDetail =>
      type == AgentMessageType.permissionRequest
      ? _trimmedString(raw['detail'])
      : null;

  /// Canonical permission decision options advertised by the broker.
  List<String> get permissionRequestOptions {
    if (type != AgentMessageType.permissionRequest) return const [];
    final value = raw['options'];
    if (value is! Iterable) return const [];
    return List.unmodifiable(
      value.map(_trimmedString).whereType<String>(),
    );
  }

  /// Structured questions carried by a canonical `question-request`.
  List<AgentQuestion> get questionRequestQuestions {
    if (type != AgentMessageType.questionRequest) return const [];
    final value = raw['questions'];
    if (value is! Iterable) return const [];
    final questions = <AgentQuestion>[];
    for (final item in value) {
      if (item is! Map) continue;
      final question = _trimmedString(item['question']);
      if (question == null) continue;
      final rawOptions = item['options'];
      final options = <AgentQuestionOption>[];
      if (rawOptions is Iterable) {
        for (final rawOption in rawOptions) {
          if (rawOption is! Map) continue;
          final label = _trimmedString(rawOption['label']);
          if (label == null) continue;
          options.add(
            AgentQuestionOption(
              label: label,
              description: _trimmedString(rawOption['description']),
            ),
          );
        }
      }
      questions.add(
        AgentQuestion(
          question: question,
          header: _trimmedString(item['header']),
          options: List.unmodifiable(options),
          multiple: item['multiple'] == true,
        ),
      );
    }
    return List.unmodifiable(questions);
  }
}

/// Typed accessors for canonical tool-message fields.
extension ToolAgentMessage on AgentMessage {
  /// Adapter-owned display class, or `null` for non-tool messages and an
  /// absent/wrongly typed field.
  ///
  /// Future string values decode as [ToolDisplayClass.unknown], which keeps
  /// them collapsed and ungrouped.
  ToolDisplayClass? get toolDisplayClass {
    if (type != AgentMessageType.toolCall &&
        type != AgentMessageType.toolResult) {
      return null;
    }
    final value = raw['toolClass'];
    if (value is! String) return null;
    return ToolDisplayClass.fromWire(value);
  }

  /// Origin and material of a [kContextInjectionEvent] event, when this is one.
  ///
  /// Returns `null` for every other message, so a caller cannot accidentally
  /// render an unrelated event through the context presentation.
  ///
  /// `truncated` is true when the adapter clipped the material at the shared
  /// body ceiling, so the reader can be told the block is a prefix instead of
  /// being shown a body that merely stops. A missing or non-bool flag reads as
  /// false — an older broker that never sends one is claiming nothing.
  ({String source, String body, bool truncated})? get contextInjection {
    if (eventName != kContextInjectionEvent) return null;
    final payload = raw['payload'];
    if (payload is! Map) return null;
    final source = payload['source'];
    final body = payload['body'];
    if (source is! String || body is! String || body.isEmpty) return null;
    return (
      source: source,
      body: body,
      truncated: payload['truncated'] == true,
    );
  }

  /// Canonical event name, for [AgentMessageType.event] frames that carry one.
  ///
  /// Read as a typed field rather than dug out of the payload at each call
  /// site, because the name is the only thing that tells one event from
  /// another. It is NOT a display string: adapters namespace these
  /// (`dsh.session-event`), and rendering one verbatim is the raw-identifier
  /// leakage the transcript exists to keep out.
  String? get eventName {
    if (type != AgentMessageType.event) return null;
    final value = raw['name'];
    return value is String && value.isNotEmpty ? value : null;
  }

  /// Stable call id shared by a tool call and its result, when present.
  String? get toolCallId {
    if (type != AgentMessageType.toolCall &&
        type != AgentMessageType.toolResult) {
      return null;
    }
    final value = raw['callId'];
    return value is String && value.isNotEmpty ? value : null;
  }

  /// Adapter-normalized structured detail, or `null` for non-tool messages, an
  /// absent envelope, and a future family this client cannot present.
  ///
  /// Decoding is deliberately eager but bounded: every field is already clamped
  /// on the wire, so this allocates at most one bounded envelope per message
  /// and never retains the raw payload.
  ToolSemantic? get toolSemantic {
    if (type != AgentMessageType.toolCall &&
        type != AgentMessageType.toolResult) {
      return null;
    }
    return ToolSemantic.fromJson(raw['semantic']);
  }

  /// Authoritative native tool duration in milliseconds.
  ///
  /// Only finite, non-negative `tool-result.durationMs` values are exposed.
  /// The client never derives a duration from receive time.
  double? get toolDurationMs {
    if (type != AgentMessageType.toolResult) return null;
    final value = raw['durationMs'];
    if (value is! num || !value.isFinite || value < 0) return null;
    return value.toDouble();
  }
}

/// Typed accessors for canonical queued user-message identity.
extension UserAgentMessage on AgentMessage {
  /// Stable user-message identity, or `null` when absent.
  String? get userMessageKey {
    if (type != AgentMessageType.userMessage) return null;
    final value = raw['key'];
    return value is String && value.isNotEmpty ? value : null;
  }

  /// Broker-controlled app-send correlation token the adapter stamped on this
  /// echo, or `null` for terminal-typed messages and legacy echoes.
  ///
  /// This correlates one echo with one exact app send. It is never canonical
  /// dedupe/merge identity — that stays [userMessageKey].
  String? get userMessageClientKey {
    if (type != AgentMessageType.userMessage) return null;
    final value = raw['clientKey'];
    return value is String && value.isNotEmpty ? value : null;
  }

  /// Whether this user message is waiting to be delivered to the agent.
  bool get userMessageQueued =>
      type == AgentMessageType.userMessage && raw['queued'] == true;
}

/// Broker-side truncation of a message body, for bounded history replay.
extension TruncatedBodyAgentMessage on AgentMessage {
  /// Whether the broker shortened this message's body to fit a bounded replay.
  ///
  /// Set only on the families the broker is allowed to substitute
  /// (`model-output`, `thinking`, `user-message`): a message too large to send
  /// whose shape could not survive shortening is left out of the frame
  /// entirely rather than sent incomplete, and the frame's gap notice accounts
  /// for it. The broker never writes an explanation into the body itself, so
  /// this flag is what lets the client say so in the reader's own language.
  bool get bodyTruncated =>
      (type == AgentMessageType.modelOutput ||
          type == AgentMessageType.thinking ||
          type == AgentMessageType.userMessage) &&
      raw['bodyTruncated'] == true;
}

/// Canonical lifecycle values for a broker `goal-state` message.
enum GoalStateStatus {
  active('active'),
  done('done'),
  blocked('blocked'),
  error('error'),
  paused('paused'),
  cleared('cleared'),
  unknown('unknown');

  const GoalStateStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static GoalStateStatus fromWire(String? value) => switch (value) {
    'active' => GoalStateStatus.active,
    'done' => GoalStateStatus.done,
    'blocked' => GoalStateStatus.blocked,
    'error' => GoalStateStatus.error,
    'paused' => GoalStateStatus.paused,
    'cleared' => GoalStateStatus.cleared,
    _ => GoalStateStatus.unknown,
  };
}

/// Typed, validated view of a canonical `goal-state` message.
final class GoalStateSnapshot {
  /// Creates a typed goal snapshot.
  const GoalStateSnapshot({
    required this.key,
    required this.status,
    this.title,
    this.detail,
    this.startedAt,
    this.elapsedMs,
  });

  /// Decodes [message], returning null for another or malformed message.
  static GoalStateSnapshot? fromMessage(AgentMessage message) {
    if (message.type != AgentMessageType.goalState) return null;
    final statusValue = message.raw['status'];
    final status = GoalStateStatus.fromWire(
      statusValue is String ? statusValue : null,
    );
    if (status == GoalStateStatus.unknown) return null;
    final rawKey = message.raw['key'];
    final rawTitle = message.raw['title'];
    final rawDetail = message.raw['detail'];
    return GoalStateSnapshot(
      key: rawKey is String && rawKey.trim().isNotEmpty
          ? rawKey.trim()
          : 'current',
      status: status,
      title: rawTitle is String && rawTitle.trim().isNotEmpty
          ? rawTitle.trim()
          : null,
      detail: rawDetail is String && rawDetail.trim().isNotEmpty
          ? rawDetail.trim()
          : null,
      startedAt: _nonNegativeInt(message.raw['startedAt']),
      elapsedMs: _nonNegativeInt(message.raw['elapsedMs']),
    );
  }

  /// Stable broker upsert key; defaults to `current` when omitted.
  final String key;

  /// Current canonical lifecycle status.
  final GoalStateStatus status;

  /// User-facing objective, when published.
  final String? title;

  /// Optional phase or blocker detail.
  final String? detail;

  /// Authoritative start time in epoch milliseconds.
  final int? startedAt;

  /// Authoritative elapsed duration in milliseconds.
  final int? elapsedMs;
}

/// Canonical lifecycle values for a broker task-list state.
enum TaskListStateStatus {
  running('running'),
  done('done'),
  cleared('cleared'),
  unknown('unknown');

  const TaskListStateStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static TaskListStateStatus fromWire(String? value) => switch (value) {
    'running' => TaskListStateStatus.running,
    'done' => TaskListStateStatus.done,
    'cleared' => TaskListStateStatus.cleared,
    _ => TaskListStateStatus.unknown,
  };
}

/// Broker-authored lifecycle for an exact native plan.
enum PlanSemanticState {
  proposed('proposed'),
  active('active'),
  completed('completed'),
  exited('exited'),
  unknown('unknown');

  const PlanSemanticState(this.wireValue);
  final String wireValue;

  static PlanSemanticState fromWire(Object? value) => switch (value) {
    'proposed' => PlanSemanticState.proposed,
    'active' => PlanSemanticState.active,
    'completed' => PlanSemanticState.completed,
    'exited' => PlanSemanticState.exited,
    _ => PlanSemanticState.unknown,
  };
}

/// Explicit plan identity, revision, lifecycle, and action availability.
final class PlanSemantic {
  const PlanSemantic({
    required this.planKey,
    required this.revision,
    required this.state,
    required this.canApprove,
    required this.canEdit,
    required this.canExit,
  });

  /// Decodes a typed plan marker, returning null for malformed/future data.
  static PlanSemantic? fromJson(Object? value) {
    if (value is! Map || value['kind'] != 'plan') return null;
    final planKey = _shortPolicyToken(value['planKey']);
    final revision = _shortPolicyToken(value['revision']);
    final state = PlanSemanticState.fromWire(value['state']);
    final actions = value['actions'];
    if (planKey == null ||
        revision == null ||
        state == PlanSemanticState.unknown ||
        actions is! Map ||
        actions['approve'] is! bool ||
        actions['edit'] is! bool ||
        actions['exit'] is! bool) {
      return null;
    }
    return PlanSemantic(
      planKey: planKey,
      revision: revision,
      state: state,
      canApprove: actions['approve'] == true,
      canEdit: actions['edit'] == true,
      canExit: actions['exit'] == true,
    );
  }

  final String planKey;
  final String revision;
  final PlanSemanticState state;
  final bool canApprove;
  final bool canEdit;
  final bool canExit;

  /// Terminal plans remain displayable but cannot dispatch lifecycle actions.
  bool get isTerminal =>
      state == PlanSemanticState.completed || state == PlanSemanticState.exited;
}

/// Canonical lifecycle values for one task item.
enum TaskItemStatus {
  open('open'),
  inProgress('in-progress'),
  done('done'),
  cancelled('cancelled'),
  unknown('unknown');

  const TaskItemStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static TaskItemStatus fromWire(String? value) => switch (value) {
    'open' => TaskItemStatus.open,
    'in-progress' => TaskItemStatus.inProgress,
    'done' => TaskItemStatus.done,
    'cancelled' => TaskItemStatus.cancelled,
    _ => TaskItemStatus.unknown,
  };
}

/// Typed task row inside a [TaskListStateSnapshot].
final class TaskStateItem {
  /// Creates a typed task item.
  const TaskStateItem({
    required this.title,
    required this.status,
    this.id,
    this.detail,
    this.priority,
  });

  /// Optional native item identity.
  final String? id;

  /// User-facing task title.
  final String title;

  /// Current task status.
  final TaskItemStatus status;

  /// Optional short detail.
  final String? detail;

  /// Optional low/normal/high broker priority.
  final String? priority;
}

/// Typed, validated view of a canonical `task-list-state` message.
final class TaskListStateSnapshot {
  /// Creates a typed task-list snapshot.
  const TaskListStateSnapshot({
    required this.key,
    required this.status,
    required this.items,
    this.title,
    this.source,
    this.semantic,
    this.updatedAt,
  });

  /// Decodes [message], returning null for another or malformed message.
  static TaskListStateSnapshot? fromMessage(AgentMessage message) {
    if (message.type != AgentMessageType.taskListState) return null;
    final rawKey = message.raw['key'];
    if (rawKey is! String || rawKey.trim().isEmpty) return null;
    final rawStatus = message.raw['status'];
    final status = TaskListStateStatus.fromWire(
      rawStatus is String ? rawStatus : null,
    );
    if (status == TaskListStateStatus.unknown) return null;
    final rawItems = message.raw['items'];
    if (rawItems is! Iterable) return null;
    final items = <TaskStateItem>[];
    for (final value in rawItems) {
      if (value is! Map) continue;
      final rawTitle = value['title'];
      if (rawTitle is! String || rawTitle.trim().isEmpty) continue;
      final rawItemStatus = value['status'];
      final itemStatus = TaskItemStatus.fromWire(
        rawItemStatus is String ? rawItemStatus : null,
      );
      final rawId = value['id'];
      final rawDetail = value['detail'];
      final rawPriority = value['priority'];
      items.add(
        TaskStateItem(
          id: rawId is String && rawId.trim().isNotEmpty ? rawId.trim() : null,
          title: rawTitle.trim(),
          status: itemStatus,
          detail: rawDetail is String && rawDetail.trim().isNotEmpty
              ? rawDetail.trim()
              : null,
          priority: rawPriority is String && rawPriority.trim().isNotEmpty
              ? rawPriority.trim()
              : null,
        ),
      );
    }
    final rawTitle = message.raw['title'];
    final rawSource = message.raw['source'];
    return TaskListStateSnapshot(
      key: rawKey.trim(),
      status: status,
      title: rawTitle is String && rawTitle.trim().isNotEmpty
          ? rawTitle.trim()
          : null,
      source: rawSource is String && rawSource.trim().isNotEmpty
          ? rawSource.trim()
          : null,
      semantic: PlanSemantic.fromJson(message.raw['semantic']),
      updatedAt: _nonNegativeInt(message.raw['updatedAt']),
      items: List.unmodifiable(items),
    );
  }

  /// Stable broker upsert key.
  final String key;

  /// Current canonical lifecycle status.
  final TaskListStateStatus status;

  /// User-facing panel title.
  final String? title;

  /// Broad diagnostic source category.
  final String? source;

  /// Exact broker-authored plan semantics; absent means a generic task list.
  final PlanSemantic? semantic;

  /// Authoritative update time in epoch milliseconds.
  final int? updatedAt;

  /// Current structured tasks.
  final List<TaskStateItem> items;
}

/// Canonical activity kind published by broker adapters.
enum AgentActivityKind {
  subagent('subagent'),
  workflow('workflow'),
  unknown('unknown');

  const AgentActivityKind(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static AgentActivityKind fromWire(String? value) => switch (value) {
    'subagent' => AgentActivityKind.subagent,
    'workflow' => AgentActivityKind.workflow,
    _ => AgentActivityKind.unknown,
  };
}

/// Canonical lifecycle for a broker `agent-activity` state row.
enum AgentActivityStatus {
  running('running'),
  done('done'),
  error('error'),
  unknown('unknown');

  const AgentActivityStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static AgentActivityStatus fromWire(String? value) => switch (value) {
    'running' => AgentActivityStatus.running,
    'done' => AgentActivityStatus.done,
    'error' => AgentActivityStatus.error,
    _ => AgentActivityStatus.unknown,
  };
}

/// Typed token counts attached to activity progress.
final class AgentActivityTokens {
  /// Creates activity token counts.
  const AgentActivityTokens({
    this.input,
    this.output,
    this.cacheRead,
    this.cacheWrite,
  });

  /// Context/input tokens. This is the TUI-equivalent subagent figure.
  final int? input;

  /// Generated/output tokens.
  final int? output;

  /// Cache-read tokens.
  final int? cacheRead;

  /// Cache-write tokens.
  final int? cacheWrite;
}

/// One optional child row inside a workflow activity.
final class AgentActivityChild {
  /// Creates a typed activity child.
  const AgentActivityChild({
    required this.key,
    required this.title,
    required this.status,
    this.phase,
    this.elapsedMs,
    this.tokens,
  });

  /// Stable broker child key.
  final String key;

  /// User-facing child label.
  final String title;

  /// Current child status. Future values fail closed to `unknown`.
  final String status;

  /// Optional workflow phase.
  final String? phase;

  /// Authoritative elapsed duration.
  final int? elapsedMs;

  /// Optional token counts.
  final AgentActivityTokens? tokens;
}

/// Typed, validated view of a canonical `agent-activity` message.
final class AgentActivitySnapshot {
  /// Creates a typed activity snapshot.
  const AgentActivitySnapshot({
    required this.key,
    required this.kind,
    required this.title,
    required this.status,
    required this.children,
    this.subtitle,
    this.elapsedMs,
    this.startedAtMs,
    this.tokens,
    this.agentsDone,
    this.agentsTotal,
    this.toolCalls,
  });

  /// Decodes [message], returning null for another or malformed message.
  static AgentActivitySnapshot? fromMessage(AgentMessage message) {
    if (message.type != AgentMessageType.agentActivity) return null;
    final rawKey = _trimmedString(message.raw['key']);
    final rawTitle = _trimmedString(message.raw['title']);
    final rawStatus = message.raw['status'];
    final status = AgentActivityStatus.fromWire(
      rawStatus is String ? rawStatus : null,
    );
    if (rawKey == null ||
        rawTitle == null ||
        status == AgentActivityStatus.unknown) {
      return null;
    }
    final rawKind = message.raw['kind'];
    return AgentActivitySnapshot(
      key: rawKey,
      kind: AgentActivityKind.fromWire(rawKind is String ? rawKind : null),
      title: rawTitle,
      status: status,
      subtitle: _trimmedString(message.raw['subtitle']),
      elapsedMs: _nonNegativeInt(message.raw['elapsedMs']),
      startedAtMs: _nonNegativeInt(message.raw['startedAtMs']),
      tokens: _activityTokens(message.raw['tokens']),
      agentsDone: _nonNegativeInt(message.raw['agentsDone']),
      agentsTotal: _nonNegativeInt(message.raw['agentsTotal']),
      toolCalls: _nonNegativeInt(message.raw['toolCalls']),
      children: _activityChildren(message.raw['children']),
    );
  }

  /// Stable broker upsert key.
  final String key;

  /// Structured activity kind; future values remain generic.
  final AgentActivityKind kind;

  /// User-facing primary label.
  final String title;

  /// Optional agent type or workflow phase.
  final String? subtitle;

  /// Current lifecycle status.
  final AgentActivityStatus status;

  /// Authoritative elapsed duration at the latest frame.
  final int? elapsedMs;

  /// Authoritative wall-clock start for client-side ticking.
  final int? startedAtMs;

  /// Optional token totals.
  final AgentActivityTokens? tokens;

  /// Number of completed child agents.
  final int? agentsDone;

  /// Total number of child agents.
  final int? agentsTotal;

  /// Tool-call total for a workflow.
  final int? toolCalls;

  /// Optional structured workflow children.
  final List<AgentActivityChild> children;
}

AgentActivityTokens? _activityTokens(Object? raw) {
  if (raw is! Map) return null;
  final tokens = AgentActivityTokens(
    input: _nonNegativeInt(raw['input']),
    output: _nonNegativeInt(raw['output']),
    cacheRead: _nonNegativeInt(raw['cacheRead']),
    cacheWrite: _nonNegativeInt(raw['cacheWrite']),
  );
  if (tokens.input == null &&
      tokens.output == null &&
      tokens.cacheRead == null &&
      tokens.cacheWrite == null) {
    return null;
  }
  return tokens;
}

List<AgentActivityChild> _activityChildren(Object? raw) {
  if (raw is! Iterable) return const [];
  return List.unmodifiable([
    for (final value in raw)
      if (value is Map)
        if ((_trimmedString(value['key']), _trimmedString(value['title']))
            case (final String key, final String title))
          AgentActivityChild(
            key: key,
            title: title,
            status: _trimmedString(value['status']) ?? 'unknown',
            phase: _trimmedString(value['phase']),
            elapsedMs: _nonNegativeInt(value['elapsedMs']),
            tokens: _activityTokens(value['tokens']),
          ),
  ]);
}

String? _trimmedString(Object? value) {
  if (value is! String || value.trim().isEmpty) return null;
  return value.trim();
}

String? _shortPolicyToken(Object? value, {int maxLength = 200}) {
  if (value is! String || !isShortPolicyToken(value, maxLength: maxLength)) {
    return null;
  }
  return value;
}

int? _nonNegativeInt(Object? value) {
  if (value is! num || !value.isFinite || value < 0) return null;
  return value.toInt();
}

int? _positiveInt(Object? value) {
  final parsed = _nonNegativeInt(value);
  return parsed == null || parsed == 0 ? null : parsed;
}
