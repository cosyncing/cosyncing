// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'session_info.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

SessionDriveControl _$SessionDriveControlFromJson(Map<String, dynamic> json) =>
    SessionDriveControl(
      state: $enumDecode(_$DriveStateEnumMap, json['state']),
      supported: json['supported'] as bool,
      reason: json['reason'] as String?,
      willFork: json['willFork'] as bool?,
      handoffAvailable: json['handoffAvailable'] as bool?,
      takeoverAvailable: json['takeoverAvailable'] as bool?,
      takeoverMode: $enumDecodeNullable(
        _$AttachModeEnumMap,
        json['takeoverMode'],
        unknownValue: AttachMode.unknown,
      ),
    );

Map<String, dynamic> _$SessionDriveControlToJson(
  SessionDriveControl instance,
) => <String, dynamic>{
  'state': _$DriveStateEnumMap[instance.state]!,
  'supported': instance.supported,
  'reason': instance.reason,
  'willFork': instance.willFork,
  'handoffAvailable': instance.handoffAvailable,
  'takeoverAvailable': instance.takeoverAvailable,
  'takeoverMode': _$AttachModeEnumMap[instance.takeoverMode],
};

const _$DriveStateEnumMap = {
  DriveState.observing: 'observing',
  DriveState.driving: 'driving',
  DriveState.unavailable: 'unavailable',
  DriveState.unknown: 'unknown',
};

const _$AttachModeEnumMap = {
  AttachMode.live: 'live',
  AttachMode.resume: 'resume',
  AttachMode.observe: 'observe',
  AttachMode.unknown: 'unknown',
};

SessionTerminalSync _$SessionTerminalSyncFromJson(Map<String, dynamic> json) =>
    SessionTerminalSync(
      supported: json['supported'] as bool,
      syncAvailable: json['syncAvailable'] as bool,
      active: json['active'] as bool,
      behind: json['behind'] as bool?,
      presence: $enumDecodeNullable(
        _$TerminalSyncPresenceEnumMap,
        json['presence'],
        unknownValue: TerminalSyncPresence.unknown,
      ),
      action: $enumDecodeNullable(
        _$TerminalSyncActionEnumMap,
        json['action'],
        unknownValue: TerminalSyncAction.unknown,
      ),
      label: json['label'] as String?,
      command: json['command'] as String?,
      note: json['note'] as String?,
      reason: json['reason'] as String?,
      input: json['input'] as String?,
    );

Map<String, dynamic> _$SessionTerminalSyncToJson(
  SessionTerminalSync instance,
) => <String, dynamic>{
  'supported': instance.supported,
  'presence': _$TerminalSyncPresenceEnumMap[instance.presence],
  'action': _$TerminalSyncActionEnumMap[instance.action],
  'behind': instance.behind,
  'syncAvailable': instance.syncAvailable,
  'active': instance.active,
  'label': instance.label,
  'command': instance.command,
  'note': instance.note,
  'reason': instance.reason,
  'input': instance.input,
};

const _$TerminalSyncPresenceEnumMap = {
  TerminalSyncPresence.absent: 'absent',
  TerminalSyncPresence.shared: 'shared',
  TerminalSyncPresence.private: 'private',
  TerminalSyncPresence.unknown: 'unknown',
};

const _$TerminalSyncActionEnumMap = {
  TerminalSyncAction.join: 'join',
  TerminalSyncAction.handoff: 'handoff',
  TerminalSyncAction.unknown: 'unknown',
};

SessionControlState _$SessionControlStateFromJson(Map<String, dynamic> json) =>
    SessionControlState(
      drive: SessionDriveControl.fromJson(
        json['drive'] as Map<String, dynamic>,
      ),
      terminalSync: SessionTerminalSync.fromJson(
        json['terminalSync'] as Map<String, dynamic>,
      ),
    );

Map<String, dynamic> _$SessionControlStateToJson(
  SessionControlState instance,
) => <String, dynamic>{
  'drive': instance.drive.toJson(),
  'terminalSync': instance.terminalSync.toJson(),
};

SessionOwnerRevision _$SessionOwnerRevisionFromJson(
  Map<String, dynamic> json,
) => SessionOwnerRevision(
  epoch: json['epoch'] as String,
  seq: (json['seq'] as num).toInt(),
);

Map<String, dynamic> _$SessionOwnerRevisionToJson(
  SessionOwnerRevision instance,
) => <String, dynamic>{'epoch': instance.epoch, 'seq': instance.seq};

SessionOwnerProjection _$SessionOwnerProjectionFromJson(
  Map<String, dynamic> json,
) => SessionOwnerProjection(
  revision: SessionOwnerRevision.fromJson(
    json['revision'] as Map<String, dynamic>,
  ),
  state: $enumDecode(
    _$SessionOwnerStateEnumMap,
    json['state'],
    unknownValue: SessionOwnerState.unknown,
  ),
);

Map<String, dynamic> _$SessionOwnerProjectionToJson(
  SessionOwnerProjection instance,
) => <String, dynamic>{
  'revision': instance.revision.toJson(),
  'state': _$SessionOwnerStateEnumMap[instance.state]!,
};

const _$SessionOwnerStateEnumMap = {
  SessionOwnerState.none: 'none',
  SessionOwnerState.drive: 'drive',
  SessionOwnerState.terminalSync: 'terminal-sync',
  SessionOwnerState.unknown: 'unknown',
};

SessionConnectionAuthority _$SessionConnectionAuthorityFromJson(
  Map<String, dynamic> json,
) => SessionConnectionAuthority(
  canMutate: json['canMutate'] as bool,
  prompt: $enumDecode(
    _$SessionPromptAuthorityEnumMap,
    json['prompt'],
    unknownValue: SessionPromptAuthority.unknown,
  ),
);

Map<String, dynamic> _$SessionConnectionAuthorityToJson(
  SessionConnectionAuthority instance,
) => <String, dynamic>{
  'canMutate': instance.canMutate,
  'prompt': _$SessionPromptAuthorityEnumMap[instance.prompt]!,
};

const _$SessionPromptAuthorityEnumMap = {
  SessionPromptAuthority.none: 'none',
  SessionPromptAuthority.answerOnly: 'answer-only',
  SessionPromptAuthority.full: 'full',
  SessionPromptAuthority.unknown: 'unknown',
};

SessionJoinExistingAction _$SessionJoinExistingActionFromJson(
  Map<String, dynamic> json,
) => SessionJoinExistingAction(
  ownerRevision: SessionOwnerRevision.fromJson(
    json['ownerRevision'] as Map<String, dynamic>,
  ),
);

Map<String, dynamic> _$SessionJoinExistingActionToJson(
  SessionJoinExistingAction instance,
) => <String, dynamic>{'ownerRevision': instance.ownerRevision.toJson()};

SessionCurrentModel _$SessionCurrentModelFromJson(Map<String, dynamic> json) =>
    SessionCurrentModel(
      providerID: json['providerID'] as String,
      modelID: json['modelID'] as String,
      label: json['label'] as String?,
      reasoningEffort: json['reasoningEffort'] as String?,
      variant: json['variant'] as String?,
    );

Map<String, dynamic> _$SessionCurrentModelToJson(
  SessionCurrentModel instance,
) => <String, dynamic>{
  'providerID': instance.providerID,
  'modelID': instance.modelID,
  'label': instance.label,
  'reasoningEffort': instance.reasoningEffort,
  'variant': instance.variant,
};

SessionTerminalSyncHint _$SessionTerminalSyncHintFromJson(
  Map<String, dynamic> json,
) => SessionTerminalSyncHint(
  label: json['label'] as String,
  command: json['command'] as String,
  note: json['note'] as String?,
);

Map<String, dynamic> _$SessionTerminalSyncHintToJson(
  SessionTerminalSyncHint instance,
) => <String, dynamic>{
  'label': instance.label,
  'command': instance.command,
  'note': instance.note,
};

SessionInfo _$SessionInfoFromJson(Map<String, dynamic> json) => SessionInfo(
  id: json['id'] as String,
  tool: json['tool'] as String,
  title: json['title'] as String,
  status: $enumDecode(_$SessionStatusEnumMap, json['status']),
  attachMode: $enumDecode(
    _$AttachModeEnumMap,
    json['attachMode'],
    unknownValue: AttachMode.unknown,
  ),
  launchSurface: $enumDecodeNullable(
    _$SessionLaunchSurfaceEnumMap,
    json['launchSurface'],
    unknownValue: SessionLaunchSurface.unknown,
  ),
  lineageId: json['lineageId'] as String?,
  liveUuid: json['liveUuid'] as String?,
  machine: json['machine'] as String?,
  slug: json['slug'] as String?,
  cwd: json['cwd'] as String?,
  projectName: json['projectName'] as String?,
  origin: $enumDecodeNullable(
    _$SessionOriginEnumMap,
    json['origin'],
    unknownValue: SessionOrigin.unknown,
  ),
  parentThreadId: json['parentThreadId'] as String?,
  nativeId: json['nativeId'] as String?,
  model: json['model'] as String?,
  currentModel: json['currentModel'] == null
      ? null
      : SessionCurrentModel.fromJson(
          json['currentModel'] as Map<String, dynamic>,
        ),
  currentAgent: json['currentAgent'] as String?,
  currentMode: json['currentMode'] as String?,
  createdAt: (json['createdAt'] as num?)?.toInt(),
  updatedAt: (json['updatedAt'] as num?)?.toInt(),
  terminalSyncHint: json['terminalSyncHint'] == null
      ? null
      : SessionTerminalSyncHint.fromJson(
          json['terminalSyncHint'] as Map<String, dynamic>,
        ),
  control: json['control'] == null
      ? null
      : SessionControlState.fromJson(json['control'] as Map<String, dynamic>),
  sessionOwner: json['sessionOwner'] == null
      ? null
      : SessionOwnerProjection.fromJson(
          json['sessionOwner'] as Map<String, dynamic>,
        ),
);

Map<String, dynamic> _$SessionInfoToJson(SessionInfo instance) =>
    <String, dynamic>{
      'id': instance.id,
      'lineageId': instance.lineageId,
      'liveUuid': instance.liveUuid,
      'tool': instance.tool,
      'launchSurface': _$SessionLaunchSurfaceEnumMap[instance.launchSurface],
      'machine': instance.machine,
      'title': instance.title,
      'slug': instance.slug,
      'cwd': instance.cwd,
      'projectName': instance.projectName,
      'origin': _$SessionOriginEnumMap[instance.origin],
      'parentThreadId': instance.parentThreadId,
      'nativeId': instance.nativeId,
      'status': _$SessionStatusEnumMap[instance.status]!,
      'attachMode': _$AttachModeEnumMap[instance.attachMode]!,
      'model': instance.model,
      'currentModel': instance.currentModel?.toJson(),
      'currentAgent': instance.currentAgent,
      'currentMode': instance.currentMode,
      'createdAt': instance.createdAt,
      'updatedAt': instance.updatedAt,
      'terminalSyncHint': instance.terminalSyncHint?.toJson(),
      'control': instance.control?.toJson(),
      'sessionOwner': instance.sessionOwner?.toJson(),
    };

const _$SessionStatusEnumMap = {
  SessionStatus.working: 'working',
  SessionStatus.needsInput: 'needs-input',
  SessionStatus.idle: 'idle',
};

const _$SessionLaunchSurfaceEnumMap = {
  SessionLaunchSurface.app: 'app',
  SessionLaunchSurface.terminal: 'terminal',
  SessionLaunchSurface.ide: 'ide',
  SessionLaunchSurface.unknown: 'unknown',
};

const _$SessionOriginEnumMap = {
  SessionOrigin.subagent: 'subagent',
  SessionOrigin.exec: 'exec',
  SessionOrigin.vscode: 'vscode',
  SessionOrigin.unknown: 'unknown',
};
