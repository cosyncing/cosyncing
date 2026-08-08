part of 'session_detail_page.dart';

class _ArchivableLiveStateItem extends StatefulWidget {
  const _ArchivableLiveStateItem({
    required this.item,
    required this.additionalCount,
    required this.initiallyExpanded,
    required this.onArchive,
    required this.archiveTargetKey,
    required this.fullCard,
    super.key,
  });

  final _LiveStateItem item;
  final int additionalCount;
  final bool initiallyExpanded;
  final VoidCallback onArchive;
  final GlobalKey archiveTargetKey;
  final Widget fullCard;

  @override
  State<_ArchivableLiveStateItem> createState() =>
      _ArchivableLiveStateItemState();
}

class _ArchivableLiveStateItemState extends State<_ArchivableLiveStateItem>
    with SingleTickerProviderStateMixin {
  static const double _archiveThreshold = 72;

  final GlobalKey _flightSourceKey = GlobalKey(
    debugLabel: 'session-live-state-flight-source',
  );
  late bool _expanded = widget.initiallyExpanded;
  Timer? _doneArchiveTimer;
  double _dragOffset = 0;
  bool _committing = false;
  PointerDeviceKind? _pointerKind;
  AnimationController? _flightController;
  OverlayEntry? _flightOverlay;

  @override
  void initState() {
    super.initState();
    _scheduleDoneArchive();
  }

  @override
  void didUpdateWidget(covariant _ArchivableLiveStateItem oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.initiallyExpanded && !oldWidget.initiallyExpanded) {
      _expanded = true;
    }
    if (oldWidget.item.fingerprint != widget.item.fingerprint) {
      _scheduleDoneArchive();
    }
  }

  void _scheduleDoneArchive() {
    _doneArchiveTimer?.cancel();
    if (widget.item.statusLabel == 'Done' && !widget.item.actionRequired) {
      _doneArchiveTimer = Timer(
        const Duration(seconds: 3),
        () => unawaited(_commitArchive()),
      );
    }
  }

  @override
  void dispose() {
    _doneArchiveTimer?.cancel();
    _flightOverlay?.remove();
    _flightController?.dispose();
    super.dispose();
  }

  bool get _allowsDrag =>
      _pointerKind == PointerDeviceKind.touch ||
      _pointerKind == PointerDeviceKind.mouse ||
      _pointerKind == PointerDeviceKind.trackpad;

  Future<void> _commitArchive() async {
    if (_committing) return;
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final source = _globalRect(_flightSourceKey);
    final target = _globalRect(widget.archiveTargetKey);
    setState(() {
      _committing = true;
      _dragOffset = 0;
    });
    if (!reduceMotion && source != null && target != null) {
      final overlay = Overlay.maybeOf(context, rootOverlay: true);
      if (overlay != null) {
        final controller = AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 250),
        );
        final animation = CurvedAnimation(
          parent: controller,
          curve: Curves.easeInOutCubic,
        );
        _flightController = controller;
        _flightOverlay = OverlayEntry(
          builder: (overlayContext) => AnimatedBuilder(
            animation: animation,
            builder: (context, child) {
              final value = animation.value;
              return Positioned.fromRect(
                rect: Rect.lerp(source, target, value)!,
                child: IgnorePointer(
                  child: Opacity(
                    opacity: 1 - (value * 0.2),
                    child: Material(
                      color: overlayContext.tokens.surface2,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(
                          overlayContext.tokens.radiusSm,
                        ),
                        side: BorderSide(
                          color: overlayContext.tokens.separator,
                        ),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          child: Row(
                            children: [
                              Icon(widget.item.icon, size: 17),
                              const SizedBox(width: 7),
                              Text(widget.item.label),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        );
        overlay.insert(_flightOverlay!);
        try {
          await controller.forward();
        } on TickerCanceled {
          // Disposal cancels an in-flight archive animation. The state teardown
          // already removes the overlay and owns controller disposal.
        } finally {
          if (_flightController == controller) {
            _flightOverlay?.remove();
            _flightOverlay = null;
            controller.dispose();
            _flightController = null;
          }
        }
      } else {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
    } else if (!reduceMotion) {
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    if (mounted) widget.onArchive();
  }

  Rect? _globalRect(GlobalKey key) {
    final renderObject = key.currentContext?.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) return null;
    return renderObject.localToGlobal(Offset.zero) & renderObject.size;
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (!_allowsDrag || _committing) return;
    final raw = (_dragOffset + details.delta.dx).clamp(0.0, 240.0);
    setState(() {
      _dragOffset = raw > 96 ? 96 + (raw - 96) * 0.25 : raw;
    });
  }

  void _onDragEnd(DragEndDetails details) {
    if (_dragOffset >= _archiveThreshold) {
      unawaited(_commitArchive());
    } else {
      setState(() => _dragOffset = 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final duration = MediaQuery.maybeOf(context)?.disableAnimations ?? false
        ? Duration.zero
        : const Duration(milliseconds: 200);
    return AnimatedSize(
      duration: duration,
      alignment: Alignment.topCenter,
      child: _committing
          ? const SizedBox.shrink(
              key: Key('session-live-state-archiving'),
            )
          : Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Listener(
                key: _flightSourceKey,
                onPointerDown: (event) => _pointerKind = event.kind,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onHorizontalDragUpdate: _onDragUpdate,
                  onHorizontalDragEnd: _onDragEnd,
                  child: AnimatedContainer(
                    duration: duration,
                    transform: Matrix4.translationValues(_dragOffset, 0, 0),
                    transformAlignment: Alignment.centerLeft,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Material(
                          key: ValueKey('session-live-strip-${widget.item.id}'),
                          color: tokens.surface2,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              tokens.radiusSm,
                            ),
                            side: BorderSide(color: tokens.separator),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: InkWell(
                            key: ValueKey(
                              'session-live-strip-toggle-${widget.item.id}',
                            ),
                            onTap: () => setState(() => _expanded = !_expanded),
                            child: SizedBox(
                              height: 38,
                              child: Row(
                                children: [
                                  const SizedBox(width: 10),
                                  Icon(widget.item.icon, size: 17),
                                  const SizedBox(width: 7),
                                  Text(
                                    widget.item.label,
                                    style: theme.textTheme.labelLarge,
                                  ),
                                  if (widget.additionalCount > 0) ...[
                                    const SizedBox(width: 5),
                                    Text(
                                      '+${widget.additionalCount}',
                                      key: const Key(
                                        'session-live-strip-additional-count',
                                      ),
                                      style: theme.textTheme.labelMedium
                                          ?.copyWith(
                                            color: tokens.textSecondary,
                                          ),
                                    ),
                                  ],
                                  if (widget.item.total != null) ...[
                                    const SizedBox(width: 6),
                                    Text(
                                      '${widget.item.done ?? 0}/${widget.item.total}',
                                      key: const Key(
                                        'session-live-strip-progress',
                                      ),
                                      style: theme.textTheme.labelMedium
                                          ?.copyWith(
                                            color: tokens.textSecondary,
                                          ),
                                    ),
                                  ],
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      widget.item.title,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: tokens.textSecondary,
                                          ),
                                    ),
                                  ),
                                  StatusPill(
                                    label: widget.item.statusLabel,
                                    color: widget.item.actionRequired
                                        ? tokens.statusNeedsInput
                                        : tokens.statusWorking,
                                  ),
                                  Icon(
                                    _expanded
                                        ? Icons.expand_less
                                        : Icons.expand_more,
                                    size: 18,
                                  ),
                                  IconButton(
                                    key: ValueKey(
                                      'session-live-strip-archive-'
                                      '${widget.item.id}',
                                    ),
                                    tooltip: AppLocalizations.of(
                                      context,
                                    ).archiveToStatus,
                                    visualDensity: VisualDensity.compact,
                                    onPressed: () =>
                                        unawaited(_commitArchive()),
                                    icon: const Icon(Icons.close, size: 16),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        AnimatedCrossFade(
                          duration: duration,
                          crossFadeState: _expanded
                              ? CrossFadeState.showSecond
                              : CrossFadeState.showFirst,
                          firstChild: const SizedBox.shrink(),
                          secondChild: Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: widget.fullCard,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}

class _CommandProgressCard extends StatefulWidget {
  const _CommandProgressCard({required this.progress, super.key});

  final SessionCommandProgress progress;

  @override
  State<_CommandProgressCard> createState() => _CommandProgressCardState();
}

class _CommandProgressCardState extends State<_CommandProgressCard> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final elapsed =
        DateTime.now().millisecondsSinceEpoch - widget.progress.startedAt;
    return Container(
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusMd),
        border: Border.all(
          color: tokens.statusWorking.withValues(alpha: 0.45),
        ),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.compress_rounded,
                size: 18,
                color: tokens.statusWorking,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  l10n.runningCommand(widget.progress.name),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              Text(
                _formatElapsedMilliseconds(elapsed),
                key: const Key('session-command-progress-elapsed'),
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const LinearProgressIndicator(
            key: Key('session-command-progress-indicator'),
          ),
          if (widget.progress.name == 'compact') ...[
            const SizedBox(height: 8),
            Text(
              l10n.compactionProgress,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _AgentActivityCard extends StatefulWidget {
  const _AgentActivityCard({required this.activity, super.key});

  final AgentActivitySnapshot activity;

  @override
  State<_AgentActivityCard> createState() => _AgentActivityCardState();
}

class _AgentActivityCardState extends State<_AgentActivityCard> {
  Timer? _ticker;
  late int _startedAtMs;

  @override
  void initState() {
    super.initState();
    _syncStart();
    _startTicker();
  }

  @override
  void didUpdateWidget(covariant _AgentActivityCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.activity.key != widget.activity.key ||
        oldWidget.activity.startedAtMs != widget.activity.startedAtMs) {
      _syncStart();
    }
  }

  void _syncStart() {
    _startedAtMs =
        widget.activity.startedAtMs ??
        DateTime.now().millisecondsSinceEpoch -
            (widget.activity.elapsedMs ?? 0);
  }

  void _startTicker() {
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final wallClock = DateTime.now().millisecondsSinceEpoch - _startedAtMs;
    final elapsed = wallClock > (widget.activity.elapsedMs ?? 0)
        ? wallClock
        : widget.activity.elapsedMs ?? 0;
    final label = switch (widget.activity.kind) {
      AgentActivityKind.workflow => l10n.backgroundWorkflow,
      AgentActivityKind.subagent => l10n.backgroundAgent,
      AgentActivityKind.unknown => l10n.backgroundActivity,
    };
    final tokenFigure =
        widget.activity.tokens?.input ?? widget.activity.tokens?.output;
    final details = <String>[
      if (widget.activity.subtitle case final subtitle?) subtitle,
      if (widget.activity.agentsDone != null &&
          widget.activity.agentsTotal != null)
        l10n.agentsProgress(
          widget.activity.agentsDone!,
          widget.activity.agentsTotal!,
        ),
      if (tokenFigure != null) l10n.tokensCount(_formatTokenCount(tokenFigure)),
      if (widget.activity.toolCalls case final calls?) l10n.toolsCount(calls),
    ];

    return Material(
      color: tokens.surface2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(tokens.radiusMd),
        side: BorderSide(
          color: tokens.statusWorking.withValues(alpha: 0.45),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        leading: Icon(Icons.psychology, color: tokens.statusWorking),
        title: Text(widget.activity.title),
        subtitle: Text(
          [
            label,
            _formatElapsedMilliseconds(elapsed),
            ...details,
          ].join(' · '),
          key: const Key('session-agent-activity-summary'),
        ),
        trailing: StatusPill(
          label: l10n.running,
          color: tokens.statusWorking,
        ),
        children: [
          for (final child in widget.activity.children)
            ListTile(
              dense: true,
              leading: Icon(
                child.status == 'done'
                    ? Icons.check_circle_outline
                    : child.status == 'error'
                    ? Icons.error_outline
                    : Icons.pending_outlined,
                size: 20,
              ),
              title: Text(child.title),
              subtitle: Text(
                [
                  _activityChildStatus(l10n, child.status),
                  if (child.elapsedMs case final childElapsed?)
                    _formatElapsedMilliseconds(childElapsed),
                ].join(' · '),
              ),
            ),
          if (widget.activity.children.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  l10n.activityProgressLive,
                  style: theme.textTheme.bodySmall,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _GoalStateCard extends StatefulWidget {
  const _GoalStateCard({
    required this.goal,
    required this.command,
    required this.controller,
    required this.isConnected,
    required this.canPrompt,
    super.key,
  });

  final GoalStateSnapshot goal;
  final SlashCommand? command;
  final SessionDetailController controller;
  final bool isConnected;
  final bool canPrompt;

  @override
  State<_GoalStateCard> createState() => _GoalStateCardState();
}

String _activityChildStatus(
  AppLocalizations l10n,
  String status,
) => switch (status) {
  'done' => l10n.done,
  'error' => l10n.failed,
  'running' || 'active' => l10n.running,
  _ => l10n.pending,
};

class _GoalStateCardState extends State<_GoalStateCard> {
  Timer? _ticker;
  bool _isSending = false;

  @override
  void initState() {
    super.initState();
    _syncTicker();
  }

  @override
  void didUpdateWidget(covariant _GoalStateCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.goal.status != widget.goal.status ||
        oldWidget.goal.startedAt != widget.goal.startedAt) {
      _syncTicker();
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  void _syncTicker() {
    _ticker?.cancel();
    _ticker = null;
    if (widget.goal.status == GoalStateStatus.active &&
        widget.goal.startedAt != null) {
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  bool get _canAct =>
      !_isSending &&
      widget.isConnected &&
      widget.canPrompt &&
      widget.command != null;

  Future<void> _dispatch(String arguments) async {
    if (!_canAct) return;
    setState(() => _isSending = true);
    await widget.controller.sendActionCommand(
      widget.command!.name,
      args: {'args': arguments},
    );
    if (mounted) setState(() => _isSending = false);
  }

  Future<void> _edit() async {
    if (!_canAct) return;
    final l10n = AppLocalizations.of(context);
    final textController = TextEditingController(text: widget.goal.title);
    // A revised objective exists only in this dialog until it is dispatched.
    // The hold is unconditional — an open modal defers the handoff until it
    // closes, so emptying the field needs no readiness signal (N3b).
    final value = await WebHandoffParticipants.instance.holdOpen(
      () => showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.updateGoalObjective),
          content: TextField(
            key: const Key('session-goal-edit-field'),
            controller: textController,
            autofocus: true,
            maxLines: 4,
            decoration: InputDecoration(labelText: l10n.objective),
            onSubmitted: (value) => Navigator.of(context).pop(value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              key: const Key('session-goal-edit-save'),
              onPressed: () => Navigator.of(context).pop(textController.text),
              child: Text(l10n.save),
            ),
          ],
        ),
      ),
    );
    textController.dispose();
    final objective = value?.trim();
    if (objective == null || objective.isEmpty || !mounted) return;
    await _dispatch('set $objective');
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final status = widget.goal.status;
    final color = switch (status) {
      GoalStateStatus.active => tokens.statusWorking,
      GoalStateStatus.paused => tokens.statusIdle,
      GoalStateStatus.blocked => tokens.statusNeedsInput,
      _ => tokens.statusError,
    };
    final statusLabel = switch (status) {
      GoalStateStatus.active => l10n.goalPursuing,
      GoalStateStatus.paused => l10n.goalPaused,
      GoalStateStatus.blocked => l10n.goalBlocked,
      _ => l10n.goal,
    };
    final elapsed = _goalElapsed(widget.goal);
    final blockedReason = !widget.isConnected
        ? l10n.goalReconnectActions
        : !widget.canPrompt
        ? l10n.goalNeedsPromptControl
        : widget.command == null
        ? l10n.goalActionUnavailable
        : null;

    return Container(
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusMd),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StatusPill(
                label: statusLabel,
                color: color,
                icon: Icons.track_changes_outlined,
              ),
              if (elapsed != null)
                Text(
                  elapsed,
                  key: const Key('session-goal-elapsed'),
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            widget.goal.title ?? l10n.currentGoal,
            style: theme.textTheme.titleSmall?.copyWith(
              color: tokens.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (widget.goal.detail != null) ...[
            const SizedBox(height: 4),
            Text(
              widget.goal.detail!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: 10),
          Tooltip(
            message: blockedReason ?? '',
            child: Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                OutlinedButton(
                  key: Key(
                    status == GoalStateStatus.active
                        ? 'session-goal-pause'
                        : 'session-goal-resume',
                  ),
                  onPressed: _canAct
                      ? () => _dispatch(
                          status == GoalStateStatus.active ? 'pause' : 'resume',
                        )
                      : null,
                  child: Text(
                    status == GoalStateStatus.active ? l10n.pause : l10n.resume,
                  ),
                ),
                OutlinedButton(
                  key: const Key('session-goal-edit'),
                  onPressed: _canAct ? _edit : null,
                  child: Text(l10n.edit),
                ),
                TextButton(
                  key: const Key('session-goal-clear'),
                  onPressed: _canAct ? () => _dispatch('clear') : null,
                  child: Text(l10n.clear),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskListStateCard extends StatelessWidget {
  const _TaskListStateCard({
    required this.taskList,
    required this.controller,
    required this.isConnected,
    required this.canPrompt,
    super.key,
  });

  final TaskListStateSnapshot taskList;
  final SessionDetailController controller;
  final bool isConnected;
  final bool canPrompt;

  Future<void> _dispatch(PlanActionKind action, {String? text}) async {
    final semantic = taskList.semantic;
    if (semantic == null) return;
    await controller.sendPlanAction(
      PlanActionRequest(
        action: action,
        planKey: semantic.planKey,
        planRevision: semantic.revision,
        text: text,
      ),
    );
  }

  Future<void> _edit(BuildContext context) async {
    final l10n = AppLocalizations.of(context);
    final textController = TextEditingController();
    // Same as the goal editor: an unconditional hold for as long as the
    // dialog is open, released — and readiness announced — when it closes
    // however it closes (N3b).
    final text = await WebHandoffParticipants.instance.holdOpen(
      () => showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.revisePlan),
          content: TextField(
            key: const Key('session-plan-edit-text'),
            controller: textController,
            autofocus: true,
            minLines: 2,
            maxLines: 8,
            decoration: InputDecoration(
              hintText: l10n.revisePlanHint,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              key: const Key('session-plan-edit-submit'),
              onPressed: () {
                final value = textController.text.trim();
                if (value.isNotEmpty) Navigator.of(context).pop(value);
              },
              child: Text(l10n.sendRevision),
            ),
          ],
        ),
      ),
    );
    textController.dispose();
    if (text != null) await _dispatch(PlanActionKind.edit, text: text);
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final done = taskList.items
        .where((item) => item.status == TaskItemStatus.done)
        .length;
    final running = taskList.items
        .where((item) => item.status == TaskItemStatus.inProgress)
        .length;
    final color = taskList.status == TaskListStateStatus.done
        ? tokens.statusIdle
        : tokens.statusWorking;
    final semantic = taskList.semantic;
    final canAct =
        semantic != null && !semantic.isTerminal && isConnected && canPrompt;
    final statusLabel = semantic == null
        ? taskList.status == TaskListStateStatus.done
              ? l10n.done
              : l10n.running
        : switch (semantic.state) {
            PlanSemanticState.proposed => l10n.proposed,
            PlanSemanticState.active => l10n.active,
            PlanSemanticState.completed => l10n.completed,
            PlanSemanticState.exited => l10n.exited,
            PlanSemanticState.unknown => l10n.plan,
          };

    return Material(
      color: tokens.surface2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(tokens.radiusMd),
        side: BorderSide(color: tokens.separator),
      ),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        key: const Key('session-task-list-expansion'),
        initiallyExpanded: taskList.status == TaskListStateStatus.running,
        leading: Icon(Icons.checklist_rounded, color: color),
        title: Text(
          taskList.title ?? (semantic == null ? l10n.tasks : l10n.plan),
        ),
        subtitle: Text(
          running > 0
              ? l10n.taskSummaryRunning(
                  taskList.items.length,
                  done,
                  running,
                )
              : l10n.taskSummary(taskList.items.length, done),
        ),
        trailing: StatusPill(
          label: statusLabel,
          color: color,
        ),
        children: [
          for (var index = 0; index < taskList.items.length; index++)
            _TaskStateRow(item: taskList.items[index], index: index),
          if (taskList.items.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(l10n.noTasksReported),
              ),
            ),
          if (semantic != null &&
              (semantic.canApprove || semantic.canEdit || semantic.canExit))
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
              child: Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (semantic.canApprove)
                    FilledButton(
                      key: const Key('session-plan-approve'),
                      onPressed: canAct
                          ? () => unawaited(_dispatch(PlanActionKind.approve))
                          : null,
                      child: Text(l10n.approve),
                    ),
                  if (semantic.canEdit)
                    OutlinedButton(
                      key: const Key('session-plan-edit'),
                      onPressed: canAct
                          ? () => unawaited(_edit(context))
                          : null,
                      child: Text(l10n.revise),
                    ),
                  if (semantic.canExit)
                    TextButton(
                      key: const Key('session-plan-exit'),
                      onPressed: canAct
                          ? () => unawaited(_dispatch(PlanActionKind.exit))
                          : null,
                      child: Text(l10n.exitPlan),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _TaskStateRow extends StatelessWidget {
  const _TaskStateRow({required this.item, required this.index});

  final TaskStateItem item;
  final int index;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final (icon, color) = switch (item.status) {
      TaskItemStatus.open => (Icons.radio_button_unchecked, tokens.statusIdle),
      TaskItemStatus.inProgress => (
        Icons.pending_outlined,
        tokens.statusWorking,
      ),
      TaskItemStatus.done => (Icons.check_circle_outline, tokens.statusWorking),
      TaskItemStatus.cancelled => (Icons.cancel_outlined, tokens.statusIdle),
      TaskItemStatus.unknown => (Icons.help_outline, tokens.textTertiary),
    };
    return ListTile(
      key: Key('session-task-item-$index'),
      dense: true,
      leading: Icon(icon, size: 20, color: color),
      title: Text(item.title),
      subtitle: item.detail == null ? null : Text(item.detail!),
      trailing: item.priority == null
          ? null
          : Text(
              item.priority!,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
    );
  }
}

String? _goalElapsed(GoalStateSnapshot goal) {
  var elapsed = goal.elapsedMs;
  if (goal.status == GoalStateStatus.active && goal.startedAt != null) {
    final wallClock = DateTime.now().millisecondsSinceEpoch - goal.startedAt!;
    if (wallClock >= 0 && (elapsed == null || wallClock > elapsed)) {
      elapsed = wallClock;
    }
  }
  if (elapsed == null) return null;
  final seconds = (elapsed / 1000).round();
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  if (seconds < 3600) return '${minutes}m ${seconds % 60}s';
  return '${minutes ~/ 60}h ${minutes % 60}m';
}

String _formatElapsedMilliseconds(int milliseconds) {
  final safeMilliseconds = milliseconds < 0 ? 0 : milliseconds;
  final seconds = safeMilliseconds ~/ 1000;
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  if (seconds < 3600) return '${minutes}m ${seconds % 60}s';
  return '${minutes ~/ 60}h ${minutes % 60}m';
}

String _formatTokenCount(int tokens) {
  if (tokens < 1000) return '$tokens';
  if (tokens < 1000000) {
    final value = (tokens / 1000).toStringAsFixed(tokens < 100000 ? 1 : 0);
    return '${value.replaceFirst(RegExp(r'\.0$'), '')}k';
  }
  final value = (tokens / 1000000).toStringAsFixed(1);
  return '${value.replaceFirst(RegExp(r'\.0$'), '')}m';
}

/// Inline read-only reason shown above the composer when the app is connected
/// but the session's narrow gate (canPrompt) is closed — Observe, answer-only
/// sync, or unavailable (WP2).
