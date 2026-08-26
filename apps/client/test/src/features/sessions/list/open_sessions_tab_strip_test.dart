import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/gestures.dart'
    show PointerDeviceKind, kMiddleMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

SessionRef _ref(
  String tool,
  String id, {
  String title = 'title',
  SessionStatus status = SessionStatus.idle,
}) => SessionRef(
  tool: tool,
  id: id,
  title: title,
  status: status,
);

void main() {
  // The strip labels unnamed tabs through `AppLocalizations` (U3), so its host
  // needs the app's delegates like any other localized surface.
  Widget host(Widget child, {Locale? locale}) => MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    locale: locale,
    theme: buildAppTheme(
      themeSpecById(kDefaultThemeId).light,
      Brightness.light,
    ),
    home: Scaffold(body: child),
  );

  group('OpenSessionsTabStrip', () {
    testWidgets('hides when a single session is open', (tester) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a')],
            activeKey: 'claude/a',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );

      expect(find.byKey(const Key('open-session-tab-claude/a')), findsNothing);
    });

    testWidgets('renders a tab per open session', (tester) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );

      expect(
        find.byKey(const Key('open-session-tab-claude/a')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('open-session-tab-codex/b')), findsOneWidget);
    });

    testWidgets('reports selection and close', (tester) async {
      final selected = <String>[];
      final closed = <String>[];
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            onSelect: selected.add,
            onClose: closed.add,
          ),
        ),
      );

      await tester.tap(find.byKey(const Key('open-session-tab-codex/b')));
      await tester.tap(
        find.byKey(const Key('open-session-tab-close-claude/a')),
      );

      expect(selected, ['codex/b']);
      expect(closed, ['claude/a']);
    });

    // The one Chrome tab affordance that needs no chord and no browser
    // reservation, so it works identically on native and on web.
    testWidgets('middle-click closes a tab without selecting it', (
      tester,
    ) async {
      final selected = <String>[];
      final closed = <String>[];
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            onSelect: selected.add,
            onClose: closed.add,
          ),
        ),
      );

      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('open-session-tab-codex/b'))),
        kind: PointerDeviceKind.mouse,
        buttons: kMiddleMouseButton,
      );
      await gesture.up();
      await tester.pumpAndSettle();

      expect(closed, ['codex/b']);
      expect(selected, isEmpty);
    });

    testWidgets('a primary click still selects rather than closes', (
      tester,
    ) async {
      final selected = <String>[];
      final closed = <String>[];
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            onSelect: selected.add,
            onClose: closed.add,
          ),
        ),
      );

      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('open-session-tab-codex/b'))),
        kind: PointerDeviceKind.mouse,
      );
      await gesture.up();
      await tester.pumpAndSettle();

      expect(selected, ['codex/b']);
      expect(closed, isEmpty);
    });

    testWidgets('a mouse wheel scrolls the strip horizontally', (tester) async {
      // Narrow viewport plus many tabs, so the strip actually overflows.
      tester.view
        ..physicalSize = const Size(400, 200)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [
              for (var i = 0; i < 12; i++)
                _ref('claude', 'session-$i', title: 'Session number $i'),
            ],
            activeKey: 'claude/session-0',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      final scrollable = tester.widget<Scrollable>(
        find
            .descendant(
              of: find.byType(OpenSessionsTabStrip),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      final position = scrollable.controller!.position;
      expect(
        position.maxScrollExtent,
        greaterThan(0),
        reason: 'the strip must overflow for the wheel to have anything to do',
      );
      expect(position.pixels, 0);

      // A mouse wheel emits a vertical delta only; the strip should still move.
      final center = tester.getCenter(find.byType(OpenSessionsTabStrip));
      final pointer = TestPointer(1, PointerDeviceKind.mouse);
      tester.binding.handlePointerEvent(pointer.hover(center));
      tester.binding.handlePointerEvent(
        pointer.scroll(const Offset(0, 120)),
      );
      await tester.pumpAndSettle();

      expect(position.pixels, 120);

      // And it clamps at the end rather than running past it.
      tester.binding.handlePointerEvent(
        pointer.scroll(const Offset(0, 100000)),
      );
      await tester.pumpAndSettle();
      expect(position.pixels, position.maxScrollExtent);
    });

    testWidgets('the bottom hairline is a draggable scrollbar on overflow', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(400, 200)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [
              for (var i = 0; i < 12; i++)
                _ref('claude', 'session-$i', title: 'Session number $i'),
            ],
            activeKey: 'claude/session-0',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The scrollbar lives inside the strip: no extra height.
      expect(tester.getSize(find.byType(OpenSessionsTabStrip)).height, 32);

      final scrollbar = find.byKey(const Key('open-sessions-tab-scrollbar'));
      expect(scrollbar, findsOneWidget);
      // Overflowing tabs make the track interactive.
      expect(
        find.descendant(
          of: scrollbar,
          matching: find.byType(GestureDetector),
        ),
        findsOneWidget,
      );

      final position = tester
          .widget<Scrollable>(
            find
                .descendant(
                  of: find.byType(OpenSessionsTabStrip),
                  matching: find.byType(Scrollable),
                )
                .first,
          )
          .controller!
          .position;
      expect(position.maxScrollExtent, greaterThan(0));
      expect(position.pixels, 0);

      // Dragging the thumb right scrolls the strip right...
      await tester.drag(scrollbar, const Offset(60, 0));
      await tester.pumpAndSettle();
      expect(position.pixels, greaterThan(0));

      // ...and dragging far left clamps back to the start.
      await tester.drag(scrollbar, const Offset(-4000, 0));
      await tester.pumpAndSettle();
      expect(position.pixels, 0);

      // Tapping the far end of the track jumps toward it.
      final trackRect = tester.getRect(scrollbar);
      await tester.tapAt(
        Offset(trackRect.right - 2, trackRect.bottom - 2),
      );
      await tester.pumpAndSettle();
      expect(position.pixels, position.maxScrollExtent);
    });

    testWidgets('the scrollbar is inert when the tabs fit', (tester) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      final scrollbar = find.byKey(const Key('open-sessions-tab-scrollbar'));
      expect(scrollbar, findsOneWidget);
      // No overflow: the track is the plain hairline — nothing interactive
      // and nothing stealing taps from the tabs above it.
      expect(
        find.descendant(
          of: scrollbar,
          matching: find.byType(GestureDetector),
        ),
        findsNothing,
      );
      expect(tester.getSize(find.byType(OpenSessionsTabStrip)).height, 32);
    });

    // U3. `SessionRef.fromSession` writes the session id into the title slot
    // when the broker reports no title, so a resolved untitled tab used to
    // read as a fingerprint — and disagree with the top strip, which names the
    // same session "Untitled session". The strip is the Compact single-pane
    // surface, so this is where a phone user would have seen it.
    testWidgets('a resolved untitled tab shows the label, not the id', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: const [
              SessionRef(
                tool: 'claude',
                id: 'ses_untitled_01',
                // Exactly what `SessionRef.fromSession` produces for an
                // authoritatively untitled session.
                title: 'ses_untitled_01',
                status: SessionStatus.idle,
              ),
              SessionRef(
                tool: 'codex',
                id: 'ses_named_02',
                title: 'Named tab',
                status: SessionStatus.idle,
              ),
            ],
            activeKey: 'claude/ses_untitled_01',
            onSelect: (_) {},
            onClose: (_) {},
          ),
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Untitled session'), findsOneWidget);
      expect(find.text('ses_untitled_01'), findsNothing);
      expect(find.text('Named tab'), findsOneWidget);
    });

    testWidgets('a never-resolved tab shows the opening label', (tester) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: const [
              // `SessionRef.cachedIdentity` with nothing better than the id.
              SessionRef.cachedIdentity(
                tool: 'claude',
                id: 'ses_deep_link_01',
                title: 'ses_deep_link_01',
              ),
              SessionRef(
                tool: 'codex',
                id: 'ses_named_02',
                title: 'Named tab',
                status: SessionStatus.idle,
              ),
            ],
            activeKey: 'claude/ses_deep_link_01',
            onSelect: (_) {},
            onClose: (_) {},
          ),
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Opening session'), findsOneWidget);
      expect(find.text('Untitled session'), findsNothing);
      expect(find.text('ses_deep_link_01'), findsNothing);
    });

    testWidgets('tabs use pulse and full ring status contracts', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [
              _ref(
                'claude',
                'working',
                title: 'Working',
                status: SessionStatus.working,
              ),
              _ref(
                'codex',
                'needs-input',
                title: 'Needs input',
                status: SessionStatus.needsInput,
              ),
            ],
            activeKey: 'claude/working',
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );
      await tester.pump();

      StatusDot marker(String key) => tester.widget<StatusDot>(
        find
            .descendant(
              of: find.byKey(Key('open-session-tab-$key')),
              matching: find.byType(StatusDot),
            )
            .first,
      );

      expect(marker('claude/working').pulse, isTrue);
      expect(marker('claude/working').ringColor, isNull);
      expect(marker('codex/needs-input').pulse, isFalse);
      expect(marker('codex/needs-input').ringColor, isNotNull);
      expect(marker('codex/needs-input').ringGapColor, isNotNull);
    });
  });
}
