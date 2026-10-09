part of 'message_renderer_registry.dart';

Widget _modelOutputMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.smart_toy_outlined,
    title: l10n.modelOutput,
    summary:
        message.modelOutputText ??
        message.modelOutputDelta ??
        l10n.modelOutputReceived,
    payloadRows: _modelOutputPayloadRows(message),
  );
}

/// Builds payload rows for a `model-output` message.
///
/// Deliberately empty. The canonical broker fields are `text`, `delta`, `final`
/// and `key`: the first two are already the bubble body, and the last two are
/// stream bookkeeping and a de-duplication id — none of them are content a
/// reader needs, and rendering them duplicated every answer underneath itself.
/// The typed [AgentMessageModelOutput] accessors still back the body and the
/// per-message Details dialog.
///
/// Governing doc:
/// `docs/architecture/client-ui.md`
/// (section "Flutter Integration Direction" - typed accessor adoption).
List<MapEntry<String, Object?>> _modelOutputPayloadRows(
  AgentMessage message,
) {
  return const [];
}

Widget _thinkingMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.psychology_outlined,
    title: l10n.thinking,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['content', 'thought', 'text', 'status'],
        ) ??
        l10n.thinkingStep,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['content', 'thought', 'text', 'status', 'reason'],
    ),
  );
}

Widget _statusMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptMetaLine(
    key: const Key('transcript-status-line'),
    icon: Icons.info_outline,
    text:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['status', 'state', 'message'],
        ) ??
        l10n.statusUpdated,
  );
}

Widget _toolCallMessageRenderer(BuildContext context, AgentMessage message) {
  return _ToolMessageCard(
    key: ValueKey(
      'tool-message-${message.toolCallId ?? identityHashCode(message)}-'
      '${ToolDisplayModeScope.expansionRevisionOf(context)}',
    ),
    call: message,
    result: null,
    initiallyExpanded: ToolDisplayModeScope.toolsExpandedOf(context) ?? false,
  );
}

Widget _toolResultMessageRenderer(BuildContext context, AgentMessage message) {
  return _ToolMessageCard(
    key: ValueKey(
      'tool-message-${message.toolCallId ?? identityHashCode(message)}-'
      '${ToolDisplayModeScope.expansionRevisionOf(context)}',
    ),
    call: null,
    result: message,
    initiallyExpanded: ToolDisplayModeScope.toolsExpandedOf(context) ?? false,
  );
}

Widget _fsEditMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.edit_note,
    title: l10n.filesystemEdit,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['path', 'name', 'patch', 'status'],
        ) ??
        l10n.filesystemEditEvent,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['path', 'name', 'status', 'oldValue', 'newValue'],
    ),
  );
}

Widget _fileArtifactMessageRenderer(
  BuildContext context,
  AgentMessage message, {
  Widget? action,
}) {
  return _TranscriptArtifactRow(message: message, action: action);
}

/// One quiet sentence for each reason the broker lets a held call go.
///
/// The reason is the broker's fact and the sentence is the client's, which is
/// why the
/// wire carries a code and not a message: a released prompt is exactly the case
/// where
/// the app has to explain itself, and translated copy is the only version a
/// reader can
/// act on. An unrecognized code earns nothing, so it returns null and the card
/// keeps
/// its ordinary title rather than asserting a reason nobody checked.
String? _permissionReleaseSummary(AppLocalizations l10n, AgentMessage message) {
  return switch (message.permissionReleaseReason) {
    PermissionReleaseReason.modeBypassPermissions =>
      l10n.sessionRequestReleaseModeBypass,
    PermissionReleaseReason.modeUnknown =>
      l10n.sessionRequestReleaseModeUnknown,
    PermissionReleaseReason.planTerminalOnly =>
      l10n.sessionRequestReleasePlanTerminalOnly,
    PermissionReleaseReason.viewerNone => l10n.sessionRequestReleaseViewerNone,
    PermissionReleaseReason.killSwitch => l10n.sessionRequestReleaseKillSwitch,
    PermissionReleaseReason.band => l10n.sessionRequestReleaseBand,
    PermissionReleaseReason.expired => l10n.sessionRequestReleaseExpired,
    PermissionReleaseReason.unknown || null => null,
  };
}

/// The mode line under an approval card, or null when there is nothing to name.
///
/// The tool's own word goes in unedited: a translated guess about which mode
/// the
/// user's terminal is in is worse than vendor jargon they can check against the
/// prompt
/// in front of them. A mode this client has not met decodes to `unknown`, and
/// `unknown` is not a mode anybody chose, so it names nothing here.
String? _permissionModeNote(AppLocalizations l10n, AgentMessage message) {
  final mode = message.permissionRequestMode;
  if (mode == null || mode == PermissionModeName.unknown) return null;
  return l10n.sessionRequestInMode(mode.wireValue);
}

Widget _permissionRequestMessageRenderer(
  BuildContext context,
  AgentMessage message, {
  Widget? action,
}) {
  final l10n = AppLocalizations.of(context);
  // A released prompt is not a request this app can answer. The broker let it
  // fall
  // back to the terminal, so the card says where the prompt went and which rule
  // sent
  // it there, and it grows no buttons — an actionable card for a decision that
  // is
  // already closed invites a tap that cannot land.
  final releaseSummary = message.requestIsReadOnly
      ? _permissionReleaseSummary(l10n, message)
      : null;
  final released = releaseSummary != null;
  final preview = released ? null : message.permissionRequestInputPreview;
  return _TranscriptBoxMessage(
    plain: true,
    icon: released ? Icons.gpp_maybe_outlined : Icons.gpp_good_outlined,
    // The title outlives the prompt: the card stays in the transcript once the
    // terminal has settled it, so it says where the approval went, not that
    // anybody is still waiting on it.
    title: released
        ? l10n.sessionRequestLeftToTerminal
        : l10n.sessionRequestPermissionTitle,
    // What is being approved comes first. A card that names the tool and
    // nothing else asks for agreement to a command the user cannot see, so the
    // broker sends the command, path or URL and the card leads with it. The
    // session title is the fallback for a broker that had nothing to name.
    summary: released
        ? releaseSummary
        : preview ??
              message.permissionRequestTitle ??
              l10n.sessionRequestPermissionFallback,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const [
        'title',
        'permission',
        'reason',
        'tool',
        'operation',
        'target',
      ],
    ),
    // Only when the request really is read-only. The hint renders as
    // "… (read-only)", so passing it unconditionally labelled an answerable
    // request read-only directly above its own working Reject/Allow buttons —
    // the transcript called the decision somebody else's while the card below
    // was taking it. An actionable request needs no hint: its own action card
    // already states whether it is pending, sent, or settled.
    note: _permissionModeNote(l10n, message),
    // A released card's title already says the terminal has it. "Awaiting
    // permission response" beside it was a third account of the same prompt,
    // and the one that stayed wrong after the terminal settled it.
    readOnlyHint: message.requestIsReadOnly && !released
        ? l10n.sessionRequestAwaitingPermission
        : null,
    payloadAsChips: true,
    // The preview names the call; "Show details" holds all of it: the rest of
    // a long command, an edit's old and new text, a file's body. A detail that
    // only repeats the preview (an older broker's copy of it, for clients that
    // predate the preview) is left out rather than offered again. A released
    // card leads with its reason instead, and keeps every detail.
    detailContent: _PermissionRequestDetail(
      detail: _detailBeyondPreview(message.permissionRequestDetail, preview),
      action: action,
    ),
  );
}

/// The card's detail, or null when it says nothing the preview does not.
///
/// A copy of the preview is one line ending with the preview's value: the
/// broker's copy for older clients is `Tool: value`, and the call's full input
/// is exactly `key: value` when the call has one short field. Anything longer,
/// or on more than one line, is more of the call, and the card offers it.
String? _detailBeyondPreview(String? detail, String? preview) {
  final text = detail?.trim();
  if (text == null || text.isEmpty) return null;
  final shown = preview?.trim();
  if (shown == null || shown.isEmpty) return text;
  if (text.contains('\n')) return text;
  final colon = shown.indexOf(': ');
  final value = colon > 0 ? shown.substring(colon + 2) : shown;
  return text == shown || text.endsWith(': $value') ? null : text;
}

Widget _permissionResolvedMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  final resolutionSummary = switch (message.permissionResolutionDecision) {
    PermissionResolutionDecision.approve => l10n.permissionApproved,
    PermissionResolutionDecision.approveSession =>
      l10n.permissionApprovedSession,
    PermissionResolutionDecision.approveRule =>
      l10n.sessionRequestOutcomeApprovedRule,
    PermissionResolutionDecision.reject => l10n.permissionRejected,
    PermissionResolutionDecision.external =>
      l10n.sessionRequestResolvedElsewhere,
    PermissionResolutionDecision.unknown || null => null,
  };
  return _TranscriptBubble(
    icon: Icons.gpp_maybe_outlined,
    title: l10n.permissionResolved,
    summary:
        resolutionSummary ??
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['result', 'status'],
        ) ??
        l10n.permissionResponseApplied,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const [
        'requestId',
        'decision',
        'permission',
        'result',
        'status',
        'granted',
      ],
    ),
  );
}

Widget _questionRequestMessageRenderer(
  BuildContext context,
  AgentMessage message, {
  Widget? action,
  bool settled = false,
}) {
  final l10n = AppLocalizations.of(context);
  final questions = message.questionRequestQuestions;
  return _TranscriptBoxMessage(
    plain: true,
    icon: Icons.quiz_outlined,
    title: questions.length > 1
        ? l10n.sessionRequestQuestionsTitle
        : l10n.sessionRequestQuestionTitle,
    // Structured actions render each question next to its own input. Only the
    // legacy free-text request needs a separate summary above the controls.
    summary: questions.isNotEmpty && action != null
        ? null
        : questions.isNotEmpty
        ? questions.first.question
        : l10n.sessionRequestQuestionFallback,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['question', 'prompt', 'message', 'context'],
    ),
    // Only while somebody still owes the answer. A settled question is drawn
    // read-only too, and "Awaiting answer" above "Settled in your terminal or
    // another app." gave one card two accounts of the same question.
    readOnlyHint: message.requestIsReadOnly && !settled
        ? l10n.sessionRequestAwaitingAnswer
        : null,
    payloadAsChips: true,
    detailContent: action,
  );
}

Widget _questionResolvedMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.mark_chat_read_outlined,
    title: l10n.questionResolved,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['answer', 'status'],
        ) ??
        l10n.questionResolvedSummary,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['answer', 'status', 'reason'],
    ),
  );
}

Widget _terminalOutputMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  final detailsRows = _collectPayloadRows(
    message: message,
    preferredKeys: const [
      'command',
      'output',
      'text',
      'stdout',
      'stderr',
      'exitCode',
    ],
  );
  final preface = _firstPayloadValue(
    message: message,
    preferredKeys: const ['command'],
  );
  final bodyText = _stringifyPayloadValue(
    _firstPayloadValueRaw(message: message),
  );

  return _TranscriptBubble(
    icon: Icons.terminal_outlined,
    title: l10n.terminalOutput,
    summary: preface ?? l10n.terminalOutputSummary,
    payloadRows: detailsRows,
    detailContent: bodyText.isEmpty
        ? null
        : _MonospaceDetailSection(
            sourceId: message.id ?? message.seq?.toString() ?? 'unknown',
            text: bodyText,
          ),
  );
}

Widget _noticeMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  final raw =
      _firstPayloadValue(
        message: message,
        preferredKeys: const ['message', 'notice', 'text'],
      ) ??
      l10n.sessionTranscriptNotice;
  final isInterruption =
      message.transcriptNoticeSemanticKind ==
      TranscriptNoticeSemanticKind.interruption;
  final isContinuation =
      message.transcriptNoticeSemanticKind ==
      TranscriptNoticeSemanticKind.continuation;
  final text =
      message.transcriptInterruptionReason ==
          TranscriptInterruptionReason.automaticApprovalDeniedRepeatedly
      ? l10n.sessionTranscriptInterruptedAutomaticApproval
      : isInterruption
      ? l10n.sessionTranscriptInterrupted
      : raw;
  return _InlineTranscriptNotice(
    key: Key(
      isInterruption
          ? 'session-transcript-interruption-inline'
          : isContinuation
          ? 'session-transcript-continuation-inline'
          : 'session-transcript-notice-inline',
    ),
    text: text,
    color: isInterruption
        ? context.tokens.statusError
        : context.tokens.textSecondary,
  );
}

Widget _metadataUpdateMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  final key = _firstPayloadValue(
    message: message,
    preferredKeys: const ['key'],
  );
  final value = _firstPayloadValue(
    message: message,
    preferredKeys: const ['value'],
  );
  return _TranscriptBubble(
    icon: Icons.badge_outlined,
    title: l10n.metadataUpdate,
    summary: switch ((key, value)) {
      (final key?, final value?) => l10n.metadataUpdatedKeyValue(key, value),
      (final key?, null) => l10n.metadataUpdatedKey(key),
      _ => l10n.metadataUpdated,
    },
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['key', 'value', 'source', 'updatedAt'],
      maxRows: 8,
    ),
  );
}

Widget _tokenCountMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptMetaLine(
    key: const Key('transcript-token-count-line'),
    icon: Icons.numbers_outlined,
    text: _formatTokenSummary(l10n, message.raw) ?? l10n.tokenUsageUpdated,
  );
}

Widget _runSummaryMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.summarize,
    title: l10n.runSummary,
    summary: _formatRunSummary(l10n, message.raw),
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const [
        'status',
        'turnId',
        'totalRuntimeMs',
        'agentRuntimeMs',
        'executionRuntimeMs',
        'tokens',
        'source',
      ],
      maxRows: 10,
    ),
  );
}

Widget _userMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.person_outline,
    title: l10n.userMessage,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['content', 'text', 'message'],
        ) ??
        l10n.userMessageSummary,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['content', 'text', 'message'],
      maxRows: 4,
    ),
    isUserMessage: true,
    isQueued: message.userMessageQueued,
  );
}

Widget _eventMessageRenderer(BuildContext context, AgentMessage message) {
  // Context material gets a presentation of its own: quiet, collapsed, and
  // labelled for a human. Every other event keeps the generic card below, so an
  // unknown or future event still renders honestly rather than disappearing.
  //
  // Steering is checked first because it is the user's own words arriving by an
  // unusual route. An ordinary event row hides that the message reached the
  // agent at
  // all, which is the one thing a reader mid-turn needs to know, and a user
  // bubble
  // would claim it was typed at that terminal.
  if (message.steeringMessage != null) {
    return _SteeringRow(message: message);
  }
  if (message.contextInjection != null) {
    return _ContextInjectionRow(message: message);
  }
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.event_note_outlined,
    title: l10n.event,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['status', 'name', 'event'],
        ) ??
        l10n.sessionEvent,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['status', 'name', 'event', 'message'],
    ),
  );
}

Widget _goalStateMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.track_changes_outlined,
    title: l10n.goalState,
    summary: _formatGoalState(l10n, message.raw),
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const [
        'title',
        'status',
        'detail',
        'elapsedMs',
        'startedAt',
        'key',
      ],
    ),
  );
}

Widget _taskListMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  final items = _taskItems(message.raw['items']);
  return _TranscriptBubble(
    icon: Icons.list_alt_outlined,
    title: l10n.taskListState,
    summary: _formatTaskListSummary(l10n, message.raw, items),
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['title', 'status', 'source', 'updatedAt', 'key'],
      maxRows: 8,
    ),
    detailContent: items.isEmpty
        ? null
        : _TaskListDetailSection(
            items: items,
          ),
  );
}

Widget _agentActivityMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  final children = _activityChildren(message.raw['children']);
  return _TranscriptBubble(
    icon: Icons.psychology,
    title: l10n.agentActivity,
    summary: _formatAgentActivity(l10n, message.raw),
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const [
        'kind',
        'title',
        'subtitle',
        'status',
        'elapsedMs',
        'agentsDone',
        'agentsTotal',
        'toolCalls',
        'tokens',
      ],
      maxRows: 10,
    ),
    detailContent: children.isEmpty
        ? null
        : _ActivityChildrenSection(children: children),
  );
}

Widget _historyResetMessageRenderer(
  BuildContext context,
  AgentMessage message,
) {
  final l10n = AppLocalizations.of(context);
  final raw = _firstPayloadValue(
    message: message,
    preferredKeys: const ['notice', 'reason'],
  );
  final text =
      message.historyResetSemanticKind == HistoryResetSemanticKind.compaction
      ? l10n.sessionTranscriptCompactionComplete
      : raw ?? l10n.sessionTranscriptHistoryReloaded;
  return _InlineTranscriptNotice(
    key: const Key('session-transcript-history-reset-inline'),
    text: text,
    color: context.tokens.textSecondary,
  );
}

/// Transcript control text without card chrome or an invented icon.
///
/// A plain [Text] registers with the transcript-level [SelectionArea].
/// [SelectableText] would create a nested selection island and stop a range
/// that begins in an adjacent message.
class _InlineTranscriptNotice extends StatelessWidget {
  const _InlineTranscriptNotice({
    required this.text,
    required this.color,
    super.key,
  });

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
    child: Text(
      text,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        color: color,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

Widget _errorMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);

  return _TranscriptBoxMessage(
    icon: Icons.error_outline,
    title: l10n.errorEvent,
    isError: true,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['message', 'code', 'details', 'stack'],
      maxRows: 10,
    ),
    noDetailText: l10n.errorEventNoDetail,
  );
}

Widget _unknownMessageRenderer(BuildContext context, AgentMessage message) {
  final l10n = AppLocalizations.of(context);
  return _TranscriptBubble(
    icon: Icons.help_outline,
    title: l10n.unsupportedMessageType,
    summary:
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['payload'],
        ) ??
        l10n.noSummaryAvailable,
    payloadRows: _collectPayloadRows(
      message: message,
      preferredKeys: const ['payload', 'message', 'details'],
      maxRows: 10,
    ),
  );
}

String? _firstPayloadValue({
  required AgentMessage message,
  required List<String> preferredKeys,
}) {
  for (final key in preferredKeys) {
    final value = message.raw[key];
    if (value == null) {
      continue;
    }
    return _stringifyPayloadValue(value);
  }
  return null;
}

Object? _firstPayloadValueRaw({
  required AgentMessage message,
}) {
  const orderedKeys = ['output', 'text', 'stdout', 'stderr'];
  for (final key in orderedKeys) {
    final value = message.raw[key];
    if (value != null) {
      return value;
    }
  }
  return null;
}
