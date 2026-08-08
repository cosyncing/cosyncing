part of 'message_renderer_registry.dart';

/// Fraction of the readable row a bubble occupies.
///
/// The inset is what makes left/right alignment legible — a full-width bubble
/// reads the same whoever sent it. It stays small because it multiplies the
/// row measure (`_ReadableColumn.maxWidth`); the previous 0.93 compounded with
/// an already-narrow row and cost about 80px on a wide window for no extra
/// signal.
const double _transcriptBubbleWidthFactor = 0.97;

class _TranscriptBubble extends StatelessWidget {
  const _TranscriptBubble({
    required this.icon,
    required this.title,
    required this.summary,
    required this.payloadRows,
    this.readOnlyHint,
    this.detailContent,
    this.isError = false,
    this.isUserMessage = false,
    this.isQueued = false,
  });

  final IconData icon;
  final String title;
  final String summary;
  final List<MapEntry<String, Object?>> payloadRows;
  final String? readOnlyHint;
  final Widget? detailContent;
  final bool isError;
  final bool isUserMessage;
  final bool isQueued;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final accentColor = isError
        ? theme.colorScheme.error
        : isUserMessage
        ? theme.colorScheme.primary
        : theme.colorScheme.primaryContainer;
    final backgroundColor = isError
        ? theme.colorScheme.errorContainer.withValues(alpha: 0.35)
        : isUserMessage
        ? theme.colorScheme.primaryContainer.withValues(alpha: 0.75)
        : theme.colorScheme.surfaceContainerHighest;
    final timestamp = TranscriptMessageMetadataScope.timestampOf(context);
    final visibleRows = visibleTranscriptPayloadRows(
      summary: summary,
      rows: payloadRows,
    );

    return Opacity(
      opacity: isQueued ? 0.62 : 1,
      child: Align(
        alignment: isUserMessage ? Alignment.centerRight : Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: _transcriptBubbleWidthFactor,
          child: Card(
            color: backgroundColor,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(icon, color: accentColor),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          title,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      if (isError)
                        Icon(
                          Icons.warning_amber,
                          color: theme.colorScheme.error,
                          size: 18,
                        ),
                      if (isQueued)
                        _ToolMetadataChip(
                          key: const Key('queued-user-message-badge'),
                          label: l10n.sessionTurnQueuedBadge,
                        ),
                      if (timestamp != null) ...[
                        const SizedBox(width: 8),
                        Text(
                          _formatTranscriptTime(timestamp),
                          key: const Key('transcript-message-time'),
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ],
                  ),
                  if (readOnlyHint != null) ...[
                    const SizedBox(height: 8),
                    _ReadOnlyHint(label: l10n.readOnlySuffix(readOnlyHint!)),
                  ],
                  const SizedBox(height: 8),
                  _MarkdownBody(source: summary),
                  if (visibleRows.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Divider(height: 1),
                    const SizedBox(height: 8),
                    for (final row in visibleRows)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: _TranscriptDetailRow(row: row),
                      ),
                  ],
                  if (detailContent != null) ...[
                    const SizedBox(height: 8),
                    detailContent!,
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A one-line muted caption for low-signal metadata events (token counts,
/// status ticks).
///
/// These carry no conversational content, so they get a caption row instead of
/// a [_TranscriptBubble] card. Full payload stays reachable through the
/// per-message context menu's Details entry. Registry-driven like every other
/// renderer — nothing here branches on an agent or tool name.
class _TranscriptMetaLine extends StatelessWidget {
  const _TranscriptMetaLine({
    required this.icon,
    required this.text,
    super.key,
  });

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.onSurfaceVariant;
    final timestamp = TranscriptMessageMetadataScope.timestampOf(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      child: Row(
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodySmall?.copyWith(color: color),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (timestamp != null) ...[
            const SizedBox(width: 8),
            Text(
              _formatTranscriptTime(timestamp),
              key: const Key('transcript-message-time'),
              style: theme.textTheme.labelSmall?.copyWith(color: color),
            ),
          ],
        ],
      ),
    );
  }
}

String _formatTranscriptTime(int timestamp) {
  final dateTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
  final hour = dateTime.hour.toString().padLeft(2, '0');
  final minute = dateTime.minute.toString().padLeft(2, '0');
  return '$hour:$minute';
}

class _TaskListDetailSection extends StatelessWidget {
  const _TaskListDetailSection({required this.items});

  final List<_TaskListItem> items;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _taskIcon(item.status),
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _taskLine(l10n, item),
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _ActivityChildrenSection extends StatelessWidget {
  const _ActivityChildrenSection({required this.children});

  final List<_ActivityChild> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.activityChildren,
          style: theme.textTheme.labelLarge,
        ),
        const SizedBox(height: 6),
        for (final child in children)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _activityIcon(child.status),
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _activityChildLine(l10n, child),
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

IconData _taskIcon(String status) {
  return switch (status) {
    'done' => Icons.check_circle_outline,
    'in-progress' => Icons.radio_button_checked,
    'cancelled' => Icons.cancel_outlined,
    _ => Icons.radio_button_unchecked,
  };
}

String _taskLine(AppLocalizations l10n, _TaskListItem item) {
  final pieces = <String>[item.title, _taskStatusLabel(l10n, item.status)];
  if (item.priority != null) {
    pieces.add(l10n.priorityLabel(item.priority!));
  }
  if (item.detail != null) {
    pieces.add(item.detail!);
  }
  return pieces.join(' - ');
}

IconData _activityIcon(String status) {
  return switch (status) {
    'done' => Icons.check_circle_outline,
    'running' => Icons.play_circle_outline,
    'error' => Icons.error_outline,
    _ => Icons.pending_outlined,
  };
}

String _activityChildLine(
  AppLocalizations l10n,
  _ActivityChild child,
) {
  final pieces = <String>[
    child.title,
    _taskStatusLabel(l10n, child.status),
  ];
  if (child.phase != null) {
    pieces.add(child.phase!);
  }
  final elapsed = _formatDuration(child.elapsedMs);
  if (elapsed != null) {
    pieces.add(elapsed);
  }
  return pieces.join(' - ');
}

String _taskStatusLabel(
  AppLocalizations l10n,
  String status,
) => switch (status) {
  'done' => l10n.done,
  'in-progress' => l10n.inProgress,
  'cancelled' || 'canceled' => l10n.canceled,
  _ => l10n.pending,
};

class _TranscriptDetailRow extends StatelessWidget {
  const _TranscriptDetailRow({required this.row});

  final MapEntry<String, Object?> row;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '${row.key}: ',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            TextSpan(
              text: _stringifyPayloadValue(row.value),
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

/// Right-aligned user bubble for a conversation turn.
///
/// Authorship is carried by alignment and surface colour alone — no person icon
/// and no `User message` header. A queued prompt is dimmed and tagged.
class _ConversationUserBubble extends StatelessWidget {
  const _ConversationUserBubble({required this.message});

  final AgentMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final queued = message.userMessageQueued;
    final text =
        _firstPayloadValue(
          message: message,
          preferredKeys: const ['content', 'text', 'message'],
        ) ??
        '';
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth * 0.82
            : double.infinity;
        return Align(
          alignment: Alignment.centerRight,
          child: Opacity(
            opacity: queued ? 0.62 : 1,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: Container(
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer.withValues(
                    alpha: 0.75,
                  ),
                  borderRadius: BorderRadius.circular(context.tokens.radiusLg),
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (queued) ...[
                      _ToolMetadataChip(
                        key: const Key('queued-user-message-badge'),
                        label: l10n.sessionTurnQueuedBadge,
                      ),
                      const SizedBox(height: 4),
                    ],
                    _MarkdownBody(source: text),
                    if (message.bodyTruncated)
                      const _BodyTruncatedNote(
                        key: Key('user-message-body-truncated'),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Continuous left-aligned model-output surface for a conversation turn.
class _ConversationModelOutput extends StatelessWidget {
  const _ConversationModelOutput({required this.message});

  final AgentMessage message;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final text =
        message.modelOutputText ??
        message.modelOutputDelta ??
        l10n.sessionTurnModelOutputFallback;
    return Align(
      alignment: Alignment.centerLeft,
      child: message.bodyTruncated
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _MarkdownBody(source: text),
                const _BodyTruncatedNote(
                  key: Key('model-output-body-truncated'),
                ),
              ],
            )
          : _MarkdownBody(source: text),
    );
  }
}

/// Quiet expandable thinking row for a conversation turn.
class _ConversationThinkingRow extends StatefulWidget {
  const _ConversationThinkingRow({required this.message});

  final AgentMessage message;

  @override
  State<_ConversationThinkingRow> createState() =>
      _ConversationThinkingRowState();
}

class _ConversationThinkingRowState extends State<_ConversationThinkingRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final content =
        _firstPayloadValue(
          message: widget.message,
          preferredKeys: const ['content', 'thought', 'text', 'status'],
        ) ??
        '';
    return Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: const Key('conversation-thinking-toggle'),
            borderRadius: BorderRadius.circular(context.tokens.radiusMd),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.psychology_outlined,
                    size: 16,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    l10n.sessionTurnThinkingLabel,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded && content.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2, bottom: 4),
              child: DefaultTextStyle.merge(
                style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _MarkdownBody(source: content),
                    if (widget.message.bodyTruncated)
                      const _BodyTruncatedNote(
                        key: Key('thinking-body-truncated'),
                      ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Localized note under a body the BROKER shortened to fit a bounded history
/// replay.
///
/// The broker deliberately sends no prose inside message content — English text
/// in a transcript body is the localization defect H1c removed from the gap
/// notice — so it sends a `bodyTruncated` flag and this renders the sentence in
/// the reader's own language.
class _BodyTruncatedNote extends StatelessWidget {
  const _BodyTruncatedNote({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(
        AppLocalizations.of(context).sessionTurnBodyTruncated,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _ReadOnlyHint extends StatelessWidget {
  const _ReadOnlyHint({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.lock_outline,
              size: 14,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
