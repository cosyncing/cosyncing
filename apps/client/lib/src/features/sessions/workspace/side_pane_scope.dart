import 'package:flutter/widgets.dart';

/// Actual available workspace geometry, shared by all right-panel openers.
class SidePaneScope extends InheritedWidget {
  /// Carries the split's availability and expand action.
  const SidePaneScope({
    required this.available,
    required this.expand,
    required super.child,
    super.key,
  });

  /// Whether the current main area can fit both panes.
  final bool available;

  /// Reveals an already collapsed panel when content is opened.
  final VoidCallback expand;

  /// The enclosing workspace, if this is an embedded session.
  static SidePaneScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SidePaneScope>();
  @override
  bool updateShouldNotify(SidePaneScope oldWidget) =>
      available != oldWidget.available || expand != oldWidget.expand;
}

/// Wide landscape windows use the split; portrait keeps the single view.
bool canShowSidePane(
  Size window,
  double available, {
  required bool drawerLayout,
}) => !drawerLayout && window.width >= window.height && available >= 520;
