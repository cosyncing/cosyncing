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
    this.detailContent,
    this.isUserMessage = false,
    this.isQueued = false,
  });

  final IconData icon;
  final String title;
  final String summary;
  final List<MapEntry<String, Object?>> payloadRows;
  final Widget? detailContent;
  final bool isUserMessage;
  final bool isQueued;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final accentColor = isUserMessage
        ? theme.colorScheme.primary
        : theme.colorScheme.primaryContainer;
    final backgroundColor = isUserMessage
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

/// Compact shared shell for error, permission, and question messages.
///
/// These families are structurally boxed content rather than conversational
/// bubbles. Keeping this adapter beside [_TranscriptBubble] preserves the same
/// readable width and alignment while [TranscriptBox] owns the common chrome.
class _TranscriptBoxMessage extends StatelessWidget {
  const _TranscriptBoxMessage({
    required this.icon,
    required this.title,
    required this.payloadRows,
    this.summary,
    this.readOnlyHint,
    this.detailContent,
    this.noDetailText,
    this.isError = false,
    this.payloadAsChips = false,
  });

  final IconData icon;
  final String title;
  final String? summary;
  final List<MapEntry<String, Object?>> payloadRows;
  final String? readOnlyHint;
  final Widget? detailContent;
  final String? noDetailText;
  final bool isError;
  final bool payloadAsChips;

  @override
  Widget build(BuildContext context) {
    final timestamp = TranscriptMessageMetadataScope.timestampOf(context);
    final summary = this.summary?.trim();
    final hasSummary = summary != null && summary.isNotEmpty;
    final visibleRows = visibleTranscriptPayloadRows(
      summary: summary ?? '',
      rows: payloadRows,
    );
    final hasBody =
        hasSummary ||
        visibleRows.isNotEmpty ||
        readOnlyHint != null ||
        detailContent != null ||
        noDetailText != null;

    return Align(
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: _transcriptBubbleWidthFactor,
        child: TranscriptBox(
          tone: isError ? TranscriptBoxTone.error : TranscriptBoxTone.neutral,
          icon: icon,
          title: title,
          trailing: timestamp == null
              ? null
              : Text(
                  _formatTranscriptTime(timestamp),
                  key: const Key('transcript-message-time'),
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: context.tokens.textSecondary,
                  ),
                ),
          body: hasBody
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (hasSummary) _MarkdownBody(source: summary),
                    if (readOnlyHint != null) ...[
                      if (hasSummary) const SizedBox(height: 4),
                      _ReadOnlyHint(
                        label: AppLocalizations.of(
                          context,
                        ).readOnlySuffix(readOnlyHint!),
                      ),
                    ],
                    if (visibleRows.isNotEmpty) ...[
                      if (hasSummary || readOnlyHint != null) ...[
                        const SizedBox(height: 8),
                        const Divider(height: 1),
                        const SizedBox(height: 8),
                      ],
                      if (payloadAsChips)
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            for (final row in visibleRows)
                              MetadataChip(
                                label:
                                    '${row.key}: '
                                    '${_stringifyPayloadValue(row.value)}',
                                maxWidth: 280,
                              ),
                          ],
                        )
                      else
                        for (final row in visibleRows)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: _TranscriptDetailRow(row: row),
                          ),
                    ],
                    if (detailContent != null) ...[
                      if (hasSummary ||
                          readOnlyHint != null ||
                          visibleRows.isNotEmpty)
                        const SizedBox(height: 8),
                      detailContent!,
                    ],
                    if (!hasSummary &&
                        visibleRows.isEmpty &&
                        readOnlyHint == null &&
                        detailContent == null &&
                        noDetailText != null)
                      Text(noDetailText!),
                  ],
                )
              : null,
        ),
      ),
    );
  }
}

/// Permission details stay compact by default but remain fully inspectable.
///
/// Commands and reasons can be long and may contain newlines. A metadata chip
/// intentionally ellipsizes that content, so permission cards use this explicit
/// disclosure instead and keep the full text selectable.
class _PermissionRequestDetail extends StatefulWidget {
  const _PermissionRequestDetail({required this.detail, this.action});

  final String? detail;
  final Widget? action;

  @override
  State<_PermissionRequestDetail> createState() =>
      _PermissionRequestDetailState();
}

class _PermissionRequestDetailState extends State<_PermissionRequestDetail> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final detail = widget.detail?.trim();
    final hasDetail = detail != null && detail.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (hasDetail) ...[
          TextButton.icon(
            key: const Key('session-permission-detail-toggle'),
            onPressed: () => setState(() => _expanded = !_expanded),
            icon: Icon(
              _expanded ? Icons.expand_less : Icons.expand_more,
              size: 18,
            ),
            label: Text(
              _expanded
                  ? l10n.sessionRequestHideDetails
                  : l10n.sessionRequestShowDetails,
            ),
          ),
          if (_expanded) ...[
            const SizedBox(height: 4),
            SelectionArea(
              child: Text(
                detail,
                key: const Key('session-permission-full-detail'),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                ),
              ),
            ),
          ],
        ],
        if (hasDetail && widget.action != null) const SizedBox(height: 8),
        if (widget.action != null) widget.action!,
      ],
    );
  }
}

/// One-line file-artifact presentation with the existing download widget.
///
/// An artifact the user SENT (one carrying a `userMessageKey`) reads user-side
/// here too: right-aligned on the user surface colour. This is the fallback for
/// a linked artifact whose owning row is outside the retained window, and for
/// the non-turn display modes that render artifacts as standalone rows.
class _TranscriptArtifactRow extends StatelessWidget {
  const _TranscriptArtifactRow({required this.message, this.action});

  final AgentMessage message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final descriptor = SessionArtifactDescriptor.fromMessage(message);
    final descriptorName = descriptor?.name?.trim();
    final descriptorPath = descriptor?.path?.trim();
    final name = (descriptorName?.isNotEmpty ?? false)
        ? descriptorName!
        : (descriptorPath?.isNotEmpty ?? false)
        ? descriptorPath!
        : l10n.sessionArtifactUntitled;
    final size = descriptor?.size;
    final userSent = message.isUserAttachment;
    // Only a file the AGENT handed over is badged. A file it merely wrote and
    // the broker surfaced carries the same actions but makes no such claim,
    // and a user's own attachment is already right-aligned as theirs.
    final sentToYou = !userSent && (descriptor?.proactive ?? false);
    final alignment = userSent ? Alignment.centerRight : Alignment.centerLeft;

    return Align(
      alignment: alignment,
      child: FractionallySizedBox(
        alignment: alignment,
        widthFactor: _transcriptBubbleWidthFactor,
        child: Card(
          color: userSent
              ? theme.colorScheme.primaryContainer.withValues(alpha: 0.75)
              : theme.colorScheme.surfaceContainerHighest,
          margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(tokens.radiusLg),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final compactAtLargeText =
                    MediaQuery.textScalerOf(context).scale(1) >= 1.5 &&
                    constraints.maxWidth < 400;
                return Row(
                  children: [
                    Icon(
                      Icons.insert_drive_file_outlined,
                      size: 16,
                      color: tokens.textSecondary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      // Name and badge share one flex child so the badge hugs
                      // the name's right edge instead of drifting across to
                      // the size, and a long name still ellipsizes rather than
                      // pushing the badge out of the row.
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: tokens.textPrimary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          if (sentToYou) ...[
                            const SizedBox(width: 8),
                            MetadataChip(
                              label: l10n.sessionArtifactSentToYou,
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (size != null && !compactAtLargeText) ...[
                      const SizedBox(width: 8),
                      Text(
                        l10n.bytesCount(size),
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: tokens.textTertiary,
                        ),
                      ),
                    ],
                    if (action != null) ...[
                      const SizedBox(width: 8),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth:
                              constraints.maxWidth *
                              (compactAtLargeText ? 0.62 : 0.45),
                        ),
                        child: action,
                      ),
                    ],
                  ],
                );
              },
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
