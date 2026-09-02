import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// VS Code-style strip of the sessions being actively driven (the working set).
///
/// Presentational: it renders [refs] with [activeKey] highlighted and reports
/// selection/close via callbacks — the owner wires those to
/// `OpenSessionsController`. Tool identity is a color dot (never a letter
/// monogram); a session that needs the user shows a status marker.
///
/// Hidden when only one session is open (per the layout policy), unless
/// [hideWhenSingle] is disabled. See
/// `docs/architecture/client-ui.md`.
class OpenSessionsTabStrip extends StatefulWidget {
  /// Creates an opened-sessions tab strip.
  const OpenSessionsTabStrip({
    required this.refs,
    required this.activeKey,
    required this.onSelect,
    required this.onClose,
    this.onReorder,
    this.promptTargetKey,
    this.hideWhenSingle = true,
    super.key,
  });

  /// Height of the strip.
  ///
  /// 32dp, not 40: this bar stacks directly on the 36dp session strip, so the
  /// two together are pure chrome above the transcript. The tab's own content
  /// is a 12dp dot, one line of `bodySmall` and a 24dp close button — all of
  /// which fit inside 32 with the 2dp vertical inset below.
  static const double height = 32;

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
  /// Note this signal is invisible with a single session open, because the
  /// strip itself is. That is the case where it has nothing to disambiguate —
  /// there is only one session input could reach — and the composer's own note
  /// still names it.
  final String? promptTargetKey;

  /// Whether to render nothing when fewer than two sessions are open.
  final bool hideWhenSingle;

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
    if (refs.isEmpty || (widget.hideWhenSingle && refs.length < 2)) {
      return const SizedBox.shrink();
    }
    final tokens = context.tokens;
    // The strip's old 1dp bottom hairline is now the scrollbar track: the same
    // separator-colored line, but with a draggable VS Code-style thumb overlaid
    // when the tabs overflow. It lives *inside* the 32dp strip (bottom-anchored
    // in a Stack), so the swap adds no height.
    return Container(
      height: OpenSessionsTabStrip.height,
      color: tokens.canvas,
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
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          itemCount: refs.length,
                          itemBuilder: (context, index) {
                            final ref = refs[index];
                            return _Tab(
                              key: Key('open-session-tab-${ref.key}'),
                              ref: ref,
                              selected: ref.key == widget.activeKey,
                              promptTarget: ref.key == widget.promptTargetKey,
                              onSelect: () => widget.onSelect(ref.key),
                              onClose: () => widget.onClose(ref.key),
                            );
                          },
                        )
                      : ReorderableListView.builder(
                          scrollController: _controller,
                          scrollDirection: Axis.horizontal,
                          buildDefaultDragHandles: false,
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          itemCount: refs.length,
                          onReorderItem: reorder,
                          proxyDecorator: (child, index, animation) => child,
                          itemBuilder: (context, index) {
                            final ref = refs[index];
                            return ReorderableDragStartListener(
                              key: Key('open-session-tab-${ref.key}'),
                              index: index,
                              child: _Tab(
                                ref: ref,
                                selected: ref.key == widget.activeKey,
                                promptTarget: ref.key == widget.promptTargetKey,
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
              trackColor: tokens.separator,
              thumbColor: tokens.textTertiary,
              activeThumbColor: tokens.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
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
  static const double hitHeight = 6;

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
    super.key,
  });

  final SessionRef ref;
  final bool selected;

  /// Whether this tab still receives typing while a file pane holds focus.
  final bool promptTarget;
  final VoidCallback onSelect;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final needsInput = ref.status == SessionStatus.needsInput;
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
    final tab = Padding(
      padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 2),
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
          color: selected ? tokens.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(tokens.radiusSm),
          child: InkWell(
            onTap: onSelect,
            onLongPress: onClose,
            borderRadius: BorderRadius.circular(tokens.radiusSm),
            child: Container(
              constraints: const BoxConstraints(maxWidth: 220),
              padding: const EdgeInsets.only(left: 10, right: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(tokens.radiusSm),
                border: Border.all(
                  color: selected ? tokens.separator : Colors.transparent,
                ),
              ),
              child: Stack(
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      StatusDot(
                        color: tokens.toolColor(ref.tool),
                        ringColor: needsInput ? tokens.statusNeedsInput : null,
                        ringGapColor: needsInput ? tokens.surface : null,
                        pulse: ref.status == SessionStatus.working,
                      ),
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
                      const SizedBox(width: 2),
                      IconButton(
                        key: Key('open-session-tab-close-${ref.key}'),
                        onPressed: onClose,
                        icon: const Icon(Icons.close, size: 14),
                        tooltip: AppLocalizations.of(context).close,
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        color: tokens.textTertiary,
                      ),
                    ],
                  ),
                  // Underline rather than a second dot: the leading dot is
                  // already spoken for by tool colour and run state, and a
                  // mark competing with it would have to be read against the
                  // one glyph on the tab that changes for other reasons.
                  if (promptTarget)
                    Positioned(
                      key: Key('open-session-tab-prompt-target-${ref.key}'),
                      left: 12,
                      right: 12,
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
