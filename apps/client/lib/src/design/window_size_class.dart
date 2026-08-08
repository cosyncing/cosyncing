import 'package:flutter/widgets.dart';

/// Minimum logical width (dp) for the [WindowSizeClass.medium] class.
const double kMediumWindowMinWidth = 600;

/// Minimum logical width (dp) for the [WindowSizeClass.expanded] class.
///
/// Aligned to Material's canonical Expanded threshold.
const double kExpandedWindowMinWidth = 840;

/// Material window width size classes.
///
/// The layout policy asks one width question — conceptually
/// `layout.showListDetail` — instead of branching on `Platform.is*`. Width
/// captures the user's intuition (landscape → two-pane, portrait → single):
/// a tablet or foldable crosses into [expanded] in landscape and drops to
/// [compact] folded or in portrait, while a phone-in-landscape stays single.
///
/// See `docs/architecture/client-ui.md`.
enum WindowSizeClass {
  /// `< 600dp` — phone (portrait and most landscape), folded foldable.
  /// Single pane, drill-in.
  compact,

  /// `600–840dp` — small tablet portrait, large phone landscape.
  /// Roomier single pane (not two-pane).
  medium,

  /// `≥ 840dp` — tablet landscape, unfolded foldable, desktop.
  /// Two-pane: persistent list plus detail.
  expanded;

  /// Classifies a logical [width] in dp.
  ///
  /// Reads logical width, which does not move with text scale, so bumping the
  /// text size never silently collapses the two-pane split.
  static WindowSizeClass fromWidth(double width) {
    if (width < kMediumWindowMinWidth) {
      return WindowSizeClass.compact;
    }
    if (width < kExpandedWindowMinWidth) {
      return WindowSizeClass.medium;
    }
    return WindowSizeClass.expanded;
  }

  /// Classifies from the nearest [MediaQuery] width.
  static WindowSizeClass of(BuildContext context) =>
      fromWidth(MediaQuery.sizeOf(context).width);

  /// Whether this class shows the persistent list + detail two-pane workspace.
  ///
  /// Only [expanded] does; [compact] and [medium] stay single-pane.
  bool get showListDetail => this == WindowSizeClass.expanded;
}
