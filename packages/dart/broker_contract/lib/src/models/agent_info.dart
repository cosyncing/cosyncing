import 'package:json_annotation/json_annotation.dart';

part 'agent_info.g.dart';

/// Integration kind — how an adapter talks to its underlying tool.
///
/// Mirrors `IntegrationKind` from `@cosyncing/protocol`.
enum IntegrationKind {
  /// OpenCode: opencode serve HTTP + SSE.
  @JsonValue('http-sse')
  httpSse,

  /// Codex app-server, Pi --mode rpc.
  @JsonValue('jsonrpc-stdio')
  jsonrpcStdio,

  /// ACP (Zed) agents.
  @JsonValue('acp-stdio')
  acpStdio,

  /// Claude Agent SDK.
  @JsonValue('sdk-callback')
  sdkCallback,

  /// Kimi Code: kimi web HTTP + WebSocket.
  @JsonValue('http-websocket')
  httpWebsocket,

  /// Raw PTY wrap (agentapi-style).
  @JsonValue('pty-floor')
  ptyFloor,

  /// A kind this client build does not know.
  ///
  /// Never produced by the broker; it exists purely as the landing place for
  /// `unknownEnumValue` on [AgentCapabilities.integrationKind]. Without it a
  /// strict `$enumDecode` throws on the first unrecognized kind, and because
  /// `/api/agents` is decoded as one list, that single row would abort the
  /// WHOLE roster decode — a client would lose every agent because of one it
  /// does not support. Degrading to this member costs one unusable row instead.
  unknown,
}

/// Attach mode — how a client connects to a session.
///
/// Mirrors `AttachMode` from `@cosyncing/protocol`.
enum AttachMode {
  /// Many clients on one live session via a single owner.
  @JsonValue('live')
  live,

  /// Continue a saved session as a broker-owned process.
  @JsonValue('resume')
  resume,

  /// Read-only transcript tail; always available, zero-config.
  @JsonValue('observe')
  observe,

  /// A mode this client does not recognize.
  ///
  /// Reached only through `unknownEnumValue`, never sent by a broker. A future
  /// mode must degrade one field rather than abort the surrounding decode — the
  /// same argument as [IntegrationKind.unknown], applied where the consequence
  /// is worse: aborting here would drop a whole session row.
  ///
  /// Treat it as READ-ONLY, and never echo it back into a reconnect request. A
  /// client that cannot reason about a mode cannot ask to be attached in it.
  unknown,
}

/// Permission granularity for an agent.
///
/// Mirrors `PermissionGranularity` from `@cosyncing/protocol`.
enum PermissionGranularity {
  /// No permission system.
  @JsonValue('none')
  none,

  /// Per-tool permission.
  @JsonValue('per-tool')
  perTool,

  /// Per-session permission.
  @JsonValue('per-session')
  perSession,

  /// YOLO mode (auto-approve).
  @JsonValue('yolo')
  yolo,
}

/// Agent capabilities — what an agent backend can do.
///
/// Mirrors `AgentCapabilities` from `@cosyncing/protocol`.
@JsonSerializable()
class AgentCapabilities {
  /// Creates an [AgentCapabilities].
  const AgentCapabilities({
    required this.integrationKind,
    required this.attachModes,
    required this.supportsObserve,
    required this.supportsResume,
    required this.supportsLiveAttach,
    required this.supportsNativeArtifact,
    required this.supportsNativeFileInput,
    required this.supportsModelSwitch,
    required this.permissionGranularity,
    this.supportsCrossClientDriveSharing = false,
  });

  /// Creates an [AgentCapabilities] from a JSON map.
  factory AgentCapabilities.fromJson(Map<String, dynamic> json) =>
      _$AgentCapabilitiesFromJson(json);

  /// How the adapter talks to its underlying tool.
  ///
  /// Decodes tolerantly: a kind added after this client was built lands on
  /// [IntegrationKind.unknown] instead of throwing, so one unsupported agent
  /// costs its own row and not the entire roster.
  @JsonKey(unknownEnumValue: IntegrationKind.unknown)
  final IntegrationKind integrationKind;

  /// Supported attach modes, best-first.
  ///
  /// Decodes tolerantly per element, for the same reason
  /// [integrationKind] does: `/api/agents` decodes as ONE list, so a mode added
  /// after this client was built would otherwise abort the entire agent roster
  /// rather than cost the one entry that carries it. An unrecognized member
  /// lands on [AttachMode.unknown], which no caller can act on.
  @JsonKey(unknownEnumValue: AttachMode.unknown)
  final List<AttachMode> attachModes;

  /// Whether the agent supports observe mode.
  final bool supportsObserve;

  /// Whether the agent supports resume mode.
  final bool supportsResume;

  /// Whether the agent supports live attach.
  final bool supportsLiveAttach;

  /// Whether an authenticated foreground client may reuse an existing Drive.
  @JsonKey(defaultValue: false)
  final bool supportsCrossClientDriveSharing;

  /// Whether the agent has a native "send file to user" signal.
  final bool supportsNativeArtifact;

  /// Whether the agent accepts native binary/image input.
  final bool supportsNativeFileInput;

  /// Whether the agent supports model switching.
  final bool supportsModelSwitch;

  /// Permission granularity for this agent.
  final PermissionGranularity permissionGranularity;

  /// Converts this [AgentCapabilities] to a JSON map.
  Map<String, dynamic> toJson() => _$AgentCapabilitiesToJson(this);
}

/// Agent info from the `/api/agents` endpoint.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class AgentInfo {
  /// Creates an [AgentInfo].
  const AgentInfo({
    required this.id,
    required this.displayName,
    required this.capabilities,
    required this.canCreateSession,
    required this.canRenameNative,
    required this.canFork,
    required this.canClone,
    required this.canTranscriptExport,
    this.canSelectModelAtCreation = false,
    this.syncEnabled,
  });

  /// Creates an [AgentInfo] from a JSON map.
  factory AgentInfo.fromJson(Map<String, dynamic> json) =>
      _$AgentInfoFromJson(json);

  /// Agent backend id (e.g. 'opencode', 'pi', 'codex', 'claude').
  final String id;

  /// Human-readable display name.
  final String displayName;

  /// Agent capabilities.
  final AgentCapabilities capabilities;

  /// Whether this agent can create new sessions.
  @JsonKey(name: 'canCreateSession', defaultValue: false)
  final bool canCreateSession;

  /// Whether this agent exposes a pre-session model catalog for exact
  /// selection when creating a session.
  ///
  /// Revision-7 brokers omit this additive field, which intentionally
  /// resolves to false so newer clients keep the tool-default path without
  /// probing an endpoint the older broker does not have.
  @JsonKey(name: 'canSelectModelAtCreation', defaultValue: false)
  final bool canSelectModelAtCreation;

  /// Whether this agent supports native session rename.
  @JsonKey(name: 'canRenameNative', defaultValue: false)
  final bool canRenameNative;

  /// Whether this agent supports session fork.
  @JsonKey(name: 'canFork', defaultValue: false)
  final bool canFork;

  /// Whether this agent supports session clone.
  @JsonKey(name: 'canClone', defaultValue: false)
  final bool canClone;

  /// Whether this agent supports transcript export.
  @JsonKey(name: 'canTranscriptExport', defaultValue: false)
  final bool canTranscriptExport;

  /// Whether sync is enabled for this agent (currently only Codex).
  @JsonKey(name: 'syncEnabled')
  final bool? syncEnabled;

  /// Converts this [AgentInfo] to a JSON map.
  Map<String, dynamic> toJson() => _$AgentInfoToJson(this);
}
