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
          isResolved: isResolved,
          resolvedDecision: resolvedRequestDecisions[requestId],
        ),
      AgentMessageType.questionRequest when requestId != null =>
        _QuestionRequestActions(
          requestId: requestId,
          questions: message.questionRequestQuestions,
          isReadOnly: message.requestIsReadOnly,
          isEnabled: isConnected && canMutate,
          isResolved: isResolved,
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
      final details = notifier.selection;
      final range = details.range;
      if (details.status == SelectionStatus.uncollapsed &&
          range != null &&
          range.startOffset != range.endOffset) {
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
    final identity =
        message.toolCallId ??
        message.userMessageClientKey ??
        message.userMessageKey ??
        message.id ??
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
    this.resolvedDecision,
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

  /// The canonical resolution's decision (`approve`, `approve-session`,
  /// `reject`, `external`, …) when [isResolved]; renders the settled card's
  /// compact outcome.
  final String? resolvedDecision;

  @override
  State<_PermissionRequestActions> createState() =>
      _PermissionRequestActionsState();
}

class _PermissionRequestActionsState extends State<_PermissionRequestActions> {
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
    // Resolved by another client while this card was still pending locally
    // (a local send flips _outcome to `sent` and owns its own "Sent" badge).
    final resolvedElsewhere =
        widget.isResolved && _outcome != _RequestActionOutcomeState.sent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (resolvedElsewhere) ...[
          Text(
            switch (widget.resolvedDecision) {
              'approve' => l10n.sessionRequestOutcomeApproved,
              'approve-session' => l10n.sessionRequestOutcomeApprovedSession,
              'approve-rule' => l10n.sessionRequestOutcomeApprovedRule,
              'reject' => l10n.sessionRequestOutcomeRejected,
              _ => l10n.sessionRequestResolvedElsewhere,
            },
            key: ValueKey(
              'session-detail-permission-outcome-${widget.requestId}',
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
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
        const SizedBox(height: 8),
        _RequestOutcomeBadge(
          state: _outcome,
          label: _requestOutcomeLabel(l10n, _outcome),
        ),
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
  });

  final String requestId;
  final List<AgentQuestion> questions;
  final bool isReadOnly;
  final bool isEnabled;

  /// Whether a `question-resolved` for this request already arrived (locally or
  /// from another client). When true the answer/dismiss controls deactivate.
  final bool isResolved;
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
            answers.every((answer) => answer.isNotEmpty));
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.isResolved && _outcome != _RequestActionOutcomeState.sent)
          Text(
            l10n.sessionRequestResolvedElsewhere,
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
        if (widget.questions.isEmpty)
          _buildAnswerField(context, index: 0, legacy: true)
        else
          for (var index = 0; index < widget.questions.length; index++) ...[
            if (index > 0) const SizedBox(height: 16),
            _buildStructuredQuestion(context, index),
          ],
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
        const SizedBox(height: 8),
        _RequestOutcomeBadge(
          state: _outcome,
          label: _requestOutcomeLabel(l10n, _outcome),
        ),
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

  Widget _buildStructuredQuestion(BuildContext context, int index) {
    final question = widget.questions[index];
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
        const SizedBox(height: 8),
        _buildAnswerField(context, index: index, legacy: false),
      ],
    );
  }

  Widget _buildQuestionOption(
    BuildContext context, {
    required int questionIndex,
    required int optionIndex,
  }) {
    final question = widget.questions[questionIndex];
    final option = question.options[optionIndex];
    final selected = _selectedAnswers[questionIndex].contains(option.label);
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
}
