// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agent_info.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AgentCapabilities _$AgentCapabilitiesFromJson(Map<String, dynamic> json) =>
    AgentCapabilities(
      integrationKind: $enumDecode(
        _$IntegrationKindEnumMap,
        json['integrationKind'],
        unknownValue: IntegrationKind.unknown,
      ),
      attachModes: (json['attachModes'] as List<dynamic>)
          .map(
            (e) => $enumDecode(
              _$AttachModeEnumMap,
              e,
              unknownValue: AttachMode.unknown,
            ),
          )
          .toList(),
      supportsObserve: json['supportsObserve'] as bool,
      supportsResume: json['supportsResume'] as bool,
      supportsLiveAttach: json['supportsLiveAttach'] as bool,
      supportsNativeArtifact: json['supportsNativeArtifact'] as bool,
      supportsNativeFileInput: json['supportsNativeFileInput'] as bool,
      supportsModelSwitch: json['supportsModelSwitch'] as bool,
      permissionGranularity: $enumDecode(
        _$PermissionGranularityEnumMap,
        json['permissionGranularity'],
      ),
      supportsCrossClientDriveSharing:
          json['supportsCrossClientDriveSharing'] as bool? ?? false,
    );

Map<String, dynamic> _$AgentCapabilitiesToJson(
  AgentCapabilities instance,
) => <String, dynamic>{
  'integrationKind': _$IntegrationKindEnumMap[instance.integrationKind]!,
  'attachModes': instance.attachModes
      .map((e) => _$AttachModeEnumMap[e]!)
      .toList(),
  'supportsObserve': instance.supportsObserve,
  'supportsResume': instance.supportsResume,
  'supportsLiveAttach': instance.supportsLiveAttach,
  'supportsCrossClientDriveSharing': instance.supportsCrossClientDriveSharing,
  'supportsNativeArtifact': instance.supportsNativeArtifact,
  'supportsNativeFileInput': instance.supportsNativeFileInput,
  'supportsModelSwitch': instance.supportsModelSwitch,
  'permissionGranularity':
      _$PermissionGranularityEnumMap[instance.permissionGranularity]!,
};

const _$IntegrationKindEnumMap = {
  IntegrationKind.httpSse: 'http-sse',
  IntegrationKind.jsonrpcStdio: 'jsonrpc-stdio',
  IntegrationKind.acpStdio: 'acp-stdio',
  IntegrationKind.sdkCallback: 'sdk-callback',
  IntegrationKind.httpWebsocket: 'http-websocket',
  IntegrationKind.ptyFloor: 'pty-floor',
  IntegrationKind.unknown: 'unknown',
};

const _$AttachModeEnumMap = {
  AttachMode.live: 'live',
  AttachMode.resume: 'resume',
  AttachMode.observe: 'observe',
  AttachMode.unknown: 'unknown',
};

const _$PermissionGranularityEnumMap = {
  PermissionGranularity.none: 'none',
  PermissionGranularity.perTool: 'per-tool',
  PermissionGranularity.perSession: 'per-session',
  PermissionGranularity.yolo: 'yolo',
};

AgentInfo _$AgentInfoFromJson(Map<String, dynamic> json) => AgentInfo(
  id: json['id'] as String,
  displayName: json['displayName'] as String,
  capabilities: AgentCapabilities.fromJson(
    json['capabilities'] as Map<String, dynamic>,
  ),
  canCreateSession: json['canCreateSession'] as bool? ?? false,
  canRenameNative: json['canRenameNative'] as bool? ?? false,
  canFork: json['canFork'] as bool? ?? false,
  canClone: json['canClone'] as bool? ?? false,
  canTranscriptExport: json['canTranscriptExport'] as bool? ?? false,
  canSelectModelAtCreation: json['canSelectModelAtCreation'] as bool? ?? false,
  syncEnabled: json['syncEnabled'] as bool?,
);

Map<String, dynamic> _$AgentInfoToJson(AgentInfo instance) => <String, dynamic>{
  'id': instance.id,
  'displayName': instance.displayName,
  'capabilities': instance.capabilities,
  'canCreateSession': instance.canCreateSession,
  'canSelectModelAtCreation': instance.canSelectModelAtCreation,
  'canRenameNative': instance.canRenameNative,
  'canFork': instance.canFork,
  'canClone': instance.canClone,
  'canTranscriptExport': instance.canTranscriptExport,
  'syncEnabled': instance.syncEnabled,
};
