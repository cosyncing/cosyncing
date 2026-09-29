import 'package:cosyncing_client/src/design/components.dart';
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
/// Set [settle] to false when the caller only needs one frame. The normal path
/// advances a fixed duration rather than settling, so a caller whose subject
/// runs a spinner still gets there.
Future<void> expandRosterProject(
  WidgetTester tester, {
  String key = kUngroupedProjectKey,
  bool settle = true,
}) async {
  final collapsed = find.byWidgetPredicate(
    (widget) =>
        widget is StrokeIcon &&
        widget.key == ValueKey('project-collapse-icon-$key') &&
        widget.quarterTurns != 0,
  );
  if (collapsed.evaluate().isEmpty) return;
  await tester.tap(find.byKey(ValueKey('project-header-$key')));
  if (settle) {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
  } else {
    await tester.pump();
  }
}
