import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/widgets.dart' show StringCharacters;

/// A user-facing group of notification types (an Android channel group).
enum AttentionNotificationFamily {
  /// Session events: requests, questions, finished and failed turns.
  sessions,

  /// Device access and authentication.
  security,

  /// The broker itself: health, runtime updates, usage quota.
  server;

  /// Stable Android channel-group id.
  String get channelGroupId => 'cosy.v2.$name';
}

/// One fine-grained, user-configurable notification type.
///
/// The type — not the broker event kind — is what the user switches on or off
/// and what Android shows as one channel. Kinds that map to no type are never
/// presented as OS notifications.
enum AttentionNotificationType {
  /// An agent is waiting for permission.
  permissionRequest(
    'permission_request',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: true,
    urgent: true,
  ),

  /// An agent asked a question.
  question(
    'question',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: true,
    urgent: true,
  ),

  /// A main session turn finished.
  turnFinished(
    'turn_finished',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: false,
    urgent: false,
  ),

  /// A session goal finished.
  goalFinished(
    'goal_finished',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: false,
    urgent: false,
  ),

  /// A session turn failed.
  turnFailed(
    'turn_failed',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: true,
    urgent: false,
  ),

  /// A scheduled message could not be sent.
  scheduledSendFailed(
    'scheduled_send_failed',
    AttentionNotificationFamily.sessions,
    defaultEnabled: true,
    defaultSound: true,
    urgent: false,
  ),

  /// A device-access or authentication incident.
  securityAlert(
    'security_alert',
    AttentionNotificationFamily.security,
    defaultEnabled: true,
    defaultSound: true,
    urgent: true,
  ),

  /// A new device was paired.
  devicePaired(
    'device_paired',
    AttentionNotificationFamily.security,
    defaultEnabled: true,
    defaultSound: false,
    urgent: false,
  ),

  /// The server reported a critical or action-required health problem.
  serverProblem(
    'server_problem',
    AttentionNotificationFamily.server,
    defaultEnabled: true,
    defaultSound: true,
    urgent: true,
  ),

  /// A managed agent runtime has an update or needs a restart.
  runtimeUpdate(
    'runtime_update',
    AttentionNotificationFamily.server,
    defaultEnabled: false,
    defaultSound: false,
    urgent: false,
  ),

  /// Usage quota is running low.
  usageQuota(
    'usage_quota',
    AttentionNotificationFamily.server,
    defaultEnabled: false,
    defaultSound: false,
    urgent: false,
  );

  const AttentionNotificationType(
    this.id,
    this.family, {
    required this.defaultEnabled,
    required this.defaultSound,
    required this.urgent,
  });

  /// Stable id used in settings keys and the channel id.
  final String id;

  /// Family (Android channel group).
  final AttentionNotificationFamily family;

  /// Whether the type is on before the user changes anything.
  final bool defaultEnabled;

  /// Whether the type plays a sound before the user changes anything.
  final bool defaultSound;

  /// Whether the type interrupts (heads-up, long toast).
  final bool urgent;

  /// Stable platform channel id. Android freezes a channel's importance once
  /// created, so changing a type's defaults means a new `v` prefix.
  String get channelId => 'cosy.v2.$id';

  /// Whether the event belongs to one session and collapses per session.
  bool get isSessionOutcome =>
      this == turnFinished || this == goalFinished || this == turnFailed;

  /// Whether the notification stands for a pending request that is resolved
  /// elsewhere (answered, session ended) rather than read.
  bool get isRequest => this == permissionRequest || this == question;
}

/// Channel ids created by clients before per-type notifications. Deleted at
/// startup so Android settings list only the current types.
const legacyAttentionNotificationChannelIds = <String>{
  'cosyncing_session_action',
  'cosyncing_session_info',
  'cosyncing_session_maintenance',
  'cosyncing_session_error',
};

/// Notification type for [event], or null when the event is never an OS
/// notification (scheduled-send success, non-critical broker health,
/// sync-degraded, and kinds this client does not know).
///
/// A broker from contract revision 27 names the type itself, and that wins: a
/// type id this client does not know is never presented. An older broker names
/// none, and the kind is mapped here, exactly as the broker maps it (both are
/// tested against `contracts/fixtures/attention-notification-types.json`).
AttentionNotificationType? attentionNotificationTypeOf(AttentionEvent event) {
  final named = event.notificationType;
  if (named != null) return _typesById[named];
  return _localNotificationTypeOf(event);
}

final Map<String, AttentionNotificationType> _typesById = {
  for (final type in AttentionNotificationType.values) type.id: type,
};

AttentionNotificationType? _localNotificationTypeOf(AttentionEvent event) {
  return switch (event.kind) {
    'permission-required' => AttentionNotificationType.permissionRequest,
    'question-required' => AttentionNotificationType.question,
    'run-finished' => AttentionNotificationType.turnFinished,
    'goal-finished' => AttentionNotificationType.goalFinished,
    'run-failed' => AttentionNotificationType.turnFailed,
    'scheduled-send-failed' => AttentionNotificationType.scheduledSendFailed,
    'security-alert' => AttentionNotificationType.securityAlert,
    'device-paired' => AttentionNotificationType.devicePaired,
    'broker-health'
        when event.severity == 'action-required' ||
            event.severity == 'critical' =>
      AttentionNotificationType.serverProblem,
    'runtime-update-ready' => AttentionNotificationType.runtimeUpdate,
    'usage-threshold' => AttentionNotificationType.usageQuota,
    _ => null,
  };
}

/// The notification slot [event] occupies. Showing into an occupied slot
/// replaces what is there: a newer turn outcome replaces the session's older
/// one, and a reminder re-alerts the same request instead of stacking.
String attentionNotificationCollapseKey(
  AttentionEvent event,
  AttentionNotificationType type,
) {
  final named = event.collapseKey;
  if (named != null) return named;
  final sessionKey = _sessionKey(event);
  if (type.isSessionOutcome && sessionKey != null) {
    return 'session-outcome:$sessionKey';
  }
  final dedupeKey = event.dedupeKey.trim();
  return dedupeKey.isEmpty ? 'event:${event.id}' : dedupeKey;
}

/// Visual grouping key: every notification from one session groups together.
String? attentionNotificationThreadKey(AttentionEvent event) =>
    _sessionKey(event);

String? _sessionKey(AttentionEvent event) {
  final tool = (event.action.tool ?? event.agent)?.trim();
  final sessionId = (event.action.sessionId ?? event.sessionId)?.trim();
  if (tool == null || tool.isEmpty || sessionId == null || sessionId.isEmpty) {
    return null;
  }
  return '$tool:$sessionId';
}

/// The delivery stage of an event's first alert. Later stages are reminders.
const attentionNotificationFirstStage = 'immediate';

/// Which alert a presentation of [eventId] raises: its presentation
/// [revision] at a delivery [stage]. The app presents each revision once, as
/// its first stage; a Web Push names its own stage. Mirrors `alertKeyOf` in
/// `web/sw.js`.
String attentionNotificationAlertKey({
  required String eventId,
  required int revision,
  String stage = attentionNotificationFirstStage,
}) => '$eventId\n$revision\n$stage';

/// Longest notification body, in user-perceived characters.
const attentionNotificationBodyMaxCharacters = 48;

/// [text] cut to [max] grapheme clusters with an ellipsis, so a CJK title or
/// an emoji is never split mid-character.
String truncateAttentionNotificationText(
  String text, {
  int max = attentionNotificationBodyMaxCharacters,
}) {
  final normalized = text.trim().replaceAll(RegExp(r'\s+'), ' ');
  final characters = normalized.characters;
  if (characters.length <= max) return normalized;
  return '${characters.take(max - 1).toString().trimRight()}…';
}

/// Notification title: the event type.
String attentionNotificationTitle(
  AttentionNotificationType type,
  AppLocalizations l10n,
) => switch (type) {
  AttentionNotificationType.permissionRequest =>
    l10n.notificationTypeTitlePermissionRequest,
  AttentionNotificationType.question => l10n.notificationTypeTitleQuestion,
  AttentionNotificationType.turnFinished =>
    l10n.notificationTypeTitleTurnFinished,
  AttentionNotificationType.goalFinished =>
    l10n.notificationTypeTitleGoalFinished,
  AttentionNotificationType.turnFailed => l10n.notificationTypeTitleTurnFailed,
  AttentionNotificationType.scheduledSendFailed =>
    l10n.notificationTypeTitleScheduledSendFailed,
  AttentionNotificationType.securityAlert =>
    l10n.notificationTypeTitleSecurityAlert,
  AttentionNotificationType.devicePaired =>
    l10n.notificationTypeTitleDevicePaired,
  AttentionNotificationType.serverProblem =>
    l10n.notificationTypeTitleServerProblem,
  AttentionNotificationType.runtimeUpdate =>
    l10n.notificationTypeTitleRuntimeUpdate,
  AttentionNotificationType.usageQuota => l10n.notificationTypeTitleUsageQuota,
};

/// Settings and Android channel name for [type].
String attentionNotificationTypeName(
  AttentionNotificationType type,
  AppLocalizations l10n,
) => switch (type) {
  AttentionNotificationType.permissionRequest =>
    l10n.notificationTypeNamePermissionRequests,
  AttentionNotificationType.question => l10n.notificationTypeNameQuestions,
  AttentionNotificationType.turnFinished =>
    l10n.notificationTypeNameTurnFinished,
  AttentionNotificationType.goalFinished =>
    l10n.notificationTypeNameGoalFinished,
  AttentionNotificationType.turnFailed => l10n.notificationTypeNameTurnFailed,
  AttentionNotificationType.scheduledSendFailed =>
    l10n.notificationTypeNameScheduledSendFailed,
  AttentionNotificationType.securityAlert =>
    l10n.notificationTypeNameSecurityAlerts,
  AttentionNotificationType.devicePaired =>
    l10n.notificationTypeNameDevicePaired,
  AttentionNotificationType.serverProblem =>
    l10n.notificationTypeNameServerProblems,
  AttentionNotificationType.runtimeUpdate =>
    l10n.notificationTypeNameRuntimeUpdates,
  AttentionNotificationType.usageQuota => l10n.notificationTypeNameUsageQuota,
};

/// Settings and Android channel description for [type].
String attentionNotificationTypeDescription(
  AttentionNotificationType type,
  AppLocalizations l10n,
) => switch (type) {
  AttentionNotificationType.permissionRequest =>
    l10n.notificationTypeDescriptionPermissionRequests,
  AttentionNotificationType.question =>
    l10n.notificationTypeDescriptionQuestions,
  AttentionNotificationType.turnFinished =>
    l10n.notificationTypeDescriptionTurnFinished,
  AttentionNotificationType.goalFinished =>
    l10n.notificationTypeDescriptionGoalFinished,
  AttentionNotificationType.turnFailed =>
    l10n.notificationTypeDescriptionTurnFailed,
  AttentionNotificationType.scheduledSendFailed =>
    l10n.notificationTypeDescriptionScheduledSendFailed,
  AttentionNotificationType.securityAlert =>
    l10n.notificationTypeDescriptionSecurityAlerts,
  AttentionNotificationType.devicePaired =>
    l10n.notificationTypeDescriptionDevicePaired,
  AttentionNotificationType.serverProblem =>
    l10n.notificationTypeDescriptionServerProblems,
  AttentionNotificationType.runtimeUpdate =>
    l10n.notificationTypeDescriptionRuntimeUpdates,
  AttentionNotificationType.usageQuota =>
    l10n.notificationTypeDescriptionUsageQuota,
};

/// Settings and Android channel-group name for [family].
String attentionNotificationFamilyName(
  AttentionNotificationFamily family,
  AppLocalizations l10n,
) => switch (family) {
  AttentionNotificationFamily.sessions => l10n.notificationFamilySessions,
  AttentionNotificationFamily.security => l10n.notificationFamilySecurity,
  AttentionNotificationFamily.server => l10n.notificationFamilyServer,
};

/// Platform channel for [type], localized.
BrokerNotificationChannel attentionNotificationChannel(
  AttentionNotificationType type,
  AppLocalizations l10n,
) => BrokerNotificationChannel(
  id: type.channelId,
  name: attentionNotificationTypeName(type, l10n),
  description: attentionNotificationTypeDescription(type, l10n),
  groupId: type.family.channelGroupId,
  defaultEnabled: type.defaultEnabled,
  defaultSound: type.defaultSound,
  urgent: type.urgent,
);

/// Every channel group, localized.
List<BrokerNotificationChannelGroup> attentionNotificationChannelGroups(
  AppLocalizations l10n,
) => [
  for (final family in AttentionNotificationFamily.values)
    BrokerNotificationChannelGroup(
      id: family.channelGroupId,
      name: attentionNotificationFamilyName(family, l10n),
    ),
];
