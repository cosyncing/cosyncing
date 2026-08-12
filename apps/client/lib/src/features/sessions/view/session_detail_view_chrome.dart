part of 'session_detail_page.dart';

/// Height of the Variant C session strip.
///
/// One 32dp line carries the title slot, the drive pill and the view menu at
/// every breakpoint, replacing the old header + tab row. Everything else on
/// the page is transcript. The spec's original 36dp
/// (`output/UI-design/session-topbar/spec.md` §5b) was overridden by the
/// product owner: measured at 36dp the strip was a 32dp control row plus 4dp
/// of pure slack, so the strip now hugs its tallest children — the 32dp icon
/// buttons — exactly. Do not grow it back without an owner decision.
const double kSessionStripHeight = 32;

/// One live-only OpenCode retry line below the fixed session strip.
class _OpenCodeRetryStatusBand extends StatelessWidget {
  const _OpenCodeRetryStatusBand({required this.retry});

  final SessionTransientRetryStatus retry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final primary = l10n.sessionOpenCodeRetrying;
    final secondary = l10n.sessionOpenCodeRetryDetail(retry.providerDetail);
    return Semantics(
      container: true,
      liveRegion: true,
      label: '$primary\n$secondary',
      excludeSemantics: true,
      child: DecoratedBox(
        key: const Key('session-opencode-retry-status'),
        decoration: BoxDecoration(
          color: tokens.surface2,
          border: Border(bottom: BorderSide(color: tokens.separator)),
        ),
        child: SelectionArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: StatusDot(color: tokens.statusWorking),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        primary,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: tokens.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        secondary,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: tokens.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The single chrome row above the session body.
///
/// Chat is the only primary view; the other four are destinations reached from
/// [menu]. Entering one swaps the title slot for a back affordance, which is
/// why [onBack] and [viewLabel] arrive together.
class _SessionTopStrip extends StatelessWidget {
  const _SessionTopStrip({
    required this.title,
    required this.editableTitle,
    required this.tool,
    required this.canRename,
    required this.renameBusy,
    required this.onRename,
    required this.control,
    required this.freshness,
    required this.telemetry,
    required this.badgeLabel,
    required this.onStatusTap,
    required this.menu,
    this.restoringDrive = false,
    this.viewLabel,
    this.onBack,
    this.onPopRoute,
  });

  final String title;

  /// The title a rename starts from, or empty when this client knows none.
  ///
  /// Separate from [title] because [title] may be the neutral "Opening session"
  /// placeholder while the session frame is outstanding, and that label is
  /// presentation — it must never be seeded into the rename field and committed
  /// to the broker as the session's name.
  final String editableTitle;
  final String tool;
  final bool canRename;
  final bool renameBusy;
  final ValueChanged<String> onRename;
  final SessionControlView control;

  /// The detail's one typed freshness state, consumed by the control pill.
  final SessionDetailFreshnessPresentation freshness;
  final SessionTelemetry telemetry;
  final String? badgeLabel;
  final VoidCallback onStatusTap;

  /// Whether a bounded automatic Drive restoration is being arbitrated.
  final bool restoringDrive;

  /// The `⋮` button, built by the page so this widget stays layout-only.
  final Widget menu;

  /// Name of the active sub-view. Null on Chat, where the title slot is the
  /// session title instead.
  final String? viewLabel;

  /// Returns to Chat from a sub-view. Null on Chat.
  final VoidCallback? onBack;

  /// Leaves the session entirely. Only supplied when this page sits on a
  /// poppable route, which is the phone/single-pane case — without it there
  /// would be no way back to the roster now that the AppBar is gone.
  final VoidCallback? onPopRoute;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final back = onBack;
    final leadingBack = back ?? onPopRoute;

    return LayoutBuilder(
      builder: (context, constraints) {
        final telemetryText = constraints.maxWidth >= 840
            ? _formatSessionTopRowTelemetry(l10n, telemetry)
            : null;
        return SizedBox(
          key: const Key('session-detail-top-strip'),
          width: double.infinity,
          height: kSessionStripHeight,
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              leadingBack == null ? 16 : 4,
              0,
              4,
              0,
            ),
            child: Row(
              children: [
                if (back != null)
                  _StripBackButton(
                    key: const Key('session-detail-view-back'),
                    tooltip: l10n.sessionViewBackTooltip,
                    onPressed: back,
                  )
                else if (onPopRoute != null)
                  // Material's own BackButton, not a look-alike: this leaves
                  // route, and the compact layout hides the bottom nav on the
                  // promise that detail stays poppable.
                  BackButton(
                    key: const Key('session-detail-route-back'),
                    onPressed: onPopRoute,
                    style: _stripIconButtonStyle(context),
                  ),
                Expanded(
                  child: viewLabel != null
                      ? Text(
                          viewLabel!,
                          key: const Key('session-detail-view-title'),
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        )
                      : _SessionTitleEditor(
                          title: title,
                          editableTitle: editableTitle,
                          tool: tool,
                          canRename: canRename,
                          busy: renameBusy,
                          onRename: onRename,
                        ),
                ),
                if (telemetryText != null) ...[
                  const SizedBox(width: 8),
                  // Non-flex, exactly like the status chip below and for the
                  // same reason: a loose Flexible here shares the row's free
                  // space 50/50 with the expanded title, and the unused half of
                  // that share collapses AFTER the menu — stranding the whole
                  // trailing cluster near the middle of a wide pane. A fixed
                  // cap keeps giant counters ellipsizing while the title
                  // absorbs every spare pixel and the cluster stays at the
                  // trailing edge.
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 320),
                    child: ExcludeSemantics(
                      child: Text(
                        telemetryText,
                        key: const Key('session-detail-top-row-telemetry'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: context.tokens.textTertiary,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ),
                  ),
                ],
                const SizedBox(width: 8),
                // This must not be a loose Flexible beside the expanded title:
                // Flex would reserve half the remaining row for this
                // intrinsically
                // small pill and leave that unused allocation after the menu,
                // stranding the right controls near the middle of a wide pane.
                // The cap still makes long freshness copy ellipsize at large
                // text
                // scales while the title absorbs every other spare pixel.
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 192),
                  child: KeyedSubtree(
                    key: const Key('session-detail-bottom-status-button'),
                    child: _StatusChipButton(
                      control: control,
                      freshness: freshness,
                      badgeLabel: badgeLabel,
                      onTap: onStatusTap,
                      restoringDrive: restoringDrive,
                    ),
                  ),
                ),
                menu,
              ],
            ),
          ),
        );
      },
    );
  }
}

String? _formatSessionTopRowTelemetry(
  AppLocalizations l10n,
  SessionTelemetry telemetry,
) {
  final parts = <String>[
    if (telemetry.inputTokens case final value?)
      l10n.sessionTurnTokensInput(_formatCompactTelemetryCount(value)),
    if (telemetry.outputTokens case final value?)
      l10n.sessionTurnTokensOutput(_formatCompactTelemetryCount(value)),
    if (telemetry.totalRuntimeMs case final value?)
      [
        l10n.sessionDetailTelemetryChipRuntime,
        _formatCompactDuration(value),
      ].join(' '),
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

String _formatCompactTelemetryCount(int value) {
  if (value.abs() < 1000) return '$value';
  if (value.abs() < 1000000) {
    final compact = (value / 1000).toStringAsFixed(
      value.abs() < 100000 ? 1 : 0,
    );
    return '${compact.replaceFirst(RegExp(r'\.0$'), '')}k';
  }
  if (value.abs() < 1000000000) {
    final compact = (value / 1000000).toStringAsFixed(1);
    return '${compact.replaceFirst(RegExp(r'\.0$'), '')}M';
  }
  final compact = (value / 1000000000).toStringAsFixed(1);
  return '${compact.replaceFirst(RegExp(r'\.0$'), '')}B';
}

/// Shared sizing for the strip's icon buttons: a 32dp box holding a 16px glyph
/// that grows with the ambient text scale, so the row never out-weighs its own
/// text at large UI scales.
ButtonStyle _stripIconButtonStyle(BuildContext context) {
  return IconButton.styleFrom(
    iconSize: MediaQuery.textScalerOf(context).scale(16),
    minimumSize: const Size(32, 32),
    fixedSize: const Size(32, 32),
    padding: EdgeInsets.zero,
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );
}

/// Back chevron that leaves a sub-view for Chat.
class _StripBackButton extends StatelessWidget {
  const _StripBackButton({
    required this.tooltip,
    required this.onPressed,
    super.key,
  });

  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      style: _stripIconButtonStyle(context),
      icon: const Icon(Icons.arrow_back),
    );
  }
}

/// The session title, which is itself the rename affordance.
///
/// Tapping converts it in place into a single-line field at the same
/// typography (the Notion/VS Code pattern): Enter commits, Esc cancels, focus
/// loss commits. The standalone pencil is gone — it sat ~30dp from the drive
/// pill's own pencil and the two read as a bug.
class _SessionTitleEditor extends StatefulWidget {
  const _SessionTitleEditor({
    required this.title,
    required this.editableTitle,
    required this.tool,
    required this.canRename,
    required this.busy,
    required this.onRename,
  });

  final String title;

  /// The text a rename starts from — the real title, or empty when unknown.
  final String editableTitle;
  final String tool;
  final bool canRename;
  final bool busy;
  final ValueChanged<String> onRename;

  @override
  State<_SessionTitleEditor> createState() => _SessionTitleEditorState();
}

class _SessionTitleEditorState extends State<_SessionTitleEditor>
    with WebHandoffHold<_SessionTitleEditor> {
  late final TextEditingController _controller;
  late final FocusNode _focusNode;
  bool _editing = false;
  bool _hovered = false;

  @override
  List<TextEditingController> get webHandoffControllers => [_controller];

  /// An in-progress rename is held nowhere but this field (N3b).
  ///
  /// Only while `_editing`: the controller keeps the last committed title after
  /// the field closes, and holding a handoff off for that would mean a tab that
  /// ever renamed a session never updates again.
  @override
  bool webHandoffHasContent() => _editing && _controller.text.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController();
    _focusNode = FocusNode(debugLabel: 'session-detail-title-rename')
      ..addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _focusNode
      ..removeListener(_onFocusChanged)
      ..dispose();
    _controller.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (!_focusNode.hasFocus) _commit();
  }

  void _begin() {
    setState(() {
      _editing = true;
      _controller.value = TextEditingValue(
        text: widget.editableTitle,
        selection: TextSelection(
          baseOffset: 0,
          extentOffset: widget.editableTitle.length,
        ),
      );
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _editing) _focusNode.requestFocus();
    });
  }

  void _commit() {
    // Clearing `_editing` first is what makes Esc safe: cancelling tears the
    // field down, which fires the focus listener, which would otherwise commit
    // the very edit the user just abandoned.
    if (!_editing) return;
    final next = _controller.text;
    setState(() => _editing = false);
    webHandoffContentChanged();
    if (next.trim() != widget.editableTitle.trim()) widget.onRename(next);
  }

  void _cancel() {
    if (!_editing) return;
    setState(() => _editing = false);
    webHandoffContentChanged();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      _cancel();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final titleStyle = theme.textTheme.titleSmall?.copyWith(
      fontWeight: FontWeight.w600,
    );

    if (_editing) {
      return Focus(
        onKeyEvent: _onKey,
        child: TextField(
          key: const Key('session-detail-rename-input'),
          controller: _controller,
          focusNode: _focusNode,
          maxLength: 200,
          style: titleStyle,
          onSubmitted: (_) => _commit(),
          decoration: InputDecoration(
            labelText: l10n.sessionDetailRenameFieldLabel,
            floatingLabelBehavior: FloatingLabelBehavior.never,
            counterText: '',
            isDense: true,
            filled: false,
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none,
            contentPadding: EdgeInsets.zero,
          ),
        ),
      );
    }

    final label = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(
          child: Text(
            widget.title,
            key: const Key('session-detail-wide-title'),
            style: titleStyle?.copyWith(
              decoration: _hovered && widget.canRename
                  ? TextDecoration.underline
                  : null,
              decorationStyle: TextDecorationStyle.dotted,
              decorationColor: tokens.textSecondary,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (widget.tool.isNotEmpty) ...[
          Text(
            ' · ',
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textTertiary,
            ),
          ),
          Flexible(
            child: Text(
              widget.tool,
              key: const Key('session-detail-strip-tool'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textTertiary,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
        if (widget.busy) ...[
          const SizedBox(width: 8),
          const SizedBox.square(
            dimension: 12,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ],
      ],
    );

    if (!widget.canRename) {
      return Align(alignment: Alignment.centerLeft, child: label);
    }

    return Tooltip(
      message: l10n.sessionDetailRenameTooltip,
      child: InkWell(
        key: const Key('session-detail-rename-button'),
        borderRadius: BorderRadius.circular(8),
        onTap: widget.busy ? null : _begin,
        onHover: (hovered) {
          if (hovered != _hovered && mounted) {
            setState(() => _hovered = hovered);
          }
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Align(alignment: Alignment.centerLeft, child: label),
        ),
      ),
    );
  }
}
