import 'package:broker_contract/src/models/session_info.dart';
import 'package:broker_contract/src/models/stream_models.dart';
import 'package:json_annotation/json_annotation.dart';

part 'rest_responses.g.dart';

/// Response from `GET /api/sessions`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class ListSessionsResponse {
  /// Creates a [ListSessionsResponse].
  const ListSessionsResponse({
    required this.sessions,
    this.machine,
    this.machineId,
    this.generatedAt,
    this.revision,
  });

  /// Creates a [ListSessionsResponse] from a JSON map.
  factory ListSessionsResponse.fromJson(Map<String, dynamic> json) =>
      _$ListSessionsResponseFromJson(json);

  /// The machine hostname.
  final String? machine;

  /// Configured authoritative machine identity, when advertised.
  final String? machineId;

  /// Broker roster generation time in epoch milliseconds.
  final int? generatedAt;

  /// Monotonic broker roster content revision.
  final int? revision;

  /// List of sessions.
  final List<SessionInfo> sessions;

  /// Converts this [ListSessionsResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$ListSessionsResponseToJson(this);
}

/// Response from `POST /api/sessions/:tool`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class CreateSessionResponse {
  /// Creates a [CreateSessionResponse].
  const CreateSessionResponse({
    required this.session,
    this.attachMode,
  });

  /// Creates a [CreateSessionResponse] from a JSON map.
  factory CreateSessionResponse.fromJson(Map<String, dynamic> json) =>
      _$CreateSessionResponseFromJson(json);

  /// The created session info.
  final SessionInfo session;

  /// The attach mode for the created session.
  final String? attachMode;

  /// Converts this [CreateSessionResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$CreateSessionResponseToJson(this);
}

/// Response from `GET /api/agents/:tool/models`.
@JsonSerializable()
class ModelCatalogResponse {
  /// Creates a pre-session model catalog response.
  const ModelCatalogResponse({
    required this.tool,
    required this.models,
    required this.refreshedAt,
  });

  /// Decodes a model catalog response.
  factory ModelCatalogResponse.fromJson(Map<String, dynamic> json) =>
      _$ModelCatalogResponseFromJson(json);

  /// Adapter id that owns every option.
  final String tool;

  /// Exact selectable identities.
  final List<ModelOption> models;

  /// Broker observation time in epoch milliseconds.
  final int refreshedAt;

  /// Encodes this response.
  Map<String, dynamic> toJson() => _$ModelCatalogResponseToJson(this);
}

/// Response from `POST /api/sessions/:tool/:id/fork`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class ForkSessionResponse {
  /// Creates a [ForkSessionResponse].
  const ForkSessionResponse({
    required this.ok,
    this.session,
  });

  /// Creates a [ForkSessionResponse] from a JSON map.
  factory ForkSessionResponse.fromJson(Map<String, dynamic> json) =>
      _$ForkSessionResponseFromJson(json);

  /// Whether the fork request was accepted.
  final bool ok;

  /// Optional resulting session.
  final SessionInfo? session;

  /// Converts this [ForkSessionResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$ForkSessionResponseToJson(this);
}

/// Response from `POST /api/sessions/:tool/:id/clone`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class CloneSessionResponse {
  /// Creates a [CloneSessionResponse].
  const CloneSessionResponse({
    required this.ok,
    this.session,
  });

  /// Creates a [CloneSessionResponse] from a JSON map.
  factory CloneSessionResponse.fromJson(Map<String, dynamic> json) =>
      _$CloneSessionResponseFromJson(json);

  /// Whether the clone request was accepted.
  final bool ok;

  /// Optional resulting session.
  final SessionInfo? session;

  /// Converts this [CloneSessionResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$CloneSessionResponseToJson(this);
}

/// Response from `POST /api/sessions/:tool/:id/export/preflight`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class TranscriptExportPreflightResponse {
  /// Creates a [TranscriptExportPreflightResponse].
  const TranscriptExportPreflightResponse({
    required this.ok,
    required this.nonce,
    required this.expiresAt,
    required this.confirm,
  });

  /// Creates a [TranscriptExportPreflightResponse] from a JSON map.
  factory TranscriptExportPreflightResponse.fromJson(
    Map<String, dynamic> json,
  ) => _$TranscriptExportPreflightResponseFromJson(json);

  /// Whether the preflight request was accepted.
  final bool ok;

  /// Confirmation nonce for the export call.
  final String nonce;

  /// Confirmation expiry timestamp in epoch milliseconds.
  final int expiresAt;

  /// Export confirmation metadata.
  final TranscriptExportConfirm confirm;

  /// Converts this [TranscriptExportPreflightResponse] to a JSON map.
  Map<String, dynamic> toJson() =>
      _$TranscriptExportPreflightResponseToJson(this);
}

/// Confirmation payload returned by transcript export preflight.
@JsonSerializable()
class TranscriptExportConfirm {
  /// Creates a [TranscriptExportConfirm].
  const TranscriptExportConfirm({
    required this.action,
    required this.tool,
    required this.sessionId,
    required this.sessionTitle,
    required this.format,
    required this.redactionMode,
    required this.tier,
    required this.retentionMinutes,
    required this.sizeCapBytes,
    required this.irreversible,
    required this.message,
  });

  /// Creates a [TranscriptExportConfirm] from a JSON map.
  factory TranscriptExportConfirm.fromJson(Map<String, dynamic> json) =>
      _$TranscriptExportConfirmFromJson(json);

  /// Export action id.
  final String action;

  /// Backend id for the session.
  final String tool;

  /// Session id that the confirmation applies to.
  final String sessionId;

  /// Session title that the confirmation applies to.
  final String sessionTitle;

  /// Export format (`json` or `html`).
  final String format;

  /// Redaction mode in force for the export.
  final String redactionMode;

  /// Trust tier for the request that generated this confirm.
  final String tier;

  /// Retention duration in minutes.
  final int retentionMinutes;

  /// Broker export size cap in bytes.
  final int sizeCapBytes;

  /// Whether this export can be revoked.
  final bool irreversible;

  /// User-facing summary message for confirmation UX.
  final String message;

  /// Converts this [TranscriptExportConfirm] to a JSON map.
  Map<String, dynamic> toJson() => _$TranscriptExportConfirmToJson(this);
}

/// Response from `POST /api/sessions/:tool/:id/export`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class TranscriptExportResponse {
  /// Creates a [TranscriptExportResponse].
  const TranscriptExportResponse({
    required this.ok,
    this.artifact,
  });

  /// Creates a [TranscriptExportResponse] from a JSON map.
  factory TranscriptExportResponse.fromJson(Map<String, dynamic> json) =>
      _$TranscriptExportResponseFromJson(json);

  /// Whether the export request was accepted.
  final bool ok;

  /// Exported file-artifact description.
  final SessionArtifact? artifact;

  /// Converts this [TranscriptExportResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$TranscriptExportResponseToJson(this);
}

/// Descriptor for an export attachment artifact.
@JsonSerializable()
class SessionArtifact {
  /// Creates a [SessionArtifact].
  const SessionArtifact({
    this.path,
    this.name,
    this.mimeType,
    this.size,
    this.url,
    this.artifactKey,
    this.contentHash,
    this.fetchUrl,
    this.proactive,
    this.deliveryClass,
    this.format,
    this.redactionSummary,
    this.expiresAt,
  });

  /// Creates a [SessionArtifact] from a JSON map.
  factory SessionArtifact.fromJson(Map<String, dynamic> json) =>
      _$SessionArtifactFromJson(json);

  /// Path or internal id for artifact lookup.
  final String? path;

  /// Human-readable artifact name.
  final String? name;

  /// Artifact MIME type.
  final String? mimeType;

  /// Artifact size in bytes.
  final int? size;

  /// Deprecated or optional direct link.
  final String? url;

  /// Stable artifact key for dedupe.
  final String? artifactKey;

  /// Optional content hash.
  final String? contentHash;

  /// Browser-safe fetch URL if available.
  final String? fetchUrl;

  /// Whether this artifact was proactively sent.
  final bool? proactive;

  /// Delivery class (`interactive` or `export-attachment`).
  final String? deliveryClass;

  /// Export format (`json` / `html`).
  final String? format;

  /// Redaction summary text for export attachments.
  final String? redactionSummary;

  /// Expiry timestamp for export artifacts.
  final int? expiresAt;

  /// Converts this [SessionArtifact] to a JSON map.
  Map<String, dynamic> toJson() => _$SessionArtifactToJson(this);
}

/// Response from `PATCH /api/sessions/:tool/:id/rename`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class RenameSessionResponse {
  /// Creates a [RenameSessionResponse].
  const RenameSessionResponse({
    required this.ok,
    this.title,
    this.session,
  });

  /// Creates a [RenameSessionResponse] from a JSON map.
  factory RenameSessionResponse.fromJson(Map<String, dynamic> json) =>
      _$RenameSessionResponseFromJson(json);

  /// Whether the rename was successful.
  final bool ok;

  /// The new title (null if cleared).
  final String? title;

  /// The updated session info (if available).
  final SessionInfo? session;

  /// Converts this [RenameSessionResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$RenameSessionResponseToJson(this);
}

/// Response from `PATCH /api/projects/rename`.
///
/// This changes only the broker's display alias for [cwd]; the directory is
/// never moved or renamed.
@JsonSerializable()
class RenameProjectResponse {
  /// Creates a [RenameProjectResponse].
  const RenameProjectResponse({
    required this.ok,
    required this.cwd,
    this.projectName,
  });

  /// Creates a [RenameProjectResponse] from a JSON map.
  factory RenameProjectResponse.fromJson(Map<String, dynamic> json) =>
      _$RenameProjectResponseFromJson(json);

  /// Whether the alias mutation succeeded.
  final bool ok;

  /// Exact directory whose display alias changed.
  final String cwd;

  /// New alias, or null when the alias was reset.
  final String? projectName;

  /// Converts this [RenameProjectResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$RenameProjectResponseToJson(this);
}

/// Response from `DELETE /api/sessions/:tool/:id/cache`.
///
/// See `docs/protocol/contract-sync.md`.
@JsonSerializable()
class ClearSessionCacheResponse {
  /// Creates a [ClearSessionCacheResponse].
  const ClearSessionCacheResponse({
    required this.ok,
    this.clearedArtifacts,
  });

  /// Creates a [ClearSessionCacheResponse] from a JSON map.
  factory ClearSessionCacheResponse.fromJson(Map<String, dynamic> json) =>
      _$ClearSessionCacheResponseFromJson(json);

  /// Whether the cache clear was successful.
  final bool ok;

  /// Number of artifacts cleared.
  final int? clearedArtifacts;

  /// Converts this [ClearSessionCacheResponse] to a JSON map.
  Map<String, dynamic> toJson() => _$ClearSessionCacheResponseToJson(this);
}
