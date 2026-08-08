import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Group key used by roster sessions that carry no `cwd`.
const String kUngroupedProjectKey = '__ungrouped__';

/// Opens one roster project group, or does nothing if it is already open.
///
/// R1b made projects collapsed by default, so any test that asserts on session
/// rows has to expand their group first. This is idempotent so a test that
/// re-pumps the same pane (for example across several widths) can call it on
/// every iteration without toggling the group shut again.
/// Set [settle] to false when the roster is in a busy freshness state: the
/// shared R0b status slot renders a continuous progress indicator there, so
/// `pumpAndSettle` would never return.
Future<void> expandRosterProject(
  WidgetTester tester, {
  String key = kUngroupedProjectKey,
  bool settle = true,
}) async {
  final collapsed = find.byWidgetPredicate(
    (widget) =>
        widget is Icon &&
        widget.key == ValueKey('project-collapse-icon-$key') &&
        widget.icon == Icons.chevron_right,
  );
  if (collapsed.evaluate().isEmpty) return;
  await tester.tap(find.byKey(ValueKey('project-header-$key')));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
  }
}
