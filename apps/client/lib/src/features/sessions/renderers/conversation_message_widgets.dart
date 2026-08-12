part of 'message_renderer_registry.dart';

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

/// Localized note under a body the broker shortened to fit bounded history.
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
    final tokens = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(tokens.radiusSm),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.lock_outline,
              size: 14,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 8),
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
