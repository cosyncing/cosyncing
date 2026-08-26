import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';

/// Localized recovery advice for a classified [FailureKind].
String localizedFailureAdvice(
  AppLocalizations l10n,
  FailureKind kind,
) {
  return switch (kind) {
    FailureKind.offline => l10n.failureAdviceOffline,
    FailureKind.unauthorized => l10n.failureAdviceUnauthorized,
    FailureKind.rejected => l10n.failureAdviceRejected,
    FailureKind.brokerFault => l10n.failureAdviceBrokerFault,
    FailureKind.deviceStorage => l10n.failureAdviceDeviceStorage,
    FailureKind.unknown => l10n.failureAdviceUnknown,
  };
}

/// Builds localized primary copy without exposing [error]'s diagnostic text.
String localizedFailureMessage(
  AppLocalizations l10n,
  Object error, {
  required String lead,
}) {
  return l10n.failureMessage(
    lead,
    localizedFailureAdvice(l10n, classifyFailure(error)),
  );
}

/// Localized lead sentence naming the operation that failed.
String localizedFailureLead(AppLocalizations l10n, FailureLead lead) {
  return switch (lead) {
    FailureLead.accessFile => l10n.failureLeadAccessFile,
    FailureLead.acknowledgeHistory => l10n.failureLeadAcknowledgeHistory,
    FailureLead.changeSessionAgent => l10n.failureLeadChangeSessionAgent,
    FailureLead.cloneSession => l10n.failureLeadCloneSession,
    FailureLead.connectSession => l10n.failureLeadConnectSession,
    FailureLead.createSession => l10n.failureLeadCreateSession,
    FailureLead.downloadFile => l10n.failureLeadDownloadFile,
    FailureLead.exportTranscript => l10n.failureLeadExportTranscript,
    FailureLead.forkSession => l10n.failureLeadForkSession,
    FailureLead.handBackControl => l10n.failureLeadHandBackControl,
    FailureLead.loadAgents => l10n.failureLeadLoadAgents,
    FailureLead.loadEarlierHistory => l10n.failureLeadLoadEarlierHistory,
    FailureLead.loadScheduledSends => l10n.failureLeadLoadScheduledSends,
    FailureLead.loadSessions => l10n.failureLeadLoadSessions,
    FailureLead.prepareArtifactPreview =>
      l10n.failureLeadPrepareArtifactPreview,
    FailureLead.reachServer => l10n.failureLeadReachServer,
    FailureLead.refreshModelCatalog => l10n.failureLeadRefreshModelCatalog,
    FailureLead.renameSession => l10n.failureLeadRenameSession,
    FailureLead.restoreControl => l10n.failureLeadRestoreControl,
    FailureLead.saveArtifact => l10n.failureLeadSaveArtifact,
    FailureLead.saveTranscript => l10n.failureLeadSaveTranscript,
    FailureLead.scheduleSend => l10n.failureLeadScheduleSend,
    FailureLead.sendArtifactInteraction =>
      l10n.failureLeadSendArtifactInteraction,
    FailureLead.sendCommand => l10n.failureLeadSendCommand,
    FailureLead.sendPrompt => l10n.failureLeadSendPrompt,
    FailureLead.sendTranscriptReceipt => l10n.failureLeadSendTranscriptReceipt,
    FailureLead.startBackgroundDownload =>
      l10n.failureLeadStartBackgroundDownload,
    FailureLead.takeOverSession => l10n.failureLeadTakeOverSession,
    FailureLead.updateBackgroundDownload =>
      l10n.failureLeadUpdateBackgroundDownload,
    FailureLead.updatePlan => l10n.failureLeadUpdatePlan,
    FailureLead.updateSchedule => l10n.failureLeadUpdateSchedule,
    FailureLead.uploadFile => l10n.failureLeadUploadFile,
    FailureLead.permissionDecisionMissingRequestId =>
      l10n.failureNoticePermissionDecisionMissingRequestId,
    FailureLead.permissionDecisionEmpty =>
      l10n.failureNoticePermissionDecisionEmpty,
    FailureLead.permissionDecisionDisconnected =>
      l10n.failureNoticePermissionDecisionDisconnected,
    FailureLead.agentSwitchEmptyName => l10n.failureNoticeAgentSwitchEmptyName,
    FailureLead.agentSwitchUnadvertised =>
      l10n.failureNoticeAgentSwitchUnadvertised,
    FailureLead.agentSwitchRequiresDrive =>
      l10n.failureNoticeAgentSwitchRequiresDrive,
    FailureLead.agentSwitchDisconnected =>
      l10n.failureNoticeAgentSwitchDisconnected,
    FailureLead.questionAnswerMissingRequestId =>
      l10n.failureNoticeQuestionAnswerMissingRequestId,
    FailureLead.questionAnswerEmpty => l10n.failureNoticeQuestionAnswerEmpty,
    FailureLead.questionAnswerDisconnected =>
      l10n.failureNoticeQuestionAnswerDisconnected,
    FailureLead.questionRejectMissingRequestId =>
      l10n.failureNoticeQuestionRejectMissingRequestId,
    FailureLead.questionRejectDisconnected =>
      l10n.failureNoticeQuestionRejectDisconnected,
    FailureLead.promptDisconnected => l10n.failureNoticePromptDisconnected,
    FailureLead.planActionMissingIdentity =>
      l10n.failureNoticePlanActionMissingIdentity,
    FailureLead.planRevisionEmpty => l10n.failureNoticePlanRevisionEmpty,
    FailureLead.planActionPolicyMismatch =>
      l10n.failureNoticePlanActionPolicyMismatch,
    FailureLead.planActionRequiresDrive =>
      l10n.failureNoticePlanActionRequiresDrive,
    FailureLead.artifactInteractionMissingContext =>
      l10n.failureNoticeArtifactInteractionMissingContext,
    FailureLead.artifactInteractionRequiresDrive =>
      l10n.failureNoticeArtifactInteractionRequiresDrive,
    FailureLead.commandUnadvertised => l10n.failureNoticeCommandUnadvertised,
    FailureLead.commandRequiresDrive => l10n.failureNoticeCommandRequiresDrive,
    FailureLead.commandNameEmpty => l10n.failureNoticeCommandNameEmpty,
    FailureLead.commandPermissionModeArgument =>
      l10n.failureNoticeCommandPermissionModeArgument,
    FailureLead.commandDisconnected => l10n.failureNoticeCommandDisconnected,
    FailureLead.takeOverDisconnected => l10n.failureNoticeTakeOverDisconnected,
    FailureLead.controlChangedReview => l10n.failureNoticeControlChangedReview,
    FailureLead.takeOverReconnectFailed =>
      l10n.failureNoticeTakeOverReconnectFailed,
    FailureLead.handBackDisconnected => l10n.failureNoticeHandBackDisconnected,
    FailureLead.handBackReconnectFailed =>
      l10n.failureNoticeHandBackReconnectFailed,
    FailureLead.handBackUnconfirmed => l10n.failureNoticeHandBackUnconfirmed,
    FailureLead.attachRequiresServer => l10n.failureNoticeAttachRequiresServer,
    FailureLead.chooseCreatableAgent => l10n.failureNoticeChooseCreatableAgent,
    FailureLead.scheduleUnavailable => l10n.failureNoticeScheduleUnavailable,
    FailureLead.attachmentUnsupported =>
      l10n.sessionAttachmentUnsupportedTooltip,
    FailureLead.attachmentSelection => l10n.sessionAttachmentSelectionError,
    FailureLead.attachmentIntake => l10n.sessionAttachmentIntakeError,
    FailureLead.attachmentReplacement => l10n.sessionAttachmentReplacementError,
    FailureLead.attachmentLimit => l10n.sessionAttachmentLimitError,
    FailureLead.attachmentStaging => l10n.sessionAttachmentStagingError,
    FailureLead.attachmentDelivery => l10n.sessionAttachmentDeliveryError,
    FailureLead.renameRequiresServer => l10n.sessionRenameRequiresServer,
    FailureLead.renameUnsupported => l10n.sessionRenameUnsupported,
    FailureLead.renameRejected => l10n.sessionRenameRejected,
    FailureLead.forkRequiresServer => l10n.sessionForkRequiresServer,
    FailureLead.forkUnsupported => l10n.sessionForkUnsupported,
    FailureLead.forkAlreadyRunning => l10n.sessionForkAlreadyRunning,
    FailureLead.forkReturnedNothing => l10n.sessionForkReturnedNothing,
    FailureLead.cloneRequiresServer => l10n.sessionCloneRequiresServer,
    FailureLead.cloneUnsupported => l10n.sessionCloneUnsupported,
    FailureLead.cloneAlreadyRunning => l10n.sessionCloneAlreadyRunning,
    FailureLead.cloneReturnedNothing => l10n.sessionCloneReturnedNothing,
    FailureLead.exportConfirmationStale => l10n.sessionExportConfirmationStale,
    FailureLead.exportRateLimited => l10n.sessionExportRateLimited,
    FailureLead.exportDisabled => l10n.sessionExportDisabled,
    FailureLead.exportBadParam => l10n.sessionExportBadParam,
    FailureLead.exportUnsupported => l10n.sessionExportDisabledUnsupported,
    FailureLead.historyPageTimeout => l10n.failureNoticeHistoryPageTimeout,
    FailureLead.historyPageOffline => l10n.failureNoticeHistoryPageOffline,
    FailureLead.scheduleConflict => l10n.failureNoticeScheduleConflict,
    FailureLead.exportRequiresServer => l10n.failureNoticeExportRequiresServer,
    FailureLead.exportConfirmationMissing =>
      l10n.failureNoticeExportConfirmationMissing,
    FailureLead.exportNoArtifact => l10n.failureNoticeExportNoArtifact,
    FailureLead.historyPageMemoryBudget =>
      l10n.failureNoticeHistoryPageMemoryBudget,
    FailureLead.historyPageMalformed => l10n.failureNoticeHistoryPageMalformed,
    FailureLead.commandModelArgument => l10n.failureNoticeCommandModelArgument,
    FailureLead.modelsRequireServer => l10n.failureNoticeModelsRequireServer,
    FailureLead.serverUnhealthy => l10n.failureNoticeServerUnhealthy,
  };
}

/// Renders a [LocalizedFailure] as the full sentence a user reads.
///
/// This is the only place a typed failure becomes text, so every surface that
/// reports the same operation and the same failure mode reads identically.
/// [LocalizedFailure.detail] stays out of the result by construction.
String localizedFailureText(AppLocalizations l10n, LocalizedFailure failure) {
  final lead = localizedFailureLead(l10n, failure.lead);
  final kind = failure.kind;
  if (kind == null) return lead;
  return l10n.failureMessage(lead, localizedFailureAdvice(l10n, kind));
}
