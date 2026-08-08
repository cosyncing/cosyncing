part of 'message_renderer_registry.dart';

class _LookupToolGroup extends StatelessWidget {
  const _LookupToolGroup({
    required this.tools,
    required this.toolsExpanded,
    required this.expansionRevision,
  });

  final List<ToolTranscriptDisplayEntry> tools;
  final bool toolsExpanded;
  final int expansionRevision;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final previews = tools
        .take(2)
        .map((entry) => _toolSummaryForEntry(l10n, entry))
        .where((value) => value.isNotEmpty)
        .join(' · ');
    // A flat expandable row, not a Card or shaded box, matching the single
    // tool row's low-chrome treatment.
    return Theme(
      key: ValueKey('lookup-group-${tools.first.callId ?? tools.length}'),
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: ValueKey('lookup-group-details-$expansionRevision'),
        shape: const Border(),
        collapsedShape: const Border(),
        tilePadding: const EdgeInsets.symmetric(horizontal: 4),
        initiallyExpanded: toolsExpanded,
        leading: Icon(
          Icons.search,
          size: 18,
          color: theme.colorScheme.onSurfaceVariant,
        ),
        title: Text(l10n.lookupsCount(tools.length)),
        subtitle: previews.isEmpty ? null : Text(previews),
        childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
        children: [
          for (final tool in tools)
            TranscriptMessageMetadataScope(
              timestamp: tool.primaryMessage.timestamp,
              child: buildToolTranscriptRenderer(
                context,
                tool,
                toolsExpanded: toolsExpanded,
                expansionRevision: expansionRevision,
              ),
            ),
        ],
      ),
    );
  }
}

class _ToolMessageCard extends StatefulWidget {
  const _ToolMessageCard({
    required this.call,
    required this.result,
    required this.initiallyExpanded,
    super.key,
  }) : assert(
         call != null || result != null,
         'a tool card needs a call, a result, or both',
       );

  final AgentMessage? call;
  final AgentMessage? result;
  final bool initiallyExpanded;

  @override
  State<_ToolMessageCard> createState() => _ToolMessageCardState();
}

class _ToolMessageCardState extends State<_ToolMessageCard> {
  late bool _expanded = widget.initiallyExpanded;

  @override
  void didUpdateWidget(_ToolMessageCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initiallyExpanded != widget.initiallyExpanded) {
      _expanded = widget.initiallyExpanded;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final message = widget.result ?? widget.call!;
    final summary = _toolSummary(l10n, widget.call, widget.result);
    final exitCode = _intValue(widget.result?.raw['exitCode']);
    final isError =
        widget.result?.raw['isError'] == true ||
        (exitCode != null && exitCode != 0);
    final rawDiff = widget.result?.raw['diff'];
    final diffText = rawDiff is String && rawDiff.trim().isNotEmpty
        ? rawDiff
        : null;
    // Optional multi-file change set and oversized-diff fetch reference. Either
    // means there is diff content to render even when inline `diff` is absent.
    final fileChanges = _FileChangeView.fromRaw(
      widget.result?.raw['fileChanges'],
    );
    final diffRef = _DiffBodyRefView.fromRaw(widget.result?.raw['diffRef']);
    final hasDiff = diffText != null || fileChanges != null || diffRef != null;
    // One provider-independent family decision per row. Resolving is O(1) —
    // it reads a decoded envelope and a display class, never a payload body —
    // so a collapsed card stays constant-cost.
    final family = resolveToolPresentationFamily(
      call: widget.call,
      result: widget.result,
    );
    // The expanded body is built ONLY when expanded, so a collapsed transcript
    // never derives a stream, preview, match set, or fallback walk.
    final familyBody = _expanded
        ? _buildToolFamilyBody(family, widget.call, widget.result)
        : null;
    // Generic key/value details remain the last resort, and only for rows the
    // registry did not claim.
    final details = _expanded && familyBody == null
        ? _toolDetails(widget.call, widget.result, includeDiff: false)
        : const <_ToolDetail>[];
    final diffPath = hasDiff
        ? _stringifyPayloadValue(widget.result?.raw['path'])
        : '';
    final callId = message.toolCallId;
    final detailsKey = callId != null
        ? ValueKey('tool-$callId-details')
        : widget.call != null
        ? const ValueKey('tool-call-details')
        : const ValueKey('tool-result-details');
    final stateLabel = _toolStateLabel(
      l10n,
      family,
      widget.call,
      widget.result,
    );
    final duration = _formatToolDuration(widget.result?.toolDurationMs);
    final additions = _intValue(widget.result?.raw['additions']);
    final deletions = _intValue(widget.result?.raw['deletions']);
    final truncated = widget.result?.raw['truncated'] == true;
    final timestamp = TranscriptMessageMetadataScope.timestampOf(context);

    // A tool call is a flat, low-chrome row inside the turn — no card, no
    // shaded box, no `Tool call/result details` title. The human summary leads,
    // with compact plain metadata on the same line and an expansion chevron.
    return Column(
      key: ValueKey(
        'tool-card-${callId ?? message.id ?? identityHashCode(message)}',
      ),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          key: detailsKey,
          onTap: () => setState(() => _expanded = !_expanded),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  isError ? Icons.error_outline : Icons.handyman_outlined,
                  size: 18,
                  color: isError
                      ? theme.colorScheme.error
                      : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 8),
                // Summary and compact metadata share the first line
                // (`Edited foo.dart  +24 −7  1.2s`), wrapping only when the
                // row is too narrow to hold them.
                Expanded(
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        summary,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: isError ? theme.colorScheme.error : null,
                        ),
                      ),
                      if (stateLabel != null)
                        _ToolMetadataChip(
                          key: const Key('tool-command-state-chip'),
                          label: stateLabel,
                        ),
                      if (duration != null)
                        _ToolMetadataChip(
                          key: const Key('tool-duration-chip'),
                          label: duration,
                        ),
                      if (exitCode != null)
                        _ToolMetadataChip(
                          label: l10n.exitCodeMetadata(exitCode),
                        ),
                      if (additions != null || deletions != null)
                        _ToolMetadataChip(
                          label: '+${additions ?? 0} −${deletions ?? 0}',
                        ),
                      if (truncated) _ToolMetadataChip(label: l10n.truncated),
                    ],
                  ),
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
                Icon(
                  _expanded ? Icons.expand_less : Icons.expand_more,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        if (_expanded)
          // Expanded details indent under the icon; no surrounding box.
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 0, 4, 8),
            child: !hasDiff && familyBody == null && details.isEmpty
                ? Text(l10n.noDetails, style: theme.textTheme.bodySmall)
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // T1's diff renderer keeps ownership of edit results; the
                      // family body never re-renders a diff.
                      if (hasDiff)
                        _ToolDiffSection(
                          diff: diffText,
                          path: diffPath.isEmpty ? null : diffPath,
                          fileChanges: fileChanges,
                          diffRef: diffRef,
                        ),
                      if (familyBody != null) ...[
                        if (hasDiff) const SizedBox(height: 8),
                        familyBody,
                      ],
                      for (var index = 0; index < details.length; index++) ...[
                        if (index > 0 || hasDiff) const SizedBox(height: 8),
                        _BoundedToolText(detail: details[index]),
                      ],
                    ],
                  ),
          ),
      ],
    );
  }
}

class _ToolMetadataChip extends StatelessWidget {
  const _ToolMetadataChip({required this.label, super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Plain inline metadata, not a bordered pill: the row stays low-chrome.
    return Text(
      label,
      style: theme.textTheme.labelSmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

class _BoundedToolText extends StatefulWidget {
  const _BoundedToolText({required this.detail});

  final _ToolDetail detail;

  @override
  State<_BoundedToolText> createState() => _BoundedToolTextState();
}

class _BoundedToolTextState extends State<_BoundedToolText> {
  bool _showAll = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final preview = buildToolTextPreview(
      widget.detail.text,
      keepTail: widget.detail.keepTail,
    );
    final visibleText = _showAll ? widget.detail.text : preview.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${widget.detail.label}: $visibleText',
          key: ValueKey('tool-detail-${widget.detail.label}'),
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            fontFamily: widget.detail.monospace ? 'monospace' : null,
          ),
        ),
        if (preview.isTruncated)
          TextButton(
            key: ValueKey('tool-show-all-${widget.detail.label}'),
            onPressed: () => setState(() => _showAll = !_showAll),
            child: Text(_showAll ? l10n.showPreview : l10n.showAll),
          ),
      ],
    );
  }
}

final class _ToolDetail {
  const _ToolDetail({
    required this.label,
    required this.text,
    required this.keepTail,
    this.monospace = false,
  });

  final String label;
  final String text;
  final bool keepTail;
  final bool monospace;
}

List<_ToolDetail> _toolDetails(
  AgentMessage? call,
  AgentMessage? result, {
  bool includeDiff = true,
}) {
  final details = <_ToolDetail>[];
  if (call != null) {
    for (final key in const ['args', 'arguments', 'input']) {
      final value = call.raw[key];
      if (value != null) {
        details.add(
          _ToolDetail(
            label: key,
            text: _stringifyPayloadValue(value),
            keepTail: false,
            monospace: true,
          ),
        );
        break;
      }
    }
  }
  if (result != null) {
    final diff = result.raw['diff'];
    if (includeDiff && diff != null) {
      details.add(
        _ToolDetail(
          label: 'diff',
          text: _stringifyPayloadValue(diff),
          keepTail: false,
          monospace: true,
        ),
      );
    }
    for (final key in const ['result', 'output', 'error']) {
      final value = result.raw[key];
      if (value != null && value != diff) {
        details.add(
          _ToolDetail(
            label: key,
            text: _stringifyPayloadValue(value),
            keepTail: true,
            monospace: true,
          ),
        );
        break;
      }
    }
  }
  return details;
}

/// Builds the dedicated expanded body for [family], or null when no dedicated
/// renderer applies and the generic detail rows should be used instead.
///
/// Called only from an expanded row: every builder below derives bounded text,
/// so nothing here walks an unbounded payload and nothing is retained after the
/// row collapses.
Widget? _buildToolFamilyBody(
  ToolPresentationFamily family,
  AgentMessage? call,
  AgentMessage? result,
) {
  switch (family) {
    case ToolPresentationFamily.command:
      final presentation = buildToolCommandPresentation(
        call: call,
        result: result,
        expanded: true,
      );
      return presentation == null
          ? null
          : _ToolCommandSection(presentation: presentation);
    case ToolPresentationFamily.fileRead:
      final presentation = buildToolFileReadPresentation(
        call: call,
        result: result,
      );
      return presentation == null
          ? null
          : _ToolFileReadSection(presentation: presentation);
    case ToolPresentationFamily.search:
      final presentation = buildToolSearchPresentation(
        call: call,
        result: result,
      );
      return presentation == null
          ? null
          : _ToolSearchSection(presentation: presentation);
    case ToolPresentationFamily.web:
      final presentation = buildToolWebPresentation(call: call, result: result);
      return presentation == null
          ? null
          : _ToolWebSection(presentation: presentation);
    case ToolPresentationFamily.edit:
      // Owned by the T1 diff renderer, which the card already placed.
      return null;
    case ToolPresentationFamily.generic:
      final input = _toolFallbackPayload(call, _toolInputKeys);
      final output = _toolFallbackPayload(result, _toolOutputKeys);
      if (input == null && output == null) return null;
      return _ToolFallbackSection(input: input, output: output);
  }
}

/// Canonical field names that carry a tool's structured input.
const List<String> _toolInputKeys = ['args', 'arguments', 'input'];

/// Canonical field names that carry a tool's structured output.
const List<String> _toolOutputKeys = ['result', 'output', 'error'];

/// Builds the bounded fallback for the first present canonical payload field.
///
/// The lookup is by canonical contract field only; no provider-specific key is
/// consulted, and an absent payload yields null rather than an empty block.
ToolFallbackPresentation? _toolFallbackPayload(
  AgentMessage? message,
  List<String> keys,
) {
  if (message == null) return null;
  for (final key in keys) {
    final value = message.raw[key];
    if (value == null) continue;
    final presentation = buildToolFallbackPresentation(value);
    return presentation.isEmpty ? null : presentation;
  }
  return null;
}

/// The canonical status chip label for a command row, or null for other rows.
///
/// Exit code and lifecycle are distinct facts: a command can be `interrupted`
/// with no code, and `unknown` means the native source published neither.
///
/// Resolves the state WITHOUT deriving a body, so a collapsed row costs the
/// same whether the command emitted one line or a gigabyte.
String? _toolStateLabel(
  AppLocalizations l10n,
  ToolPresentationFamily family,
  AgentMessage? call,
  AgentMessage? result,
) {
  if (family != ToolPresentationFamily.command) return null;
  return switch (resolveToolCommandState(call: call, result: result)) {
    ToolCommandState.running => l10n.toolCommandStateRunning,
    ToolCommandState.completed => l10n.toolCommandStateCompleted,
    ToolCommandState.failed => l10n.toolCommandStateFailed,
    ToolCommandState.interrupted => l10n.toolCommandStateInterrupted,
    ToolCommandState.unknown => l10n.toolCommandStateUnknown,
    null => null,
  };
}

String _toolSummaryForEntry(
  AppLocalizations l10n,
  ToolTranscriptDisplayEntry entry,
) => _toolSummary(l10n, entry.call, entry.result);

/// The collapsed row's line, composed from the canonical semantic identity.
///
/// Returns null when no semantic was published (a revision-8 broker), leaving
/// the generic canonical-field summary in place.
String? _toolSemanticSummary(
  AppLocalizations l10n,
  AgentMessage? call,
  AgentMessage? result,
) {
  final summary = resolveToolSummary(call: call, result: result);
  if (summary == null) return null;
  final counts = _toolSummaryCounts(l10n, summary);
  final parts = [
    summary.primary,
    switch (summary.family) {
      ToolPresentationFamily.command =>
        summary.secondary == null
            ? null
            : l10n.toolCommandWorkingDirectory(summary.secondary!),
      ToolPresentationFamily.search =>
        summary.secondary == null
            ? null
            : l10n.toolSearchScope(summary.secondary!),
      _ => summary.secondary,
    },
    counts,
  ].whereType<String>().where((part) => part.isNotEmpty).toList();
  if (parts.isEmpty) return null;
  return parts.reduce((left, right) => l10n.toolSummarySeparator(left, right));
}

/// The count clause for a collapsed row, or null when none was published.
String? _toolSummaryCounts(
  AppLocalizations l10n,
  ToolSummaryPresentation summary,
) {
  if (summary.resultCount != null) {
    return l10n.toolSummaryResults(summary.resultCount!);
  }
  final matches = summary.matchCount;
  final files = summary.fileCount;
  if (matches != null && files != null) {
    return l10n.toolSummaryMatchesInFiles(matches, files);
  }
  if (matches != null) return l10n.toolSummaryMatches(matches);
  if (files != null) return l10n.toolSummaryFiles(files);
  return null;
}

String _toolSummary(
  AppLocalizations l10n,
  AgentMessage? call,
  AgentMessage? result,
) {
  // The canonical semantic answers "what did this tool act on?" directly, so
  // a collapsed row shows the command, the path, the query and its match
  // count, or the domain — without the reader expanding the card to find out.
  final semantic = _toolSemanticSummary(l10n, call, result);
  if (semantic != null) return semantic;
  for (final message in [result, call].whereType<AgentMessage>()) {
    final summary = _firstPayloadValue(
      message: message,
      preferredKeys: const [
        'title',
        'path',
        'command',
        'toolName',
        'name',
        'tool',
        'result',
        'output',
        'status',
      ],
    );
    if (summary != null && summary.isNotEmpty) {
      final humanized = _humanizeToolLabel(summary);
      return humanized.length <= 160
          ? humanized
          : '${humanized.substring(0, 160)}…';
    }
  }
  return result != null ? l10n.toolReturnedOutput : l10n.toolCallRequested;
}

/// Turns a machine tool identifier into a compact human label.
///
/// Purely lexical and provider-independent: it recognizes the `namespace__tool`
/// and `snake_case` shapes that machine identifiers share, never a particular
/// vendor. Anything that already reads as a sentence (an adapter-authored
/// title, a path, a command line) is returned untouched.
String _humanizeToolLabel(String value) {
  if (value.contains(' ') || value.contains('/')) return value;
  final segments = value.split('__').where((part) => part.isNotEmpty).toList();
  if (segments.length < 2 && !value.contains('_')) return value;
  final tail = segments.length > 2
      ? segments.sublist(segments.length - 2)
      : segments;
  return tail.map((part) => part.replaceAll('_', ' ')).join(' · ');
}

String? _formatToolDuration(double? milliseconds) {
  if (milliseconds == null || !milliseconds.isFinite || milliseconds < 0) {
    return null;
  }
  if (milliseconds < 1000) return '${milliseconds.round()}ms';
  final seconds = milliseconds / 1000;
  if (seconds < 10) {
    final value = seconds.toStringAsFixed(1);
    final compact = value.endsWith('.0')
        ? value.substring(0, value.length - 2)
        : value;
    return '${compact}s';
  }
  final roundedSeconds = seconds.round();
  if (roundedSeconds < 60) return '${roundedSeconds}s';
  return '${roundedSeconds ~/ 60}m ${roundedSeconds % 60}s';
}
