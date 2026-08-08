// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'rest_responses.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ListSessionsResponse _$ListSessionsResponseFromJson(
  Map<String, dynamic> json,
) => ListSessionsResponse(
  sessions: (json['sessions'] as List<dynamic>)
      .map((e) => SessionInfo.fromJson(e as Map<String, dynamic>))
      .toList(),
  machine: json['machine'] as String?,
  machineId: json['machineId'] as String?,
  generatedAt: (json['generatedAt'] as num?)?.toInt(),
  revision: (json['revision'] as num?)?.toInt(),
);

Map<String, dynamic> _$ListSessionsResponseToJson(
  ListSessionsResponse instance,
) => <String, dynamic>{
  'machine': instance.machine,
  'machineId': instance.machineId,
  'generatedAt': instance.generatedAt,
  'revision': instance.revision,
  'sessions': instance.sessions,
};

CreateSessionResponse _$CreateSessionResponseFromJson(
  Map<String, dynamic> json,
) => CreateSessionResponse(
  session: SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
  attachMode: json['attachMode'] as String?,
);

Map<String, dynamic> _$CreateSessionResponseToJson(
  CreateSessionResponse instance,
) => <String, dynamic>{
  'session': instance.session,
  'attachMode': instance.attachMode,
};

ModelCatalogResponse _$ModelCatalogResponseFromJson(
  Map<String, dynamic> json,
) => ModelCatalogResponse(
  tool: json['tool'] as String,
  models: (json['models'] as List<dynamic>)
      .map((e) => ModelOption.fromJson(e as Map<String, dynamic>))
      .toList(),
  refreshedAt: (json['refreshedAt'] as num).toInt(),
);

Map<String, dynamic> _$ModelCatalogResponseToJson(
  ModelCatalogResponse instance,
) => <String, dynamic>{
  'tool': instance.tool,
  'models': instance.models,
  'refreshedAt': instance.refreshedAt,
};

ForkSessionResponse _$ForkSessionResponseFromJson(Map<String, dynamic> json) =>
    ForkSessionResponse(
      ok: json['ok'] as bool,
      session: json['session'] == null
          ? null
          : SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$ForkSessionResponseToJson(
  ForkSessionResponse instance,
) => <String, dynamic>{'ok': instance.ok, 'session': instance.session};

CloneSessionResponse _$CloneSessionResponseFromJson(
  Map<String, dynamic> json,
) => CloneSessionResponse(
  ok: json['ok'] as bool,
  session: json['session'] == null
      ? null
      : SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
);

Map<String, dynamic> _$CloneSessionResponseToJson(
  CloneSessionResponse instance,
) => <String, dynamic>{'ok': instance.ok, 'session': instance.session};

TranscriptExportPreflightResponse _$TranscriptExportPreflightResponseFromJson(
  Map<String, dynamic> json,
) => TranscriptExportPreflightResponse(
  ok: json['ok'] as bool,
  nonce: json['nonce'] as String,
  expiresAt: (json['expiresAt'] as num).toInt(),
  confirm: TranscriptExportConfirm.fromJson(
    json['confirm'] as Map<String, dynamic>,
  ),
);

Map<String, dynamic> _$TranscriptExportPreflightResponseToJson(
  TranscriptExportPreflightResponse instance,
) => <String, dynamic>{
  'ok': instance.ok,
  'nonce': instance.nonce,
  'expiresAt': instance.expiresAt,
  'confirm': instance.confirm,
};

TranscriptExportConfirm _$TranscriptExportConfirmFromJson(
  Map<String, dynamic> json,
) => TranscriptExportConfirm(
  action: json['action'] as String,
  tool: json['tool'] as String,
  sessionId: json['sessionId'] as String,
  sessionTitle: json['sessionTitle'] as String,
  format: json['format'] as String,
  redactionMode: json['redactionMode'] as String,
  tier: json['tier'] as String,
  retentionMinutes: (json['retentionMinutes'] as num).toInt(),
  sizeCapBytes: (json['sizeCapBytes'] as num).toInt(),
  irreversible: json['irreversible'] as bool,
  message: json['message'] as String,
);

Map<String, dynamic> _$TranscriptExportConfirmToJson(
  TranscriptExportConfirm instance,
) => <String, dynamic>{
  'action': instance.action,
  'tool': instance.tool,
  'sessionId': instance.sessionId,
  'sessionTitle': instance.sessionTitle,
  'format': instance.format,
  'redactionMode': instance.redactionMode,
  'tier': instance.tier,
  'retentionMinutes': instance.retentionMinutes,
  'sizeCapBytes': instance.sizeCapBytes,
  'irreversible': instance.irreversible,
  'message': instance.message,
};

TranscriptExportResponse _$TranscriptExportResponseFromJson(
  Map<String, dynamic> json,
) => TranscriptExportResponse(
  ok: json['ok'] as bool,
  artifact: json['artifact'] == null
      ? null
      : SessionArtifact.fromJson(json['artifact'] as Map<String, dynamic>),
);

Map<String, dynamic> _$TranscriptExportResponseToJson(
  TranscriptExportResponse instance,
) => <String, dynamic>{'ok': instance.ok, 'artifact': instance.artifact};

SessionArtifact _$SessionArtifactFromJson(Map<String, dynamic> json) =>
    SessionArtifact(
      path: json['path'] as String?,
      name: json['name'] as String?,
      mimeType: json['mimeType'] as String?,
      size: (json['size'] as num?)?.toInt(),
      url: json['url'] as String?,
      artifactKey: json['artifactKey'] as String?,
      contentHash: json['contentHash'] as String?,
      fetchUrl: json['fetchUrl'] as String?,
      proactive: json['proactive'] as bool?,
      deliveryClass: json['deliveryClass'] as String?,
      format: json['format'] as String?,
      redactionSummary: json['redactionSummary'] as String?,
      expiresAt: (json['expiresAt'] as num?)?.toInt(),
    );

Map<String, dynamic> _$SessionArtifactToJson(SessionArtifact instance) =>
    <String, dynamic>{
      'path': instance.path,
      'name': instance.name,
      'mimeType': instance.mimeType,
      'size': instance.size,
      'url': instance.url,
      'artifactKey': instance.artifactKey,
      'contentHash': instance.contentHash,
      'fetchUrl': instance.fetchUrl,
      'proactive': instance.proactive,
      'deliveryClass': instance.deliveryClass,
      'format': instance.format,
      'redactionSummary': instance.redactionSummary,
      'expiresAt': instance.expiresAt,
    };

RenameSessionResponse _$RenameSessionResponseFromJson(
  Map<String, dynamic> json,
) => RenameSessionResponse(
  ok: json['ok'] as bool,
  title: json['title'] as String?,
  session: json['session'] == null
      ? null
      : SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
);

Map<String, dynamic> _$RenameSessionResponseToJson(
  RenameSessionResponse instance,
) => <String, dynamic>{
  'ok': instance.ok,
  'title': instance.title,
  'session': instance.session,
};

RenameProjectResponse _$RenameProjectResponseFromJson(
  Map<String, dynamic> json,
) => RenameProjectResponse(
  ok: json['ok'] as bool,
  cwd: json['cwd'] as String,
  projectName: json['projectName'] as String?,
);

Map<String, dynamic> _$RenameProjectResponseToJson(
  RenameProjectResponse instance,
) => <String, dynamic>{
  'ok': instance.ok,
  'cwd': instance.cwd,
  'projectName': instance.projectName,
};

ClearSessionCacheResponse _$ClearSessionCacheResponseFromJson(
  Map<String, dynamic> json,
) => ClearSessionCacheResponse(
  ok: json['ok'] as bool,
  clearedArtifacts: (json['clearedArtifacts'] as num?)?.toInt(),
);

Map<String, dynamic> _$ClearSessionCacheResponseToJson(
  ClearSessionCacheResponse instance,
) => <String, dynamic>{
  'ok': instance.ok,
  'clearedArtifacts': instance.clearedArtifacts,
};
