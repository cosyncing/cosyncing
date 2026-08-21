import 'package:broker_contract/src/models/agent_info.dart';
import 'package:json_annotation/json_annotation.dart';

part 'session_info.g.dart';

/// Drive state for a session.
///
/// Mirrors `DriveState` from `@cosyncing/protocol`.
enum DriveState {
  /// Observing the session (read-only).
  @JsonValue('observing')
  observing,

  /// Driving the session (can send prompts).
  @JsonValue('driving')
  driving,

  /// Drive unavailable for this session.
  @JsonValue('unavailable')
  unavailable,

  /// Unknown drive state.
  @JsonValue('unknown')
  unknown,
}

/// Session status — what the agent is doing right now.
///
/// Mirrors the `status` field from `SessionInfo` in `@cosyncing/protocol`.
enum SessionStatus {
  /// A turn is actively running.
  @JsonValue('working')
  working,

  /// Blocked on the user (pending permission/approval or question).
  @JsonValue('needs-input')
  needsInput,

  /// Available, nothing running.
  @JsonValue('idle')
  idle,
}

/// Broker-classified session origin.
///
/// An absent value means an ordinary human-started session. Unknown future
/// values fail open to [unknown] so the roster keeps them visible.
enum SessionOrigin {
  /// A session spawned by another agent session.
  @JsonValue('subagent')
  subagent,

  /// An automated or non-interactive execution.
  @JsonValue('exec')
  exec,

  /// A human-initiated IDE extension session.
  @JsonValue('vscode')
  vscode,

  /// A future origin not known to this client.
  unknown,
}

enum SessionLaunchSurface {
  @JsonValue('app')
  app,
  @JsonValue('terminal')
  terminal,
  @JsonValue('ide')
  ide,
  @JsonValue('unknown')
  unknown,
}

enum TerminalSyncPresence {
  @JsonValue('absent')
  absent,
  @JsonValue('shared')
  shared,
  @JsonValue('private')
  private,
  @JsonValue('unknown')
  unknown,
}

enum TerminalSyncAction {
  @JsonValue('join')
  join,
  @JsonValue('handoff')
  handoff,
  unknown,
}

/// Drive control for a session.
///
/// Mirrors `SessionDriveControl` from `@cosyncing/protocol`.
@JsonSerializable()
class SessionDriveControl {
  /// Creates a [SessionDriveControl].
  const SessionDriveControl({
    required this.state,
    required this.supported,
    this.reason,
    this.handoffAvailable,
    this.takeoverAvailable,
    this.takeoverMode,
  });

  /// Creates a [SessionDriveControl] from a JSON map.
  factory SessionDriveControl.fromJson(Map<String, dynamic> json) =>
      _$SessionDriveControlFromJson(json);

  /// Current drive state.
  final DriveState state;

  /// Whether drive is supported for this session.
  final bool supported;

  /// Optional reason for the current state.
  final String? reason;

  /// Whether Drive can be released to a terminal for this session.
  ///
  /// Null keeps the established behavior — a driving session offers handoff —
  /// so brokers that predate revision 15 are unchanged. False is for an adapter
  /// with no read-only surface to fall back to, where handing off would close
  /// the only owner and then fail to replace it.
  final bool? handoffAvailable;

  /// Whether a user-confirmed takeover may be offered even though [supported]
  /// is false.
  ///
  /// Null falls back to the established rule (`supported && state ==
  /// observing`). A foreign or demoted session is not drivable now, so
  /// [supported] stays false and the row stays read-only, while a takeover
  /// remains a legitimate user action.
  final bool? takeoverAvailable;

  /// Which attach mode a takeover must use.
  ///
  /// Null means [AttachMode.resume], which is what every existing takeover
  /// adapter uses. [AttachMode.unknown] means this client does not understand
  /// the broker's declared mode and must not offer takeover at all.
  @JsonKey(unknownEnumValue: AttachMode.unknown)
  final AttachMode? takeoverMode;

  /// Converts this [SessionDriveControl] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionDriveControlToJson(this);
}

/// Terminal sync state for a session.
///
/// Mirrors `SessionTerminalSync` from `@cosyncing/protocol`.
@JsonSerializable()
class SessionTerminalSync {
  /// Creates a [SessionTerminalSync].
  const SessionTerminalSync({
    required this.supported,
    required this.syncAvailable,
    required this.active,
    this.behind,
    this.presence,
    this.action,
    this.label,
    this.command,
    this.note,
    this.reason,
    this.input,
  });

  /// Creates a [SessionTerminalSync] from a JSON map.
  factory SessionTerminalSync.fromJson(Map<String, dynamic> json) =>
      _$SessionTerminalSyncFromJson(json);

  /// Whether sync infra exists for this tool/session.
  final bool supported;

  @JsonKey(unknownEnumValue: TerminalSyncPresence.unknown)
  final TerminalSyncPresence? presence;

  @JsonKey(unknownEnumValue: TerminalSyncAction.unknown)
  final TerminalSyncAction? action;

  final bool? behind;

  /// Whether sync is available right now.
  final bool syncAvailable;

  /// Whether our channel/daemon/bridge socket is connected.
  final bool active;

  /// Optional label for the sync state.
  final String? label;

  /// Optional command for terminal sync.
  final String? command;

  /// Optional note about the sync state.
  final String? note;

  /// Optional reason for the current state.
  final String? reason;

  /// What an actively-synced session accepts from the app.
  ///
  /// 'full' (default): prompts AND answers.
  /// 'answer-only': permission/question answers ONLY.
  final String? input;

  /// Converts this [SessionTerminalSync] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionTerminalSyncToJson(this);
}

/// Session control state — drive and terminal sync.
///
/// Mirrors `SessionControlState` from `@cosyncing/protocol`.
@JsonSerializable(explicitToJson: true)
class SessionControlState {
  /// Creates a [SessionControlState].
  const SessionControlState({
    required this.drive,
    required this.terminalSync,
  });

  /// Creates a [SessionControlState] from a JSON map.
  factory SessionControlState.fromJson(Map<String, dynamic> json) =>
      _$SessionControlStateFromJson(json);

  /// Drive control state.
  final SessionDriveControl drive;

  /// Terminal sync state.
  final SessionTerminalSync terminalSync;

  /// Converts this [SessionControlState] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionControlStateToJson(this);
}

/// State of the broker-selected session-level mutable owner.
enum SessionOwnerState {
  /// No active mutable owner exists.
  @JsonValue('none')
  none,

  /// A broker-owned Drive connection is active.
  @JsonValue('drive')
  drive,

  /// An active terminal-sync owner exists.
  @JsonValue('terminal-sync')
  terminalSync,

  /// A newer owner kind not known to this client.
  unknown,
}

/// One broker-process owner-projection revision.
@JsonSerializable()
class SessionOwnerRevision {
  /// Creates a session owner revision.
  const SessionOwnerRevision({required this.epoch, required this.seq});

  /// Decodes a session owner revision.
  factory SessionOwnerRevision.fromJson(Map<String, dynamic> json) =>
      _$SessionOwnerRevisionFromJson(json);

  /// Broker-process revision domain.
  final String epoch;

  /// Monotone sequence within [epoch].
  final int seq;

  /// Encodes this revision.
  Map<String, dynamic> toJson() => _$SessionOwnerRevisionToJson(this);
}

/// Session-level mutable-owner truth. Never grants one socket authority.
@JsonSerializable(explicitToJson: true)
class SessionOwnerProjection {
  /// Creates an owner projection.
  const SessionOwnerProjection({required this.revision, required this.state});

  /// Decodes an owner projection.
  factory SessionOwnerProjection.fromJson(Map<String, dynamic> json) =>
      _$SessionOwnerProjectionFromJson(json);

  /// Monotone owner revision.
  final SessionOwnerRevision revision;

  /// Current owner kind.
  @JsonKey(unknownEnumValue: SessionOwnerState.unknown)
  final SessionOwnerState state;

  /// Encodes this projection.
  Map<String, dynamic> toJson() => _$SessionOwnerProjectionToJson(this);
}

/// Prompt authority of one authenticated Session Detail socket.
enum SessionPromptAuthority {
  /// No prompt-class input is accepted.
  @JsonValue('none')
  none,

  /// Permission/question answers only; no new prompts.
  @JsonValue('answer-only')
  answerOnly,

  /// Full prompt-class input.
  @JsonValue('full')
  full,

  /// A newer authority kind not known to this client.
  unknown,
}

/// Broker-derived mutation authority for one Session Detail connection.
@JsonSerializable()
class SessionConnectionAuthority {
  /// Creates a connection authority projection.
  const SessionConnectionAuthority({
    required this.canMutate,
    required this.prompt,
  });

  /// Decodes connection authority.
  factory SessionConnectionAuthority.fromJson(Map<String, dynamic> json) =>
      _$SessionConnectionAuthorityFromJson(json);

  /// Whether permission/question mutations are accepted.
  final bool canMutate;

  /// Prompt-class authority.
  @JsonKey(unknownEnumValue: SessionPromptAuthority.unknown)
  final SessionPromptAuthority prompt;

  /// Encodes this authority.
  Map<String, dynamic> toJson() => _$SessionConnectionAuthorityToJson(this);
}

/// Revision-conditional action for reusing an existing Drive owner.
@JsonSerializable(explicitToJson: true)
class SessionJoinExistingAction {
  /// Creates join-existing metadata.
  const SessionJoinExistingAction({required this.ownerRevision});

  /// Decodes join-existing metadata.
  factory SessionJoinExistingAction.fromJson(Map<String, dynamic> json) =>
      _$SessionJoinExistingActionFromJson(json);

  /// Exact owner revision the join must still match.
  final SessionOwnerRevision ownerRevision;

  /// Encodes this action.
  Map<String, dynamic> toJson() => _$SessionJoinExistingActionToJson(this);
}

/// Current model information for a session.
@JsonSerializable()
class SessionCurrentModel {
  /// Creates a [SessionCurrentModel].
  const SessionCurrentModel({
    required this.providerID,
    required this.modelID,
    this.label,
    this.reasoningEffort,
    this.variant,
  });

  /// Creates a [SessionCurrentModel] from a JSON map.
  factory SessionCurrentModel.fromJson(Map<String, dynamic> json) =>
      _$SessionCurrentModelFromJson(json);

  /// Provider ID (e.g. 'anthropic').
  final String providerID;

  /// Model ID (e.g. 'claude-sonnet-4-6').
  final String modelID;

  /// Optional adapter-authored human display label.
  final String? label;

  /// Optional reasoning effort level.
  final String? reasoningEffort;

  /// Optional model variant.
  final String? variant;

  /// Converts this [SessionCurrentModel] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionCurrentModelToJson(this);
}

/// Terminal sync hint for mirroring a session in the tool's terminal UI.
@JsonSerializable()
class SessionTerminalSyncHint {
  /// Creates a [SessionTerminalSyncHint].
  const SessionTerminalSyncHint({
    required this.label,
    required this.command,
    this.note,
  });

  /// Creates a [SessionTerminalSyncHint] from a JSON map.
  factory SessionTerminalSyncHint.fromJson(Map<String, dynamic> json) =>
      _$SessionTerminalSyncHintFromJson(json);

  /// Display label.
  final String label;

  /// Command to run.
  final String command;

  /// Optional note.
  final String? note;

  /// Converts this [SessionTerminalSyncHint] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionTerminalSyncHintToJson(this);
}

/// Session info from the broker.
///
/// Mirrors `SessionInfo` from `@cosyncing/protocol`.
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable(explicitToJson: true)
class SessionInfo {
  /// Creates a [SessionInfo].
  const SessionInfo({
    required this.id,
    required this.tool,
    required this.title,
    required this.status,
    required this.attachMode,
    this.launchSurface,
    this.lineageId,
    this.liveUuid,
    this.machine,
    this.slug,
    this.cwd,
    this.projectName,
    this.origin,
    this.parentThreadId,
    this.nativeId,
    this.model,
    this.currentModel,
    this.currentAgent,
    this.currentMode,
    this.createdAt,
    this.updatedAt,
    this.terminalSyncHint,
    this.control,
    this.sessionOwner,
  });

  /// Creates a [SessionInfo] from a JSON map.
  factory SessionInfo.fromJson(Map<String, dynamic> json) =>
      _$SessionInfoFromJson(json);

  /// Stable session id within the tool.
  final String id;

  /// Stable conversation lineage id across native forks/continues.
  final String? lineageId;

  /// Live session id when the active owner differs from the saved session id.
  ///
  /// Some backends publish this during owner handoff so resume and fork-aware
  /// flows should use `liveUuid` for in-process operations.
  final String? liveUuid;

  /// Backend id (e.g. 'opencode', 'pi', 'claude').
  final String tool;

  @JsonKey(unknownEnumValue: SessionLaunchSurface.unknown)
  final SessionLaunchSurface? launchSurface;

  /// Set by the broker (machine/tailnet name); undefined locally.
  final String? machine;

  /// Session title.
  final String title;

  /// Optional URL slug.
  final String? slug;

  /// Current working directory.
  final String? cwd;

  /// User-facing broker/project alias for this cwd group.
  final String? projectName;

  /// How this session came to exist when it was not directly human-started.
  ///
  /// Absent and [SessionOrigin.unknown] values remain visible by default.
  @JsonKey(unknownEnumValue: SessionOrigin.unknown)
  final SessionOrigin? origin;

  /// Native parent thread id for a [SessionOrigin.subagent] row.
  final String? parentThreadId;

  /// Tool-native thread/session id used to resolve parent linkage.
  final String? nativeId;

  /// Current session status.
  final SessionStatus status;

  /// Best attach mode available for this session right now.
  ///
  /// Decodes an unrecognized broker value to [AttachMode.unknown] rather than
  /// throwing: a future mode must cost this one field, not the whole session
  /// row. An `unknown` mode is treated as read-only and is never echoed back
  /// into a reconnect request.
  @JsonKey(unknownEnumValue: AttachMode.unknown)
  final AttachMode attachMode;

  /// Current model label (legacy).
  final String? model;

  /// Current model (provider + id), for preselecting the model picker.
  final SessionCurrentModel? currentModel;

  /// Current agent/mode (e.g. 'build'), for preselecting the agent picker.
  final String? currentAgent;

  /// Current permission mode, for preselecting the mode picker.
  final String? currentMode;

  /// Creation timestamp (epoch milliseconds).
  final int? createdAt;

  /// Last update timestamp (epoch milliseconds).
  final int? updatedAt;

  /// Optional adapter-provided instruction for mirroring this session.
  final SessionTerminalSyncHint? terminalSyncHint;

  /// Explicit Observe+Drive and True Sync state.
  final SessionControlState? control;

  /// Broker-selected session-level owner truth.
  final SessionOwnerProjection? sessionOwner;

  /// Converts this [SessionInfo] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionInfoToJson(this);
}
