part of 'session_detail_page.dart';

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.message,
    required this.controller,
    required this.isConnected,
    required this.hasActiveBrokerClient,
    required this.canFork,
    required this.canMutate,
    required this.onExtractRequestId,
    required this.isNewestEligibleForIdentity,
    required this.resolvedRequestIds,
    required this.onForkFromMessage,
    required this.artifactActionState,
    this.resolvedRequestDecisions = const {},
    this.withdrawnRequestIds = const {},
    this.resolvedRequestAttributions = const {},
    this.resolvedQuestionAnswers = const {},
  });

  final AgentMessage message;
  final SessionDetailController controller;
  final bool isConnected;
  final bool hasActiveBrokerClient;
  final bool canFork;

  /// Whether the app may answer permission/question cards right now (the
  /// broker's `canMutateSession` — driving or active sync).
  final bool canMutate;
  final String? Function(AgentMessage message) onExtractRequestId;

  /// Whether this message is the newest eligible frame for its identity.
  final bool isNewestEligibleForIdentity;

  /// Request ids that already have a `*-resolved` message in the transcript
  /// (local or external), whose action cards must render deactivated.
  final Set<String> resolvedRequestIds;

  /// Resolution decision by canonical request id (`null` for a decisionless
  /// resolution, e.g. a question). Drives the settled card's compact outcome
  /// now that resolution frames render no standalone Chat row.
  final Map<String, String?> resolvedRequestDecisions;

  /// Request ids the session no longer offers although no resolution for them
  /// arrived: their cards deactivate without an outcome.
  final Set<String> withdrawnRequestIds;

  /// Who settled each request, by canonical request id. Absent when the
  /// broker did not say, which is every resolution this app saw before
  /// true sync.
  final Map<String, ResolvedRequestAttribution> resolvedRequestAttributions;

  /// The answer each settled question closed with, by canonical request id.
  /// Absent when the broker did not say.
  final Map<String, List<List<String>>> resolvedQuestionAnswers;
  final ValueChanged<String> onForkFromMessage;
  final SessionArtifactActionState artifactActionState;

  @override
  Widget build(BuildContext context) {
    final artifactDescriptor = SessionArtifactDescriptor.fromMessage(message);
    final artifactAction =
        artifactDescriptor != null && artifactDescriptor.isDownloadable
        ? _TranscriptArtifactDownloadAction(
            descriptor: artifactDescriptor,
            actionState: artifactActionState,
            hasActiveBrokerClient: hasActiveBrokerClient,
            onDownload: () => controller.downloadArtifact(
              artifactDescriptor,
            ),
          )
        : null;
    final requestId = onExtractRequestId(message);
    final isResolved =
        requestId != null && resolvedRequestIds.contains(requestId);
    final isWithdrawn =
        requestId != null && withdrawnRequestIds.contains(requestId);

    final requestAction = switch (message.type) {
      AgentMessageType.permissionRequest when requestId != null =>
        _PermissionRequestActions(
          requestId: requestId,
          options: _permissionApprovalOptions(message),
          isReadOnly: message.requestIsReadOnly,
          onApprove: () => controller.sendPermissionDecision(
            requestId: requestId,
            decision: 'approve',
          ),
          onApproveSession: () => controller.sendPermissionDecision(
            requestId: requestId,
            decision: 'approve-session',
          ),
          onApproveRule: () => controller.sendPermissionDecision(
            requestId: requestId,
            decision: 'approve-rule',
          ),
          onReject: () => controller.sendPermissionDecision(
            requestId: requestId,
            decision: 'reject',
          ),
          isEnabled: isConnected && canMutate,
          isResolved: isResolved || isWithdrawn,
          isWithdrawn: isWithdrawn,
          resolvedDecision: resolvedRequestDecisions[requestId],
          resolvedAttribution: resolvedRequestAttributions[requestId],
          releaseReason: message.requestIsReadOnly
              ? message.permissionReleaseReason
              : null,
        ),
      AgentMessageType.questionRequest when requestId != null =>
        _QuestionRequestActions(
          requestId: requestId,
          questions: message.questionRequestQuestions,
          isReadOnly: message.requestIsReadOnly,
          answerInTerminal: message.questionRequestAnswerInTerminal,
          isEnabled: isConnected && canMutate,
          isResolved: isResolved || isWithdrawn,
          isWithdrawn: isWithdrawn,
          settledAnswers: isResolved
              ? resolvedQuestionAnswers[requestId]
              : null,
          resolvedAttribution: isResolved
              ? resolvedRequestAttributions[requestId]
              : null,
          onSubmit: (answers) => controller.sendQuestionAnswer(
            requestId: requestId,
            answers: answers,
          ),
          onReject: () => controller.rejectQuestion(requestId),
        ),
      _ => null,
    };
    // Request controls remain type-driven here, while the renderer places the
    // resulting stateful surface inside the same compact box as its request
    // title and body. The controller and exact request identity never cross
    // into the design layer.
    final renderer = _MessageContextRegion(
      message: message,
      canFork: isConnected && canFork,
      onForkFromMessage: onForkFromMessage,
      child: TranscriptMessageMetadataScope(
        timestamp: message.timestamp,
        child: buildAgentMessageRenderer(
          context,
          message,
          fileArtifactAction: artifactAction,
          requestAction: requestAction,
          requestSettled: isResolved || isWithdrawn,
        ),
      ),
    );

    if (message.type == AgentMessageType.modelOutput) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          renderer,
          // Starting playback lives in the per-message context menu; only the
          // transient playback/error controls render inline here.
          ReadAloudAction(
            message: message,
            isNewestForIdentity: isNewestEligibleForIdentity,
            showIdleAction: false,
          ),
        ],
      );
    }

    return renderer;
  }
}

class _TranscriptArtifactDownloadAction extends StatelessWidget {
  const _TranscriptArtifactDownloadAction({
    required this.descriptor,
    required this.actionState,
    required this.hasActiveBrokerClient,
    required this.onDownload,
  });

  final SessionArtifactDescriptor descriptor;
  final SessionArtifactActionState actionState;
  final bool hasActiveBrokerClient;
  final Future<bool> Function() onDownload;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final isBusy = _artifactActionIsBusy(actionState.phase);
    final canDownload =
        !isBusy && (descriptor.isInlineDataUrl || hasActiveBrokerClient);
    final stateLabel = _artifactActionLabel(l10n, actionState.phase);
    final sourceId = descriptor.actionStateKey;

    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextButton.icon(
            key: ValueKey(
              'session-detail-chat-artifact-download-$sourceId',
            ),
            style: _transcriptActionButtonStyle(context),
            onPressed: canDownload ? () => unawaited(onDownload()) : null,
            icon: isBusy
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.download_outlined, size: 14),
            label: Text(l10n.download),
          ),
          if (stateLabel.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              stateLabel,
              style: theme.textTheme.labelSmall?.copyWith(
                color: actionState.phase == SessionArtifactActionPhase.error
                    ? tokens.statusError
                    : tokens.textSecondary,
              ),
            ),
          ],
          if (actionState.phase == SessionArtifactActionPhase.error &&
              actionState.message.trim().isNotEmpty)
            Material(
              type: MaterialType.transparency,
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(l10n.technicalDetails),
                children: [Text(actionState.message)],
              ),
            ),
        ],
      ),
    );
  }
}

enum _MessageContextAction { copy, fork, details, readAloud }

final class _TranscriptSelectionMessage {
  const _TranscriptSelectionMessage({
    required this.message,
    required this.canFork,
    required this.onForkFromMessage,
  });

  final AgentMessage message;
  final bool canFork;
  final ValueChanged<String> onForkFromMessage;
}

final class _TranscriptSelectionRegistry extends ChangeNotifier {
  final Map<Object, (SelectionListenerNotifier, _TranscriptSelectionMessage)>
  _messages = {};

  void register(
    Object owner,
    SelectionListenerNotifier notifier,
    _TranscriptSelectionMessage message,
  ) {
    _messages[owner] = (notifier, message);
  }

  void unregister(Object owner) {
    _messages.remove(owner);
  }

  void selectionChanged() {
    notifyListeners();
  }

  bool get hasSelection => selectedMessages.isNotEmpty;

  List<_TranscriptSelectionMessage> get selectedMessages {
    final selected = <_TranscriptSelectionMessage>[];
    for (final (notifier, message) in _messages.values) {
      if (!notifier.registered) continue;
      // The status only, never the range. The range asks each selectable in
      // the row for its own, and while a row rebuilds under a live selection
      // (a markdown row's links are selectables of their own) some of them
      // have none yet: asking then fails an assertion in debug builds and a
      // null check in release. This runs during build. An uncollapsed
      // status already means the row holds selected text.
      if (notifier.selection.status == SelectionStatus.uncollapsed) {
        selected.add(message);
      }
    }
    return selected;
  }
}

class _TranscriptSelectionScope extends InheritedWidget {
  const _TranscriptSelectionScope({
    required this.registry,
    required super.child,
  });

  final _TranscriptSelectionRegistry registry;

  static _TranscriptSelectionRegistry? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_TranscriptSelectionScope>()
      ?.registry;

  @override
  bool updateShouldNotify(_TranscriptSelectionScope oldWidget) =>
      !identical(registry, oldWidget.registry);
}

class _MessageContextRegion extends ConsumerStatefulWidget {
  const _MessageContextRegion({
    required this.message,
    required this.canFork,
    required this.onForkFromMessage,
    required this.child,
  });

  final AgentMessage message;
  final bool canFork;
  final ValueChanged<String> onForkFromMessage;
  final Widget child;

  @override
  ConsumerState<_MessageContextRegion> createState() =>
      _MessageContextRegionState();
}

class _MessageContextRegionState extends ConsumerState<_MessageContextRegion> {
  AgentMessage get message => widget.message;
  final SelectionListenerNotifier _selectionNotifier =
      SelectionListenerNotifier();
  _TranscriptSelectionRegistry? _selectionRegistry;

  /// Whether this message can be spoken right now — eligibility is
  /// type-driven and synthesis has to be available on the platform.
  bool get _canReadAloud =>
      isReadAloudEligible(message) &&
      ref.read(readAloudControllerProvider).capabilities.canAttemptSynthesis;

  void _readAloud() {
    unawaited(
      ref.read(readAloudControllerProvider.notifier).speakForMessage(message),
    );
  }

  @override
  void initState() {
    super.initState();
    _selectionNotifier.addListener(_onSelectionChanged);
  }

  void _onSelectionChanged() {
    _selectionRegistry?.selectionChanged();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = _TranscriptSelectionScope.maybeOf(context);
    if (identical(next, _selectionRegistry)) return;
    _selectionRegistry?.unregister(this);
    _selectionRegistry = next;
    next?.register(
      this,
      _selectionNotifier,
      _TranscriptSelectionMessage(
        message: message,
        canFork: widget.canFork,
        onForkFromMessage: widget.onForkFromMessage,
      ),
    );
  }

  @override
  void didUpdateWidget(_MessageContextRegion oldWidget) {
    super.didUpdateWidget(oldWidget);
    _selectionRegistry?.register(
      this,
      _selectionNotifier,
      _TranscriptSelectionMessage(
        message: message,
        canFork: widget.canFork,
        onForkFromMessage: widget.onForkFromMessage,
      ),
    );
  }

  Future<void> _copyText(BuildContext context) async {
    await Clipboard.setData(
      ClipboardData(text: _messageCopyText(message)),
    );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context).messageCopied),
        ),
      );
    }
  }

  Future<void> _showDetails(BuildContext context) {
    return showDialog<void>(
      context: context,
      builder: (context) => _MessageDetailsDialog(message: message),
    );
  }

  Future<void> _showMenu(BuildContext context, Offset position) async {
    final messageId = message.id;
    final l10n = AppLocalizations.of(context);
    final action = await showMenu<_MessageContextAction>(
      context: context,
      position: RelativeRect.fromLTRB(
        position.dx,
        position.dy,
        MediaQuery.sizeOf(context).width - position.dx,
        MediaQuery.sizeOf(context).height - position.dy,
      ),
      items: [
        PopupMenuItem(
          value: _MessageContextAction.copy,
          child: ListTile(
            dense: true,
            leading: const Icon(Icons.copy_outlined),
            title: Text(l10n.copyText),
          ),
        ),
        if (widget.canFork && messageId != null && messageId.isNotEmpty)
          PopupMenuItem(
            value: _MessageContextAction.fork,
            child: ListTile(
              dense: true,
              leading: const Icon(Icons.call_split),
              title: Text(l10n.sessionSelectionForkFromHere),
            ),
          ),
        if (_canReadAloud)
          PopupMenuItem(
            value: _MessageContextAction.readAloud,
            child: ListTile(
              key: const Key('session-message-read-aloud-item'),
              dense: true,
              leading: const Icon(Icons.volume_up_outlined),
              title: Text(l10n.sessionSelectionReadAloud),
            ),
          ),
        PopupMenuItem(
          value: _MessageContextAction.details,
          child: ListTile(
            dense: true,
            leading: const Icon(Icons.info_outline),
            title: Text(l10n.sessionSelectionDetails),
          ),
        ),
      ],
    );
    if (!context.mounted || action == null) return;
    switch (action) {
      case _MessageContextAction.copy:
        await _copyText(context);
        return;
      case _MessageContextAction.fork:
        if (messageId != null) widget.onForkFromMessage(messageId);
        return;
      case _MessageContextAction.readAloud:
        _readAloud();
        return;
      case _MessageContextAction.details:
        await _showDetails(context);
        return;
    }
  }

  @override
  void dispose() {
    _selectionRegistry?.unregister(this);
    _selectionNotifier
      ..removeListener(_onSelectionChanged)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Stable for as long as the row shows the same message. A reply streaming
    // in arrives as a new message per chunk, with no id and a new seq, under
    // one key: an identity that changed with it would rebuild the row from
    // scratch on every chunk, losing everything inside it (a thinking row
    // the reader opened, a selection) and laying out all of its text again.
    final rawKey = message.raw['key'];
    final identity =
        message.toolCallId ??
        message.userMessageClientKey ??
        message.userMessageKey ??
        message.id ??
        (rawKey is String && rawKey.isNotEmpty ? rawKey : null) ??
        message.seq ??
        identityHashCode(message);
    final registry = _selectionRegistry;
    return SelectionListener(
      selectionNotifier: _selectionNotifier,
      child: ListenableBuilder(
        listenable: registry ?? _selectionNotifier,
        builder: (context, child) => GestureDetector(
          key: ValueKey('session-message-context-$identity'),
          behavior: HitTestBehavior.translucent,
          onSecondaryTapDown: registry?.hasSelection ?? false
              ? null
              : (details) =>
                    unawaited(_showMenu(context, details.globalPosition)),
          child: child,
        ),
        child: widget.child,
      ),
    );
  }
}

class _MessageDetailsDialog extends StatelessWidget {
  const _MessageDetailsDialog({required this.message});

  final AgentMessage message;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final timestamp = message.timestamp;
    final duration = message.toolDurationMs;
    return AlertDialog(
      key: const Key('session-message-details-dialog'),
      title: Text(l10n.messageDetails),
      content: SelectionArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _DialogMetadata(
              label: l10n.typeLabel,
              value: message.type.wireValue,
            ),
            _DialogMetadata(
              label: l10n.timestamp,
              value: timestamp == null
                  ? l10n.notSuppliedByBroker
                  : DateTime.fromMillisecondsSinceEpoch(
                      timestamp,
                    ).toIso8601String(),
            ),
            if (duration != null)
              _DialogMetadata(
                label: l10n.duration,
                value: l10n.millisecondsCount(
                  duration.toStringAsFixed(0),
                ),
              ),
            if (message.id case final id?)
              _DialogMetadata(label: l10n.messageId, value: id),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.close),
        ),
      ],
    );
  }
}

String _messageCopyText(AgentMessage message) {
  final preferredKeys = switch (message.type) {
    AgentMessageType.modelOutput => const ['text', 'delta', 'content'],
    AgentMessageType.userMessage => const ['text', 'content', 'message'],
    AgentMessageType.thinking => const ['text', 'content', 'thought'],
    AgentMessageType.toolCall => const ['summary', 'command', 'name'],
    AgentMessageType.toolResult => const ['output', 'text', 'summary'],
    _ => const ['text', 'message', 'content', 'summary'],
  };
  for (final key in preferredKeys) {
    final value = message.raw[key];
    if (value is String && value.trim().isNotEmpty) return value;
  }
  return _stringifyMessageValue(message.raw);
}

String _terminalSummaryFromMessage(
  AppLocalizations l10n,
  AgentMessage message,
) {
  final command = _firstMessageValue(message, const ['command', 'cmd']);
  final exitCode = _firstMessageValue(
    message,
    const ['exitCode', 'code', 'status'],
  );
  final source = _firstMessageValue(message, const ['source', 'agent', 'id']);
  final summaryParts = <String>[
    if (command.isNotEmpty) command,
    if (source.isNotEmpty && source != command) '($source)',
    if (exitCode.isNotEmpty) 'exit=$exitCode',
  ];

  if (summaryParts.isNotEmpty) {
    return summaryParts.join(' ');
  }

  return l10n.terminalOutput;
}

String _terminalOutputText(AgentMessage message) {
  final output = _firstMessageValue(
    message,
    const ['output', 'stdout', 'stderr', 'text'],
  );
  if (output.isNotEmpty) {
    return output;
  }

  return _stringifyMessageValue(message.raw['body']);
}

String _firstMessageValue(
  AgentMessage message,
  List<String> keys,
) {
  final value = _firstMessageValueRaw(message: message, keys: keys);
  return _stringifyMessageValue(value);
}

Object? _firstMessageValueRaw({
  required AgentMessage message,
  required List<String> keys,
}) {
  for (final key in keys) {
    final value = message.raw[key];
    if (value != null) {
      return value;
    }
  }
  return null;
}

String _stringifyMessageValue(Object? value) {
  if (value == null) {
    return '';
  }
  if (value is Map) {
    return value.entries
        .map((entry) => '${entry.key}: ${_stringifyMessageValue(entry.value)}')
        .join(', ');
  }
  if (value is Iterable) {
    return value.map(_stringifyMessageValue).join(', ');
  }
  return value.toString();
}

enum _RequestActionOutcomeState {
  pending,
  submitting,
  sent,
  failed,
}

String _requestOutcomeLabel(
  AppLocalizations l10n,
  _RequestActionOutcomeState state,
) {
  return switch (state) {
    _RequestActionOutcomeState.pending => l10n.sessionRequestPending,
    _RequestActionOutcomeState.submitting => l10n.sessionRequestSubmitting,
    _RequestActionOutcomeState.sent => l10n.sessionRequestSent,
    _RequestActionOutcomeState.failed => l10n.sessionRequestFailed,
  };
}

/// The permission answers this app can actually send.
///
/// Declaration order is render order. Every member is paired with a decision
/// in [_PermissionRequestActionsState._optionButton] through an exhaustive
/// switch, so a member added without a handler fails to compile.
enum _PermissionApprovalOption { reject, approve, approveRule, approveSession }

/// Resolves one advertised `permission-request.options` entry onto the answer
/// this app sends for it, or `null` when the app has no decision for it.
///
/// The adapter states what the harness offers; the client renders what it is
/// told, but only from the vocabulary above. Anything else is not our answer
/// to give.
_PermissionApprovalOption? _permissionApprovalOptionFor(String advertised) {
  final normalized = advertised.trim().toLowerCase().replaceAll('_', '-');
  return switch (normalized) {
    'approve' => _PermissionApprovalOption.approve,
    'reject' => _PermissionApprovalOption.reject,
    'approve-session' ||
    'always' ||
    'allow-session' ||
    'allow session' => _PermissionApprovalOption.approveSession,
    'approve-rule' => _PermissionApprovalOption.approveRule,
    _ => null,
  };
}

/// The answer buttons to render for [message], in a fixed order.
///
/// `approve` and `reject` are the documented floor — `options` "defaults to
/// approve/reject in the UI when absent" — so they always render and an
/// adapter only has to advertise what it adds on top. An advertised option
/// this app has no decision for is dropped: a harness that later offers a
/// fourth answer degrades to the answers we can actually send instead of
/// growing a button that does nothing.
List<_PermissionApprovalOption> _permissionApprovalOptions(
  AgentMessage message,
) {
  final rendered = <_PermissionApprovalOption>{
    _PermissionApprovalOption.reject,
    _PermissionApprovalOption.approve,
  };
  for (final advertised in message.permissionRequestOptions) {
    final option = _permissionApprovalOptionFor(advertised);
    if (option != null) rendered.add(option);
  }
  return [
    for (final option in _PermissionApprovalOption.values)
      if (rendered.contains(option)) option,
  ];
}

class _RequestOutcomeBadge extends StatelessWidget {
  const _RequestOutcomeBadge({
    required this.state,
    required this.label,
  });

  final _RequestActionOutcomeState state;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final color = switch (state) {
      _RequestActionOutcomeState.pending => tokens.textTertiary,
      _RequestActionOutcomeState.submitting => tokens.accent,
      _RequestActionOutcomeState.sent => tokens.statusWorking,
      _RequestActionOutcomeState.failed => tokens.statusError,
    };

    return Text(
      label,
      style: theme.textTheme.labelSmall?.copyWith(color: color),
    );
  }
}

double _transcriptActionTargetExtent(BuildContext context) {
  final platform = Theme.of(context).platform;
  return platform == TargetPlatform.android || platform == TargetPlatform.iOS
      ? 40
      : 32;
}

ButtonStyle _transcriptActionButtonStyle(BuildContext context) {
  return ButtonStyle(
    minimumSize: WidgetStatePropertyAll(
      Size(0, _transcriptActionTargetExtent(context)),
    ),
    padding: const WidgetStatePropertyAll(
      EdgeInsets.symmetric(horizontal: 8),
    ),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    visualDensity: VisualDensity.standard,
  );
}

class _PermissionRequestActions extends StatefulWidget {
  const _PermissionRequestActions({
    required this.requestId,
    required this.options,
    required this.isReadOnly,
    required this.onApprove,
    required this.onApproveSession,
    required this.onApproveRule,
    required this.onReject,
    required this.isEnabled,
    required this.isResolved,
    this.isWithdrawn = false,
    this.resolvedDecision,
    this.resolvedAttribution,
    this.releaseReason,
  });

  final String requestId;

  /// The answers to offer, already filtered to the ones this app can send.
  final List<_PermissionApprovalOption> options;
  final bool isReadOnly;
  final Future<bool> Function() onApprove;
  final Future<bool> Function() onApproveSession;
  final Future<bool> Function() onApproveRule;
  final Future<bool> Function() onReject;
  final bool isEnabled;

  /// Whether a `permission-resolved` for this request already arrived (locally
  /// or from another client). When true the approve/reject buttons deactivate.
  final bool isResolved;

  /// Whether the session no longer offers this request although no
  /// resolution for it arrived ([isResolved] is then true too): the card
  /// shows no outcome.
  final bool isWithdrawn;

  /// The canonical resolution's decision (`approve`, `approve-session`,
  /// `reject`, `external`, …) when [isResolved]; renders the settled card's
  /// compact outcome.
  final String? resolvedDecision;

  /// Whose answer closed this card, when the broker said. The decision
  /// alone cannot carry it: `external` covers an app answer the terminal
  /// confirmed, a terminal answer the app never made, and nobody answering
  /// at all, and those are three different things to tell the user.
  final ResolvedRequestAttribution? resolvedAttribution;

  /// Why the broker left this read-only card to the terminal, when it did.
  /// The card leads with that sentence, so the outcome must not repeat it.
  final PermissionReleaseReason? releaseReason;

  @override
  State<_PermissionRequestActions> createState() =>
      _PermissionRequestActionsState();
}

/// Which seat settled a card, in the app's own words, or null when the broker
/// did not say. A permission card and an answered question card say it the
/// same way; a question closed unanswered says so instead
/// ([_questionClosedUnansweredLine]).
///
/// A release reason wins over a decider where both arrived, because the pair
/// only happens on a deadline, and "nobody answered in time" is the sentence
/// the user needs, not a location.
String? _requestSettledWhereLine(
  AppLocalizations l10n,
  ResolvedRequestAttribution? attribution,
) {
  if (attribution == null) return null;
  // A reason beats a seat. The pair only arrives on a deadline, and "nobody
  // answered in time" is the fact; naming a seat that did not answer is not.
  final reason = attribution.releaseReason;
  if (reason != null) {
    return switch (reason) {
      PermissionReleaseReason.modeBypassPermissions =>
        l10n.sessionRequestReleaseModeBypass,
      PermissionReleaseReason.modeUnknown =>
        l10n.sessionRequestReleaseModeUnknown,
      PermissionReleaseReason.planTerminalOnly =>
        l10n.sessionRequestReleasePlanTerminalOnly,
      PermissionReleaseReason.viewerNone =>
        l10n.sessionRequestReleaseViewerNone,
      PermissionReleaseReason.killSwitch =>
        l10n.sessionRequestReleaseKillSwitch,
      PermissionReleaseReason.band => l10n.sessionRequestReleaseBand,
      PermissionReleaseReason.expired => l10n.sessionRequestReleaseExpired,
      PermissionReleaseReason.unknown => null,
    };
  }
  final decider = attribution.decider;
  if (decider == null) return null;
  return switch (decider) {
    PermissionDecidedBy.app => l10n.sessionRequestDecidedByApp,
    PermissionDecidedBy.band => l10n.sessionRequestDecidedByBand,
    PermissionDecidedBy.expired => l10n.sessionRequestDecidedByExpired,
    PermissionDecidedBy.unknown => null,
  };
}

/// What a question card says when it closed with nothing picked, or null when
/// something was picked or the broker did not say who closed it.
///
/// The seat sentences above are an approval card's, and an approval always
/// has an answer. A question can end with none: Escape at the terminal comes
/// back as the terminal's, and Stop or Dismiss in the app as the app's, and
/// "You answered it in your terminal." or "Answered in the app" then told the
/// person an answer was given when nobody chose one. A broker that names a
/// seat also sends the answers whenever there were some (both arrived in the
/// same contract revision), so a named seat with no answers is a question
/// closed unanswered. A deadline keeps its own sentence, which already says
/// nobody answered.
String? _questionClosedUnansweredLine(
  AppLocalizations l10n,
  ResolvedRequestAttribution? attribution,
  List<List<String>>? answers,
) {
  if (attribution == null) return null;
  if (answers != null && answers.any((row) => row.isNotEmpty)) return null;
  final reason = attribution.releaseReason;
  final decider = attribution.decider;
  if (reason == PermissionReleaseReason.band ||
      (reason == null && decider == PermissionDecidedBy.band)) {
    return l10n.sessionQuestionClosedUnansweredInTerminal;
  }
  if (reason == null && decider == PermissionDecidedBy.app) {
    return l10n.sessionQuestionClosedUnansweredInApp;
  }
  return null;
}

class _PermissionRequestActionsState extends State<_PermissionRequestActions> {
  /// Which seat answered, in the app's own words, or null when the broker
  /// did not say.
  String? _settledWhereLine(AppLocalizations l10n) =>
      _requestSettledWhereLine(l10n, widget.resolvedAttribution);

  bool _isSubmitting = false;
  _RequestActionOutcomeState _outcome = _RequestActionOutcomeState.pending;
  String? _failureMessage;

  Future<void> _send(Future<bool> Function() action) async {
    if (!widget.isEnabled ||
        widget.isReadOnly ||
        _isSubmitting ||
        _outcome == _RequestActionOutcomeState.sent) {
      return;
    }

    setState(() {
      _isSubmitting = true;
      _outcome = _RequestActionOutcomeState.submitting;
      _failureMessage = null;
    });
    final success = await action();
    if (!mounted) {
      return;
    }
    setState(() {
      _isSubmitting = false;
      if (success) {
        _outcome = _RequestActionOutcomeState.sent;
      } else {
        _outcome = _RequestActionOutcomeState.failed;
        _failureMessage = AppLocalizations.of(
          context,
        ).sessionRequestActionFailed;
      }
    });
  }

  /// The single place an offered option is paired with the decision it sends.
  ///
  /// The switch is exhaustive on purpose: an option with no answer behind it
  /// cannot reach this method, because [_permissionApprovalOptionFor] drops
  /// every advertised string that does not resolve to a member.
  Widget _optionButton(
    BuildContext context,
    _PermissionApprovalOption option, {
    required bool canSubmit,
    required AppLocalizations l10n,
  }) {
    final style = _transcriptActionButtonStyle(context);
    return switch (option) {
      _PermissionApprovalOption.reject => OutlinedButton(
        key: ValueKey('session-detail-permission-reject-${widget.requestId}'),
        style: style,
        onPressed: canSubmit ? () => _send(widget.onReject) : null,
        child: Text(l10n.sessionRequestReject),
      ),
      _PermissionApprovalOption.approve => FilledButton(
        key: ValueKey('session-detail-permission-approve-${widget.requestId}'),
        style: style,
        onPressed: canSubmit ? () => _send(widget.onApprove) : null,
        child: _isSubmitting
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : Text(
                widget.options.any(
                      (candidate) =>
                          candidate != _PermissionApprovalOption.reject &&
                          candidate != _PermissionApprovalOption.approve,
                    )
                    ? l10n.sessionRequestApproveOnce
                    : l10n.sessionRequestApprove,
              ),
      ),
      _PermissionApprovalOption.approveRule => FilledButton.tonal(
        key: ValueKey(
          'session-detail-permission-approve-rule-${widget.requestId}',
        ),
        style: style,
        onPressed: canSubmit ? () => _send(widget.onApproveRule) : null,
        child: Text(l10n.sessionRequestApproveRule),
      ),
      _PermissionApprovalOption.approveSession => FilledButton.tonal(
        key: ValueKey(
          'session-detail-permission-approve-session-${widget.requestId}',
        ),
        style: style,
        onPressed: canSubmit ? () => _send(widget.onApproveSession) : null,
        child: Text(l10n.sessionRequestApproveSession),
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final canSubmit =
        widget.isEnabled &&
        !widget.isReadOnly &&
        !widget.isResolved &&
        !_isSubmitting &&
        _outcome != _RequestActionOutcomeState.sent;
    // The broker's resolution outranks this seat's own submission: a tap that
    // lost the race is still a tap the user made, and the card has to say who
    // answered the call. What it may NOT do is claim another client answered
    // when this one did. `external` is the broker's word for "somebody else
    // settled it", and it is also what it sends when THIS seat's answer
    // reached the terminal, so the sentence needs a decision value, a seat, or
    // this seat's own send to stand on -- and says nothing when none of the
    // three does. A withdrawn card is not settled at all: nobody answered
    // it, and no resolution for it arrived.
    final resolvedByBroker = widget.isResolved && !widget.isWithdrawn;
    final decisionLine = switch (widget.resolvedDecision) {
      'approve' => l10n.sessionRequestOutcomeApproved,
      'approve-session' => l10n.sessionRequestOutcomeApprovedSession,
      'approve-rule' => l10n.sessionRequestOutcomeApprovedRule,
      'reject' => l10n.sessionRequestOutcomeRejected,
      _ => null,
    };
    // A card that explains why the terminal has the prompt is closed by the
    // broker with that same reason attached, and the card already leads with
    // it: printed again as the outcome, the card said one thing twice. Only
    // the terminal could have settled it, so that is the outcome.
    final explainsItself =
        widget.isReadOnly &&
        widget.releaseReason != null &&
        widget.releaseReason != PermissionReleaseReason.unknown;
    final seatLine = resolvedByBroker && !explainsItself
        ? _settledWhereLine(l10n)
        : null;
    final settledHere = _outcome == _RequestActionOutcomeState.sent;
    final outcomeLine = !resolvedByBroker
        ? null
        : explainsItself
        ? l10n.sessionRequestSettledInTerminal
        : (decisionLine ??
              seatLine ??
              (settledHere ? null : l10n.sessionRequestResolvedElsewhere));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.isWithdrawn &&
            _outcome != _RequestActionOutcomeState.sent) ...[
          Text(
            l10n.sessionRequestNoLongerWaiting,
            key: ValueKey(
              'session-detail-permission-withdrawn-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
        ] else if (outcomeLine != null) ...[
          Text(
            outcomeLine,
            key: ValueKey(
              'session-detail-permission-outcome-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
          // The seat, under the decision. Two people with one session can each
          // answer from a different place, and "Resolved in another client"
          // over their own keyboard is the confusion this line exists to end.
          // It is the headline only when there was no decision value to show,
          // and never printed twice.
          if (decisionLine != null && seatLine != null) ...[
            Text(
              seatLine,
              key: ValueKey(
                'session-detail-permission-decided-by-${widget.requestId}',
              ),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: 4),
        ] else if (widget.isReadOnly) ...[
          Text(
            l10n.sessionRequestReadOnlyReply,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
        ] else if (!widget.isEnabled) ...[
          Text(
            l10n.sessionRequestConnectToReply,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.statusError,
            ),
          ),
          const SizedBox(height: 4),
        ],
        // A read-only request is non-actionable by design: it carries the
        // notice above and no answer controls at all, so nothing an adapter
        // advertises can grow a button on this path.
        if (!widget.isReadOnly)
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final option in widget.options)
                _optionButton(
                  context,
                  option,
                  canSubmit: canSubmit,
                  l10n: l10n,
                ),
            ],
          ),
        // The badge is this client's transport state -- pending, submitting,
        // sent, failed -- and it stops being the card's story the moment the
        // broker has a sentence of its own to put on the card. That sentence is
        // the only case that can contradict it: a request the broker settled
        // elsewhere used to render "Approved" above the buttons and "Pending"
        // below them, which is what an installed client showed. A card nobody
        // has answered yet really is waiting on this seat, so `pending` stays.
        // A read-only card is not waiting on this seat at all, and "Pending"
        // under "Answer where the agent is running" said it was.
        if (outcomeLine == null &&
            !(widget.isReadOnly &&
                _outcome == _RequestActionOutcomeState.pending)) ...[
          const SizedBox(height: 8),
          _RequestOutcomeBadge(
            state: _outcome,
            label: _requestOutcomeLabel(l10n, _outcome),
          ),
        ],
        if (_failureMessage != null && _failureMessage!.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(
            _failureMessage!,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
        ],
      ],
    );
  }
}

class _QuestionRequestActions extends StatefulWidget {
  const _QuestionRequestActions({
    required this.requestId,
    required this.questions,
    required this.isReadOnly,
    required this.isEnabled,
    required this.isResolved,
    required this.onSubmit,
    required this.onReject,
    this.isWithdrawn = false,
    this.answerInTerminal = false,
    this.settledAnswers,
    this.resolvedAttribution,
  });

  final String requestId;
  final List<AgentQuestion> questions;
  final bool isReadOnly;

  /// The question is open in the agent's terminal and only answerable there:
  /// the card shows it, says where to answer, and offers nothing to send.
  final bool answerInTerminal;
  final bool isEnabled;

  /// Whether a `question-resolved` for this request already arrived (locally or
  /// from another client). When true the answer/dismiss controls deactivate.
  final bool isResolved;

  /// Whether the session no longer offers this question although no
  /// resolution for it arrived ([isResolved] is then true too): the card
  /// shows no outcome.
  final bool isWithdrawn;

  /// The answer the question closed with, one row per question, when the
  /// resolution said. The settled card draws it: the options picked checked,
  /// and anything typed as text. Every seat draws the same answer, the one
  /// that sent it included.
  final List<List<String>>? settledAnswers;

  /// Who settled the question, when the broker said: answered in the app,
  /// taken back by the terminal, or left when cosyncing stopped waiting. The
  /// seat that sent the answer says so too, after a reload as well as live.
  final ResolvedRequestAttribution? resolvedAttribution;
  final Future<bool> Function(List<List<String>> answers) onSubmit;
  final Future<bool> Function() onReject;

  @override
  State<_QuestionRequestActions> createState() =>
      _QuestionRequestActionsState();
}

class _QuestionRequestActionsState extends State<_QuestionRequestActions>
    with WebHandoffHold<_QuestionRequestActions> {
  late List<TextEditingController> _answerControllers;
  late List<Set<String>> _selectedAnswers;
  bool _isSubmitting = false;
  _RequestActionOutcomeState _outcome = _RequestActionOutcomeState.pending;
  String? _failureMessage;

  /// The settled answer for question [index], when the card is settled and
  /// the resolution said what it was.
  List<String>? _settledRow(int index) {
    final answers = widget.settledAnswers;
    if (!widget.isResolved ||
        answers == null ||
        answers.length != widget.questions.length) {
      return null;
    }
    return answers[index];
  }

  /// Number of answer slots the current `widget.questions` requires.
  ///
  /// A single-slot card (`widget.questions` empty) still owns one controller
  /// for the legacy free-text answer field.
  int get _requiredInputCount =>
      widget.questions.isEmpty ? 1 : widget.questions.length;

  @override
  List<TextEditingController> get webHandoffControllers => _answerControllers;

  /// An answer the agent is waiting on lives only in this card (N3b).
  ///
  /// Typed text and picked options are equally unrecoverable: nothing persists
  /// either until submit, and a web-update handoff would return the user to a
  /// blank card with the question still open.
  @override
  bool webHandoffHasContent() {
    for (final selection in _selectedAnswers) {
      if (selection.isNotEmpty) return true;
    }
    return super.webHandoffHasContent();
  }

  @override
  void initState() {
    super.initState();
    final inputCount = _requiredInputCount;
    _answerControllers = List.generate(
      inputCount,
      (_) => TextEditingController(),
    );
    _selectedAnswers = List.generate(inputCount, (_) => <String>{});
  }

  @override
  void didUpdateWidget(covariant _QuestionRequestActions oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The outer _MessageRow is unkeyed in a positional ListView, so a
    // re-pair onto a different question-request at the same slot is possible
    // (history prepend, reorder). Resize the per-question state to match the
    // new widget so build() never reads an out-of-range index and so stale
    // typed/selected answers do not leak onto the wrong card.
    final target = _requiredInputCount;
    if (_answerControllers.length == target) return;
    if (_answerControllers.length < target) {
      for (var i = _answerControllers.length; i < target; i++) {
        _answerControllers.add(TextEditingController());
        _selectedAnswers.add(<String>{});
      }
    } else {
      for (var i = _answerControllers.length - 1; i >= target; i--) {
        _answerControllers.removeAt(i).dispose();
        _selectedAnswers.removeAt(i);
      }
    }
    refreshWebHandoffHold();
  }

  @override
  void dispose() {
    for (final controller in _answerControllers) {
      controller.dispose();
    }
    super.dispose();
  }

  List<List<String>> _buildAnswers() {
    if (widget.questions.isNotEmpty) {
      return List.generate(widget.questions.length, (index) {
        final customAnswer = _answerControllers[index].text.trim();
        if (customAnswer.isNotEmpty) return [customAnswer];
        return _selectedAnswers[index].toList(growable: false);
      }, growable: false);
    }

    final answers = <List<String>>[];
    final lines = _answerControllers.first.text.trim().split('\n');
    for (final line in lines) {
      final normalized = line.trim();
      if (normalized.isNotEmpty) {
        answers.add([normalized]);
      }
    }

    return answers;
  }

  bool get _canSend {
    final answers = _buildAnswers();
    return widget.isEnabled &&
        !widget.isReadOnly &&
        !widget.isResolved &&
        !_isSubmitting &&
        _outcome != _RequestActionOutcomeState.sent &&
        answers.isNotEmpty &&
        (widget.questions.isEmpty ||
            (answers.every((answer) => answer.isNotEmpty) &&
                _numbersTaken(answers)));
  }

  /// Whether every number question's answer is one it takes. A number out of
  /// range, or not written plainly, would be refused after the card said
  /// Sent, and the person would find Claude's picker still open.
  bool _numbersTaken(List<List<String>> answers) {
    for (var index = 0; index < widget.questions.length; index++) {
      final question = widget.questions[index];
      if (question.kind != AgentQuestionKind.number) continue;
      final answer = answers[index];
      if (answer.length != 1 || !question.takesNumber(answer.single)) {
        return false;
      }
    }
    return true;
  }

  Future<bool> _setOutcome(Future<bool> Function() action) async {
    if (!widget.isEnabled ||
        widget.isReadOnly ||
        _isSubmitting ||
        _outcome == _RequestActionOutcomeState.sent) {
      return false;
    }

    setState(() {
      _isSubmitting = true;
      _outcome = _RequestActionOutcomeState.submitting;
      _failureMessage = null;
    });

    final success = await action();
    if (!mounted) {
      return false;
    }

    setState(() {
      _isSubmitting = false;
      if (success) {
        _outcome = _RequestActionOutcomeState.sent;
      } else {
        _outcome = _RequestActionOutcomeState.failed;
        _failureMessage = AppLocalizations.of(
          context,
        ).sessionRequestActionFailed;
      }
    });

    return success;
  }

  Future<void> _send() async {
    final answers = _buildAnswers();
    if (!_canSend) {
      return;
    }

    final success = await _setOutcome(() => widget.onSubmit(answers));
    if (!mounted) {
      return;
    }
    if (success) {
      for (final controller in _answerControllers) {
        controller.clear();
      }
      for (final selection in _selectedAnswers) {
        selection.clear();
      }
      webHandoffContentChanged();
    }
  }

  Future<void> _reject() async {
    await _setOutcome(widget.onReject);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    // How a settled card says it was settled. A question open in the
    // terminal was answered there. A question closed with nothing picked
    // says so, and where it was closed. Otherwise the broker's word on who
    // closed it, in the permission card's sentences, which the seat that sent
    // the answer shows too; with no word, this seat names nobody when it sent
    // the answer itself, and says "your terminal or another app" when it did
    // not.
    final settledHere = _outcome == _RequestActionOutcomeState.sent;
    final settledLine = !widget.isResolved || widget.isWithdrawn
        ? null
        : widget.answerInTerminal
        ? l10n.sessionRequestSettledInTerminal
        : (_questionClosedUnansweredLine(
                l10n,
                widget.resolvedAttribution,
                widget.settledAnswers,
              ) ??
              _requestSettledWhereLine(l10n, widget.resolvedAttribution) ??
              (settledHere ? null : l10n.sessionQuestionSettledElsewhere));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.isWithdrawn && _outcome != _RequestActionOutcomeState.sent)
          Text(
            l10n.sessionRequestNoLongerWaiting,
            key: ValueKey(
              'session-detail-question-withdrawn-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          )
        else if (settledLine != null)
          Text(
            settledLine,
            key: ValueKey(
              'session-detail-question-outcome-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          )
        else if (widget.answerInTerminal)
          Text(
            l10n.sessionQuestionAnswerInTerminal,
            key: ValueKey(
              'session-detail-question-in-terminal-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          )
        else if (widget.isReadOnly)
          Text(
            l10n.sessionRequestReadOnlyReply,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          )
        else if (!widget.isEnabled)
          Text(
            l10n.sessionRequestConnectToReply,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.statusError,
            ),
          ),
        const SizedBox(height: 8),
        if (widget.questions.isEmpty) ...[
          if (!widget.answerInTerminal)
            _buildAnswerField(context, index: 0, legacy: true),
        ] else
          for (var index = 0; index < widget.questions.length; index++) ...[
            if (index > 0) const SizedBox(height: 16),
            _buildStructuredQuestion(context, index),
          ],
        // Nothing to send from here: the answer is the terminal's to give.
        if (!widget.answerInTerminal) ...[
          const SizedBox(height: 8),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 4,
            children: [
              TextButton(
                key: ValueKey(
                  'session-detail-question-reject-${widget.requestId}',
                ),
                style: _transcriptActionButtonStyle(context),
                onPressed:
                    widget.isEnabled &&
                        !widget.isReadOnly &&
                        !widget.isResolved &&
                        !_isSubmitting &&
                        _outcome != _RequestActionOutcomeState.sent
                    ? _reject
                    : null,
                child: Text(l10n.sessionRequestDismiss),
              ),
              FilledButton(
                key: ValueKey(
                  'session-detail-question-answer-button-${widget.requestId}',
                ),
                style: _transcriptActionButtonStyle(context),
                onPressed: _canSend ? _send : null,
                child: _isSubmitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(l10n.sessionRequestSubmit),
              ),
            ],
          ),
          // Same contradiction as the permission card: "Answered elsewhere"
          // above and "Pending" below, or "Pending" on a card this seat
          // cannot answer at all.
          if (!((widget.isResolved || widget.isReadOnly) &&
              _outcome == _RequestActionOutcomeState.pending)) ...[
            const SizedBox(height: 8),
            _RequestOutcomeBadge(
              state: _outcome,
              label: _requestOutcomeLabel(l10n, _outcome),
            ),
          ],
          if (_failureMessage != null && _failureMessage!.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              _failureMessage!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
        ],
      ],
    );
  }

  Widget _buildStructuredQuestion(BuildContext context, int index) {
    final question = widget.questions[index];
    final settled = _settledRow(index);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (question.header != null) ...[
          SectionHeader(question.header!),
          const SizedBox(height: 8),
        ],
        Text(
          question.question,
          key: ValueKey(
            'session-detail-question-text-${widget.requestId}-$index',
          ),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: tokens.textPrimary,
          ),
        ),
        if (question.options.isNotEmpty) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (
                var optionIndex = 0;
                optionIndex < question.options.length;
                optionIndex++
              )
                _buildQuestionOption(
                  context,
                  questionIndex: index,
                  optionIndex: optionIndex,
                ),
            ],
          ),
        ],
        // A settled card shows what was typed, as text, in place of the field.
        // A value that is not one of the question's labels was typed: it is
        // never drawn as an option.
        if (settled != null) ...[
          for (final typed in settled.where(
            (answer) => !question.options.any((o) => o.label == answer),
          )) ...[
            const SizedBox(height: 8),
            _buildTypedAnswer(context, index: index, text: typed),
          ],
        ]
        // A typed answer only where the agent takes one: a multi-select that
        // accepts its own labels alone gets no field, and neither does a
        // question that can only be answered in the terminal.
        else if (question.freeText && !widget.answerInTerminal) ...[
          const SizedBox(height: 8),
          _buildAnswerField(context, index: index, legacy: false),
        ],
      ],
    );
  }

  /// What the person typed as the answer to question [index], on a settled
  /// card: read-only, under the same label the answer field carries.
  Widget _buildTypedAnswer(
    BuildContext context, {
    required int index,
    required String text,
  }) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    return InputDecorator(
      key: ValueKey(
        'session-detail-question-typed-${widget.requestId}-$index',
      ),
      decoration: InputDecoration(
        border: InputBorder.none,
        filled: true,
        fillColor: tokens.surface2,
        labelText: l10n.sessionRequestAnswerLabel,
        enabled: false,
      ),
      child: SelectableText(
        text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: tokens.textPrimary,
        ),
      ),
    );
  }

  Widget _buildQuestionOption(
    BuildContext context, {
    required int questionIndex,
    required int optionIndex,
  }) {
    final question = widget.questions[questionIndex];
    final option = question.options[optionIndex];
    final selected =
        (_settledRow(questionIndex) ?? _selectedAnswers[questionIndex])
            .contains(option.label);
    final enabled =
        widget.isEnabled &&
        !widget.isReadOnly &&
        !widget.isResolved &&
        !_isSubmitting &&
        _outcome != _RequestActionOutcomeState.sent;
    final description = option.description;
    return FilterChip(
      key: ValueKey(
        'session-detail-question-option-${widget.requestId}-'
        '$questionIndex-$optionIndex',
      ),
      selected: selected,
      onSelected: enabled
          ? (value) {
              setState(() {
                _answerControllers[questionIndex].clear();
                final selection = _selectedAnswers[questionIndex];
                if (!question.multiple) selection.clear();
                if (value) {
                  selection.add(option.label);
                } else {
                  selection.remove(option.label);
                }
              });
              webHandoffContentChanged();
            }
          : null,
      label: description == null
          ? Text(option.label)
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(option.label),
                Text(
                  description,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: context.tokens.textSecondary,
                  ),
                ),
              ],
            ),
    );
  }

  Widget _buildAnswerField(
    BuildContext context, {
    required int index,
    required bool legacy,
  }) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final question = legacy ? null : widget.questions[index];
    if (question != null && question.kind == AgentQuestionKind.number) {
      return _buildNumberField(context, index: index, question: question);
    }
    return TextField(
      key: ValueKey(
        legacy
            ? 'session-detail-question-answer-${widget.requestId}'
            : 'session-detail-question-custom-${widget.requestId}-$index',
      ),
      controller: _answerControllers[index],
      minLines: 1,
      maxLines: legacy ? 4 : 2,
      enabled:
          widget.isEnabled &&
          !widget.isReadOnly &&
          !widget.isResolved &&
          !_isSubmitting &&
          _outcome != _RequestActionOutcomeState.sent,
      onChanged: (value) {
        setState(() {
          if (widget.questions.isNotEmpty && value.trim().isNotEmpty) {
            _selectedAnswers[index].clear();
          }
        });
      },
      decoration: InputDecoration(
        border: InputBorder.none,
        filled: true,
        fillColor: tokens.surface2,
        labelText: legacy
            ? l10n.sessionRequestAnswerLabel
            : l10n.sessionRequestCustomAnswerHint,
      ),
    );
  }

  /// A number question's answer: one number, written plainly, inside the
  /// range the agent gave. The field names the range and says so when the
  /// typed value is not one the agent takes, and Send waits until it is.
  Widget _buildNumberField(
    BuildContext context, {
    required int index,
    required AgentQuestion question,
  }) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final low = _plainNumber(question.min);
    final high = _plainNumber(question.max);
    final typed = _answerControllers[index].text;
    final invalid = typed.trim().isNotEmpty && !question.takesNumber(typed);
    return TextField(
      key: ValueKey(
        'session-detail-question-number-${widget.requestId}-$index',
      ),
      controller: _answerControllers[index],
      keyboardType: const TextInputType.numberWithOptions(
        signed: true,
        decimal: true,
      ),
      enabled:
          widget.isEnabled &&
          !widget.isReadOnly &&
          !widget.isResolved &&
          !_isSubmitting &&
          _outcome != _RequestActionOutcomeState.sent,
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(
        border: InputBorder.none,
        filled: true,
        fillColor: tokens.surface2,
        labelText: l10n.sessionQuestionNumberLabel(low, high),
        suffixText: question.unit,
        errorText: invalid
            ? l10n.sessionQuestionNumberInvalid(low, high)
            : null,
      ),
    );
  }
}

/// A number as the agent wrote it: `3`, not `3.0`.
String _plainNumber(double? value) {
  if (value == null) return '';
  return value == value.roundToDouble() && value.abs() < 1e15
      ? value.toInt().toString()
      : value.toString();
}
