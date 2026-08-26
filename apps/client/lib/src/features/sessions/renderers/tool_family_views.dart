part of 'message_renderer_registry.dart';

/// Expanded body for the command family.
///
/// Constructed only when the enclosing row is expanded, so a collapsed
/// transcript never pays for a stream body. The presentation itself is derived
/// once per build from bounded slices — the megabyte behind a long-running
/// command is never walked.
class _ToolCommandSection extends StatelessWidget {
  const _ToolCommandSection({required this.presentation});

  final ToolCommandPresentation presentation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      key: const Key('tool-command-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectionArea(
          child: Text(
            presentation.command,
            key: const Key('tool-command-line'),
            style: theme.textTheme.bodySmall?.copyWith(
              fontFamily: 'monospace',
              color: tokens.textPrimary,
            ),
          ),
        ),
        if (presentation.cwd case final String cwd) ...[
          const SizedBox(height: 4),
          SelectionArea(
            child: Text(
              l10n.toolCommandWorkingDirectory(cwd),
              key: const Key('tool-command-cwd'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ),
        ],
        if (presentation.hasSeparateStreams) ...[
          if (!presentation.stdout.isEmpty)
            _ToolOutputBlock(
              keyPrefix: 'tool-command-stdout',
              label: l10n.toolCommandStdout,
              body: presentation.stdout,
              sourceTruncated: presentation.stdoutTruncatedBySource,
            ),
          if (!presentation.stderr.isEmpty)
            _ToolOutputBlock(
              keyPrefix: 'tool-command-stderr',
              label: l10n.toolCommandStderr,
              body: presentation.stderr,
              sourceTruncated: presentation.stderrTruncatedBySource,
              emphasis: tokens.statusError,
            ),
        ] else if (!presentation.combined.isEmpty)
          _ToolOutputBlock(
            keyPrefix: 'tool-command-combined',
            label: l10n.toolCommandCombinedOutput,
            body: presentation.combined,
            sourceTruncated: false,
          ),
        if (!presentation.hasOutput) ...[
          const SizedBox(height: 8),
          Text(
            presentation.state == ToolCommandState.running
                ? l10n.toolCommandRunningNoOutput
                : l10n.toolCommandNoOutput,
            key: const Key('tool-command-empty'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
        ],
      ],
    );
  }
}

/// One labeled, copyable, bounded output stream.
class _ToolOutputBlock extends StatelessWidget {
  const _ToolOutputBlock({
    required this.keyPrefix,
    required this.label,
    required this.body,
    required this.sourceTruncated,
    this.emphasis,
  });

  /// Stable widget-key stem; the block, its Copy control, and its truncation
  /// note all derive from it so tests can address each part.
  final String keyPrefix;
  final String label;
  final BoundedToolText body;

  /// The adapter already dropped bytes before the client saw them — a distinct
  /// fact from the client's own render clip, and both must be stated.
  final bool sourceTruncated;
  final Color? emphasis;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        key: Key(keyPrefix),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: emphasis ?? tokens.textSecondary,
                  ),
                ),
              ),
              _ToolCopyButton(
                copyKey: Key('$keyPrefix-copy'),
                text: body.text,
                tooltip: l10n.toolCopyOutput,
              ),
            ],
          ),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: tokens.surface2,
              borderRadius: BorderRadius.circular(tokens.radiusSm),
            ),
            child: SelectionArea(
              child: Text(
                body.text,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  height: 1.35,
                ),
              ),
            ),
          ),
          if (body.truncated || sourceTruncated)
            _ToolTruncationNote(
              noteKey: Key('$keyPrefix-truncated'),
              text: sourceTruncated
                  ? l10n.toolOutputTruncatedBySource
                  : body.hiddenLines > 0
                  ? l10n.toolOutputTruncatedLines(body.hiddenLines)
                  : l10n.toolOutputTruncated,
            ),
        ],
      ),
    );
  }
}

/// Expanded body for the file-read family.
class _ToolFileReadSection extends StatelessWidget {
  const _ToolFileReadSection({required this.presentation});

  final ToolFileReadPresentation presentation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    if (presentation.unavailable case final ToolReadUnavailableReason reason) {
      return Text(
        switch (reason) {
          ToolReadUnavailableReason.missing => l10n.toolReadMissing,
          ToolReadUnavailableReason.unreadable => l10n.toolReadUnreadable,
          ToolReadUnavailableReason.binary => l10n.toolReadBinary,
          ToolReadUnavailableReason.empty => l10n.toolReadEmpty,
          ToolReadUnavailableReason.unknown => l10n.toolReadUnavailable,
        },
        key: const Key('tool-read-unavailable'),
        style: theme.textTheme.bodySmall?.copyWith(color: tokens.textSecondary),
      );
    }
    // Gutter width is measured from the widest rendered number, so a file read
    // at line 4 and one at line 120000 both align without a fixed guess.
    final widest = presentation.lines
        .map((line) => line.number)
        .whereType<int>()
        .fold<int>(0, (value, number) => number > value ? number : value);
    final gutterText = widest == 0 ? '' : '$widest';
    return Column(
      key: const Key('tool-read-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: SelectionArea(
                // The reference is carried as data beside the display string:
                // never re-parsed from what is on screen.
                child: presentation.reference == null
                    ? Text(
                        presentation.path,
                        key: const Key('tool-read-path'),
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontFamily: 'monospace',
                        ),
                      )
                    : _TranscriptFileLink(
                        linkKey: const Key('tool-read-path'),
                        reference: presentation.reference!,
                        text: presentation.path,
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontFamily: 'monospace',
                        ),
                      ),
              ),
            ),
            _ToolCopyButton(
              copyKey: const Key('tool-read-copy'),
              text: presentation.lines.map((line) => line.text).join('\n'),
              tooltip: l10n.toolCopyPreview,
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: tokens.surface2,
            borderRadius: BorderRadius.circular(tokens.radiusSm),
          ),
          child: SelectionArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final line in presentation.lines)
                  _ToolNumberedLine(
                    line: line,
                    gutterSample: gutterText,
                  ),
              ],
            ),
          ),
        ),
        if (presentation.truncated)
          _ToolTruncationNote(
            noteKey: const Key('tool-read-truncated'),
            text: presentation.totalLines != null
                ? l10n.toolReadTruncatedOf(
                    presentation.lines.length,
                    presentation.totalLines!,
                  )
                : l10n.toolReadTruncated,
          ),
      ],
    );
  }
}

/// One monospace line with an optional right-aligned source line number.
class _ToolNumberedLine extends StatelessWidget {
  const _ToolNumberedLine({required this.line, required this.gutterSample});

  final ToolPreviewLine line;

  /// Widest number in this block; sizes the gutter so digits stay aligned.
  final String gutterSample;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final mono = theme.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
      height: 1.35,
    );
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (gutterSample.isNotEmpty) ...[
          SizedBox(
            width: gutterSample.length * 8.0,
            child: Text(
              line.number == null ? '' : '${line.number}',
              textAlign: TextAlign.right,
              style: mono?.copyWith(color: tokens.textTertiary),
            ),
          ),
          const SizedBox(width: 8),
        ],
        Expanded(
          child: line.truncated
              // The clip is marked ON the line it happened to, so a shortened
              // match is never read as the whole line the file holds.
              ? Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(text: line.text),
                      TextSpan(
                        text: ' …',
                        style: mono?.copyWith(color: tokens.textTertiary),
                      ),
                    ],
                  ),
                  key: const Key('tool-line-truncated'),
                  style: mono,
                )
              : Text(line.text, style: mono),
        ),
      ],
    );
  }
}

/// Expanded body for the search family.
class _ToolSearchSection extends StatelessWidget {
  const _ToolSearchSection({required this.presentation});

  final ToolSearchPresentation presentation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    if (presentation.isEmptyResult) {
      return Text(
        presentation.query == null
            ? l10n.toolSearchNoMatches
            : l10n.toolSearchNoMatchesFor(presentation.query!),
        key: const Key('tool-search-empty'),
        style: theme.textTheme.bodySmall?.copyWith(color: tokens.textSecondary),
      );
    }
    return Column(
      key: const Key('tool-search-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (presentation.scope case final String scope)
          SelectionArea(
            child: Text(
              l10n.toolSearchScope(scope),
              key: const Key('tool-search-scope'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ),
        for (final group in presentation.groups)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectionArea(
                  // The header is one localized message (`{path} ({count})`,
                  // full-width parentheses in zh), so the link spans the whole
                  // run rather than splitting a composed string. The reference,
                  // the tooltip, and the screen-reader label all name the path
                  // alone.
                  child: _searchGroupHeader(
                    l10n: l10n,
                    group: group,
                    style: theme.textTheme.labelMedium?.copyWith(
                      fontFamily: 'monospace',
                      color: tokens.textPrimary,
                    ),
                  ),
                ),
                for (final match in group.matches)
                  Padding(
                    padding: const EdgeInsets.only(left: 8, top: 2),
                    child: SelectionArea(
                      child: _ToolNumberedLine(
                        line: match,
                        gutterSample: match.number == null
                            ? ''
                            : '${match.number}',
                      ),
                    ),
                  ),
                if (group.matches.any((match) => match.truncated))
                  _ToolTruncationNote(
                    noteKey: const Key('tool-search-match-truncated'),
                    text: l10n.toolSearchMatchTruncated,
                  ),
                if (group.truncated)
                  _ToolTruncationNote(
                    noteKey: const Key('tool-search-group-truncated'),
                    text: l10n.toolSearchGroupTruncated,
                  ),
              ],
            ),
          ),
        if (presentation.truncated)
          _ToolTruncationNote(
            noteKey: const Key('tool-search-truncated'),
            text: l10n.toolSearchTruncated,
          ),
      ],
    );
  }
}

/// One search group's header, linked to the matched file when it can resolve.
Widget _searchGroupHeader({
  required AppLocalizations l10n,
  required ToolSearchGroupPresentation group,
  required TextStyle? style,
}) {
  final label = group.matchCount == null
      ? group.path
      : l10n.toolSearchGroupHeader(group.path, group.matchCount!);
  final reference = group.reference;
  if (reference == null) {
    return Text(label, style: style);
  }
  return _TranscriptFileLink(
    reference: reference,
    text: label,
    style: style,
  );
}

/// Expanded body for the web family.
///
/// URLs render as selectable text only — deliberately not tappable links. Open
/// behavior is out of scope here and is not implied by showing the address.
class _ToolWebSection extends StatelessWidget {
  const _ToolWebSection({required this.presentation});

  final ToolWebPresentation presentation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      key: const Key('tool-web-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (presentation.url case final String url)
          SelectionArea(
            child: Text(
              url,
              key: const Key('tool-web-url'),
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
              ),
            ),
          ),
        if (presentation.results.isEmpty && presentation.url == null)
          Text(
            l10n.toolWebNoResults,
            key: const Key('tool-web-empty'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
        for (final result in presentation.results)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    result.title ?? result.domain,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: tokens.textPrimary,
                    ),
                  ),
                  Text(
                    result.domain,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textSecondary,
                    ),
                  ),
                  if (result.snippet case final String snippet)
                    Text(
                      snippet,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  // A snippet clipped from 4 KiB to the wire bound must say so;
                  // it otherwise reads as everything the page had to offer.
                  if (result.truncated)
                    _ToolTruncationNote(
                      noteKey: const Key('tool-web-result-truncated'),
                      text: l10n.toolWebResultTruncated,
                    ),
                ],
              ),
            ),
          ),
        if (presentation.truncated)
          _ToolTruncationNote(
            noteKey: const Key('tool-web-truncated'),
            text: l10n.toolWebTruncated,
          ),
      ],
    );
  }
}

/// Expanded body for anything without a dedicated family: MCP servers, plugin
/// tools, and future dynamic tools.
///
/// It states the shape it found and nothing more. There is no raw payload dump
/// and no attempt to infer meaning from field names beyond redaction.
class _ToolFallbackSection extends StatelessWidget {
  const _ToolFallbackSection({
    required this.input,
    required this.output,
  });

  final ToolFallbackPresentation? input;
  final ToolFallbackPresentation? output;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final sections = <Widget>[
      if (input != null && !input!.isEmpty)
        _ToolFallbackBlock(
          keyPrefix: 'tool-fallback-input',
          label: l10n.toolFallbackInput,
          presentation: input!,
        ),
      if (output != null && !output!.isEmpty)
        _ToolFallbackBlock(
          keyPrefix: 'tool-fallback-output',
          label: l10n.toolFallbackOutput,
          presentation: output!,
        ),
    ];
    if (sections.isEmpty) {
      return Text(
        l10n.noDetails,
        key: const Key('tool-fallback-empty'),
        style: theme.textTheme.bodySmall?.copyWith(color: tokens.textSecondary),
      );
    }
    return Column(
      key: const Key('tool-fallback-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: sections,
    );
  }
}

/// One labeled block of deterministically ordered fallback rows.
class _ToolFallbackBlock extends StatelessWidget {
  const _ToolFallbackBlock({
    required this.keyPrefix,
    required this.label,
    required this.presentation,
  });

  /// Stable widget-key stem shared by the block and its truncation note.
  final String keyPrefix;
  final String label;
  final ToolFallbackPresentation presentation;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        key: Key(keyPrefix),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
          SelectionArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final row in presentation.rows)
                  Padding(
                    padding: EdgeInsets.only(left: row.depth * 8.0, top: 2),
                    // A redacted row announces one explanatory label instead of
                    // reading the placeholder glyphs character by character.
                    child: Semantics(
                      container: row.redacted,
                      excludeSemantics: row.redacted,
                      label: row.redacted
                          ? l10n.toolFallbackRedactedSemantics(row.label)
                          : null,
                      child: Text.rich(
                        TextSpan(
                          children: [
                            if (row.label.isNotEmpty)
                              TextSpan(
                                text: '${row.label}: ',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: tokens.textSecondary,
                                ),
                              ),
                            TextSpan(
                              text: row.redacted
                                  ? l10n.toolFallbackRedacted
                                  : row.value,
                              style: theme.textTheme.bodySmall?.copyWith(
                                fontFamily: 'monospace',
                                color: row.redacted
                                    ? tokens.textTertiary
                                    : tokens.textPrimary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (presentation.truncated)
            _ToolTruncationNote(
              noteKey: Key('$keyPrefix-truncated'),
              text: l10n.toolFallbackTruncated,
            ),
        ],
      ),
    );
  }
}

/// An explicit, screen-reader-announced statement that content was withheld.
class _ToolTruncationNote extends StatelessWidget {
  const _ToolTruncationNote({required this.noteKey, required this.text});

  final Key noteKey;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Semantics(
        liveRegion: true,
        child: Text(
          text,
          key: noteKey,
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textSecondary,
            fontStyle: FontStyle.italic,
          ),
        ),
      ),
    );
  }
}

/// A 48×48 touch-target Copy control for one bounded body.
class _ToolCopyButton extends StatelessWidget {
  const _ToolCopyButton({
    required this.copyKey,
    required this.text,
    required this.tooltip,
  });

  final Key copyKey;
  final String text;
  final String tooltip;

  Future<void> _copy(BuildContext context) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final copied = AppLocalizations.of(context).toolCopied;
    await Clipboard.setData(ClipboardData(text: text));
    messenger?.showSnackBar(SnackBar(content: Text(copied)));
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: copyKey,
      onPressed: () => _copy(context),
      icon: const Icon(Icons.copy_all_outlined, size: 16),
      tooltip: tooltip,
      // Kit default is smaller than the 48dp touch minimum this surface needs.
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
      padding: EdgeInsets.zero,
      visualDensity: VisualDensity.standard,
    );
  }
}
