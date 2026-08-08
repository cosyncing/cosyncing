import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/view/sessions_branch_screen.dart';
import 'package:cosyncing_client/src/features/sessions/view/sessions_page.dart';
import 'package:cosyncing_client/src/features/sessions/view/sessions_workspace.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/session_detail_page_test_harness.dart'
    show
        InMemorySessionControlPreferencesStore,
        InMemorySessionDriveIntentStore,
        InMemorySessionModelPreferenceStore,
        InMemorySessionNotificationSettingsStore,
        InMemorySessionOutboxRepository,
        InMemorySessionTranscriptRepository;

void main() {
  Widget buildAt(Size size) {
    return ProviderScope(
      overrides: [
        sessionListControllerProvider.overrideWith(
          () => _StubSessionListController(
            const SessionListState(
              status: SessionListStatus.loaded,
              sessions: [
                SessionInfo(
                  id: 'a',
                  tool: 'claude',
                  title: 'First',
                  status: SessionStatus.idle,
                  attachMode: AttachMode.observe,
                ),
              ],
            ),
          ),
        ),
        openSessionsStoreProvider.overrideWithValue(_FakeOpenSessionsStore()),
        ..._sessionStoreOverrides(),
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: 'p1',
            displayName: 'p1',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026),
          ),
        ),
        brokerClientProvider.overrideWith((ref) async => null),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        home: MediaQuery(
          data: MediaQueryData(size: size),
          child: const SessionsBranchScreen(),
        ),
      ),
    );
  }

  group('SessionsBranchScreen', () {
    testWidgets('renders the two-pane workspace at Expanded width', (
      tester,
    ) async {
      await tester.pumpWidget(buildAt(const Size(1100, 800)));
      await tester.pumpAndSettle();

      expect(find.byType(SessionsWorkspace), findsOneWidget);
      expect(find.byType(SessionsPage), findsNothing);
      expect(find.text('Select a session to open it here.'), findsOneWidget);
    });

    testWidgets('renders the single-pane page at Compact width', (
      tester,
    ) async {
      await tester.pumpWidget(buildAt(const Size(400, 800)));
      await tester.pumpAndSettle();

      expect(find.byType(SessionsPage), findsOneWidget);
      expect(find.byType(SessionsWorkspace), findsNothing);
    });
  });

  // Regression: resizing an open session down to phone width used to drop the
  // user back on the bare roster. The two layouts encode "a session is open"
  // differently — Expanded keeps it as the active tab while the location stays
  // /sessions, Compact pushes /sessions/<tool>/<id> — and nothing bridged them.
  group('SessionsBranchScreen width transitions', () {
    late GoRouter router;

    // Resize the view rather than re-pumping a fresh ProviderScope: rebuilding
    // the scope would tear down and recreate every provider, which is a
    // different scenario (and a second Drift database) rather than a resize.
    void resize(WidgetTester tester, Size size) {
      tester.view
        ..physicalSize = size
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view
          ..resetPhysicalSize()
          ..resetDevicePixelRatio();
      });
    }

    Widget buildRouted({required OpenSessionsStore store}) {
      return ProviderScope(
        overrides: [
          sessionListControllerProvider.overrideWith(
            () => _StubSessionListController(
              const SessionListState(
                status: SessionListStatus.loaded,
                sessions: [
                  SessionInfo(
                    id: 'a',
                    tool: 'claude',
                    title: 'First',
                    status: SessionStatus.idle,
                    attachMode: AttachMode.observe,
                  ),
                ],
              ),
            ),
          ),
          openSessionsStoreProvider.overrideWithValue(store),
          ..._sessionStoreOverrides(),
          activeBrokerProfileProvider.overrideWith(
            (ref) => BrokerProfile(
              id: 'p1',
              displayName: 'p1',
              baseUri: Uri.parse('http://127.0.0.1:7734'),
              createdAt: DateTime(2026),
            ),
          ),
          brokerClientProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp.router(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: buildAppTheme(
            themeSpecById(kDefaultThemeId).light,
            Brightness.light,
          ),
          routerConfig: router,
        ),
      );
    }

    setUp(() {
      router = GoRouter(
        initialLocation: '/sessions',
        routes: [
          GoRoute(
            path: '/sessions',
            builder: (context, state) => const SessionsBranchScreen(),
            routes: [
              GoRoute(
                path: ':tool/:id',
                builder: (context, state) =>
                    const Scaffold(body: Text('detail stub')),
              ),
            ],
          ),
        ],
      );
    });

    testWidgets('carries the open session into the compact layout', (
      tester,
    ) async {
      final store = _FakeOpenSessionsStore()
        ..saved['p1'] = const OpenSessionsSnapshot(
          refs: [
            SessionRef(
              tool: 'claude',
              id: 'a',
              title: 'First',
              status: SessionStatus.idle,
            ),
          ],
          activeKey: 'claude/a',
        );

      resize(tester, const Size(1100, 800));
      await tester.pumpWidget(buildRouted(store: store));
      await tester.pumpAndSettle();
      expect(find.byType(SessionsWorkspace), findsOneWidget);

      // Shrink past the list/detail breakpoint with the session still open.
      resize(tester, const Size(400, 800));
      await tester.pumpAndSettle();

      expect(
        router.state.uri.path,
        sessionDetailLocation(tool: 'claude', sessionId: 'a'),
        reason: 'collapsing should push the open session, not the roster',
      );
      expect(find.text('detail stub'), findsOneWidget);
    });

    testWidgets('stays on the roster when nothing is open', (tester) async {
      final store = _FakeOpenSessionsStore();

      resize(tester, const Size(1100, 800));
      await tester.pumpWidget(buildRouted(store: store));
      await tester.pumpAndSettle();

      resize(tester, const Size(400, 800));
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/sessions');
      expect(find.byType(SessionsPage), findsOneWidget);
    });

    // Back out of the detail route and the roster must stay put. Redirecting on
    // every compact build (rather than on the transition) would re-push the
    // detail route here and make Back unusable.
    testWidgets('does not re-push the session after going back', (
      tester,
    ) async {
      final store = _FakeOpenSessionsStore()
        ..saved['p1'] = const OpenSessionsSnapshot(
          refs: [
            SessionRef(
              tool: 'claude',
              id: 'a',
              title: 'First',
              status: SessionStatus.idle,
            ),
          ],
          activeKey: 'claude/a',
        );

      resize(tester, const Size(1100, 800));
      await tester.pumpWidget(buildRouted(store: store));
      await tester.pumpAndSettle();
      resize(tester, const Size(400, 800));
      await tester.pumpAndSettle();
      expect(find.text('detail stub'), findsOneWidget);

      router.go('/sessions');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/sessions');
      expect(find.byType(SessionsPage), findsOneWidget);
      expect(find.text('detail stub'), findsNothing);
    });
  });
}

List<Override> _sessionStoreOverrides() => <Override>[
  sessionDisplayPreferencesStoreProvider.overrideWithValue(
    InMemorySessionDisplayPreferencesStore(),
  ),
  workspacePrefsStoreProvider.overrideWithValue(_FakeWorkspacePrefsStore()),
  sessionLiveStateViewStoreProvider.overrideWithValue(
    InMemorySessionLiveStateViewStore(),
  ),
  sessionArtifactTransferRepositoryProvider.overrideWithValue(
    InMemorySessionArtifactTransferRepository(),
  ),
  sessionOutboxRepositoryProvider.overrideWithValue(
    InMemorySessionOutboxRepository(),
  ),
  sessionTranscriptRepositoryProvider.overrideWithValue(
    InMemorySessionTranscriptRepository(),
  ),
  sessionControlPreferencesStoreProvider.overrideWithValue(
    InMemorySessionControlPreferencesStore(),
  ),
  sessionDriveIntentStoreProvider.overrideWithValue(
    InMemorySessionDriveIntentStore(),
  ),
  sessionModelPreferenceStoreProvider.overrideWithValue(
    InMemorySessionModelPreferenceStore(),
  ),
  sessionNotificationSettingsStoreProvider.overrideWithValue(
    InMemorySessionNotificationSettingsStore(),
  ),
];

class _StubSessionListController extends SessionListController {
  _StubSessionListController(this._preset);

  final SessionListState _preset;

  @override
  SessionListState build() => _preset;

  @override
  Future<void> load({bool silent = false}) async {}
}

class _FakeOpenSessionsStore implements OpenSessionsStore {
  final Map<String, OpenSessionsSnapshot> saved =
      <String, OpenSessionsSnapshot>{};

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      saved[profileId] ?? OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    saved[profileId] = snapshot;
  }
}

class _FakeWorkspacePrefsStore implements WorkspacePrefsStore {
  WorkspaceRosterPrefs? saved;

  @override
  Future<WorkspaceRosterPrefs?> loadRoster() async => saved;

  @override
  Future<void> saveRoster(WorkspaceRosterPrefs prefs) async {
    saved = prefs;
  }
}
