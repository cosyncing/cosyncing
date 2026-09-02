import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage prompt target', () {
    const note = Key('session-composer-prompt-target');

    /// The page with [focused] holding workspace focus.
    Widget subject(String? focused, {Locale? locale}) =>
        buildSessionDetailTestPage(
          events: const [],
          locale: locale,
          extraOverrides: [
            focusedPaneProvider.overrideWith((ref) => focused),
          ],
        );

    testWidgets('stays silent while the session pane holds focus', (
      tester,
    ) async {
      await tester.pumpWidget(subject('claude/session-1'));
      await tester.pumpAndSettle();

      // The ordinary case: the focused pane and the prompt target are the same
      // pane, so a note saying where typing goes would be on screen for the
      // whole life of the app and would teach nothing.
      expect(find.byKey(note), findsNothing);
    });

    testWidgets('stays silent when no pane holds focus', (tester) async {
      await tester.pumpWidget(subject(null));
      await tester.pumpAndSettle();

      expect(find.byKey(note), findsNothing);
    });

    testWidgets('names this session while one of its files holds focus', (
      tester,
    ) async {
      await tester.pumpWidget(subject('claude/session-1#lib/one.dart'));
      await tester.pumpAndSettle();

      // Typing after clicking into a file must never feel like it goes
      // nowhere: the composer says which session is still receiving it.
      expect(find.byKey(note), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(note)).data,
        startsWith('Prompts go to claude · '),
      );
    });

    testWidgets('ignores a file pane belonging to another session', (
      tester,
    ) async {
      await tester.pumpWidget(subject('codex/other#lib/one.dart'));
      await tester.pumpAndSettle();

      // A file open in a different tab is not on screen beside this composer,
      // so it says nothing about where this composer's input goes.
      expect(find.byKey(note), findsNothing);
    });

    testWidgets('is localized, not merely centralized', (tester) async {
      await tester.pumpWidget(
        subject('claude/session-1#lib/one.dart', locale: const Locale('zh')),
      );
      await tester.pumpAndSettle();

      expect(
        tester.widget<Text>(find.byKey(note)).data,
        startsWith('输入目标是 claude · '),
      );
    });
  });
}
