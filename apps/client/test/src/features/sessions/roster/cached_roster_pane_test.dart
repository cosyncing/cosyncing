import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/cached_roster_pane.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// N3: what the cached roster is allowed to say, and what it must never say.
void main() {
  Widget host(
    Widget child, {
    Brightness brightness = Brightness.light,
    Locale locale = const Locale('en'),
  }) => ProviderScope(
    child: MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        brightness == Brightness.dark
            ? themeSpecById(kDefaultThemeId).dark
            : themeSpecById(kDefaultThemeId).light,
        brightness,
      ),
      home: Scaffold(body: child),
    ),
  );

  SessionRosterIdentity identity({
    String id = 's1',
    String tool = 'codex',
    String title = 'Cached session',
    String? machine = 'mac',
    String? cwd = '/work/alpha',
    String? nativeId,
    String? parentThreadId,
    SessionOrigin? origin,
  }) => SessionRosterIdentity(
    tool: tool,
    sessionId: id,
    title: title,
    machine: machine,
    cwd: cwd,
    nativeId: nativeId,
    parentThreadId: parentThreadId,
    origin: origin,
  );

  CachedRosterPresentation presentation({
    List<SessionRosterIdentity>? rows,
    CachedRosterReason reason = CachedRosterReason.hydrating,
    int omitted = 0,
  }) => CachedRosterPresentation(
    snapshot: SessionRosterSnapshot(
      brokerProfileId: 'profile-a',
      rows: rows ?? [identity()],
      capturedAt: DateTime.now(),
      omittedRowCount: omitted,
    ),
    reason: reason,
  );

  const groupKey = 'mac\x00/work/alpha';

  Future<void> expandGroup(WidgetTester tester, String key) async {
    await tester.tap(find.byKey(ValueKey('cached-project-header-$key')));
    await tester.pumpAndSettle();
  }

  group('truthfulness', () {
    testWidgets(
      'a cached row claims no status, count, ready state or control',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          host(
            CachedRosterPane(
              presentation: presentation(),
              onOpen: (_) {},
              visibilityPreferences: const SessionVisibilityPreferences(),
            ),
          ),
        );
        await expandGroup(tester, groupKey);

        // No activity pill of any kind.
        expect(find.byType(StatusPill), findsNothing);
        // None of the status words, in the row or the header.
        for (final claim in ['Working', 'Needs input', 'Idle']) {
          expect(
            find.text(claim),
            findsNothing,
            reason: 'a cached row must not claim "$claim"',
          );
        }
        // No status counts and no ready-to-review dot.
        expect(
          find.byKey(const ValueKey('project-counts-$groupKey')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('project-ready-$groupKey')),
          findsNothing,
        );
        expect(find.byType(StatusDot), findsNothing);
        // And it says out loud that it is not current.
        expect(find.text('Last known'), findsOneWidget);
      },
    );

    testWidgets('the reconnecting banner states that activity is not current', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-banner')), findsOneWidget);
      expect(find.textContaining("isn't current"), findsOneWidget);
      expect(find.byKey(const Key('cached-roster-retry')), findsNothing);
    });

    testWidgets('the unreachable banner exposes Retry', (tester) async {
      var retried = 0;
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(reason: CachedRosterReason.unreachable),
            onOpen: (_) {},
            onRetry: () async => retried++,
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-retry')), findsOneWidget);
      await tester.tap(find.byKey(const Key('cached-roster-banner')));
      await tester.pump();
      expect(retried, 1);
    });

    testWidgets('a bounded snapshot admits what it dropped', (tester) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(omitted: 12),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-partial')), findsOneWidget);
      expect(find.textContaining('12 more sessions'), findsOneWidget);
    });

    testWidgets('renders Chinese copy from the ARB', (tester) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
          locale: const Locale('zh'),
        ),
      );
      await expandGroup(tester, groupKey);

      expect(find.textContaining('上次已知'), findsWidgets);
    });
  });

  group('shape', () {
    testWidgets('projects start collapsed, as R1b requires', (tester) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(
        find.byKey(const ValueKey('cached-project-header-$groupKey')),
        findsOneWidget,
      );
      expect(find.text('Cached session'), findsNothing);

      await expandGroup(tester, groupKey);
      expect(find.text('Cached session'), findsOneWidget);
    });

    testWidgets('a child row stays adjacent to and indented under its parent', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(
              rows: [
                identity(id: 'parent', title: 'Parent', nativeId: 'n-parent'),
                identity(
                  id: 'child',
                  title: 'Child',
                  nativeId: 'n-child',
                  parentThreadId: 'n-parent',
                  origin: SessionOrigin.subagent,
                ),
              ],
            ),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(
              showBackgroundSessions: true,
            ),
          ),
        ),
      );
      await expandGroup(tester, groupKey);

      final parentY = tester.getTopLeft(find.text('Parent')).dy;
      final childY = tester.getTopLeft(find.text('Child')).dy;
      expect(childY, greaterThan(parentY));
      expect(
        tester.getTopLeft(find.text('Child')).dx,
        greaterThan(tester.getTopLeft(find.text('Parent')).dx),
        reason: 'a cached child indents beneath its parent',
      );
    });

    testWidgets('opening a cached row reports its exact identity', (
      tester,
    ) async {
      final opened = <String>[];
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(rows: [identity(id: 'exact-id')]),
            onOpen: (row) => opened.add('${row.tool}/${row.sessionId}'),
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await expandGroup(tester, groupKey);
      expect(
        find.ancestor(
          of: find.text('Cached session'),
          matching: find.byType(SelectionArea),
        ),
        findsNothing,
        reason: 'cached rows are navigation and carry no selection region',
      );
      await tester.drag(find.text('Cached session'), const Offset(80, 0));
      await tester.pump();
      expect(opened, isEmpty, reason: 'drag selection must not open the row');
      await tester.tap(find.text('Cached session'));
      await tester.pump();

      expect(opened, ['codex/exact-id']);
    });

    testWidgets('reads correctly in dark mode', (tester) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
          brightness: Brightness.dark,
        ),
      );
      await expandGroup(tester, groupKey);

      expect(find.text('Last known'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('cached cwd is non-selectable metadata, no copy affordance', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      final cwd = find.byKey(
        const ValueKey('cached-project-cwd-$groupKey'),
      );
      expect(cwd, findsOneWidget);
      final cwdText = tester.widget<Text>(cwd);
      expect(cwdText.data, '/work/alpha');
      expect(cwdText.overflow, TextOverflow.ellipsis);
      // Matches the authoritative header: the copy button and the decorated
      // code surface it sat in are both gone, leaving a plain `Text`.
      expect(find.byType(CopyableCodeLine), findsNothing);
      expect(find.byTooltip('Copy command'), findsNothing);
      // Reading the path leaves the group collapsed, as before.
      expect(
        tester
            .widget<Icon>(
              find.byKey(const ValueKey('cached-project-collapse-$groupKey')),
            )
            .icon,
        Icons.chevron_right,
      );
      expect(find.text('Cached session'), findsNothing);
    });
  });

  group('SessionListPane integration', () {
    testWidgets('cached rows replace the spinner while the roster is empty', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: const [],
            status: SessionListStatus.loading,
            cachedRoster: presentation(),
            onOpenCached: (_) {},
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-pane')), findsOneWidget);
      expect(find.byKey(const Key('session-roster-loading')), findsNothing);
    });

    testWidgets('authoritative rows always win over cached ones', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: const [
              SessionInfo(
                id: 'live',
                tool: 'codex',
                title: 'Live session',
                status: SessionStatus.working,
                attachMode: AttachMode.live,
                machine: 'mac',
                cwd: '/work/alpha',
              ),
            ],
            cachedRoster: presentation(),
            onOpenCached: (_) {},
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-pane')), findsNothing);
      expect(find.byKey(const Key('session-roster-list')), findsOneWidget);
    });

    testWidgets('an empty snapshot falls back to the loading treatment', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          SessionListPane(
            sessions: const [],
            status: SessionListStatus.loading,
            cachedRoster: presentation(rows: const []),
            onOpenCached: (_) {},
            activeKey: null,
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );

      expect(find.byKey(const Key('cached-roster-pane')), findsNothing);
      expect(find.byKey(const Key('session-roster-loading')), findsOneWidget);
    });
  });

  group('selection region', () {
    // This pane mirrors the authoritative roster exactly: no selection region
    // and no per-row island. On web a SelectionArea carries a platform view
    // whose placeholder throws when a scrolling viewport collects it
    // (flutter/flutter#122680, fixed by #186840, absent from the 3.44.3 we
    // pin). No exception was captured and there is no deterministic repro, so
    // that cause is unproven; the reported grey RenderErrorBox is consistent
    // with it, and dropping SelectionArea removes the mechanism regardless.
    testWidgets('the cached roster carries no selection machinery', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(
              rows: [
                identity(title: 'Cached first'),
                identity(id: 's2', title: 'Cached second'),
                identity(id: 's3', title: 'Cached third'),
              ],
            ),
            onOpen: (_) {},
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await expandGroup(tester, groupKey);

      expect(find.byType(SelectionArea), findsNothing);
      expect(find.byType(SelectableTapRegion), findsNothing);
      for (final title in ['Cached first', 'Cached second', 'Cached third']) {
        expect(
          find.ancestor(
            of: find.text(title),
            matching: find.byType(SelectableRegion),
          ),
          findsNothing,
          reason: '$title must not sit inside any selectable region',
        );
      }
    });

    // The other half of the same change: the row's own InkWell now sees the
    // tap directly. While the row carried a selection island, that island's
    // recognizer won the arena and swallowed the tap, so the region
    // re-supplied it — leaving both to fire once the island went away.
    testWidgets('opening a cached row reports it exactly once', (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(
        host(
          CachedRosterPane(
            presentation: presentation(
              rows: [
                identity(title: 'Cached first'),
                identity(id: 's2', title: 'Cached second'),
              ],
            ),
            onOpen: (row) => opened.add(row.sessionId),
            visibilityPreferences: const SessionVisibilityPreferences(),
          ),
        ),
      );
      await expandGroup(tester, groupKey);

      await tester.tap(find.text('Cached second'));
      await tester.pumpAndSettle();
      expect(opened, ['s2']);
    });
  });
}
