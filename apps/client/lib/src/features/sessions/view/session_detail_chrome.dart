part of 'session_detail_page.dart';

/// Watches the detail state for [key], qualified against the active broker.
///
/// Reading the controller raw is never correct on a control surface. Switching
/// brokers queues an attach that only replaces the state after two stream
/// cancellations and a socket close, so between those frames the controller
/// still holds the PREVIOUS broker's session — and a Status panel built from it
/// displays and enables that broker's Driving/Sync actions against the new one.
///
/// The qualification is by (profile, endpoint): re-pointing a profile at
/// another machine keeps its id, so an id comparison passed and the retired
/// machine's content stayed on screen. See
/// [SessionDetailState.forActiveSource].
SessionDetailState watchQualifiedDetail(WidgetRef ref, SessionDetailKey key) =>
    ref
        .watch(sessionDetailControllerProvider(key))
        .forActiveSource(
          ref.watch(
            activeBrokerProfileProvider.select(RosterSource.of),
          ),
        );

/// One-shot read of the qualified detail state. See [watchQualifiedDetail].
SessionDetailState readQualifiedDetail(WidgetRef ref, SessionDetailKey key) =>
    ref
        .read(sessionDetailControllerProvider(key))
        .forActiveSource(
          RosterSource.of(ref.read(activeBrokerProfileProvider)),
        );

/// Renders a duration as `45s` / `12m` / `3h 4m`.
String _formatCompactDuration(int milliseconds) {
  final totalSeconds = milliseconds ~/ 1000;
  if (totalSeconds < 60) return '${totalSeconds}s';
  final totalMinutes = totalSeconds ~/ 60;
  if (totalMinutes < 60) return '${totalMinutes}m';
  final hours = totalMinutes ~/ 60;
  final minutes = totalMinutes % 60;
  return minutes == 0 ? '${hours}h' : '${hours}h ${minutes}m';
}

/// Full cost/context breakdown, the durable home for streaming telemetry.
class _TelemetryPanel extends StatelessWidget {
  const _TelemetryPanel({required this.telemetry});

  final SessionTelemetry telemetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    if (telemetry.isEmpty) {
      return Text(
        l10n.sessionDetailTelemetryEmpty,
        key: const Key('session-detail-telemetry-empty'),
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }

    final rows = <(String, String)>[
      if (telemetry.hasContext)
        (
          l10n.sessionDetailTelemetryContextUsed,
          _describeContext(telemetry),
        ),
      if (telemetry.totalTokens case final total?)
        (l10n.sessionDetailTelemetryTotalTokens, _formatGroupedCount(total)),
      if (telemetry.inputTokens case final value?)
        (l10n.sessionDetailTelemetryInput, _formatGroupedCount(value)),
      if (telemetry.outputTokens case final value?)
        (l10n.sessionDetailTelemetryOutput, _formatGroupedCount(value)),
      if (telemetry.cacheReadTokens case final value?)
        (l10n.sessionDetailTelemetryCacheRead, _formatGroupedCount(value)),
      if (telemetry.cacheWriteTokens case final value?)
        (l10n.sessionDetailTelemetryCacheWrite, _formatGroupedCount(value)),
      if (telemetry.cost case final value?)
        (l10n.sessionDetailTelemetryCost, '\$${value.toStringAsFixed(4)}'),
      if (telemetry.totalRuntimeMs case final value?)
        (
          l10n.sessionDetailTelemetryTotalRuntime,
          _formatCompactDuration(value),
        ),
      if (telemetry.agentRuntimeMs case final value?)
        (
          l10n.sessionDetailTelemetryAgentRuntime,
          _formatCompactDuration(value),
        ),
      if (telemetry.executionRuntimeMs case final value?)
        (
          l10n.sessionDetailTelemetryExecutionRuntime,
          _formatCompactDuration(value),
        ),
      if (telemetry.turnCount case final value?)
        (l10n.sessionDetailTelemetryTurns, '$value'),
    ];

    return Card(
      key: const Key('session-detail-telemetry-panel'),
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (telemetry.hasContext) ...[
              LinearProgressIndicator(
                key: const Key('session-detail-telemetry-context-bar'),
                value: telemetry.contextPercent! / 100,
                color: telemetry.isContextCritical
                    ? theme.colorScheme.error
                    : null,
              ),
              const SizedBox(height: 12),
            ],
            for (final (label, value) in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      label,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    Text(
                      value,
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            Text(
              l10n.sessionDetailTelemetryFootnote,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _describeContext(SessionTelemetry telemetry) {
    final percent = '${telemetry.contextPercent!.round()}%';
    final used = telemetry.contextUsedTokens;
    final max = telemetry.contextMaxTokens;
    if (used == null || max == null) return percent;
    return '$percent  '
        '(${_formatGroupedCount(used)} / ${_formatGroupedCount(max)})';
  }
}

/// Renders a count with thousands separators for the detailed panel.
String _formatGroupedCount(int value) {
  final digits = value.abs().toString();
  final buffer = StringBuffer(value < 0 ? '-' : '');
  for (var index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 == 0) buffer.write(',');
    buffer.write(digits[index]);
  }
  return buffer.toString();
}

/// Bottom inset below the chat composer, in logical pixels.
///
/// Tighter than the composer spec's 10dp (`output/composer-showcase/spec.md`
/// §3) at the product owner's request. The page's [SafeArea] adds the system
/// inset on top of this. Kept as a single named constant so it stays trivial to
/// tune.
const double kComposerBottomInset = 6;

class _PageTabContent extends StatelessWidget {
  const _PageTabContent({
    required this.child,
    this.bottomPadding = 16,
    this.fullBleed = false,
  });

  final Widget child;
  final double bottomPadding;

  /// Drops the centering constraint and the horizontal gutter so a tab can run
  /// its scroll view edge to edge (the chat transcript, so its scrollbar lands
  /// on the window edge rather than inside a centered column).
  ///
  /// A full-bleed tab owns readable width *and* the phone gutter for its own
  /// content — see `_ReadableColumn`.
  final bool fullBleed;

  /// Gap between the chrome strips and the content they head.
  ///
  /// The strips already carry their own internal insets and a hairline, so a
  /// second 12dp of air below them read as a seam rather than as separation.
  /// 4dp is the smallest grid step that still keeps the first transcript row
  /// off the hairline.
  static const double topGap = 4;

  @override
  Widget build(BuildContext context) {
    if (fullBleed) {
      return Padding(
        padding: EdgeInsets.only(top: topGap, bottom: bottomPadding),
        child: child,
      );
    }
    // One measure for the whole session surface. This used to cap sub-views at
    // 840 while the transcript ran to `_ReadableColumn.maxWidth`, so opening
    // Status/Files/Debug on a wide window shrank the content to roughly a third
    // of the pane (measured: 808 of 2231 at 2560px) and read as a page of empty
    // gutter. Sharing the transcript's measure keeps the two views the same
    // width and puts the surplus back into content.
    return LayoutBuilder(
      builder: (context, constraints) {
        return Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: _ReadableColumn.measureFor(constraints.maxWidth),
            ),
            child: Padding(
              padding: EdgeInsets.fromLTRB(16, topGap, 16, bottomPadding),
              child: child,
            ),
          ),
        );
      },
    );
  }
}

class _StatusChipButton extends StatelessWidget {
  const _StatusChipButton({
    required this.control,
    required this.badgeLabel,
    required this.onTap,
    required this.freshness,
    this.restoringDrive = false,
  });

  final SessionControlView control;
  final String? badgeLabel;
  final VoidCallback onTap;

  /// The detail's one typed freshness state (R0b).
  final SessionDetailFreshnessPresentation freshness;

  /// Bounded arbitration state: show "Restoring Drive…" instead of the
  /// broker pill until the broker confirms or denies the restoration.
  final bool restoringDrive;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final label =
        _controlPillOverrideLabel(
          context,
          freshness: freshness,
          restoringDrive: restoringDrive,
        ) ??
        _controlPillStyle(
          Theme.of(context),
          l10n,
          control.pill,
        ).$1;
    return Tooltip(
      message: label == null
          ? l10n.sessionStatusTooltip
          : l10n.sessionStatusTooltipWithLabel(label),
      child: InkWell(
        key: const Key('session-detail-status-chip'),
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: label == null
                    ? Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        child: Text(l10n.sessionViewStatus),
                      )
                    : _SessionControlPill(
                        control: control,
                        freshness: freshness,
                        restoringDrive: restoringDrive,
                      ),
              ),
            ),
            if (badgeLabel != null) ...[
              const SizedBox(width: 4),
              Container(
                key: const Key('session-detail-status-chip-badge'),
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.primary,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  badgeLabel!,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: Theme.of(context).colorScheme.onPrimary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 4),
            ],
          ],
        ),
      ),
    );
  }
}

/// Status pill for the broker-published session control state
/// (`SessionInfo.control`) — the oracle's one-pill surface. The broker fans
/// control to every attached client, so drive/observe/sync mode stays in sync
/// across a user's clients (iOS/Mac/Android/Web). WP2 —
/// docs/project/implementation-status.md
class _SessionControlPill extends StatelessWidget {
  const _SessionControlPill({
    required this.control,
    required this.freshness,
    this.keyPrefix = 'session-detail-control-pill',
    this.restoringDrive = false,
  });

  final SessionControlView control;
  final String keyPrefix;

  /// The detail's one typed freshness state.
  ///
  /// Driving/Synced/Observing is a claim the *broker* makes about ownership. It
  /// is only true while the socket that published it is connected and has
  /// delivered an authoritative `SessionInfo`; anything else is last-known, and
  /// the pill says so in this same footprint instead (R0b).
  final SessionDetailFreshnessPresentation freshness;

  /// While the broker arbitrates an automatic Drive restoration, the pill
  /// reads "Restoring Drive…" — never Driving, which only the broker's own
  /// control frame may claim.
  final bool restoringDrive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final overrideLabel = _controlPillOverrideLabel(
      context,
      freshness: freshness,
      restoringDrive: restoringDrive,
    );
    final (label, icon, color) = overrideLabel != null
        ? (
            overrideLabel,
            Icons.autorenew,
            freshness.controlIsAuthoritative
                ? tokens.statusWorking
                : tokens.textSecondary,
          )
        : _controlPillStyle(theme, l10n, control.pill);
    if (label == null || icon == null || color == null) {
      return const SizedBox.shrink();
    }
    final pillName = _controlPillStateName(
      control: control,
      freshness: freshness,
      restoringDrive: restoringDrive,
    );
    return Container(
      key: Key('$keyPrefix-$pillName'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 4),
          // The freshness labels are words, not glyphs, and the strip is one
          // 32dp line at every text scale. Ellipsize rather than overflow: the
          // full label stays in the chip's tooltip and semantics, and the pill
          // itself never hides — it is the only place the strip says whether
          // this session's state can be trusted.
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall?.copyWith(
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The label that replaces the broker's ownership claim, or null to keep it.
///
/// One precedence rule, stated once: a non-authoritative session frame outranks
/// a Drive arbitration, because "we cannot currently vouch for this session's
/// state at all" is a stronger statement than "we are arbitrating who drives
/// it". Both outrank the broker pill.
String? _controlPillOverrideLabel(
  BuildContext context, {
  required SessionDetailFreshnessPresentation freshness,
  required bool restoringDrive,
}) {
  final l10n = AppLocalizations.of(context);
  return switch (freshness.freshness) {
    SessionFreshness.reconnecting ||
    SessionFreshness.failed => l10n.sessionControlReconnecting,
    SessionFreshness.initialLoading ||
    SessionFreshness.refreshing => l10n.sessionControlRefreshing,
    SessionFreshness.current =>
      restoringDrive ? l10n.sessionControlRestoringDrive : null,
  };
}

/// Stable widget-key suffix for the pill's current state.
String _controlPillStateName({
  required SessionControlView control,
  required SessionDetailFreshnessPresentation freshness,
  required bool restoringDrive,
}) {
  return switch (freshness.freshness) {
    SessionFreshness.reconnecting || SessionFreshness.failed => 'reconnecting',
    SessionFreshness.initialLoading ||
    SessionFreshness.refreshing => 'refreshing',
    SessionFreshness.current =>
      restoringDrive ? 'restoring' : control.pill.name,
  };
}

(String?, IconData?, Color?) _controlPillStyle(
  ThemeData theme,
  AppLocalizations l10n,
  SessionControlPill pill,
) {
  final scheme = theme.colorScheme;
  return switch (pill) {
    SessionControlPill.synced => (
      l10n.sessionControlSynced,
      Icons.link,
      scheme.primary,
    ),
    // A controller in hand, not a pencil: the pencil collided with the rename
    // affordance ~30dp away and the pair read as a bug. The set is now
    // link = connected, gamepad = controlling, sync = catch up, eye = watching,
    // block = none — five glyphs with no overlap at 14px.
    SessionControlPill.driving => (
      l10n.sessionControlDriving,
      Icons.sports_esports_outlined,
      scheme.primary,
    ),
    SessionControlPill.syncAvailable => (
      l10n.sessionControlSyncAvailable,
      Icons.sync,
      scheme.tertiary,
    ),
    SessionControlPill.observing => (
      l10n.sessionControlObserving,
      Icons.visibility_outlined,
      scheme.onSurfaceVariant,
    ),
    SessionControlPill.unavailable => (
      l10n.sessionControlUnavailable,
      Icons.block_outlined,
      scheme.onSurfaceVariant,
    ),
    SessionControlPill.unknown => (null, null, null),
  };
}

class _StatusTabPanel extends ConsumerStatefulWidget {
  const _StatusTabPanel({
    required this.sessionKey,
    required this.draftController,
    required this.hasActiveBrokerClient,
    required this.onAttach,
    required this.onDetach,
    required this.onExportTranscript,
    required this.onForkSession,
    required this.onCloneSession,
    super.key,
  });

  final SessionDetailKey sessionKey;
  final TextEditingController? draftController;
  final bool hasActiveBrokerClient;
  final VoidCallback onAttach;
  final VoidCallback onDetach;
  final VoidCallback onExportTranscript;
  final VoidCallback onForkSession;
  final VoidCallback onCloneSession;

  @override
  ConsumerState<_StatusTabPanel> createState() => _StatusTabPanelState();
}

class _StatusTabPanelState extends ConsumerState<_StatusTabPanel> {
  bool _takeOverPending = false;
  bool _handoffPending = false;
  bool? _warningSuppressed;

  @override
  void initState() {
    super.initState();
    widget.draftController?.addListener(_draftChanged);
    unawaited(_loadWarningPreference());
  }

  @override
  void didUpdateWidget(covariant _StatusTabPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.draftController == widget.draftController) return;
    oldWidget.draftController?.removeListener(_draftChanged);
    widget.draftController?.addListener(_draftChanged);
  }

  @override
  void dispose() {
    widget.draftController?.removeListener(_draftChanged);
    super.dispose();
  }

  void _draftChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _loadWarningPreference() async {
    final suppressed = await ref
        .read(sessionControlPreferencesStoreProvider)
        .isRoutineTakeoverWarningSuppressed();
    if (mounted) {
      setState(() => _warningSuppressed = suppressed);
    }
  }

  Future<void> _restoreTakeOverWarnings() async {
    await ref
        .read(sessionControlPreferencesStoreProvider)
        .setRoutineTakeoverWarningSuppressed(suppressed: false);
    if (mounted) {
      setState(() => _warningSuppressed = false);
    }
  }

  Future<void> _takeOver() async {
    if (_takeOverPending) {
      return;
    }
    setState(() => _takeOverPending = true);
    try {
      await _confirmAndTakeOver(
        context,
        ref,
        widget.sessionKey,
      );
      if (mounted) {
        await _loadWarningPreference();
      }
    } finally {
      if (mounted) {
        setState(() => _takeOverPending = false);
      }
    }
  }

  Future<bool> _handoffToTerminal() async {
    if (_handoffPending) {
      return false;
    }
    setState(() => _handoffPending = true);
    try {
      return await ref
          .read(
            sessionDetailControllerProvider(widget.sessionKey).notifier,
          )
          .handoffToTerminal();
    } finally {
      if (mounted) {
        setState(() => _handoffPending = false);
      }
    }
  }

  Future<void> _scheduleMessage() async {
    final text = widget.draftController?.text.trim() ?? '';
    if (text.isEmpty) return;
    final state = readQualifiedDetail(ref, widget.sessionKey);
    final title = state.sessionInfo?.title.trim();
    final schedule = await showScheduleMessageSheet(
      context,
      tool: widget.sessionKey.tool,
      sessionId: widget.sessionKey.sessionId,
      sessionTitle: title == null || title.isEmpty
          ? widget.sessionKey.sessionId
          : title,
      text: text,
    );
    if (!mounted || schedule == null) return;
    ref
        .read(
          inlineScheduledMessageControllerProvider(
            InlineScheduledMessageKey(
              tool: widget.sessionKey.tool,
              sessionId: widget.sessionKey.sessionId,
            ),
          ).notifier,
        )
        .upsert(schedule);
    final messenger = ScaffoldMessenger.of(context);
    widget.draftController?.clear();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).sessionScheduledFor(
            DateTime.fromMillisecondsSinceEpoch(schedule.at).toString(),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    // Re-derive control LIVE from the watched controller — never a snapshot
    // frozen at open time — so `willFork` and the pill stay honest if the
    // terminal quits/reopens while the sheet is up.
    final state = watchQualifiedDetail(ref, widget.sessionKey);
    final control = SessionControlView.fromSessionInfo(state.sessionInfo);
    final freshness = SessionDetailFreshnessPresentation.fromState(state);
    final restoringDrive =
        state.driveRestorePhase == SessionDriveRestorePhase.restoring;
    final controlPillState = _controlPillStateName(
      control: control,
      freshness: freshness,
      restoringDrive: restoringDrive,
    );
    final draftText = widget.draftController?.text.trim() ?? '';
    final isHandoff = control.action == SessionControlAction.handoff;
    final isConnected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    final compatibleControls = !state.compatibilityReadOnly;
    final canDetach = switch (state.connectionStatus) {
      SessionDetailConnectionStatus.connecting ||
      SessionDetailConnectionStatus.connected ||
      SessionDetailConnectionStatus.reconnecting => true,
      SessionDetailConnectionStatus.disconnected ||
      SessionDetailConnectionStatus.closed => false,
    };
    // `agentActions.canFork` is a TOOL capability from /api/agents; the
    // agent-owned check is the per-SESSION half. Forking a session another
    // agent spawned only yields another Observe-only thread the user is then
    // navigated into, and the broker refuses it (SESSION_AGENT_OWNED), so the
    // affordance must not offer it in the first place.
    // `forkBlockedAsAgentOwned` is the shared predicate: it also covers a
    // standing refusal the broker issued when local lineage was missing,
    // where the origin alone reads false.
    final canFork =
        isConnected &&
        compatibleControls &&
        widget.hasActiveBrokerClient &&
        (state.agentActions?.canFork ?? false) &&
        !state.forkBlockedAsAgentOwned &&
        !state.forkSessionActionState.isBusy;
    final canClone =
        isConnected &&
        compatibleControls &&
        widget.hasActiveBrokerClient &&
        (state.agentActions?.canClone ?? false) &&
        !state.cloneSessionActionState.isBusy;
    final canExport =
        isConnected &&
        compatibleControls &&
        (state.agentActions?.canTranscriptExport ?? false) &&
        !state.transcriptExportActionState.isBusy;
    // Only surface the terminal command as an action affordance: handoff
    // (Resume — driving) or join/handoff. Never on Observe/Synced, where
    // `terminalSync.command` can still be set but running it would fork a
    // divergent owner (e.g. a live Claude terminal).
    final showCommand =
        compatibleControls &&
        control.command != null &&
        (control.action == SessionControlAction.join ||
            control.action == SessionControlAction.handoff) &&
        control.terminalPresence != TerminalSyncPresence.shared;
    // U3-E. In exactly one state — connected, compatible, Synced (not
    // answer-only), with the terminal actually shared and not behind — the card
    // said the same thing three times: the pill, a general "Synced with your
    // terminal…" line, and a Terminal block reading "Terminal connected and
    // synced." The pill alone is sufficient there, so the other two drop out.
    //
    // The predicate is deliberately narrow. Anything that carries an action, a
    // caveat, a limitation, or a recovery path — answer-only, observing,
    // behind, unavailable, reconnecting/disconnected, a broker `reason`, an
    // ownership conflict, a join/handoff command, a reachable Take over, or
    // compatibility read-only — fails one of these clauses and keeps its full
    // explanation. Nothing here removes a control.
    final syncedSharedHealthy =
        isConnected &&
        compatibleControls &&
        control.pill == SessionControlPill.synced &&
        !control.answerOnly &&
        control.terminalPresence == TerminalSyncPresence.shared &&
        !(control.terminalBehind ?? false) &&
        control.reason == null &&
        !control.canTakeOver &&
        !showCommand &&
        state.driveRestoreConflict == null;
    // U3-D. One selection region over the whole Status surface: labels, values,
    // descriptions and status tags are ordinary `Text`, and under a
    // `SelectionArea` they become selectable and copyable together without any
    // of them turning into a text field. Buttons, list tiles, the copy-command
    // action and the list's own scrolling keep their gestures — selection only
    // claims drags that no child recognizer wins.
    return SelectionArea(
      key: const Key('session-detail-status-selection'),
      child: ListView(
        key: const Key('session-detail-status-panel'),
        children: [
          KeyedSubtree(
            key: const Key('session-detail-status-sheet'),
            child: Card(
              margin: EdgeInsets.zero,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l10n.sessionConnectionOwnership,
                      style: theme.textTheme.titleSmall,
                    ),
                    // U3-C: the native session id used to sit here. It is
                    // technical identity, and Debug's "Session identity" card —
                    // behind General → Developer options → Show debug views,
                    // default off — already owns it. Normal Status answers "who
                    // controls this session", not "what is its fingerprint".
                    const SizedBox(height: 8),
                    // R0b: one owner for the freshness statement. The pill's
                    // footprint carries it in every state — Driving/Synced when
                    // the frame is authoritative, Refreshing/Reconnecting when
                    // it is not — so the panel no longer adds a second
                    // reconnect sentence beside it. `Not attached` survives
                    // because it is a different, terminal fact: nothing is
                    // being re-established.
                    KeyedSubtree(
                      key: Key(
                        'session-detail-status-sheet-control-pill-'
                        '$controlPillState',
                      ),
                      child: _SessionControlPill(
                        control: control,
                        freshness: freshness,
                        keyPrefix: 'session-detail-status-control-pill',
                        restoringDrive: restoringDrive,
                      ),
                    ),
                    if (!isConnected &&
                        state.connectionStatus !=
                            SessionDetailConnectionStatus.reconnecting &&
                        state.connectionStatus !=
                            SessionDetailConnectionStatus.connecting)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          l10n.sessionNotAttached,
                          key: const Key('session-detail-status-offline-hint'),
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.error,
                          ),
                        ),
                      ),
                    if (!syncedSharedHealthy) ...[
                      const SizedBox(height: 12),
                      Text(
                        _controlStatusDescription(l10n, control),
                        key: const Key(
                          'session-detail-status-control-description',
                        ),
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                    if (control.reason?.trim().isNotEmpty ?? false) ...[
                      const SizedBox(height: 8),
                      Material(
                        type: MaterialType.transparency,
                        child: ExpansionTile(
                          tilePadding: EdgeInsets.zero,
                          title: Text(l10n.technicalDetails),
                          children: [
                            SelectableText(
                              control.reason!,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    if (state.driveRestoreConflict case final conflict?) ...[
                      const SizedBox(height: 8),
                      Text(
                        switch (conflict.code) {
                          'DRIVE_OWNERSHIP_CONFLICT' =>
                            l10n.sessionDriveRestoreConflictNote,
                          'DRIVE_RESTORE_TIMEOUT' =>
                            l10n.sessionDriveTakeoverTimeoutNote,
                          _ => l10n.sessionDriveRestoreFailureNote,
                        },
                        key: const Key(
                          'session-detail-drive-restore-conflict',
                        ),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: context.tokens.textSecondary,
                        ),
                      ),
                    ],
                    if (!isConnected) ...[
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          key: const Key('session-detail-status-attach'),
                          onPressed: canDetach ? null : widget.onAttach,
                          icon: const Icon(Icons.link),
                          label: Text(
                            state.connectionStatus ==
                                    SessionDetailConnectionStatus.closed
                                ? l10n.sessionRetryAttach
                                : l10n.sessionAttach,
                          ),
                        ),
                      ),
                    ],
                    if (!syncedSharedHealthy) ...[
                      const SizedBox(height: 16),
                      Text(
                        l10n.sessionTerminalOptional,
                        key: const Key(
                          'session-detail-status-terminal-heading',
                        ),
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _controlTerminalStatusDescription(l10n, control),
                        key: const Key(
                          'session-detail-status-terminal-description',
                        ),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                    if (showCommand) ...[
                      const SizedBox(height: 12),
                      _CopyCommandRow(
                        label: _controlCommandLabel(l10n, control),
                        command: control.command!,
                        enabled:
                            isConnected &&
                            compatibleControls &&
                            !_handoffPending,
                        onCopied: isHandoff ? _handoffToTerminal : null,
                      ),
                    ],
                    if (isHandoff && control.command == null) ...[
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          key: const Key('session-detail-hand-back-button'),
                          icon: const Icon(Icons.logout),
                          label: Text(l10n.sessionSwitchToObserve),
                          onPressed:
                              isConnected &&
                                  compatibleControls &&
                                  !_handoffPending
                              ? () => unawaited(_handoffToTerminal())
                              : null,
                        ),
                      ),
                    ],
                    // Reachable on EVERY supported Observing session —
                    // including the Sync-available pill, where Join is only the
                    // primary action. Sync must never be the only path back to
                    // Drive.
                    if (control.canTakeOver) ...[
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          key: const Key('session-detail-take-over-button'),
                          icon: const Icon(Icons.login),
                          label: Text(l10n.sessionTakeOver),
                          onPressed:
                              isConnected &&
                                  compatibleControls &&
                                  !_takeOverPending
                              ? () => unawaited(_takeOver())
                              : null,
                        ),
                      ),
                    ],
                    if (_warningSuppressed ?? false) ...[
                      const SizedBox(height: 8),
                      TextButton(
                        key: const Key(
                          'session-detail-restore-takeover-warnings',
                        ),
                        onPressed: () => unawaited(_restoreTakeOverWarnings()),
                        child: Text(
                          l10n.sessionRestoreTakeoverConfirmations,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(l10n.sessionPlanActivity, style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          if (state.liveState.isEmpty && state.commandProgress == null)
            Text(
              l10n.sessionPlanActivityEmpty,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            )
          else
            _FullLiveStatePanel(
              liveState: state.liveState,
              commandProgress: state.commandProgress,
              commands: state.commands,
              controller: ref.read(
                sessionDetailControllerProvider(widget.sessionKey).notifier,
              ),
              isConnected: isConnected,
              canPrompt: compatibleControls && control.canPrompt,
            ),
          const SizedBox(height: 16),
          Text(
            l10n.sessionDetailTelemetryHeading,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 8),
          _TelemetryPanel(telemetry: state.telemetry),
          const SizedBox(height: 16),
          Text(l10n.sessionActions, style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          _SessionActionGroups(
            sessionKey: widget.sessionKey,
            state: state,
            canDetach: canDetach,
            canFork: canFork,
            canClone: canClone,
            canExport: canExport,
            hasActiveBrokerClient: widget.hasActiveBrokerClient,
            onDetach: widget.onDetach,
            onForkSession: widget.onForkSession,
            onCloneSession: widget.onCloneSession,
            onExportTranscript: widget.onExportTranscript,
          ),
          if (_transcriptExportStatusText(
                l10n,
                state.transcriptExportActionState,
              )
              case final message?)
            SelectableText(
              message,
              key: const Key('session-detail-export-transcript-status'),
              style: theme.textTheme.bodySmall,
            ),
          if (_forkActionStatusText(l10n, state.forkSessionActionState)
              case final message?)
            SelectableText(
              message,
              key: const Key('session-detail-fork-session-status'),
              style: theme.textTheme.bodySmall,
            ),
          if (_cloneActionStatusText(l10n, state.cloneSessionActionState)
              case final message?)
            SelectableText(
              message,
              key: const Key('session-detail-clone-session-status'),
              style: theme.textTheme.bodySmall,
            ),
          const SizedBox(height: 16),
          Text(l10n.sessionSendLater, style: theme.textTheme.titleSmall),
          Card(
            margin: EdgeInsets.zero,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            child: ListTile(
              key: const Key('session-detail-send-later'),
              leading: const Icon(Icons.event_outlined),
              title: Text(l10n.sessionScheduleComposerDraft),
              subtitle: Text(
                draftText.isEmpty
                    ? l10n.sessionScheduleDraftEmpty
                    : l10n.sessionScheduleDraftReady,
              ),
              enabled: compatibleControls && draftText.isNotEmpty,
              onTap: !compatibleControls || draftText.isEmpty
                  ? null
                  : () => unawaited(_scheduleMessage()),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

/// Take-over routing. The preference can skip routine non-fork confirms, but a
/// live `willFork` always gets the load-bearing red warning. Control is read
/// again after every await so a terminal owner change cannot use stale copy.
Future<bool> _confirmAndTakeOver(
  BuildContext context,
  WidgetRef ref,
  SessionDetailKey sessionKey,
) async {
  final prefs = ref.read(sessionControlPreferencesStoreProvider);
  final controller = ref.read(
    sessionDetailControllerProvider(sessionKey).notifier,
  );
  var suppressed = await prefs.isRoutineTakeoverWarningSuppressed();
  var confirmedTakeOver = false;
  var confirmedFork = false;
  if (!context.mounted) {
    return false;
  }

  while (context.mounted) {
    final state = readQualifiedDetail(ref, sessionKey);
    final control = SessionControlView.fromSessionInfo(state.sessionInfo);
    if (state.connectionStatus != SessionDetailConnectionStatus.connected ||
        state.compatibilityReadOnly ||
        !control.canTakeOver) {
      return false;
    }
    final needsConfirm = control.willFork
        ? !confirmedFork
        : !confirmedTakeOver && !suppressed;
    if (!needsConfirm) {
      break;
    }
    final choice = await showDialog<_TakeOverChoice>(
      context: context,
      builder: (context) => _TakeOverConfirmDialog(
        sessionKey: sessionKey,
        allowSuppression: !control.willFork,
      ),
    );
    if (!context.mounted || choice == null) {
      return false;
    }
    confirmedTakeOver = true;
    confirmedFork = confirmedFork || choice.confirmedFork;
    if (choice.neverWarnAgain) {
      await prefs.setRoutineTakeoverWarningSuppressed(suppressed: true);
      suppressed = true;
    }
    if (!context.mounted) {
      return false;
    }
  }

  if (!context.mounted) {
    return false;
  }
  final latestState = readQualifiedDetail(ref, sessionKey);
  final latestControl = SessionControlView.fromSessionInfo(
    latestState.sessionInfo,
  );
  if (latestState.connectionStatus != SessionDetailConnectionStatus.connected ||
      !latestControl.canTakeOver ||
      (latestControl.willFork && !confirmedFork)) {
    return false;
  }
  return controller.takeOver();
}

/// Result of the take-over confirm dialog (null = cancelled).
class _TakeOverChoice {
  const _TakeOverChoice({
    required this.neverWarnAgain,
    required this.confirmedFork,
  });

  /// Whether the user ticked "Don't warn me again" (persist the opt-out).
  final bool neverWarnAgain;

  /// Whether the live dialog explicitly showed and confirmed fork semantics.
  final bool confirmedFork;
}

class _TakeOverConfirmDialog extends ConsumerStatefulWidget {
  const _TakeOverConfirmDialog({
    required this.sessionKey,
    required this.allowSuppression,
  });

  final SessionDetailKey sessionKey;
  final bool allowSuppression;

  @override
  ConsumerState<_TakeOverConfirmDialog> createState() =>
      _TakeOverConfirmDialogState();
}

class _TakeOverConfirmDialogState
    extends ConsumerState<_TakeOverConfirmDialog> {
  bool _neverWarnAgain = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final state = watchQualifiedDetail(ref, widget.sessionKey);
    final control = SessionControlView.fromSessionInfo(state.sessionInfo);
    final actionable =
        state.connectionStatus == SessionDetailConnectionStatus.connected &&
        control.canTakeOver;
    final willFork = actionable && control.willFork;
    final title = !actionable
        ? l10n.sessionTakeoverChangedTitle
        : willFork
        ? l10n.sessionTakeoverForkTitle
        : l10n.sessionTakeoverTitle;
    final body = !actionable
        ? l10n.sessionTakeoverChangedBody
        : willFork
        ? l10n.sessionTakeoverForkBody
        : l10n.sessionTakeoverBody;
    return AlertDialog(
      key: const Key('session-detail-take-over-dialog'),
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(body),
          const SizedBox(height: 8),
          if (widget.allowSuppression && !willFork)
            CheckboxListTile(
              key: const Key('session-detail-take-over-never-warn'),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _neverWarnAgain,
              onChanged: actionable
                  ? (value) => setState(() => _neverWarnAgain = value ?? false)
                  : null,
              title: Text(l10n.sessionTakeoverDontWarn),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          key: const Key('session-detail-take-over-confirm'),
          style: willFork
              ? FilledButton.styleFrom(
                  backgroundColor: theme.colorScheme.error,
                  foregroundColor: theme.colorScheme.onError,
                )
              : null,
          onPressed: actionable
              ? () => Navigator.of(context).pop(
                  _TakeOverChoice(
                    neverWarnAgain: !willFork && _neverWarnAgain,
                    confirmedFork: willFork,
                  ),
                )
              : null,
          child: Text(
            willFork ? l10n.sessionTakeoverForkAction : l10n.sessionTakeOver,
          ),
        ),
      ],
    );
  }
}

String _controlStatusDescription(
  AppLocalizations l10n,
  SessionControlView control,
) {
  if (control.answerOnly) {
    return l10n.sessionControlAnswersOnly;
  }
  if (control.pill == SessionControlPill.driving && control.command == null) {
    return l10n.sessionControlDrivingNoCommand;
  }
  return switch (control.pill) {
    SessionControlPill.synced => l10n.sessionControlSyncedDescription,
    SessionControlPill.driving => l10n.sessionControlDrivingDescription,
    SessionControlPill.syncAvailable =>
      l10n.sessionControlSyncAvailableDescription,
    SessionControlPill.observing => l10n.sessionControlObservingDescription,
    SessionControlPill.unavailable => l10n.sessionControlUnavailableDescription,
    SessionControlPill.unknown => l10n.sessionControlUnknownDescription,
  };
}

String _controlTerminalStatusDescription(
  AppLocalizations l10n,
  SessionControlView control,
) {
  if (control.terminalPresence == TerminalSyncPresence.shared) {
    return l10n.sessionTerminalSynced;
  }
  if (control.terminalPresence == TerminalSyncPresence.private) {
    if (control.terminalBehind ?? false) {
      return l10n.sessionTerminalBehind;
    }
    return l10n.sessionTerminalRestart;
  }
  if (control.terminalPresence == TerminalSyncPresence.absent) {
    if (control.launchSurface == SessionLaunchSurface.app) {
      return l10n.sessionTerminalNoneDriving;
    }
    return l10n.sessionTerminalNone;
  }

  return l10n.sessionTerminalUnknown;
}

String _controlCommandLabel(
  AppLocalizations l10n,
  SessionControlView control,
) {
  return switch (control.action) {
    SessionControlAction.handoff => l10n.sessionResumeInTerminal,
    SessionControlAction.join => l10n.sessionOpenInTerminal,
    _ => l10n.sessionResumeInTerminal,
  };
}

/// A copyable terminal command — the adapter's join/handoff command
/// (`control.terminalSync.command`), shown verbatim and never tool-branched.
class _CopyCommandRow extends StatelessWidget {
  const _CopyCommandRow({
    required this.label,
    required this.command,
    this.enabled = true,
    this.onCopied,
  });

  final String label;
  final String command;
  final bool enabled;

  /// Invoked only after the clipboard write succeeds. For handoff this
  /// demotes the app to Observe and reports whether that transition succeeded.
  final Future<bool> Function()? onCopied;

  Future<void> _copy(BuildContext context) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await Clipboard.setData(ClipboardData(text: command));
    } on PlatformException {
      if (messenger?.mounted ?? false) {
        messenger!.showSnackBar(
          SnackBar(content: Text(l10n.sessionCopyCommandFailed)),
        );
      }
      return;
    }
    final handedOff = await onCopied?.call();
    if (!(messenger?.mounted ?? false)) {
      return;
    }
    messenger!.showSnackBar(
      SnackBar(
        content: Text(
          onCopied == null
              ? l10n.sessionCommandCopied
              : handedOff ?? false
              ? l10n.sessionCommandCopiedHandedOff
              : l10n.sessionCommandCopiedHandoffFailed,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 6),
        DecoratedBox(
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: theme.colorScheme.outlineVariant),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    command,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
                IconButton(
                  key: const Key('session-detail-status-copy-command'),
                  tooltip: l10n.sessionCopyCommand,
                  icon: const Icon(Icons.copy, size: 18),
                  onPressed: enabled ? () => unawaited(_copy(context)) : null,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _TranscriptExportConfirmDialog extends StatelessWidget {
  const _TranscriptExportConfirmDialog({required this.preflight});

  final TranscriptExportPreflightResponse preflight;

  @override
  Widget build(BuildContext context) {
    final confirm = preflight.confirm;
    final l10n = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(l10n.sessionExportTranscript),
      content: SingleChildScrollView(
        child: SelectionArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(confirm.sessionTitle),
              const SizedBox(height: 12),
              _DialogMetadata(label: l10n.format, value: confirm.format),
              _DialogMetadata(
                label: l10n.sizeCap,
                value: l10n.bytesCount(confirm.sizeCapBytes),
              ),
              _DialogMetadata(
                label: l10n.retention,
                value: l10n.minutesCount(confirm.retentionMinutes),
              ),
              const SizedBox(height: 12),
              Text(l10n.sessionExportConfirmBody(confirm.format)),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('session-detail-export-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          key: const Key('session-detail-export-confirm'),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(l10n.export),
        ),
      ],
    );
  }
}

class _DialogMetadata extends StatelessWidget {
  const _DialogMetadata({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        '$label: $value',
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}

/// Compact composer footer: merged model/effort, permission mode, and the
/// detached-only Attach affordance.
