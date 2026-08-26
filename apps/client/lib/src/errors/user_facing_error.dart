import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:meta/meta.dart';

/// Maximum UTF-16 code units retained for one copied technical detail.
const int maxTechnicalDetailLength = 2048;

/// Applies the shared construction-time diagnostic bound.
///
/// The ellipsis is inside [maxTechnicalDetailLength], and applying this to an
/// already bounded value returns it unchanged.
String? boundedTechnicalDetail(String? detail) {
  final value = detail?.trim();
  if (value == null || value.isEmpty) return null;
  if (value.length <= maxTechnicalDetailLength) return value;
  return '${value.substring(0, maxTechnicalDetailLength - 1)}…';
}

/// How a failure reached the app.
///
/// This is the discriminator every user-facing error message is built from. It
/// deliberately describes *where* the failure happened rather than which
/// operation triggered it: the operation supplies the lead sentence ("Couldn't
/// save the token."), and the kind supplies the recovery sentence ("The broker
/// didn't respond…"). Splitting the two keeps the number of strings linear
/// instead of multiplying operations by failure modes.
///
/// Modeled on `userMessageForSessionFileError` and `_transcriptExportFailure`,
/// the two error mappers in the client that already do this correctly: classify
/// first, then map to plain language. See `docs/architecture/client-ui.md`.
enum FailureKind {
  /// The broker was never reached — down, wrong address, DNS, or no network.
  ///
  /// `BrokerClient` funnels every transport failure into a [BrokerException]
  /// with a null `statusCode`, so "we never got an answer" is observable
  /// rather than guessed. See `RealBrokerAuthProbe`, which relies on the same
  /// property.
  offline,

  /// The broker answered, and refused the credential (401/403).
  unauthorized,

  /// The broker answered and rejected the request itself (other 4xx).
  rejected,

  /// The broker answered, and failed on its own side (5xx).
  brokerFault,

  /// This device's secure storage or a platform channel refused the operation.
  deviceStorage,

  /// Anything unclassified. Never assume a cause here.
  unknown,
}

/// Classifies [error] into the coarse failure mode a user can act on.
///
/// Platform failures are matched by runtime type name rather than by `is`
/// checks so this stays free of `dart:io` and platform-channel imports and can
/// run unchanged on web.
FailureKind classifyFailure(Object error) {
  if (error is BrokerException) {
    final status = error.statusCode;
    if (status == null) {
      // No status means no HTTP response was ever parsed: connection refused,
      // DNS failure, TLS handshake failure, or timeout.
      return FailureKind.offline;
    }
    if (status == 401 || status == 403) return FailureKind.unauthorized;
    if (status >= 500) return FailureKind.brokerFault;
    if (status >= 400) return FailureKind.rejected;
    return FailureKind.unknown;
  }

  if (error is TimeoutException) return FailureKind.offline;

  final typeName = error.runtimeType.toString();
  if (typeName.contains('PlatformException') ||
      typeName.contains('MissingPluginException')) {
    return FailureKind.deviceStorage;
  }
  if (typeName.contains('SocketException') ||
      typeName.contains('ClientException') ||
      typeName.contains('HandshakeException')) {
    return FailureKind.offline;
  }

  return FailureKind.unknown;
}

/// Raw, untranslated diagnostic text for a "Technical details" disclosure.
///
/// Never render this in the primary reading path. It exists so a user can copy
/// it into a support request, which is the only reason the raw text is kept at
/// all. Prefers the broker's own structured error over the Dart exception's
/// `toString()`, which is noisier and leaks type names.
String failureDetail(Object error) {
  late final String raw;
  if (error is BrokerException) {
    final structured = error.error?.error;
    final code = error.error?.code;
    final status = error.statusCode;
    final buffer = StringBuffer(structured ?? error.message);
    if (code != null) buffer.write(' [$code]');
    if (status != null) buffer.write(' (status $status)');
    raw = buffer.toString();
  } else {
    raw = error.toString();
  }
  return boundedTechnicalDetail(raw)!;
}

/// English recovery sentence for [kind] — what the user should do next.
///
/// Localized surfaces map [FailureKind] to ARB strings instead of calling this;
/// see the connection gate. This exists for the surfaces that are still
/// hardcoded English, so they at least stop leaking exceptions today.
String recoveryAdviceEn(FailureKind kind) {
  return switch (kind) {
    FailureKind.offline =>
      "The server didn't respond. Check that it's running and that you're on "
          'the right network, then try again.',
    FailureKind.unauthorized =>
      "The server refused this device's access. Pair this device again, or "
          'paste a current server token.',
    FailureKind.rejected => 'The server rejected the request. Try again.',
    FailureKind.brokerFault =>
      'The server ran into a problem on its end. Try again in a moment.',
    FailureKind.deviceStorage =>
      "This device's secure storage refused the change. Try again, or restart "
          'the app.',
    FailureKind.unknown =>
      'Try again. If it keeps happening, the technical details can help '
          'support.',
  };
}

/// A failure translated for a person to read.
///
/// [message] is the whole user-facing sentence: what happened, then what to do.
/// [detail] is the raw diagnostic, kept for a disclosure and never concatenated
/// into [message].
class UserFacingError {
  /// Creates a [UserFacingError].
  const UserFacingError({required this.message, this.detail});

  /// Plain-language message: what failed, and the next step.
  final String message;

  /// Raw diagnostic for a "Technical details" disclosure. Never in [message].
  final String? detail;
}

/// Builds a user-facing error from [error] and an operation-specific [lead].
///
/// [lead] must be a complete sentence naming what failed in the user's terms
/// ("Couldn't save the token."). The recovery sentence is chosen from the
/// classified [FailureKind] so the advice matches the actual failure instead of
/// being a generic "Something went wrong", which would be worse than the raw
/// text it replaces.
UserFacingError describeFailure(Object error, {required String lead}) {
  return UserFacingError(
    message: '$lead ${recoveryAdviceEn(classifyFailure(error))}',
    detail: failureDetail(error),
  );
}

/// Convenience for callers that can only carry a single string today.
///
/// Drops the raw diagnostic rather than appending it — appending is exactly the
/// leak this module exists to remove.
String userFacingMessage(Object error, {required String lead}) =>
    describeFailure(error, lead: lead).message;

/// Which operation failed, in the user's terms.
///
/// This is the localizable half of [LocalizedFailure]: the lead sentence
/// ("Couldn't take over this session.") that pairs with the [FailureKind]
/// recovery advice. Controllers pick a [FailureLead] instead of writing an
/// English sentence, so the string is chosen at render time in the user's
/// locale rather than frozen when the failure was caught.
///
/// The English wording for each value lives in `app_en.arb` under
/// `failureLead<Name>`; `localizedFailureLead` maps this enum to it.
enum FailureLead {
  /// Reading or listing a session file failed.
  accessFile,

  /// Acknowledging replayed attach history failed.
  acknowledgeHistory,

  /// Switching the agent backing a session failed.
  changeSessionAgent,

  /// Cloning a session failed.
  cloneSession,

  /// Connecting to (attaching to) a session failed.
  connectSession,

  /// Creating a new session failed.
  createSession,

  /// Downloading a session file failed.
  downloadFile,

  /// Forking a session failed.
  forkSession,

  /// Handing drive authority back to the terminal failed.
  handBackControl,

  /// Loading the list of available agents failed.
  loadAgents,

  /// Paging in earlier transcript history failed.
  loadEarlierHistory,

  /// Loading the scheduled-send list failed.
  loadScheduledSends,

  /// Loading the session roster failed.
  loadSessions,

  /// Preparing an artifact preview failed.
  prepareArtifactPreview,

  /// Probing broker health failed.
  reachServer,

  /// Refreshing the model catalog failed.
  refreshModelCatalog,

  /// Renaming a session failed.
  renameSession,

  /// Restoring drive authority after a reconnect failed.
  restoreControl,

  /// Saving an artifact to device storage failed.
  saveArtifact,

  /// Persisting the transcript on the device failed.
  saveTranscript,

  /// Creating a scheduled send failed.
  scheduleSend,

  /// Sending an artifact interaction failed.
  sendArtifactInteraction,

  /// Sending a slash command failed.
  sendCommand,

  /// Sending a prompt failed.
  sendPrompt,

  /// The transcript saved locally but its receipt never reached the broker.
  sendTranscriptReceipt,

  /// Starting a background download failed.
  startBackgroundDownload,

  /// Taking over drive authority failed.
  takeOverSession,

  /// Exporting a transcript failed.
  exportTranscript,

  /// Updating a background download failed.
  updateBackgroundDownload,

  /// Updating the plan failed.
  updatePlan,

  /// Updating an existing schedule failed.
  updateSchedule,

  /// Uploading a file failed.
  uploadFile,

  /// Notice: a permission decision was attempted with no request id.
  permissionDecisionMissingRequestId,

  /// Notice: an empty permission decision was attempted.
  permissionDecisionEmpty,

  /// Notice: a permission decision was attempted while disconnected.
  permissionDecisionDisconnected,

  /// Notice: an agent switch was attempted with a blank name.
  agentSwitchEmptyName,

  /// Notice: the requested agent is not advertised by the session.
  agentSwitchUnadvertised,

  /// Notice: switching agents needs drive authority.
  agentSwitchRequiresDrive,

  /// Notice: an agent switch was attempted while disconnected.
  agentSwitchDisconnected,

  /// Notice: a question answer was attempted with no request id.
  questionAnswerMissingRequestId,

  /// Notice: an empty question answer was attempted.
  questionAnswerEmpty,

  /// Notice: a question answer was attempted while disconnected.
  questionAnswerDisconnected,

  /// Notice: a question rejection was attempted with no request id.
  questionRejectMissingRequestId,

  /// Notice: a question rejection was attempted while disconnected.
  questionRejectDisconnected,

  /// Notice: a prompt was attempted while disconnected.
  promptDisconnected,

  /// Notice: a plan action arrived without plan identity.
  planActionMissingIdentity,

  /// Notice: an empty plan revision was submitted.
  planRevisionEmpty,

  /// Notice: a plan action conflicts with the server policy.
  planActionPolicyMismatch,

  /// Notice: plan actions need drive authority.
  planActionRequiresDrive,

  /// Notice: an artifact interaction lacked trusted context.
  artifactInteractionMissingContext,

  /// Notice: artifact interactions need drive authority.
  artifactInteractionRequiresDrive,

  /// Notice: the requested command is not advertised by the session.
  commandUnadvertised,

  /// Notice: action commands need drive authority.
  commandRequiresDrive,

  /// Notice: an empty command name was submitted.
  commandNameEmpty,

  /// Notice: permissionMode must not be passed as a command argument.
  commandPermissionModeArgument,

  /// Notice: a command was attempted while disconnected.
  commandDisconnected,

  /// Notice: takeover was attempted while disconnected.
  takeOverDisconnected,

  /// Notice: session control changed under the user.
  controlChangedReview,

  /// Notice: takeover failed to re-establish the connection.
  takeOverReconnectFailed,

  /// Notice: handback was attempted while disconnected.
  handBackDisconnected,

  /// Notice: handback failed to re-establish the connection.
  handBackReconnectFailed,

  /// Notice: the broker never confirmed the handback.
  handBackUnconfirmed,

  /// Notice: attaching needs an active server.
  attachRequiresServer,

  /// Notice: the chosen agent cannot create sessions.
  chooseCreatableAgent,

  /// Notice: the schedule row vanished before the action ran.
  scheduleUnavailable,

  /// Notice: this agent cannot accept file attachments.
  attachmentUnsupported,

  /// Notice: the file picker failed.
  attachmentSelection,

  /// Notice: a pasted or dropped file could not be materialized.
  attachmentIntake,

  /// Notice: replacing a single attachment failed.
  attachmentReplacement,

  /// Notice: the attachment count or byte limit was exceeded.
  attachmentLimit,

  /// Notice: chunked attachment staging failed.
  attachmentStaging,

  /// Notice: delivering staged attachments failed.
  attachmentDelivery,

  /// Notice: rename attempted with no server connection.
  renameRequiresServer,

  /// Notice: the agent does not support native rename.
  renameUnsupported,

  /// Notice: the broker refused the rename.
  renameRejected,

  /// Notice: fork attempted with no server connection.
  forkRequiresServer,

  /// Notice: the agent does not support fork.
  forkUnsupported,

  /// Notice: a fork is already running for this session.
  forkAlreadyRunning,

  /// Notice: the broker accepted the fork but named no session.
  forkReturnedNothing,

  /// Notice: clone attempted with no server connection.
  cloneRequiresServer,

  /// Notice: the agent does not support clone.
  cloneUnsupported,

  /// Notice: a clone is already running for this session.
  cloneAlreadyRunning,

  /// Notice: the broker accepted the clone but named no session.
  cloneReturnedNothing,

  /// Notice: the export confirmation token expired or changed.
  exportConfirmationStale,

  /// Notice: transcript export is rate limited.
  exportRateLimited,

  /// Notice: transcript export is switched off.
  exportDisabled,

  /// Notice: the broker rejected the export request.
  exportBadParam,

  /// Notice: this agent cannot export transcripts.
  exportUnsupported,

  /// Notice: a history page request timed out.
  historyPageTimeout,

  /// Notice: history paging attempted while disconnected.
  historyPageOffline,

  /// Notice: a schedule was modified concurrently elsewhere.
  scheduleConflict,

  /// Notice: transcript export attempted with no server connection.
  exportRequiresServer,

  /// Notice: the export confirmation nonce was blank.
  exportConfirmationMissing,

  /// Notice: the broker reported export success but returned no artifact.
  exportNoArtifact,

  /// Notice: a history page was refused by the client memory budget.
  historyPageMemoryBudget,

  /// Notice: the broker returned an unparseable history page.
  historyPageMalformed,

  /// Notice: model must not be passed as a command argument.
  commandModelArgument,

  /// Notice: model catalog load attempted with no server connection.
  modelsRequireServer,

  /// Notice: the broker responded but failed its own health check.
  serverUnhealthy,
}

/// A failure carried in typed form until something can localize it.
///
/// Controllers store this instead of a finished English sentence. Keeping the
/// pair typed is what makes the message follow a locale change: a `String`
/// built when the error was caught is frozen in whatever language was active
/// then, and a language switch cannot revisit it.
///
/// [detail] is the raw diagnostic for a "Technical details" disclosure. It is
/// never concatenated into the rendered sentence — see [failureDetail].
@immutable
class LocalizedFailure {
  /// Creates a [LocalizedFailure].
  ///
  /// [kind] is null for a notice that has no underlying exception — a guard
  /// the app applied itself ("Reconnect before taking over this session."),
  /// where recovery advice derived from a transport failure would be a lie.
  /// Such a failure renders as the lead sentence alone.
  const LocalizedFailure({
    required this.lead,
    this.kind,
    this.detail,
  });

  /// A notice with no underlying exception: renders as [lead] alone.
  const LocalizedFailure.notice(this.lead) : kind = null, detail = null;

  /// Classifies [error] and pairs it with the operation-specific [lead].
  factory LocalizedFailure.from(Object error, {required FailureLead lead}) {
    return LocalizedFailure(
      lead: lead,
      kind: classifyFailure(error),
      detail: failureDetail(error),
    );
  }

  /// Which operation failed.
  final FailureLead lead;

  /// How it failed, which selects the recovery advice, or null for a notice.
  final FailureKind? kind;

  /// Raw diagnostic for a disclosure. Never part of the primary sentence.
  final String? detail;

  @override
  bool operator ==(Object other) =>
      other is LocalizedFailure &&
      other.lead == lead &&
      other.kind == kind &&
      other.detail == detail;

  @override
  int get hashCode => Object.hash(lead, kind, detail);

  @override
  String toString() => 'LocalizedFailure($lead, $kind)';
}
