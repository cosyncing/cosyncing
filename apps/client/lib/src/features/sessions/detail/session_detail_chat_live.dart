part of 'session_detail_page.dart';

class _ChatPanel extends ConsumerWidget {
  const _ChatPanel({
    required this.sessionKey,
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
  final ValueChanged<_LiveStateItem> onArchiveLiveState;
  final GlobalKey archiveTargetKey;
  final bool reportView;
  final bool toolsExpanded;
  final int toolExpansionRevision;
  final Future<bool> Function() onSendCommand;
  final ValueChanged<String?> onCommandSelected;
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
    final transcript = _TranscriptSurface(
      state: state,
      controller: controller,
      isConnected: isConnected,
      hasActiveBrokerClient: hasActiveBrokerClient,
      // Same per-session gate as the status-panel Fork tile: the transcript's
      // message-context "Fork from here" is a second entry point into the same
      // broker route, so it answers the same shared predicate — including a
      // standing broker refusal, which is the case a bare origin check misses.
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
              if (constraints.maxHeight < 360) {
                return ListView(
                  key: const Key('session-detail-chat-compact-scroll'),
                  children: [
                    if (bootstrapStatus != null) bootstrapStatus,
                    if (!state.liveState.isEmpty ||
                        state.commandProgress != null)
                      _ReadableColumn(child: liveStateSurface),
                    SizedBox(height: 132, child: transcript),
                  ],
                );
              }
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
                        maxHeight: liveStateMaxHeight,
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
  final ValueChanged<_LiveStateItem> onArchive;
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
    final actionIndex = visibleItems.indexWhere((item) => item.actionRequired);
    final primary = actionIndex < 0
        ? visibleItems.first
        : visibleItems[actionIndex];
    final orderedItems = <_LiveStateItem>[
      primary,
      for (final item in visibleItems)
        if (!identical(item, primary)) item,
    ];
    return Column(
      key: const Key('session-live-state-surface'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          transitionBuilder: (child, animation) => SizeTransition(
            sizeFactor: animation,
            alignment: Alignment.topCenter,
            child: FadeTransition(opacity: animation, child: child),
          ),
          child: _ArchivableLiveStateItem(
            key: ValueKey('visible-${primary.id}'),
            item: primary,
            additionalCount: visibleItems.length - 1,
            initiallyExpanded: visibleItems.any(
              (item) => item.actionRequired,
            ),
            onArchive: () => onArchive(primary),
            archiveTargetKey: archiveTargetKey,
            fullCard: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var index = 0; index < orderedItems.length; index++) ...[
                  _buildFullLiveStateItem(
                    orderedItems[index],
                    goalCommand: _findGoalCommand(commands),
                    controller: controller,
                    isConnected: isConnected,
                    canPrompt: canPrompt,
                  ),
                  if (index < orderedItems.length - 1)
                    const SizedBox(height: 6),
                ],
              ],
            ),
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
    final items = _liveStateItemsFromParts(
      AppLocalizations.of(context),
      liveState,
      commandProgress,
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
    this.done,
    this.total,
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
  final int? done;
  final int? total;
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
      ),
    for (final activity in liveState.activities)
      _LiveStateItem(
        id: 'activity:${activity.key}',
        archiveIdentity: [
          activity.key,
          activity.startedAtMs,
          activity.title,
        ].join('|'),
        kind: _LiveStateItemKind.activity,
        value: activity,
        label: l10n.activity,
        title: activity.title,
        statusLabel: l10n.running,
        icon: Icons.psychology_outlined,
        actionRequired: false,
        done: activity.agentsDone,
        total: activity.agentsTotal,
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
