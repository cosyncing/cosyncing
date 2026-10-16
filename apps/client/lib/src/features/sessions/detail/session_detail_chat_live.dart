part of 'session_detail_page.dart';

class _ChatPanel extends ConsumerWidget {
  const _ChatPanel({
    required this.sessionKey,
    required this.sessionLabel,
    required this.state,
    required this.controller,
    required this.commands,
    required this.models,
    required this.modes,
    required this.effectiveModel,
    required this.selectedPermissionMode,
    required this.selectedCommand,
    required this.isConnected,
    required this.hasActiveBrokerClient,
    required this.commandArgsController,
    required this.hasModelOverride,
    required this.isSendingPrompt,
    required this.isPickingAttachments,
    required this.isAttachmentIntakeBusy,
    required this.promptController,
    required this.promptFocusNode,
    required this.stagedAttachments,
    required this.archivedLiveState,
    required this.onArchiveLiveState,
    required this.archiveTargetKey,
    required this.reportView,
    required this.toolsExpanded,
    required this.toolExpansionRevision,
    required this.onSendCommand,
    required this.onCommandSelected,
    required this.onSessionDetails,
    required this.onAttachFiles,
    required this.onBeginAttachmentIntake,
    required this.onReplaceAttachment,
    required this.onRemoveAttachment,
    required this.onSendPrompt,
    required this.onInterrupt,
    required this.bootstrapRetrying,
    required this.onRetryBootstrap,
    required this.onAttach,
    required this.onForkFromMessage,
    required this.onModelAndEffortSelected,
    required this.onPermissionModeSelected,
    super.key,
  });

  final SessionDetailKey sessionKey;

  /// How this session is named on surfaces that show it from outside — the
  /// prompt-target note. Resolved by the page, which owns the title fallback.
  final String sessionLabel;
  final SessionDetailState state;
  final SessionDetailController controller;
  final List<SlashCommand> commands;
  final List<ModelOption> models;
  final List<ModeOption> modes;
  final SessionCurrentModel? effectiveModel;
  final String? selectedPermissionMode;
  final SlashCommand? selectedCommand;
  final TextEditingController commandArgsController;

  /// Whether the composer carries a local model override, which changes how
  /// command args validate.
  final bool hasModelOverride;
  final bool isConnected;
  final bool hasActiveBrokerClient;
  final bool isSendingPrompt;
  final bool isPickingAttachments;
  final bool isAttachmentIntakeBusy;
  final TextEditingController promptController;
  final FocusNode promptFocusNode;
  final List<SessionStagedAttachment> stagedAttachments;
  final Map<String, String> archivedLiveState;
  final ValueChanged<List<_LiveStateItem>> onArchiveLiveState;
  final GlobalKey archiveTargetKey;
  final bool reportView;
  final bool toolsExpanded;
  final int toolExpansionRevision;
  final Future<bool> Function() onSendCommand;
  final ValueChanged<String?> onCommandSelected;
  final VoidCallback onSessionDetails;
  final VoidCallback onAttachFiles;
  final _SessionAttachmentIntakeLease? Function() onBeginAttachmentIntake;
  final ValueChanged<String> onReplaceAttachment;
  final ValueChanged<String> onRemoveAttachment;
  final VoidCallback onSendPrompt;
  final VoidCallback onInterrupt;
  final bool bootstrapRetrying;
  final Future<void> Function() onRetryBootstrap;
  final VoidCallback onAttach;
  final ValueChanged<String> onForkFromMessage;
  final void Function(ModelOption model, String? effort)
  onModelAndEffortSelected;
  final ValueChanged<ModeOption> onPermissionModeSelected;

  /// The transcript's theme: body text at the reader's chosen size (see
  /// [DerivedTheme]).
  static final DerivedTheme<double> _transcriptTheme = DerivedTheme(
    (theme, fontSize) => theme.copyWith(
      textTheme: theme.textTheme.copyWith(
        bodyMedium: theme.textTheme.bodyMedium?.copyWith(fontSize: fontSize),
        bodyLarge: theme.textTheme.bodyLarge?.copyWith(fontSize: fontSize),
      ),
    ),
  );

  /// Opens the slash-command sheet. Selection, args parsing and send all stay
  /// owned by the page — the sheet only presents them.
  Future<void> _openCommandPicker(BuildContext context, bool enabled) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _CommandPickerSheet(
        commands: commands,
        initialCommandName: selectedCommand?.name,
        argsController: commandArgsController,
        isEnabled: enabled,
        hasModelOverride: hasModelOverride,
        onCommandSelected: onCommandSelected,
        onSend: onSendCommand,
      ),
    );
  }

  Future<void> _scheduleDraft(BuildContext context, WidgetRef ref) async {
    final text = promptController.text.trim();
    if (text.isEmpty) return;
    final schedule = await showScheduleMessageSheet(
      context,
      tool: sessionKey.tool,
      sessionId: sessionKey.sessionId,
      sessionTitle: sessionLabel,
      text: text,
    );
    if (!context.mounted || schedule == null) return;
    ref
        .read(
          inlineScheduledMessageControllerProvider(
            InlineScheduledMessageKey(
              tool: sessionKey.tool,
              sessionId: sessionKey.sessionId,
            ),
          ).notifier,
        )
        .upsert(schedule);
    // Preserve a newer draft typed while the schedule dialog was open.
    if (promptController.text.trim() == text) promptController.clear();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).sessionScheduledFor(
            DateTime.fromMillisecondsSinceEpoch(schedule.at).toString(),
          ),
        ),
      ),
    );
  }

  String? _compatibilityHint(BuildContext context) {
    final compatibility = state.hello?.compatibility;
    if (compatibility == null) return null;
    final l10n = AppLocalizations.of(context);
    return switch (compatibility.status) {
      BrokerClientCompatibilityStatus.compatible => null,
      // A writable previous client remains coherent. Release availability is
      // presented only at app scope so it cannot be mistaken for a session
      // compatibility error.
      BrokerClientCompatibilityStatus.clientBehind => null,
      BrokerClientCompatibilityStatus.brokerBehind =>
        l10n.sessionCompatibilityBrokerBehind,
      BrokerClientCompatibilityStatus.hardIncompatible =>
        l10n.sessionCompatibilityHardIncompatible,
      BrokerClientCompatibilityStatus.unknown =>
        l10n.sessionCompatibilityUnknown,
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bootstrap = state.bootstrapState;
    if (_bootstrapBlocksChat(state)) {
      return _SessionDetailBootstrapSurface(
        bootstrap: bootstrap,
        retrying: bootstrapRetrying,
        onRetry: onRetryBootstrap,
      );
    }

    final control = SessionControlView.fromSessionDetailState(state);
    final mutationEnabled =
        isConnected && !state.compatibilityReadOnly && control.canPrompt;
    final canSendPrompt =
        mutationEnabled &&
        !isSendingPrompt &&
        !isPickingAttachments &&
        state.interruptPhase == SessionInterruptPhase.idle &&
        (promptController.text.trim().isNotEmpty ||
            stagedAttachments.isNotEmpty);
    final canInterrupt =
        mutationEnabled &&
        state.sessionInfo?.status == SessionStatus.working &&
        state.interruptCommand != null;
    final compatibilityHint = isConnected ? _compatibilityHint(context) : null;
    final showControlBar =
        isConnected && !state.compatibilityReadOnly && !control.canPrompt;
    final display =
        ref.watch(conversationDisplayControllerProvider).valueOrNull ??
        const ConversationDisplayPreferences();
    final transcript = Theme(
      data: _transcriptTheme.of(Theme.of(context), display.fontSize),
      child: _TranscriptSurface(
        state: state,
        controller: controller,
        isConnected: isConnected,
        hasActiveBrokerClient: hasActiveBrokerClient,
        // Same per-session gate as the status-panel Fork tile: the transcript's
        // message-context "Fork from here" is a second entry point into the
        // same
        // broker route, so it answers the same shared predicate — including a
        // standing broker refusal, which is the case a bare origin check
        // misses.
        canFork:
            !state.compatibilityReadOnly &&
            (state.agentActions?.canFork ?? false) &&
            !state.forkBlockedAsAgentOwned,
        toolDisplayMode:
            ref.watch(toolDisplayControllerProvider).valueOrNull ??
            ToolDisplayMode.responsive,
        onForkFromMessage: onForkFromMessage,
        reportView: reportView,
        toolsExpanded: toolsExpanded,
        toolExpansionRevision: toolExpansionRevision,
        bootstrapRetrying: bootstrapRetrying,
        onRetryBootstrap: onRetryBootstrap,
      ),
    );
    final liveStateSurface = _SessionLiveStateSurface(
      liveState: state.liveState,
      commandProgress: state.commandProgress,
      commands: commands,
      controller: controller,
      isConnected: isConnected,
      canPrompt: control.canPrompt,
      archivedIdentities: archivedLiveState,
      onArchive: onArchiveLiveState,
      archiveTargetKey: archiveTargetKey,
    );
    final bootstrapStatus = _bootstrapShowsInlineStatus(bootstrap)
        ? _SessionDetailBootstrapInlineStatus(
            bootstrap: bootstrap,
            retrying: bootstrapRetrying,
            onRetry: onRetryBootstrap,
          )
        : null;
    // The chat tab is full-bleed so the transcript scrollbar can reach the
    // window edge; everything that is not the scroll view re-applies the
    // readable width (and, on phones, the 16px gutter) for itself.
    final composer = _ReadableColumn(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (compatibilityHint != null) ...[
            _CompatibilityNotice(message: compatibilityHint),
            const SizedBox(height: 12),
          ],
          if (showControlBar) ...[
            _ObserveComposerBar(
              control: control,
              sessionKey: sessionKey,
              conflict: state.driveRestoreConflict,
            ),
            const SizedBox(height: 8),
          ],
          _PromptComposer(
            sessionPaneKey: SessionPaneKey(session: sessionKey).key,
            sessionLabel: sessionLabel,
            commands: commands,
            controller: promptController,
            focusNode: promptFocusNode,
            enabled: true,
            controlsEnabled: mutationEnabled,
            canSend: canSendPrompt,
            isSubmitting: isSendingPrompt,
            canInterrupt: canInterrupt,
            interruptPhase: state.interruptPhase,
            isPickingAttachments: isPickingAttachments,
            isAttachmentIntakeBusy: isAttachmentIntakeBusy,
            attachmentEnabled:
                (state.agentActions?.canAttachFiles ?? false) &&
                !isSendingPrompt,
            stagedAttachments: stagedAttachments,
            onSessionDetails: onSessionDetails,
            onScheduleDraft:
                mutationEnabled && promptController.text.trim().isNotEmpty
                ? () => unawaited(_scheduleDraft(context, ref))
                : null,
            onAttachFiles: onAttachFiles,
            onBeginAttachmentIntake: onBeginAttachmentIntake,
            onReplaceAttachment: onReplaceAttachment,
            onRemoveAttachment: onRemoveAttachment,
            onSend: onSendPrompt,
            onInterrupt: onInterrupt,
            connectionStatus: state.connectionStatus,
            models: models,
            agents: state.agents,
            modes: modes,
            effectiveModel: effectiveModel,
            currentAgent: state.sessionInfo?.currentAgent,
            selectedPermissionMode: selectedPermissionMode,
            legacyModel: state.sessionInfo?.model,
            telemetry: state.telemetry,
            telemetryLastKnown:
                SessionDetailFreshnessPresentation.fromState(state).freshness !=
                SessionFreshness.current,
            onModelAndEffortSelected: onModelAndEffortSelected,
            onAgentSelected: (agent) =>
                unawaited(controller.setAgent(agent.name)),
            onPermissionModeSelected: onPermissionModeSelected,
            onReattach: onAttach,
            onOpenCommandPicker: () =>
                unawaited(_openCommandPicker(context, mutationEnabled)),
          ),
        ],
      ),
    );

    // The composer remains the second child of this Column for every viewport
    // height. Keyboard-driven geometry may reshape only the upper work surface;
    // it must never reparent EditableText between a ListView and a Column.
    return Column(
      children: [
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              // The expanded panel is the reading surface for a plan or task
              // list, so its cap follows the viewport instead of a fixed 160:
              // at that height an opened list showed two rows. The transcript
              // still keeps the majority of the work surface.
              final liveStateMaxHeight = (constraints.maxHeight * 0.45).clamp(
                160.0,
                420.0,
              );
              return Column(
                children: [
                  if (bootstrapStatus != null) bootstrapStatus,
                  if (!state.liveState.isEmpty || state.commandProgress != null)
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: constraints.maxHeight < 360
                            ? constraints.maxHeight * 0.3
                            : liveStateMaxHeight,
                      ),
                      child: SingleChildScrollView(
                        child: _ReadableColumn(child: liveStateSurface),
                      ),
                    ),
                  Expanded(child: transcript),
                ],
              );
            },
          ),
        ),
        // No gap: the composer's own rounded container is the top edge of the
        // composer region. There is no card or tab around it, so any spacer
        // here would read as a second boundary.
        composer,
      ],
    );
  }
}

/// Pinned, keyed goal/task state above the transcript.
///
/// These broker messages describe current session state. They replace by key
/// and never accumulate as chronological chat bubbles.
class _SessionLiveStateSurface extends StatelessWidget {
  const _SessionLiveStateSurface({
    required this.liveState,
    required this.commandProgress,
    required this.commands,
    required this.controller,
    required this.isConnected,
    required this.canPrompt,
    required this.archivedIdentities,
    required this.onArchive,
    required this.archiveTargetKey,
  });

  final SessionLiveState liveState;
  final SessionCommandProgress? commandProgress;
  final List<SlashCommand> commands;
  final SessionDetailController controller;
  final bool isConnected;
  final bool canPrompt;
  final Map<String, String> archivedIdentities;
  final ValueChanged<List<_LiveStateItem>> onArchive;
  final GlobalKey archiveTargetKey;

  @override
  Widget build(BuildContext context) {
    final items = _liveStateItemsFromParts(
      AppLocalizations.of(context),
      liveState,
      commandProgress,
    );
    final visibleItems = items
        .where(
          (item) =>
              item.actionRequired ||
              archivedIdentities[item.id] != item.archiveIdentity,
        )
        .toList(growable: false);
    if (visibleItems.isEmpty) {
      return const SizedBox(
        key: Key('session-live-state-surface'),
      );
    }
    // One ordering, read by both the strip and the expanded list: whatever
    // needs an answer, then live work, then outcomes. The strip fronts the
    // first item, so a finished card can no longer stand in front of two that
    // are still running.
    final orderedItems = _orderLiveStateItems(visibleItems);
    final primary = orderedItems.first;
    // Every outcome ranks below all live work, so this splits the order
    // without disturbing it.
    final liveItems = [
      for (final item in orderedItems)
        if (!item.isFinished) item,
    ];
    final finishedItems = [
      for (final item in orderedItems)
        if (item.isFinished) item,
    ];
    final goalCommand = _findGoalCommand(commands);
    Widget row(_LiveStateItem item) => _DismissibleLiveStateRow(
      key: ValueKey('session-live-state-row-${item.id}'),
      item: item,
      onDismiss: item.actionRequired ? null : () => onArchive([item]),
      child: _buildFullLiveStateItem(
        item,
        goalCommand: goalCommand,
        controller: controller,
        isConnected: isConnected,
        canPrompt: canPrompt,
      ),
    );
    return Column(
      key: const Key('session-live-state-surface'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // One strip for the whole band, keyed by the band and not by whichever
        // item fronts it. Fronting now follows status, so the front changes
        // whenever a card finishes, and a per-item key collapsed the panel the
        // reader had open at exactly that moment.
        _ArchivableLiveStateItem(
          key: const ValueKey('session-live-state-band'),
          item: primary,
          summary: orderedItems.length > 1
              ? _LiveStateSummary.of(orderedItems)
              : null,
          initiallyExpanded: visibleItems.any(
            (item) => item.actionRequired,
          ),
          onArchive: () => onArchive([primary]),
          archiveTargetKey: archiveTargetKey,
          fullCard: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < liveItems.length; index++) ...[
                row(liveItems[index]),
                if (index < liveItems.length - 1 || finishedItems.isNotEmpty)
                  const SizedBox(height: 8),
              ],
              // A lone card needs no section around it; its own dismiss is
              // enough.
              if (finishedItems.isNotEmpty && orderedItems.length == 1)
                row(finishedItems.single)
              else if (finishedItems.isNotEmpty)
                _FinishedLiveStateSection(
                  // Keyed by the band, so the reader's fold choice survives
                  // cards arriving, finishing and being dismissed.
                  key: const ValueKey('session-live-state-finished'),
                  count: finishedItems.length,
                  // Folded while anything is live: outcomes pile up over a
                  // long session and would push the work still running out
                  // of the band's capped height. With nothing live, the
                  // outcomes ARE the content, so the section opens.
                  openByDefault: liveItems.isEmpty,
                  onClear: () => onArchive(finishedItems),
                  children: [for (final item in finishedItems) row(item)],
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _FullLiveStatePanel extends StatelessWidget {
  const _FullLiveStatePanel({
    required this.liveState,
    required this.commandProgress,
    required this.commands,
    required this.controller,
    required this.isConnected,
    required this.canPrompt,
  });

  final SessionLiveState liveState;
  final SessionCommandProgress? commandProgress;
  final List<SlashCommand> commands;
  final SessionDetailController controller;
  final bool isConnected;
  final bool canPrompt;

  @override
  Widget build(BuildContext context) {
    final goalCommand = _findGoalCommand(commands);
    final items = _orderLiveStateItems(
      _liveStateItemsFromParts(
        AppLocalizations.of(context),
        liveState,
        commandProgress,
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final item in items) ...[
          _buildFullLiveStateItem(
            item,
            goalCommand: goalCommand,
            controller: controller,
            isConnected: isConnected,
            canPrompt: canPrompt,
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

/// Finds the `goal` action command, tolerating a leading `/` in the name.
SlashCommand? _findGoalCommand(List<SlashCommand> commands) {
  for (final command in commands) {
    final name = command.name.startsWith('/')
        ? command.name.substring(1)
        : command.name;
    if (name == 'goal' && command.kind == SlashCommandKind.action) {
      return command;
    }
  }
  return null;
}

enum _LiveStateItemKind { command, activity, goal, taskList }

/// Where an item stands, harness-neutral: every adapter's activity frame, goal
/// and plan maps onto these five.
enum _LiveStatePhase { needsInput, running, paused, failed, done }

class _LiveStateItem {
  const _LiveStateItem({
    required this.id,
    required this.archiveIdentity,
    required this.kind,
    required this.value,
    required this.label,
    required this.title,
    required this.statusLabel,
    required this.icon,
    required this.actionRequired,
    required this.phase,
    this.done,
    this.total,
    this.startedAtMs,
    this.order,
  });

  final String id;
  final String archiveIdentity;
  final _LiveStateItemKind kind;
  final Object value;
  final String label;
  final String title;
  final String statusLabel;
  final IconData icon;
  final bool actionRequired;
  final _LiveStatePhase phase;
  final int? done;
  final int? total;

  /// The adapter's wall-clock start, when it reports one.
  final int? startedAtMs;

  /// The projection's own first-seen and finished ordinals for an activity.
  final SessionActivityOrder? order;

  /// Whether this is an outcome rather than live work.
  bool get isFinished =>
      phase == _LiveStatePhase.failed || phase == _LiveStatePhase.done;
}

/// The band's rank for [item]: lower fronts the strip.
///
/// A running background command sits below other live work — nothing about it
/// is actionable and it is expected to sit there for minutes — but above every
/// outcome, because it is still live.
int _liveStateRank(_LiveStateItem item) => switch (item.phase) {
  _LiveStatePhase.needsInput => 0,
  _LiveStatePhase.running ||
  _LiveStatePhase.paused => _isBackgroundCommand(item) ? 2 : 1,
  _LiveStatePhase.failed => 3,
  _LiveStatePhase.done => 4,
};

/// Orders [items] for display: by rank, then live work oldest-first (so a new
/// card joins the end instead of shuffling the rows above it) and outcomes
/// newest-first. Ties keep source order.
///
/// Live work orders by the adapter's start time when it reports one, else by
/// when the projection first saw it. Not every adapter stamps a start, so the
/// first-seen ordinal is what keeps the order stable for all of them.
List<_LiveStateItem> _orderLiveStateItems(List<_LiveStateItem> items) {
  // Present before absent, then ascending. Spelled out rather than with a
  // large sentinel: the web build's ints are doubles and its shifts 32-bit.
  int nullsLast(int? a, int? b, {bool descending = false}) {
    if (a == null || b == null) {
      return (a == null ? 1 : 0).compareTo(b == null ? 1 : 0);
    }
    return descending ? b.compareTo(a) : a.compareTo(b);
  }

  int compareWithinRank(_LiveStateItem a, _LiveStateItem b) {
    if (a.isFinished) {
      // Newest outcome first. An item without an ordinal (a finished task
      // list) follows the activities that have one.
      return nullsLast(a.order?.ended, b.order?.ended, descending: true);
    }
    final started = nullsLast(a.startedAtMs, b.startedAtMs);
    if (started != 0) return started;
    return nullsLast(a.order?.seen, b.order?.seen);
  }

  final indexed =
      [
        for (var index = 0; index < items.length; index++)
          (index, items[index]),
      ]..sort((a, b) {
        final rank = _liveStateRank(a.$2).compareTo(_liveStateRank(b.$2));
        if (rank != 0) return rank;
        final within = compareWithinRank(a.$2, b.$2);
        if (within != 0) return within;
        return a.$1.compareTo(b.$1);
      });
  return [for (final entry in indexed) entry.$2];
}

/// Per-phase counts across the band, shown on the strip when it holds more
/// than one item.
final class _LiveStateSummary {
  const _LiveStateSummary({
    required this.running,
    required this.paused,
    required this.failed,
    required this.done,
  });

  factory _LiveStateSummary.of(List<_LiveStateItem> items) {
    int count(_LiveStatePhase phase) =>
        items.where((item) => item.phase == phase).length;
    return _LiveStateSummary(
      running: count(_LiveStatePhase.running),
      paused: count(_LiveStatePhase.paused),
      failed: count(_LiveStatePhase.failed),
      done: count(_LiveStatePhase.done),
    );
  }

  final int running;
  final int paused;
  final int failed;
  final int done;
}

/// Whether an item is a background shell command, the band's lowest rank.
bool _isBackgroundCommand(_LiveStateItem item) {
  final value = item.value;
  return value is AgentActivitySnapshot &&
      value.kind == AgentActivityKind.command;
}

List<_LiveStateItem> _liveStateItemsFromParts(
  AppLocalizations l10n,
  SessionLiveState liveState,
  SessionCommandProgress? commandProgress,
) {
  return [
    if (commandProgress case final progress?)
      _LiveStateItem(
        id: 'command:${progress.name}',
        archiveIdentity: '${progress.name}:${progress.startedAt}',
        kind: _LiveStateItemKind.command,
        value: progress,
        label: l10n.command,
        title: '/${progress.name}',
        statusLabel: l10n.running,
        icon: Icons.compress_rounded,
        actionRequired: false,
        phase: _LiveStatePhase.running,
      ),
    for (final activity in liveState.activities)
      _LiveStateItem(
        id: 'activity:${activity.key}',
        // The identity deliberately excludes elapsed and output, so a
        // ticking card does not un-archive itself every frame. For a
        // background command it DOES carry whether the work has ended:
        // archiving one while it runs means "not now", and hiding its result
        // forever would discard the one fact the card exists to deliver. It
        // re-surfaces once when it ends, and a second archive is permanent. A
        // subagent or workflow keeps the original identity — those are read
        // while they run.
        archiveIdentity: [
          activity.key,
          activity.startedAtMs,
          activity.title,
          if (activity.kind == AgentActivityKind.command)
            activity.status == AgentActivityStatus.running
                ? 'running'
                : 'ended',
        ].join('|'),
        kind: _LiveStateItemKind.activity,
        value: activity,
        label: switch (activity.kind) {
          AgentActivityKind.command => l10n.backgroundCommand,
          AgentActivityKind.workflow => l10n.backgroundWorkflow,
          AgentActivityKind.subagent ||
          AgentActivityKind.unknown => l10n.activity,
        },
        title: activity.title,
        statusLabel: switch (activity.status) {
          AgentActivityStatus.running => l10n.running,
          AgentActivityStatus.done => l10n.done,
          AgentActivityStatus.error => l10n.failed,
          // Withdrawn or unrecognized: the projection drops the row before it
          // becomes an item, so this branch is for exhaustiveness only.
          AgentActivityStatus.retired ||
          AgentActivityStatus.unknown => l10n.activity,
        },
        // A shell is not an agent, and the band can hold both at once.
        icon: activity.kind == AgentActivityKind.command
            ? Icons.terminal_outlined
            : Icons.psychology_outlined,
        actionRequired: false,
        phase: switch (activity.status) {
          AgentActivityStatus.running => _LiveStatePhase.running,
          AgentActivityStatus.error => _LiveStatePhase.failed,
          AgentActivityStatus.done ||
          AgentActivityStatus.retired ||
          AgentActivityStatus.unknown => _LiveStatePhase.done,
        },
        // A lone agent's "0/1" or "1/1" restates the status pill. The count is
        // only news when a workflow fans out to more than one.
        done: (activity.agentsTotal ?? 0) > 1 ? activity.agentsDone : null,
        total: (activity.agentsTotal ?? 0) > 1 ? activity.agentsTotal : null,
        startedAtMs: activity.startedAtMs,
        order: liveState.activityOrder(activity.key),
      ),
    for (final goal in liveState.goals)
      _LiveStateItem(
        id: 'goal:${goal.key}',
        archiveIdentity: [goal.key, goal.startedAt, goal.title].join('|'),
        kind: _LiveStateItemKind.goal,
        value: goal,
        label: l10n.goal,
        title: goal.title ?? l10n.currentGoal,
        statusLabel: switch (goal.status) {
          GoalStateStatus.blocked => l10n.blocked,
          GoalStateStatus.paused => l10n.paused,
          _ => l10n.active,
        },
        icon: Icons.track_changes_outlined,
        actionRequired: goal.status == GoalStateStatus.blocked,
        phase: switch (goal.status) {
          GoalStateStatus.blocked => _LiveStatePhase.needsInput,
          GoalStateStatus.paused => _LiveStatePhase.paused,
          _ => _LiveStatePhase.running,
        },
      ),
    for (final taskList in liveState.taskLists)
      _LiveStateItem(
        id: 'task-list:${taskList.key}',
        archiveIdentity: taskList.key,
        kind: _LiveStateItemKind.taskList,
        value: taskList,
        label: taskList.semantic == null ? l10n.tasks : l10n.plan,
        title: _currentTaskTitle(l10n, taskList),
        statusLabel: taskList.status == TaskListStateStatus.done
            ? l10n.done
            : taskList.semantic?.state == PlanSemanticState.proposed
            ? l10n.review
            : l10n.running,
        icon: Icons.checklist_rounded,
        actionRequired: taskList.semantic?.state == PlanSemanticState.proposed,
        phase: taskList.semantic?.state == PlanSemanticState.proposed
            ? _LiveStatePhase.needsInput
            : taskList.status == TaskListStateStatus.done
            ? _LiveStatePhase.done
            : _LiveStatePhase.running,
        done: taskList.items
            .where((item) => item.status == TaskItemStatus.done)
            .length,
        total: taskList.items.length,
      ),
  ];
}

String _currentTaskTitle(
  AppLocalizations l10n,
  TaskListStateSnapshot taskList,
) {
  for (final item in taskList.items) {
    if (item.status == TaskItemStatus.inProgress) return item.title;
  }
  for (final item in taskList.items) {
    if (item.status == TaskItemStatus.open) return item.title;
  }
  return taskList.title ?? (taskList.semantic == null ? l10n.tasks : l10n.plan);
}

String? _primaryLiveStateProgress(List<_LiveStateItem> items) {
  for (final item in items) {
    if (item.total != null && item.total! > 0 && item.done != null) {
      return '${item.done}/${item.total}';
    }
  }
  return null;
}

Widget _buildFullLiveStateItem(
  _LiveStateItem item, {
  required SlashCommand? goalCommand,
  required SessionDetailController controller,
  required bool isConnected,
  required bool canPrompt,
}) {
  return switch (item.kind) {
    _LiveStateItemKind.command => _CommandProgressCard(
      key: Key('session-command-progress-${item.id}'),
      progress: item.value as SessionCommandProgress,
    ),
    _LiveStateItemKind.activity => _AgentActivityCard(
      key: Key('session-agent-activity-${item.id}'),
      activity: item.value as AgentActivitySnapshot,
    ),
    _LiveStateItemKind.goal => _GoalStateCard(
      key: Key('session-goal-state-${item.id}'),
      goal: item.value as GoalStateSnapshot,
      command: goalCommand,
      controller: controller,
      isConnected: isConnected,
      canPrompt: canPrompt,
    ),
    _LiveStateItemKind.taskList => _TaskListStateCard(
      key: Key('session-task-list-state-${item.id}'),
      taskList: item.value as TaskListStateSnapshot,
      controller: controller,
      isConnected: isConnected,
      canPrompt: canPrompt,
    ),
  };
}
