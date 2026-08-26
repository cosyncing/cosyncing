import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

OpenSessionsStore _twoOpenSessions() => InMemoryOpenSessionsStore(
  snapshot: const OpenSessionsSnapshot(
    refs: [
      SessionRef(
        tool: 'claude',
        id: 'session-1',
        title: 'Current',
        status: SessionStatus.idle,
      ),
      SessionRef(
        tool: 'codex',
        id: 'session-2',
        title: 'Other',
        status: SessionStatus.idle,
      ),
    ],
    activeKey: 'claude/session-1',
  ),
);

Future<void> _press(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  List<LogicalKeyboardKey> modifiers = const [],
}) async {
  for (final modifier in modifiers) {
    await tester.sendKeyDownEvent(modifier);
  }
  await tester.sendKeyDownEvent(key);
  await tester.sendKeyUpEvent(key);
  for (final modifier in modifiers.reversed) {
    await tester.sendKeyUpEvent(modifier);
  }
  await tester.pumpAndSettle();
}

OpenSessionsTabStrip _strip(WidgetTester tester) =>
    tester.widget<OpenSessionsTabStrip>(find.byType(OpenSessionsTabStrip));

void main() {
  group('SessionDetailPage opened-session chords (compact)', () {
    testWidgets('Ctrl+W closes this session and it does not come back', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
        ),
      );
      await tester.pumpAndSettle();
      expect(_strip(tester).refs, hasLength(2));

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );

      // The close only lands if `_establishDraftDurabilityBarrier` resolved:
      // the shortcut path is the same async close the button takes.
      expect(
        _strip(tester).refs.map((entry) => entry.key),
        ['codex/session-2'],
      );

      // The `_suppressedSessionTabKey` handshake. Without it
      // `_ensureCurrentSessionTab` re-adds the tab the user just closed on the
      // very next frame, and the chord looks like it did nothing.
      await tester.pump();
      await tester.pumpAndSettle();
      expect(_strip(tester).refs, hasLength(1));
    });

    testWidgets('Ctrl+Alt+W closes this session too', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
        ),
      );
      await tester.pumpAndSettle();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );

      expect(_strip(tester).refs, hasLength(1));
    });

    testWidgets('bare 2 selects the second tab from the compact strip', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
        ),
      );
      await tester.pumpAndSettle();
      expect(_strip(tester).activeKey, 'claude/session-1');

      // Compact selection is `_selectOpenSession`: flush the draft, activate,
      // then route to the neighbour. This harness mounts the page without a
      // GoRouter, so the route never changes and `_ensureCurrentSessionTab`
      // re-claims the active tab for the session this page still shows — the
      // same thing the tab strip's own onSelect would do here. The controller
      // transition is therefore what proves the chord is wired.
      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );
      final activations = <String?>[];
      final subscription = container.listen(
        openSessionsControllerProvider,
        (_, next) => activations.add(next.valueOrNull?.activeKey),
      );
      addTearDown(subscription.close);

      await _press(tester, LogicalKeyboardKey.digit2);

      expect(activations, contains('codex/session-2'));
    });

    // The regression that would make the whole feature unusable: an unmodified
    // key typed into the composer is text, never a command.
    testWidgets('typing w and digits in the composer never closes a tab', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      await tester.pumpAndSettle();
      await tester.enterText(input, 'w2]9[');
      await tester.pumpAndSettle();

      await _press(tester, LogicalKeyboardKey.keyW);
      await _press(tester, LogicalKeyboardKey.digit2);
      await _press(tester, LogicalKeyboardKey.bracketRight);

      expect(find.text('w2]9['), findsOneWidget);
      expect(_strip(tester).refs, hasLength(2));
      expect(_strip(tester).activeKey, 'claude/session-1');
    });

    testWidgets('web keeps the +Alt close and drops the plain Ctrl+W', (
      tester,
    ) async {
      debugWebReservedChordsOverride = true;
      addTearDown(() => debugWebReservedChordsOverride = null);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
        ),
      );
      await tester.pumpAndSettle();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );
      expect(_strip(tester).refs, hasLength(2));

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [
          LogicalKeyboardKey.controlLeft,
          LogicalKeyboardKey.altLeft,
        ],
      );
      expect(_strip(tester).refs, hasLength(1));
    });

    // The compact page keeps its own barrier ahead of the controller's
    // precisely because it can do something the notifier cannot: report the
    // refusal and keep the tab. A close that dropped the view anyway would
    // discard the only copy of the text along with it.
    testWidgets('a refused draft write aborts the close and keeps the tab', (
      tester,
    ) async {
      final drafts = FailingSessionDraftRepository();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
          draftRepository: drafts,
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      await tester.pumpAndSettle();
      await tester.enterText(input, 'the sentence that must not be lost');
      await tester.pumpAndSettle();

      await _press(
        tester,
        LogicalKeyboardKey.keyW,
        modifiers: const [LogicalKeyboardKey.controlLeft],
      );

      expect(drafts.saveAttempts, greaterThan(0));
      expect(
        _strip(tester).refs.map((entry) => entry.key),
        ['claude/session-1', 'codex/session-2'],
      );
      // Stated once, where the gesture happened — a silent refusal would read
      // as a broken shortcut.
      expect(
        find.text(
          'Draft could not be saved. Try again before leaving this session.',
        ),
        findsOneWidget,
      );
      // And the text is still in the composer, which is the whole point of
      // refusing to close.
      expect(find.text('the sentence that must not be lost'), findsOneWidget);
    });

    testWidgets('the close button aborts on a refused draft write too', (
      tester,
    ) async {
      final drafts = FailingSessionDraftRepository();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: _twoOpenSessions(),
          draftRepository: drafts,
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      await tester.pumpAndSettle();
      await tester.enterText(input, 'still unsent');
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('open-session-tab-close-claude/session-1')),
      );
      await tester.pumpAndSettle();

      expect(drafts.saveAttempts, greaterThan(0));
      expect(_strip(tester).refs, hasLength(2));
    });
  });
}
