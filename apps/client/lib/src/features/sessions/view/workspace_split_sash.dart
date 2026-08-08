import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Invisible hit strip around the 1dp separator, so the sash is grabbable
/// without thickening the resting divider (4dp each side of the line).
const double workspaceSashHitWidth = 9;

/// Width of the icon rail shown in place of a collapsed roster.
///
/// Wide enough for real icon buttons: collapsing must not strand the Expanded
/// layout's only Attention and Settings entry points. Still reclaims ~272dp
/// from the default 320dp roster.
const double workspaceCollapsedRailWidth = 48;

/// Arrow-key resize step.
const double workspaceSashKeyStep = 16;

/// Shift+arrow resize step.
const double workspaceSashCoarseKeyStep = 64;

/// The draggable split between the roster and detail panes.
///
/// Replaces the fixed `VerticalDivider`: same 1dp resting weight, but with a
/// [workspaceSashHitWidth] hit strip, a `resizeColumn` cursor, a 2dp neutral
/// line while hovered/dragged/focused, double-click reset, and arrow-key
/// resizing.
///
/// Geometry decisions (clamping, snap-to-collapse, persistence) stay with the
/// workspace; this widget only reports intent.
class WorkspaceSplitSash extends StatefulWidget {
  /// Creates the split sash.
  const WorkspaceSplitSash({
    required this.separatorColor,
    required this.onDragStart,
    required this.onDragDelta,
    required this.onDragEnd,
    required this.onReset,
    required this.onStep,
    super.key,
  });

  /// Resting 1dp line colour.
  final Color separatorColor;

  /// Called when a horizontal drag begins.
  final VoidCallback onDragStart;

  /// Called with each horizontal drag delta, in logical pixels.
  final ValueChanged<double> onDragDelta;

  /// Called when a horizontal drag ends.
  final VoidCallback onDragEnd;

  /// Called on double-click, and on Home — reset to the default split.
  final VoidCallback onReset;

  /// Called with a signed logical-pixel step from an arrow key.
  final ValueChanged<double> onStep;

  @override
  State<WorkspaceSplitSash> createState() => WorkspaceSplitSashState();
}

/// State for [WorkspaceSplitSash]. Public so widget tests can drive the
/// keyboard path via [focusForTest].
class WorkspaceSplitSashState extends State<WorkspaceSplitSash> {
  final FocusNode _focusNode = FocusNode(debugLabel: 'WorkspaceSplitSash');
  bool _hovering = false;
  bool _dragging = false;
  bool _focused = false;

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  /// Focuses the sash so arrow keys reach it. For widget tests only — in the
  /// app the sash takes focus on drag or via normal traversal.
  @visibleForTesting
  void focusForTest() => _focusNode.requestFocus();

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.home) {
      widget.onReset();
      return KeyEventResult.handled;
    }
    final isLeft = key == LogicalKeyboardKey.arrowLeft;
    final isRight = key == LogicalKeyboardKey.arrowRight;
    if (!isLeft && !isRight) return KeyEventResult.ignored;
    final magnitude = HardwareKeyboard.instance.isShiftPressed
        ? workspaceSashCoarseKeyStep
        : workspaceSashKeyStep;
    widget.onStep(isLeft ? -magnitude : magnitude);
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final active = _hovering || _dragging || _focused;
    return Focus(
      focusNode: _focusNode,
      onKeyEvent: _handleKey,
      onFocusChange: (value) => setState(() => _focused = value),
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeColumn,
        onEnter: (_) => setState(() => _hovering = true),
        onExit: (_) => setState(() => _hovering = false),
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onHorizontalDragStart: (_) {
            _focusNode.requestFocus();
            setState(() => _dragging = true);
            widget.onDragStart();
          },
          onHorizontalDragUpdate: (details) =>
              widget.onDragDelta(details.delta.dx),
          onHorizontalDragEnd: (_) {
            setState(() => _dragging = false);
            widget.onDragEnd();
          },
          onHorizontalDragCancel: () {
            setState(() => _dragging = false);
            widget.onDragEnd();
          },
          onDoubleTap: widget.onReset,
          child: Semantics(
            label: l10n.workspaceResizeSessionsListLabel,
            child: SizedBox(
              width: workspaceSashHitWidth,
              child: Center(
                child: Container(
                  key: const Key('workspace-split-sash-line'),
                  width: active ? 2 : 1,
                  height: double.infinity,
                  color: widget.separatorColor,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The left-edge tab shown in place of a collapsed roster.
///
/// A full-height [workspaceCollapsedRailWidth] icon rail: the expand
/// affordance, New session, Attention (badged), and Settings.
///
/// This is deliberately an icon rail rather than the slimmer chevron tab the
/// split-resizer spec first sketched. The Expanded layout has no bottom nav and
/// no desktop command surface — the roster header is its only route to
/// Attention and Settings — so a bare expand tab would strand both behind
/// "reopen the roster first". Since the roster now defaults to closed, that
/// would be the common path, not an edge case.
///
/// The action keys are shared with the roster header on purpose: expanded and
/// collapsed are mutually exclusive, so exactly one of the two is ever mounted.
class WorkspaceCollapsedRosterRail extends StatelessWidget {
  /// Creates the collapsed-roster icon rail.
  const WorkspaceCollapsedRosterRail({
    required this.separatorColor,
    required this.unreadCount,
    required this.unreadLabel,
    required this.onExpand,
    required this.onNewSession,
    required this.onAttention,
    required this.onSettings,
    super.key,
  });

  /// Colour of the 1dp edge separating the rail from the detail pane.
  final Color separatorColor;

  /// Unread attention count; drives the badge on the Attention icon.
  final int unreadCount;

  /// Pre-formatted badge label for [unreadCount].
  final String unreadLabel;

  /// Called when the user reopens the roster.
  final VoidCallback onExpand;

  /// Called to start a new session.
  final VoidCallback onNewSession;

  /// Called to open the Attention inbox.
  final VoidCallback onAttention;

  /// Called to open Settings.
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SizedBox(
      width: workspaceCollapsedRailWidth,
      height: double.infinity,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(right: BorderSide(color: separatorColor)),
        ),
        // Scrollable so a short window shortens the rail instead of
        // overflowing it.
        child: SingleChildScrollView(
          child: Column(
            children: [
              const SizedBox(height: 7),
              IconButton(
                key: const Key('workspace-roster-expand-tab'),
                tooltip: l10n.workspaceShowSessionsTooltip,
                visualDensity: VisualDensity.compact,
                onPressed: onExpand,
                icon: const Icon(Icons.chevron_right),
              ),
              IconButton.filledTonal(
                key: const Key('sessions-workspace-global-new'),
                tooltip: l10n.newSessionTitle,
                visualDensity: VisualDensity.compact,
                onPressed: onNewSession,
                icon: const Icon(Icons.add, size: 19),
              ),
              const SizedBox(height: 4),
              IconButton(
                key: const Key('sessions-workspace-attention'),
                tooltip: l10n.notificationsTitle,
                visualDensity: VisualDensity.compact,
                onPressed: onAttention,
                icon: Badge(
                  isLabelVisible: unreadCount > 0,
                  label: Text(unreadLabel),
                  child: const Icon(Icons.notifications_outlined),
                ),
              ),
              IconButton(
                key: const Key('sessions-workspace-settings'),
                tooltip: l10n.settingsTitle,
                visualDensity: VisualDensity.compact,
                onPressed: onSettings,
                icon: const Icon(Icons.settings_outlined),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
