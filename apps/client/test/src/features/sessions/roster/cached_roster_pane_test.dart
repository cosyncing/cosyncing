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
    String? modelLabel,
    String? modelId,
  }) => SessionRosterIdentity(
    tool: tool,
    sessionId: id,
    title: title,
    machine: machine,
    cwd: cwd,
    nativeId: nativeId,
    parentThreadId: parentThreadId,
    origin: origin,
    modelLabel: modelLabel,
    modelId: modelId,
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
                // Origin-null lineage: a subagent child would be folded
                // away, since the cached pane mirrors the live closed default.
                identity(
                  id: 'child',
                  title: 'Child',
                  nativeId: 'n-child',
                  parentThreadId: 'n-parent',
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
