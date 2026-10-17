import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
  Widget host(Widget child, {Locale? locale, BrokerProfile? profile}) =>
      ProviderScope(
        overrides: [activeBrokerProfileProvider.overrideWith((ref) => profile)],
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          locale: locale,
          theme: buildAppTheme(
            themeSpecById(kDefaultThemeId).light,
            Brightness.light,
          ),
          home: Scaffold(body: child),
        ),
      );

  group('OpenSessionsTabStrip', () {
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
      testWidgets('$kind uses drag for reorder and hold for rename', (
        tester,
      ) async {
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
            profile: BrokerProfile(
              id: 'studio',
              displayName: 'Studio',
              baseUri: Uri.parse('http://studio.test:7734'),
              createdAt: DateTime.utc(2026),
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
        if (kind == PointerDeviceKind.mouse) {
          expect(moves, [(1, 0)]);
        } else {
          expect(moves, isEmpty);
          expect(find.byType(AlertDialog), findsOneWidget);
          expect(
            find.byKey(const Key('session-rename-dialog-input')),
            findsOneWidget,
          );
        }
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
  });
}
