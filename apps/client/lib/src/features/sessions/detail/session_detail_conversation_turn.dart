part of 'session_detail_page.dart';

/// One action + runtime footer rendered after a turn's model output.
///
/// Read aloud and Copy act on the C1 [ConversationTurn.modelText] aggregate —
/// model prose only, never tool output or thinking. Turn telemetry opens the
/// per-turn run-summary inspector. The visible runtime line is sourced only
/// from the authoritative `totalRuntimeMs`/`completedAt`.
class _ConversationTurnFooter extends ConsumerWidget {
  const _ConversationTurnFooter({required this.turn, super.key});

  final ConversationTurn turn;

  // The turn key already carries a `turn:` prefix; reuse it directly so the
  // read-aloud playback key is stable and unambiguous.
  String get _speechKey => turn.turnKey;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: turn.modelText));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppLocalizations.of(context).sessionTurnCopyConfirmation),
      ),
    );
  }

  void _speak(WidgetRef ref) => unawaited(
    ref
        .read(readAloudControllerProvider.notifier)
        .speakText(messageKey: _speechKey, text: turn.modelText),
  );

  void _pause(WidgetRef ref) =>
      unawaited(ref.read(readAloudControllerProvider.notifier).pause());

  void _resume(WidgetRef ref) =>
      unawaited(ref.read(readAloudControllerProvider.notifier).resume());

  void _stop(WidgetRef ref) =>
      unawaited(ref.read(readAloudControllerProvider.notifier).stop());

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final readAloud = ref.watch(readAloudControllerProvider);
    final output = readAloud.outputState;
    // Playback state scoped to THIS turn's key, so pause/resume/stop/retry
    // reflect only this footer's own playback (the old per-message control's
    // capabilities, now scoped to the turn).
    final speakingHere =
        output is SpeechOutputSpeaking && output.messageKey == _speechKey;
    final pausedHere =
        output is SpeechOutputPaused && output.messageKey == _speechKey;
    final errorHere =
        output is SpeechOutputError && output.messageKey == _speechKey;
    final pauseResume = readAloud.capabilities.pauseResume;
    final activeHere = speakingHere || pausedHere;
    final canReadAloud =
        turn.hasModelText && readAloud.capabilities.canAttemptSynthesis;
    final summary = turn.runSummary;
    final runtimeLine = summary == null
        ? null
        : _turnRuntimeLine(context, summary);

    // The primary read-aloud button is state-aware, and a separate Stop is
    // offered only when the primary is not itself Stop.
    final IconData primaryIcon;
    final String primaryTooltip;
    final void Function() onPrimary;
    final bool showStop;
    if (errorHere) {
      primaryIcon = Icons.refresh;
      primaryTooltip = l10n.sessionTurnRetryReadAloudTooltip;
      onPrimary = () => _speak(ref);
      showStop = false;
    } else if (pausedHere) {
      primaryIcon = Icons.play_arrow_outlined;
      primaryTooltip = l10n.sessionTurnResumeReadAloudTooltip;
      onPrimary = () => _resume(ref);
      showStop = true;
    } else if (speakingHere && pauseResume) {
      primaryIcon = Icons.pause_outlined;
      primaryTooltip = l10n.sessionTurnPauseReadAloudTooltip;
      onPrimary = () => _pause(ref);
      showStop = true;
    } else if (speakingHere) {
      // Speaking with no pause/resume support: the primary itself stops.
      primaryIcon = Icons.stop_circle_outlined;
      primaryTooltip = l10n.sessionTurnStopReadAloudTooltip;
      onPrimary = () => _stop(ref);
      showStop = false;
    } else {
      primaryIcon = Icons.volume_up_outlined;
      primaryTooltip = l10n.sessionTurnReadAloudTooltip;
      onPrimary = () => _speak(ref);
      showStop = false;
    }

    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: [
          if (runtimeLine != null)
            Expanded(
              child: Tooltip(
                message: _turnRuntimeTooltip(context, summary!) ?? runtimeLine,
                child: Text(
                  runtimeLine,
                  key: const Key('conversation-turn-runtime-line'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            )
          else
            const Spacer(),
          if (canReadAloud) ...[
            _TurnFooterAction(
              icon: primaryIcon,
              tooltip: primaryTooltip,
              actionKey: const Key('conversation-turn-read-aloud'),
              onPressed: onPrimary,
            ),
            if (activeHere)
              SizedBox.square(
                dimension: 40,
                child: PopupMenuButton<double>(
                  key: const Key('conversation-turn-read-aloud-rate'),
                  tooltip: l10n.readAloudSpeed,
                  initialValue: readAloud.rate,
                  onSelected: (rate) => unawaited(
                    ref
                        .read(readAloudControllerProvider.notifier)
                        .setRate(rate),
                  ),
                  itemBuilder: (context) => [
                    for (final rate in kReadAloudRates)
                      PopupMenuItem(
                        value: rate,
                        child: Text(formatReadAloudRate(rate)),
                      ),
                  ],
                  child: Center(
                    child: Text(
                      formatReadAloudRate(readAloud.rate),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ),
            if (showStop)
              _TurnFooterAction(
                icon: Icons.stop_circle_outlined,
                tooltip: l10n.sessionTurnStopReadAloudTooltip,
                actionKey: const Key('conversation-turn-read-aloud-stop'),
                onPressed: () => _stop(ref),
              ),
          ],
          if (turn.hasModelText)
            _TurnFooterAction(
              icon: Icons.copy_outlined,
              tooltip: l10n.sessionTurnCopyTooltip,
              actionKey: const Key('conversation-turn-copy'),
              onPressed: () => unawaited(_copy(context)),
            ),
          _TurnFooterAction(
            icon: Icons.insights_outlined,
            tooltip: l10n.sessionTurnTelemetryTooltip,
            actionKey: const Key('conversation-turn-telemetry'),
            onPressed: () => unawaited(_showTurnTelemetry(context, turn)),
          ),
        ],
      ),
    );
  }
}

/// One small footer icon action with a 40dp minimum touch target.
class _TurnFooterAction extends StatelessWidget {
  const _TurnFooterAction({
    required this.icon,
    required this.tooltip,
    required this.actionKey,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final Key actionKey;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return IconButton(
      key: actionKey,
      onPressed: onPressed,
      tooltip: tooltip,
      iconSize: 16,
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
      padding: EdgeInsets.zero,
      color: theme.colorScheme.onSurfaceVariant,
      icon: Icon(icon),
    );
  }
}

String? _turnRuntimeLine(
  BuildContext context,
  ConversationTurnRunSummary summary,
) {
  final l10n = AppLocalizations.of(context);
  final parts = <String>[
    if (summary.totalRuntimeMs case final ms?)
      l10n.sessionTurnRanFor(_formatTurnDuration(ms)),
    if (summary.completedAt case final at?)
      l10n.sessionTurnFinishedAt(_formatTurnClock(context, at)),
  ];
  if (parts.isEmpty) return null;
  return parts.join(' · ');
}

String? _turnRuntimeTooltip(
  BuildContext context,
  ConversationTurnRunSummary summary,
) {
  final at = summary.completedAt;
  if (at == null) return null;
  final materialL10n = MaterialLocalizations.of(context);
  final dateTime = DateTime.fromMillisecondsSinceEpoch(at);
  final time = materialL10n.formatTimeOfDay(
    TimeOfDay.fromDateTime(dateTime),
    alwaysUse24HourFormat: MediaQuery.of(context).alwaysUse24HourFormat,
  );
  return '${materialL10n.formatFullDate(dateTime)} $time';
}

/// Opens the per-turn telemetry inspector: a dialog on roomy layouts, a bottom
/// sheet on compact.
Future<void> _showTurnTelemetry(BuildContext context, ConversationTurn turn) {
  final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
  final content = _TurnTelemetryContent(turn: turn);
  if (compact) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) {
        final theme = Theme.of(context);
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    AppLocalizations.of(context).sessionTurnTelemetryTitle,
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: 12),
                  content,
                ],
              ),
            ),
          ),
        );
      },
    );
  }
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      key: const Key('conversation-turn-telemetry-dialog'),
      title: Text(AppLocalizations.of(context).sessionTurnTelemetryTitle),
      content: SingleChildScrollView(child: content),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(AppLocalizations.of(context).close),
        ),
      ],
    ),
  );
}

/// Body of the per-turn telemetry inspector, shared by dialog and sheet.
class _TurnTelemetryContent extends StatelessWidget {
  const _TurnTelemetryContent({required this.turn});

  final ConversationTurn turn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final summary = turn.runSummary;
    final rows = <_TurnTelemetryRow>[
      if (summary != null)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryStatusLabel,
          _turnStatusLabel(l10n, summary.status),
        ),
      if (summary?.totalRuntimeMs case final ms?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryRuntimeLabel,
          _formatTurnDuration(ms),
        ),
      if (summary?.agentRuntimeMs case final ms?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryAgentRuntimeLabel,
          _formatTurnDuration(ms),
        ),
      if (summary?.executionRuntimeMs case final ms?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryExecutionRuntimeLabel,
          _formatTurnDuration(ms),
        ),
      if (summary?.inputTokens case final value?)
        _TurnTelemetryRow(
          l10n.sessionDetailTelemetryInput,
          '$value',
        ),
      if (summary?.outputTokens case final value?)
        _TurnTelemetryRow(
          l10n.sessionDetailTelemetryOutput,
          '$value',
        ),
      if (summary?.cacheReadTokens case final value?)
        _TurnTelemetryRow(
          l10n.sessionDetailTelemetryCacheRead,
          '$value',
        ),
      if (summary?.cacheWriteTokens case final value?)
        _TurnTelemetryRow(
          l10n.sessionDetailTelemetryCacheWrite,
          '$value',
        ),
      if (summary?.cost case final cost?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryCostLabel,
          '\$${cost.toStringAsFixed(4)}',
        ),
      if (summary?.startedAt case final at?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryStartedLabel,
          _formatTurnClock(context, at),
        ),
      if (summary?.completedAt case final at?)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryFinishedLabel,
          _formatTurnClock(context, at),
        ),
      // Only when there is something to attribute — otherwise the empty-state
      // note below stands alone instead of pairing with a `Tool calls: 0` row.
      if (summary != null || turn.distinctToolCallCount > 0)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryToolCallsLabel,
          '${turn.distinctToolCallCount}',
        ),
      if (summary != null && summary.children.isNotEmpty)
        _TurnTelemetryRow(
          l10n.sessionTurnTelemetryChildRunsLabel,
          '${summary.children.length}',
        ),
    ];

    final hasAttributable = summary != null || turn.distinctToolCallCount > 0;

    return SelectionArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!hasAttributable)
            Text(
              l10n.sessionTurnTelemetryEmpty,
              key: const Key('conversation-turn-telemetry-empty'),
              style: theme.textTheme.bodyMedium,
            ),
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 132,
                    child: Text(
                      row.label,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(row.value, style: theme.textTheme.bodyMedium),
                  ),
                ],
              ),
            ),
          if (turn.isPartial)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                l10n.sessionTurnTelemetryPartial,
                key: const Key('conversation-turn-telemetry-partial'),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _TurnTelemetryRow {
  const _TurnTelemetryRow(this.label, this.value);

  final String label;
  final String value;
}

String _turnStatusLabel(AppLocalizations l10n, ConversationRunStatus status) =>
    switch (status) {
      ConversationRunStatus.done => l10n.sessionTurnStatusDone,
      ConversationRunStatus.error => l10n.sessionTurnStatusError,
      ConversationRunStatus.cancelled => l10n.sessionTurnStatusCancelled,
      ConversationRunStatus.running => l10n.sessionTurnStatusRunning,
      ConversationRunStatus.unknown => l10n.sessionTurnStatusUnknown,
    };

String _formatTurnDuration(int milliseconds) {
  if (milliseconds < 1000) return '${milliseconds}ms';
  final totalSeconds = (milliseconds / 1000).round();
  if (totalSeconds < 60) return '${totalSeconds}s';
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  if (minutes < 60) return '${minutes}m ${seconds}s';
  final hours = minutes ~/ 60;
  final remMinutes = minutes % 60;
  return '${hours}h ${remMinutes}m';
}

String _formatTurnClock(BuildContext context, int epochMilliseconds) {
  final materialL10n = MaterialLocalizations.of(context);
  final dateTime = DateTime.fromMillisecondsSinceEpoch(epochMilliseconds);
  final time = materialL10n.formatTimeOfDay(
    TimeOfDay.fromDateTime(dateTime),
    alwaysUse24HourFormat: MediaQuery.of(context).alwaysUse24HourFormat,
  );
  final now = DateTime.now();
  final sameDay =
      dateTime.year == now.year &&
      dateTime.month == now.month &&
      dateTime.day == now.day;
  if (sameDay) return time;
  return '${materialL10n.formatShortDate(dateTime)} $time';
}
