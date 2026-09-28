import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_harness_logo.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Persistent strip of open sessions, including a single tab.
///
/// Presentational: it renders [refs] with [activeKey] highlighted and reports
/// selection/close via callbacks. Original harness artwork carries identity;
/// a separate amber marker identifies sessions that need input.
/// See `docs/architecture/client-ui.md`.
class OpenSessionsTabStrip extends StatefulWidget {
  /// Creates an opened-sessions tab strip.
  const OpenSessionsTabStrip({
    required this.refs,
    required this.activeKey,
    required this.onSelect,
    required this.onClose,
    this.onReorder,
    this.promptTargetKey,
    this.hideWhenSingle = false,
    this.onOverview,
    this.onCloseAll,
    this.onOpenRoster,
    this.showLiveStatus = true,
    this.unreadCompletionKeys = const {},
    super.key,
  });

  /// Desktop bar height. The 36dp tabs sit centred in it, level with the
  /// sidebar's brand row; compact layouts use a 44dp touch strip.
  static const double height = 52;

  /// Desktop tab height inside [height].
  static const double tabHeight = 36;

  /// Compact strip height.
  static const double compactHeight = 44;

  /// The open sessions, left to right.
  final List<SessionRef> refs;

  /// The [SessionRef.key] of the active tab.
  final String? activeKey;

  /// Called with a tab's [SessionRef.key] when it is tapped.
  final ValueChanged<String> onSelect;

  /// Called with a tab's [SessionRef.key] when its close affordance is used.
  final ValueChanged<String> onClose;

  /// Moves a tab within the strip, or null to leave tabs fixed.
  ///
  /// `onReorderItem` semantics: `newIndex` is already adjusted for the removal
  /// at `oldIndex`.
  final void Function(int oldIndex, int newIndex)? onReorder;

  /// The tab that still owns typing while a *file* pane holds focus.
  ///
  /// Null whenever the focused pane is a session's own, which is the ordinary
  /// case: the active tab is then both the focused pane and the prompt target,
  /// and a mark saying so would be on screen permanently and mean nothing.
  ///
  final String? promptTargetKey;

  /// Whether to render nothing when fewer than two sessions are open.
  final bool hideWhenSingle;

  /// Explicit home destination, independent of open tab membership.
  final VoidCallback? onOverview;

  /// Closes the working set while leaving sessions running.
  final VoidCallback? onCloseAll;

  /// Drawer affordance for compact and medium layouts.
  final VoidCallback? onOpenRoster;

  /// False while the roster is unavailable; persisted activity is not live.
  final bool showLiveStatus;

  /// Durable unread completion markers already qualified to the active source.
  final Set<String> unreadCompletionKeys;

  @override
  State<OpenSessionsTabStrip> createState() => _OpenSessionsTabStripState();
}

class _OpenSessionsTabStripState extends State<OpenSessionsTabStrip> {
  /// Owned so the wheel handler and the bottom scrollbar can drive the same
  /// position the list scrolls.
  final ScrollController _controller = ScrollController();

  /// Latest scroll geometry for the bottom scrollbar: (pixels, max, viewport).
  ///
  /// Copied out of notifications rather than read live so the scrollbar also
  /// repaints when the *extent* changes without a scroll (a tab opened or
  /// closed), which [ScrollController]'s own listener does not report.
  (double, double, double)? _scrollGeometry;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool _rebuildScheduled = false;

  bool _syncScrollGeometry(ScrollMetrics metrics) {
    if (!metrics.hasContentDimensions) return false;
    final next = (
      metrics.pixels,
      metrics.maxScrollExtent,
      metrics.viewportDimension,
    );
    if (next == _scrollGeometry) return false;
    _scrollGeometry = next;
    // Metrics notifications can arrive during layout, where setState is
    // illegal; the scrollbar painter tracks pixel changes itself with no lag
    // (its repaint listenable is the scroll position), so a post-frame rebuild
    // here only needs to catch extent changes — a tab opened or closed.
    if (!_rebuildScheduled) {
      _rebuildScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _rebuildScheduled = false;
        if (mounted) setState(() {});
      });
    }
    return false;
  }

  /// Maps a vertical wheel delta onto the strip's horizontal offset, VS Code
  /// style.
  ///
  /// A trackpad emits horizontal pan deltas, which the list already consumes; a
  /// mouse wheel emits `scrollDelta.dy` only, which a horizontal [ListView]
  /// ignores outright — that is why the strip felt trackpad-only. Taking the
  /// larger of the two axes keeps genuine horizontal wheels (and tilt wheels)
  /// working instead of double-counting them.
  void _onPointerSignal(PointerSignalEvent event) {
    if (event is! PointerScrollEvent) return;
    if (!_controller.hasClients) return;
    final position = _controller.position;
    if (!position.hasContentDimensions) return;
    final delta = event.scrollDelta;
    final primary = delta.dx.abs() > delta.dy.abs() ? delta.dx : delta.dy;
    if (primary == 0) return;
    final target = (position.pixels + primary).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (target != position.pixels) position.jumpTo(target);
  }

  @override
  Widget build(BuildContext context) {
    final refs = widget.refs;
    final reorder = widget.onReorder;
    if ((refs.isEmpty && widget.onOverview == null) ||
        (widget.hideWhenSingle && refs.length < 2)) {
      return const SizedBox.shrink();
    }
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    // The strip's old 1dp bottom hairline is now the scrollbar track: the same
    // separator-colored line, but with a draggable VS Code-style thumb overlaid
    // when the tabs overflow. It lives *inside* the strip (bottom-anchored in a
    // Stack), so the swap adds no height.
    return Container(
      height: compact
          ? OpenSessionsTabStrip.compactHeight
          : OpenSessionsTabStrip.height,
      color: tokens.canvas,
      padding: EdgeInsets.symmetric(horizontal: compact ? 0 : 16),
      child: Row(
        children: [
          if (widget.onOpenRoster != null)
            IconButton(
              key: const Key('workspace-open-drawer'),
              tooltip: l10n.workspaceShowSessionsTooltip,
              onPressed: widget.onOpenRoster,
              icon: const StrokeIcon(StrokeGlyph.menu),
            ),
          if (widget.onOverview != null)
            _OverviewTab(
              key: const Key('workspace-overview-tab'),
              label: l10n.workspaceOverview,
              selected: widget.activeKey == null,
              iconOnly: compact,
              onPressed: widget.onOverview!,
            ),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: Listener(
                    onPointerSignal: _onPointerSignal,
                    child: NotificationListener<ScrollMetricsNotification>(
                      onNotification: (notification) =>
                          _syncScrollGeometry(notification.metrics),
                      child: NotificationListener<ScrollNotification>(
                        onNotification: (notification) =>
                            _syncScrollGeometry(notification.metrics),
                        child: reorder == null
                            ? ListView.builder(
                                controller: _controller,
                                scrollDirection: Axis.horizontal,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                ),
                                itemCount: refs.length,
                                itemBuilder: (context, index) {
                                  final ref = refs[index];
                                  return _Tab(
                                    key: Key('open-session-tab-${ref.key}'),
                                    ref: ref,
                                    selected: ref.key == widget.activeKey,
                                    promptTarget:
                                        ref.key == widget.promptTargetKey,
                                    showLiveStatus: widget.showLiveStatus,
                                    unreadCompletion: widget
                                        .unreadCompletionKeys
                                        .contains(ref.key),
                                    onSelect: () => widget.onSelect(ref.key),
                                    onClose: () => widget.onClose(ref.key),
                                  );
                                },
                              )
                            : ReorderableListView.builder(
                                scrollController: _controller,
                                scrollDirection: Axis.horizontal,
                                buildDefaultDragHandles: false,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                ),
                                itemCount: refs.length,
                                onReorderItem: reorder,
                                proxyDecorator: (child, index, animation) =>
                                    child,
                                itemBuilder: (context, index) {
                                  final ref = refs[index];
                                  return _TabReorderListener(
                                    key: Key('open-session-tab-${ref.key}'),
                                    index: index,
                                    child: _Tab(
                                      longPressToClose: false,
                                      ref: ref,
                                      selected: ref.key == widget.activeKey,
                                      promptTarget:
                                          ref.key == widget.promptTargetKey,
                                      showLiveStatus: widget.showLiveStatus,
                                      unreadCompletion: widget
                                          .unreadCompletionKeys
                                          .contains(ref.key),
                                      onSelect: () => widget.onSelect(ref.key),
                                      onClose: () => widget.onClose(ref.key),
                                    ),
                                  );
                                },
                              ),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: _StripScrollbar(
                    key: const Key('open-sessions-tab-scrollbar'),
                    controller: _controller,
                    geometry: _scrollGeometry,
                    trackColor: tokens.canvas.withValues(alpha: 0),
                    thumbColor: tokens.textTertiary,
                    activeThumbColor: tokens.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          if (refs.isNotEmpty && widget.onCloseAll != null)
            IconButton(
              key: const Key('workspace-close-all-tabs'),
              tooltip: l10n.workspaceCloseAllTabs,
              onPressed: widget.onCloseAll,
              icon: const StrokeIcon(StrokeGlyph.closeAll),
            ),
        ],
      ),
    );
  }
}

/// Finger/stylus drags scroll first; a deliberate hold picks up the tab.
/// Pointer kind, rather than platform or viewport, also handles touch laptops
/// and a mouse connected to a phone correctly.
class _TabReorderListener extends StatelessWidget {
  const _TabReorderListener({
    required this.index,
    required this.child,
    super.key,
  });

  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (event) {
      final recognizer = event.kind == PointerDeviceKind.mouse
          ? ImmediateMultiDragGestureRecognizer(debugOwner: this)
          : DelayedMultiDragGestureRecognizer(debugOwner: this);
      SliverReorderableList.of(context).startItemDragReorder(
        index: index,
        event: event,
        recognizer: recognizer
          ..gestureSettings = MediaQuery.maybeGestureSettingsOf(context),
      );
    },
    child: child,
  );
}

/// The strip's bottom hairline, doubling as a horizontal scrollbar.
///
/// When the tabs fit, this is exactly the 1dp separator line the strip always
/// had. When they overflow, a slim thumb (2dp, 3dp while hovered or dragged)
/// rides on that line showing scroll position and extent; dragging it scrolls
/// the strip and tapping the track jumps there. The interactive band is 6dp
/// tall — an overlay over the tabs' bottom inset, VS Code-style — so the strip
/// itself never grows.
class _StripScrollbar extends StatefulWidget {
  const _StripScrollbar({
    required this.controller,
    required this.geometry,
    required this.trackColor,
    required this.thumbColor,
    required this.activeThumbColor,
    super.key,
  });

  /// Height of the hover/drag hit band (painting stays within 1–3dp).
  static const double hitHeight = 8;

  /// Minimum thumb length, so a long tab set still leaves something to grab.
  static const double minThumbWidth = 32;

  final ScrollController controller;

  /// (pixels, maxScrollExtent, viewportDimension) of the strip, or null before
  /// the first layout.
  final (double, double, double)? geometry;

  final Color trackColor;
  final Color thumbColor;
  final Color activeThumbColor;

  @override
  State<_StripScrollbar> createState() => _StripScrollbarState();
}

class _StripScrollbarState extends State<_StripScrollbar> {
  bool _hovered = false;
  bool _dragging = false;

  bool get _overflows {
    final geometry = widget.geometry;
    return geometry != null && geometry.$2 > 0;
  }

  ScrollPosition? get _position =>
      widget.controller.hasClients ? widget.controller.position : null;

  static double _thumbWidthFor(double trackWidth, ScrollMetrics metrics) {
    final fraction =
        metrics.viewportDimension /
        (metrics.viewportDimension + metrics.maxScrollExtent);
    return (trackWidth * fraction).clamp(
      _StripScrollbar.minThumbWidth,
      trackWidth,
    );
  }

  void _onDragUpdate(DragUpdateDetails details) {
    final position = _position;
    final trackWidth = context.size?.width ?? 0;
    if (position == null ||
        !position.hasContentDimensions ||
        position.maxScrollExtent <= 0 ||
        trackWidth <= 0) {
      return;
    }
    final scrollableTrack = trackWidth - _thumbWidthFor(trackWidth, position);
    if (scrollableTrack <= 0) return;
    final delta = details.delta.dx * position.maxScrollExtent / scrollableTrack;
    position.jumpTo(
      (position.pixels + delta).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
  }

  void _onTapDown(TapDownDetails details) {
    final position = _position;
    final trackWidth = context.size?.width ?? 0;
    if (position == null ||
        !position.hasContentDimensions ||
        position.maxScrollExtent <= 0 ||
        trackWidth <= 0) {
      return;
    }
    final thumbWidth = _thumbWidthFor(trackWidth, position);
    final scrollableTrack = trackWidth - thumbWidth;
    if (scrollableTrack <= 0) return;
    final fraction =
        ((details.localPosition.dx - thumbWidth / 2) / scrollableTrack).clamp(
          0.0,
          1.0,
        );
    position.jumpTo(fraction * position.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final active = _hovered || _dragging;
    final painter = _StripScrollbarPainter(
      controller: widget.controller,
      trackColor: widget.trackColor,
      thumbColor: active ? widget.activeThumbColor : widget.thumbColor,
      thumbHeight: active ? 3 : 2,
      minThumbWidth: _StripScrollbar.minThumbWidth,
    );
    // Purely a redundant affordance for the list it scrolls, so it carries no
    // semantics of its own.
    return ExcludeSemantics(
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        hitTestBehavior: _overflows
            ? HitTestBehavior.opaque
            : HitTestBehavior.translucent,
        child: _overflows
            ? GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: _onTapDown,
                onHorizontalDragStart: (_) => setState(() => _dragging = true),
                onHorizontalDragUpdate: _onDragUpdate,
                onHorizontalDragEnd: (_) => setState(() => _dragging = false),
                onHorizontalDragCancel: () => setState(() => _dragging = false),
                child: CustomPaint(
                  size: const Size(
                    double.infinity,
                    _StripScrollbar.hitHeight,
                  ),
                  painter: painter,
                ),
              )
            : IgnorePointer(
                child: CustomPaint(
                  size: const Size(
                    double.infinity,
                    _StripScrollbar.hitHeight,
                  ),
                  painter: painter,
                ),
              ),
      ),
    );
  }
}

class _StripScrollbarPainter extends CustomPainter {
  /// Repaints on every scroll tick by listening to the position itself, so the
  /// thumb never lags the tabs.
  _StripScrollbarPainter({
    required this.controller,
    required this.trackColor,
    required this.thumbColor,
    required this.thumbHeight,
    required this.minThumbWidth,
  }) : super(repaint: controller.hasClients ? controller.position : null);

  final ScrollController controller;
  final Color trackColor;
  final Color thumbColor;
  final double thumbHeight;
  final double minThumbWidth;

  @override
  void paint(Canvas canvas, Size size) {
    // The 1dp separator hairline, always — with no overflow this is all that
    // paints and the strip looks exactly as it did before.
    canvas.drawRect(
      Rect.fromLTWH(0, size.height - 1, size.width, 1),
      Paint()..color = trackColor,
    );
    if (!controller.hasClients || size.width <= 0) return;
    final position = controller.position;
    if (!position.hasContentDimensions || position.maxScrollExtent <= 0) {
      return;
    }
    final maxExtent = position.maxScrollExtent;
    final viewport = position.viewportDimension;
    final fraction = viewport / (viewport + maxExtent);
    final thumbWidth = (size.width * fraction).clamp(minThumbWidth, size.width);
    final scrollableTrack = size.width - thumbWidth;
    final offsetFraction = (position.pixels / maxExtent).clamp(0.0, 1.0);
    final left = scrollableTrack * offsetFraction;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(left, size.height - thumbHeight, thumbWidth, thumbHeight),
        const Radius.circular(1),
      ),
      Paint()..color = thumbColor,
    );
  }

  @override
  bool shouldRepaint(_StripScrollbarPainter oldDelegate) {
    return controller != oldDelegate.controller ||
        trackColor != oldDelegate.trackColor ||
        thumbColor != oldDelegate.thumbColor ||
        thumbHeight != oldDelegate.thumbHeight;
  }
}

class _Tab extends StatelessWidget {
  const _Tab({
    required this.ref,
    required this.selected,
    required this.onSelect,
    required this.onClose,
    this.promptTarget = false,
    this.showLiveStatus = true,
    this.unreadCompletion = false,
    this.longPressToClose = true,
    super.key,
  });

  final SessionRef ref;
  final bool selected;
  final bool showLiveStatus;
  final bool unreadCompletion;
  final bool longPressToClose;

  /// Whether this tab still receives typing while a file pane holds focus.
  final bool promptTarget;
  final VoidCallback onSelect;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final needsInput = showLiveStatus && ref.status == SessionStatus.needsInput;
    // U3: a working-set row persists the session id as its "no title yet"
    // placeholder — `SessionRef.fromSession` writes it for an authoritatively
    // untitled session too. That is right for storage and wrong on a tab: the
    // label would be a fingerprint, and it would disagree with the top strip,
    // which names the same session neutrally.
    //
    // Which neutral label follows the row's own resolution marker: a null
    // status is "never resolved" (still opening), a present one is a session
    // the broker resolved and simply did not name.
    final l10n = AppLocalizations.of(context);
    final label =
        knownSessionTitle([ref.title], sessionId: ref.id) ??
        (ref.status == null
            ? l10n.sessionDetailTitleOpening
            : l10n.sessionDetailTitleUntitled);
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    // A fixed target, independent of the platform's visual density: desktop
    // density used to shrink this to 20dp, which also shortened the row and
    // left the title riding the top of its tab.
    final closeExtent = compact ? 40.0 : 28.0;
    final radius = BorderRadius.circular(tokens.radiusMd);
    final tab = Padding(
      padding: EdgeInsets.symmetric(
        vertical: compact
            ? 2
            : (OpenSessionsTabStrip.height - OpenSessionsTabStrip.tabHeight) /
                  2,
        horizontal: 2,
      ),
      // Middle-click closes the tab — the one Chrome tab affordance that needs
      // no chord and no reservation, so it works identically on native and on
      // web. A `Listener` rather than a gesture recognizer because Flutter's
      // tap recognizers only report the primary button; the auxiliary button
      // is readable on the raw pointer event and nowhere else.
      child: Listener(
        onPointerDown: (event) {
          if (event.kind != PointerDeviceKind.mouse) return;
          if (event.buttons & kMiddleMouseButton == 0) return;
          onClose();
        },
        child: Material(
          color: selected ? tokens.surface2 : tokens.canvas,
          borderRadius: radius,
          child: InkWell(
            onTap: onSelect,
            // Reorderable tabs reserve the hold for picking up the tab.
            onLongPress: longPressToClose ? onClose : null,
            borderRadius: radius,
            hoverColor: tokens.surface2,
            child: Container(
              constraints: BoxConstraints(
                maxWidth: compact
                    ? MediaQuery.sizeOf(context).width - 140
                    : 240,
              ),
              padding: const EdgeInsets.only(left: 12, right: 4),
              child: Stack(
                alignment: AlignmentDirectional.centerStart,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SessionHarnessLogo(tool: ref.tool, size: 12),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: selected
                                ? tokens.textPrimary
                                : tokens.textSecondary,
                            fontWeight: needsInput || selected
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                        ),
                      ),
                      if (needsInput) ...[
                        const SizedBox(width: 4),
                        StatusDot(color: tokens.statusNeedsInput, size: 4),
                      ],
                      if (unreadCompletion) ...[
                        const SizedBox(width: 4),
                        Tooltip(
                          message: l10n.workspaceUnreadCompletions,
                          child: StatusDot(
                            key: Key('open-session-tab-unread-${ref.key}'),
                            color: tokens.statusError,
                            size: 4,
                          ),
                        ),
                      ],
                      const SizedBox(width: 4),
                      SizedBox.square(
                        dimension: closeExtent,
                        child: IconButton(
                          key: Key('open-session-tab-close-${ref.key}'),
                          onPressed: onClose,
                          icon: const StrokeIcon(StrokeGlyph.close, size: 14),
                          tooltip: l10n.close,
                          color: tokens.textTertiary,
                          style: IconButton.styleFrom(
                            padding: EdgeInsets.zero,
                            visualDensity: VisualDensity.standard,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            minimumSize: Size.square(closeExtent),
                            maximumSize: Size.square(closeExtent),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                tokens.radiusSm,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                  // The prompt-target underline remains separate from the
                  // harness artwork and trailing attention markers.
                  if (promptTarget)
                    Positioned(
                      key: Key('open-session-tab-prompt-target-${ref.key}'),
                      left: 0,
                      right: 8,
                      bottom: 1,
                      height: 2,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: tokens.accent,
                          borderRadius: BorderRadius.circular(1),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    if (!promptTarget) return tab;
    return Tooltip(message: l10n.workspacePromptTargetTooltip, child: tab);
  }
}

/// The strip's fixed home destination: the Overview, labelled on wide
/// layouts and icon-only on compact ones.
class _OverviewTab extends StatelessWidget {
  const _OverviewTab({
    required this.label,
    required this.selected,
    required this.iconOnly,
    required this.onPressed,
    super.key,
  });

  final String label;
  final bool selected;
  final bool iconOnly;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final color = selected ? tokens.textPrimary : tokens.textSecondary;
    final icon = StrokeIcon(StrokeGlyph.overview, color: color);
    if (iconOnly) {
      return IconButton(
        tooltip: label,
        isSelected: selected,
        onPressed: onPressed,
        icon: icon,
      );
    }
    final radius = BorderRadius.circular(tokens.radiusMd);
    // A container, so these flags stay on the tab instead of merging into the
    // page around it; the tap is restated because its children are excluded.
    return Semantics(
      container: true,
      selected: selected,
      button: true,
      excludeSemantics: true,
      label: label,
      onTap: onPressed,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Material(
          color: selected ? tokens.surface2 : tokens.canvas,
          borderRadius: radius,
          child: InkWell(
            onTap: onPressed,
            borderRadius: radius,
            hoverColor: tokens.surface2,
            child: SizedBox(
              height: OpenSessionsTabStrip.tabHeight,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    icon,
                    const SizedBox(width: 8),
                    Text(
                      label,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: color),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
