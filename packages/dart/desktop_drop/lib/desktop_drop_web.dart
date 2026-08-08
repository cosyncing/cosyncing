import 'package:flutter_web_plugins/flutter_web_plugins.dart';

/// Web registrar intentionally leaves browser drag events to the owning app.
///
/// Upstream 0.7.1 installs a global handler that recursively enumerates a
/// directory before a [DropItemDirectory] reaches the widget callback. The
/// client instead snapshots bounded files at its exact composer boundary.
final class DesktopDropWeb {
  /// Registers no global browser event handler.
  static void registerWith(Registrar registrar) {}
}
