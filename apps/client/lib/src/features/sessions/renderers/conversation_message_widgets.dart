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

/// Collapsed row for agent-visible context the user never typed.
///
/// Quiet by default and expandable on demand: this material is background the
/// agent was handed, not something the reader has to act on, and at session
/// open there can be several of them in a row. Rendered literally they were
/// the loudest thing on screen — centred walls of prose quoting plugin ids and
/// raw `<system-reminder>` tags — while carrying nothing a reader needs at a
/// glance.
///
/// Collapsed, the row is a plain human word and nothing else. The origin is an
/// unedited provider identifier — `@deepseek-ai/dsh-system-prompt` — and putting
/// it in the always-visible header made the resting transcript read as internal
/// plumbing, which is the raw-identifier leakage this presentation exists to
/// keep out. It belongs to the reader who opened the block and asked where the
/// material came from, so it appears above the body once expanded.
///
/// The material itself is kept whole, and when the adapter had to clip it the
/// block says so in words instead of just stopping.
class _ContextInjectionRow extends StatefulWidget {
  const _ContextInjectionRow({required this.message});

  final AgentMessage message;

  @override
  State<_ContextInjectionRow> createState() => _ContextInjectionRowState();
}

class _ContextInjectionRowState extends State<_ContextInjectionRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final injected = widget.message.contextInjection;
    if (injected == null) return const SizedBox.shrink();
    final quiet = theme.colorScheme.onSurfaceVariant;
    return Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // One merged semantics node: the label comes from the Text, the tap
          // from the InkWell, and the disclosure state is declared explicitly
          // so a screen reader knows the row opens and whether it is open.
          MergeSemantics(
            child: Semantics(
              button: true,
              expanded: _expanded,
              child: InkWell(
                key: const Key('transcript-context-toggle'),
                borderRadius: BorderRadius.circular(context.tokens.radiusMd),
                onTap: () => setState(() => _expanded = !_expanded),
                child: ConstrainedBox(
                  // 40 is the floor for a real touch target, not the 36 some
                  // quiet transcript affordances use: this one is tapped to
                  // read the material, so it has to be reliably hittable on a
                  // phone. Still under the 48 of primary controls, so it does
                  // not push the messages around it apart.
                  constraints: const BoxConstraints(minHeight: 40),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.article_outlined, size: 16, color: quiet),
                        const SizedBox(width: 8),
                        Text(
                          l10n.transcriptContextLabel,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: quiet,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Icon(
                          _expanded ? Icons.expand_less : Icons.expand_more,
                          size: 18,
                          color: quiet,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 4, bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    injected.source,
                    key: const Key('transcript-context-source'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(color: quiet),
                  ),
                  const SizedBox(height: 4),
                  DefaultTextStyle.merge(
                    style: TextStyle(color: quiet),
                    child: _MarkdownBody(source: injected.body),
                  ),
                  if (injected.truncated) ...[
                    const SizedBox(height: 4),
                    Text(
                      l10n.transcriptContextTruncated,
                      key: const Key('transcript-context-truncated'),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: quiet,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}
