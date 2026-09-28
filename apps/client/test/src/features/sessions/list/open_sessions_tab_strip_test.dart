import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_harness_logo.dart';
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
    // Widget tests default to Android, whose density is standard; desktop and
    // web desktop resolve `adaptivePlatformDensity` to compact. That is where
    // the tab row once shrank and its title rode the top of the tab, so the
    // geometry is pinned under a desktop platform too.
    testWidgets(
      'a desktop-width tab fills and centres in the strip',
      (
        tester,
      ) async {
        tester.view
          ..physicalSize = const Size(1440, 900)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          host(
            OpenSessionsTabStrip(
              refs: [
                _ref('codex', 'a', title: 'Refine session navigation'),
                _ref('claude', 'b', title: 'Improve reconnect handling'),
              ],
              activeKey: 'codex/a',
              onSelect: (_) {},
              onClose: (_) {},
              onOverview: () {},
            ),
          ),
        );
        await tester.pumpAndSettle();

        final strip = tester.getRect(find.byType(OpenSessionsTabStrip));
        expect(strip.height, OpenSessionsTabStrip.height);
        final tab = tester.getRect(
          find
              .descendant(
                of: find.byKey(const Key('open-session-tab-codex/a')),
                matching: find.byType(Material),
              )
              .first,
        );
        expect(tab.height, OpenSessionsTabStrip.tabHeight);
        expect(tab.center.dy, moreOrLessEquals(strip.center.dy, epsilon: 1));
        final close = tester.getRect(
          find.byKey(const Key('open-session-tab-close-codex/a')),
        );
        expect(close.size, const Size.square(28));
        expect(close.center.dy, moreOrLessEquals(tab.center.dy, epsilon: 0.5));
        final title = tester.getRect(find.text('Refine session navigation'));
        expect(title.center.dy, moreOrLessEquals(tab.center.dy, epsilon: 1));
      },
      variant: const TargetPlatformVariant({
        TargetPlatform.windows,
        TargetPlatform.android,
      }),
    );

    testWidgets('the labelled Overview tab is its own tappable button', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      tester.view
        ..physicalSize = const Size(1440, 900)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var overviews = 0;
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('codex', 'a', title: 'Refine session navigation')],
            activeKey: null,
            onSelect: (_) {},
            onClose: (_) {},
            onOverview: () => overviews++,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final tab = find.byKey(const Key('workspace-overview-tab'));
      final node = tester.getSemantics(tab);
      // Its flags once merged into the page around it, which then announced
      // itself as one selected "Overview" button with nothing to tap.
      expect(node.rect.size, tester.getSize(tab));
      expect(
        node,
        isSemantics(
          label: 'Overview',
          isButton: true,
          isSelected: true,
          hasTapAction: true,
        ),
      );
      tester.semantics.tap(find.semantics.byLabel('Overview'));
      expect(overviews, 1);
      semantics.dispose();
    });

    testWidgets('a phone swipe scrolls reorderable tabs without moving them', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final moves = <(int, int)>[];
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [
              for (var i = 0; i < 12; i++)
                _ref('codex', '$i', title: 'Session $i'),
            ],
            activeKey: 'codex/0',
            onSelect: (_) {},
            onClose: (_) {},
            onOverview: () {},
            onOpenRoster: () {},
            onReorder: (oldIndex, newIndex) => moves.add((oldIndex, newIndex)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final position = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position;
      expect(position.maxScrollExtent, greaterThan(0));
      await tester.dragFrom(const Offset(280, 22), const Offset(-130, 0));
      await tester.pumpAndSettle();
      expect(position.pixels, greaterThan(0));
      expect(moves, isEmpty);
    });

    for (final kind in [PointerDeviceKind.touch, PointerDeviceKind.mouse]) {
      testWidgets('$kind can deliberately reorder tabs', (tester) async {
        tester.view
          ..physicalSize = const Size(390, 844)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final moves = <(int, int)>[];
        final closed = <String>[];
        await tester.pumpWidget(
          host(
            OpenSessionsTabStrip(
              refs: [
                _ref('codex', '0', title: 'First'),
                _ref('codex', '1', title: 'Second'),
              ],
              activeKey: 'codex/0',
              onSelect: (_) {},
              onClose: closed.add,
              onReorder: (oldIndex, newIndex) =>
                  moves.add((oldIndex, newIndex)),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final first = tester.getRect(
          find.byKey(const Key('open-session-tab-codex/0')),
        );
        final second = tester.getRect(
          find.byKey(const Key('open-session-tab-codex/1')),
        );
        final gesture = await tester.startGesture(second.center, kind: kind);
        if (kind == PointerDeviceKind.touch) {
          await tester.pump(const Duration(milliseconds: 600));
        }
        // Cross the insertion midpoint over real frames. A single teleport
        // beyond the first tab can skip Flutter's intermediate insertion gap.
        for (var frame = 1; frame <= 8; frame++) {
          await gesture.moveTo(
            Offset.lerp(second.center, first.center, frame / 8)!,
          );
          await tester.pump(const Duration(milliseconds: 32));
        }
        await tester.pump(const Duration(milliseconds: 300));
        await gesture.up();
        await tester.pumpAndSettle();
        expect(moves, [(1, 0)]);
        expect(closed, isEmpty);
      });
    }

    testWidgets('keeps a single session visible and closable', (tester) async {
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

      expect(
        find.byKey(const Key('open-session-tab-claude/a')),
        findsOneWidget,
      );
    });

    testWidgets('unread completion cue is separate from harness and close', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          OpenSessionsTabStrip(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'claude/a',
            unreadCompletionKeys: const {'codex/b'},
            onSelect: (_) {},
            onClose: (_) {},
          ),
        ),
      );
      expect(
        find.byKey(const Key('open-session-tab-unread-codex/b')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('open-session-tab-unread-claude/a')),
        findsNothing,
      );
      expect(find.byType(SessionHarnessLogo), findsNWidgets(2));
      expect(
        find.byKey(const Key('open-session-tab-close-codex/b')),
        findsOneWidget,
      );
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
      expect(
        tester.getSize(find.byType(OpenSessionsTabStrip)).height,
        44,
      );

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
      expect(
        tester.getSize(find.byType(OpenSessionsTabStrip)).height,
        OpenSessionsTabStrip.height,
      );
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

    testWidgets('tabs separate original harness marks from input status', (
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

      expect(find.byType(SessionHarnessLogo), findsNWidgets(2));
      expect(marker('codex/needs-input').pulse, isFalse);
      expect(marker('codex/needs-input').ringColor, isNull);
      expect(marker('codex/needs-input').size, 4);
    });
  });
}
