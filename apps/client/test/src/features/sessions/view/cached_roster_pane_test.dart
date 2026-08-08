import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/view/cached_roster_pane.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_list_pane.dart';
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
}
