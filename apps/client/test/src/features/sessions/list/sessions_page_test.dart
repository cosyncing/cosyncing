import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../../../support/in_memory_roster_snapshot_repository.dart';
import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/roster_expansion.dart';

void main() {
  late InMemorySessionListRepository fakeRepo;

  setUp(() {
    fakeRepo = InMemorySessionListRepository();
  });

  InMemorySessionDisplayPreferencesStore unboundedRosterPreferences() =>
      InMemorySessionDisplayPreferencesStore()..sessionRosterWindow = 'all';

  /// One in-memory database per test, in place of the production one.
  ///
  /// The page pulls in the active-profile store and the roster snapshot
  /// repository, both of which read `appDatabaseProvider`. Unoverridden that is
  /// `AppDatabase.defaults()` — the real on-disk `cosyncing_client` database —
  /// so every widget test here was one executed query away from the developer's
  /// own data, and from every other test's.
  ///
  /// Drift still warns that `AppDatabase` was constructed more than once; it
  /// warns on the class, not on the executor, so per-test in-memory databases
  /// always trip it. `session_detail_page_test_harness.dart` does the same.
  List<Override> localStorageOverrides({RosterSnapshotRepository? snapshots}) {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    return [
      appDatabaseProvider.overrideWithValue(database),
      rosterSnapshotRepositoryProvider.overrideWithValue(
        snapshots ?? InMemoryRosterSnapshotRepository(),
      ),
    ];
  }

  Widget buildSubject({
    List<SessionInfo>? sessions,
    BrokerProfile? activeProfile,
    BrokerClient? brokerClient,
  }) {
    fakeRepo.sessions = sessions ?? [];
    return ProviderScope(
      overrides: [
        ...localStorageOverrides(),
        sessionListRepositoryProvider.overrideWith((ref) async => fakeRepo),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          unboundedRosterPreferences(),
        ),
        sessionLiveStateViewStoreProvider.overrideWithValue(
          InMemorySessionLiveStateViewStore(),
        ),
        if (activeProfile != null)
          activeBrokerProfileProvider.overrideWith((ref) => activeProfile),
        if (brokerClient != null)
          brokerClientProvider.overrideWith((ref) async => brokerClient),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        home: const SessionsPage(),
      ),
    );
  }

  Widget buildRoutedSubject({
    List<SessionInfo>? sessions,
    SessionListRepository? repository,
    RosterSnapshotRepository? snapshots,
    OpenSessionsStore? openSessions,
  }) {
    fakeRepo.sessions = sessions ?? [];
    return ProviderScope(
      overrides: [
        ...localStorageOverrides(snapshots: snapshots),
        openSessionsStoreProvider.overrideWithValue(
          openSessions ?? _MemoryOpenSessionsStore(),
        ),
        sessionListRepositoryProvider.overrideWith(
          (ref) async => repository ?? fakeRepo,
        ),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          unboundedRosterPreferences(),
        ),
        sessionArtifactTransferRepositoryProvider.overrideWithValue(
          InMemorySessionArtifactTransferRepository(),
        ),
        activeBrokerProfileProvider.overrideWith((ref) {
          final now = DateTime(2026, 6, 26);
          return BrokerProfile(
            id: 'local',
            displayName: 'local',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: now,
          );
        }),
        sessionDetailConnectionFactoryProvider.overrideWithValue(
          ({required resolver, required sessionId, required tool}) =>
              _NeverConnectsSessionDetailConnection(),
        ),
      ],
      child: MaterialApp.router(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        routerConfig: createGoRouter(),
      ),
    );
  }

  group('SessionsPage', () {
    testWidgets(
      'a failed refresh keeps the rows and leaves Retry to the shared slot',
      (tester) async {
        // Compact used to swap the whole roster for an error page while
        // Expanded kept the rows behind its own Retry banner, so one failure
        // meant two different things depending on the width (R0b).
        await tester.pumpWidget(
          buildSubject(
            sessions: [
              const SessionInfo(
                id: 's1',
                tool: 'claude',
                title: 'Kept session',
                status: SessionStatus.idle,
                attachMode: AttachMode.live,
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('roster-freshness-refresh')),
          findsOneWidget,
        );

        fakeRepo.shouldFail = true;
        await tester.tap(find.byKey(const Key('roster-freshness-refresh')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 250));

        expect(find.text('Failed to load sessions'), findsNothing);
        expect(find.byKey(const Key('session-roster-list')), findsOneWidget);
        await expandRosterProject(tester, settle: false);
        expect(find.text('Kept session'), findsOneWidget);

        // Exactly one Retry, and it is the shared slot — not a second banner.
        expect(find.byKey(const Key('roster-freshness-retry')), findsOneWidget);
        expect(find.byKey(const Key('roster-freshness-busy')), findsNothing);
        expect(
          find.byKey(const Key('session-roster-stale-error')),
          findsNothing,
        );
        expect(find.widgetWithText(FilledButton, 'Retry'), findsNothing);
      },
    );

    testWidgets('shows empty state when no sessions', (tester) async {
      await tester.pumpWidget(buildSubject(sessions: []));
      await tester.pumpAndSettle();

      expect(find.text('Connect to a server'), findsNWidgets(2));
      expect(find.byKey(const Key('sessions-empty-title')), findsOneWidget);
      expect(find.byKey(const Key('sessions-empty-connect')), findsOneWidget);
      expect(
        find.text('Connect to a server to see its sessions.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'shows connected empty state when broker has no active sessions',
      (tester) async {
        await tester.pumpWidget(
          buildSubject(
            sessions: [],
            activeProfile: BrokerProfile(
              id: 'local',
              displayName: 'local',
              baseUri: Uri.parse('http://127.0.0.1:7734'),
              createdAt: DateTime(2026),
            ),
            brokerClient: _AgentCapabilityBrokerClient(canCreate: true),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('No active sessions'), findsOneWidget);
        expect(
          find.text(
            'This server is connected, but nothing is running yet. Start a '
            'session and it will appear here.',
          ),
          findsOneWidget,
        );
        expect(
          find.text('Connect to a server to see its sessions.'),
          findsNothing,
        );
        final create = tester.widget<TextButton>(
          find.byKey(const Key('sessions-global-new')),
        );
        expect(create.onPressed, isNotNull);
      },
    );

    testWidgets(
      'connected empty page disables creation when no agent is ready',
      (tester) async {
        await tester.pumpWidget(
          buildSubject(
            sessions: [],
            activeProfile: BrokerProfile(
              id: 'local',
              displayName: 'local',
              baseUri: Uri.parse('http://127.0.0.1:7734'),
              createdAt: DateTime(2026),
            ),
            brokerClient: _AgentCapabilityBrokerClient(canCreate: false),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(
            'This server is connected, but no registered agent is ready to '
            'create sessions.',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('Start a session'), findsNothing);
        final create = tester.widget<TextButton>(
          find.byKey(const Key('sessions-global-new')),
        );
        expect(create.onPressed, isNull);
      },
    );

    testWidgets(
      'connected empty page reports creation readiness while checking',
      (tester) async {
        final heldReadiness = Completer<List<AgentInfo>>();
        final client = _ScriptedCapabilityBrokerClient([
          () => heldReadiness.future,
        ]);
        await tester.pumpWidget(
          buildSubject(
            sessions: const [],
            activeProfile: _profile('server-a'),
            brokerClient: client,
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(
          find.text(
            'This server is connected. Checking whether a registered agent '
            'can create sessions…',
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining('no registered agent is ready'),
          findsNothing,
        );
        expect(_compactCreateAction(tester).onPressed, isNull);

        heldReadiness.complete(const []);
        await tester.pumpAndSettle();
      },
    );

    testWidgets(
      'connected empty page reports a creation readiness check failure',
      (tester) async {
        final client = _ScriptedCapabilityBrokerClient([
          () => Future<List<AgentInfo>>.error(StateError('starting')),
        ]);
        await tester.pumpWidget(
          buildSubject(
            sessions: const [],
            activeProfile: _profile('server-a'),
            brokerClient: client,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(
            "This server is connected, but the app couldn't check whether an "
            'agent can create sessions. Refresh Sessions to try again.',
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining('no registered agent is ready'),
          findsNothing,
        );
        expect(_compactCreateAction(tester).onPressed, isNull);
      },
    );

    testWidgets(
      'creation readiness recovers from unavailable without remounting',
      (tester) async {
        final client = _ScriptedCapabilityBrokerClient([
          () async => const [],
          () async => const [_creationReadyAgent],
        ]);
        await tester.pumpWidget(
          buildSubject(
            sessions: const [],
            activeProfile: _profile('server-a'),
            brokerClient: client,
          ),
        );
        await tester.pumpAndSettle();
        expect(_compactCreateAction(tester).onPressed, isNull);

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionsPage)),
        );
        await container.read(sessionCreationReadyProvider.notifier).refresh();
        await tester.pumpAndSettle();

        expect(_compactCreateAction(tester).onPressed, isNotNull);
        expect(find.textContaining('Start a session'), findsOneWidget);
      },
    );

    testWidgets('creation readiness retries after a request failure', (
      tester,
    ) async {
      final client = _ScriptedCapabilityBrokerClient([
        () => Future<List<AgentInfo>>.error(StateError('starting')),
        () async => const [_creationReadyAgent],
      ]);
      await tester.pumpWidget(
        buildSubject(
          sessions: const [],
          activeProfile: _profile('server-a'),
          brokerClient: client,
        ),
      );
      await tester.pumpAndSettle();
      expect(_compactCreateAction(tester).onPressed, isNull);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionsPage)),
      );
      await container.read(sessionCreationReadyProvider.notifier).refresh();
      await tester.pumpAndSettle();

      expect(_compactCreateAction(tester).onPressed, isNotNull);
      expect(client.listAgentCalls, 2);
    });

    testWidgets('manual Sessions refresh rechecks creation readiness', (
      tester,
    ) async {
      final client = _ScriptedCapabilityBrokerClient([
        () async => const [_creationReadyAgent],
        () async => const [],
      ]);
      await tester.pumpWidget(
        buildSubject(
          sessions: const [],
          activeProfile: _profile('server-a'),
          brokerClient: client,
        ),
      );
      await tester.pumpAndSettle();
      expect(_compactCreateAction(tester).onPressed, isNotNull);

      await tester.tap(find.byKey(const Key('roster-freshness-refresh')));
      await tester.pumpAndSettle();

      expect(_compactCreateAction(tester).onPressed, isNull);
      expect(client.listAgentCalls, 2);
    });

    testWidgets(
      'old server readiness cannot publish after a profile switch',
      (tester) async {
        final heldA = Completer<List<AgentInfo>>();
        final client = _ScriptedCapabilityBrokerClient([
          () => heldA.future,
          () async => const [_creationReadyAgent],
        ]);
        await tester.pumpWidget(
          buildSubject(
            sessions: const [],
            activeProfile: _profile('server-a'),
            brokerClient: client,
          ),
        );
        await tester.pump();
        await tester.pump();

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionsPage)),
        );
        container.read(activeBrokerProfileProvider.notifier).state = _profile(
          'server-b',
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(_compactCreateAction(tester).onPressed, isNotNull);

        heldA.complete(const []);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(_compactCreateAction(tester).onPressed, isNotNull);
        expect(
          container.read(sessionCreationReadyProvider).source?.profileId,
          'server-b',
        );
      },
    );

    testWidgets(
      'reloads the roster when a broker client becomes available (race fix)',
      (tester) async {
        // Repo mirrors the real wiring: null client -> empty (in-memory
        // fallback), real client -> populated (broker-backed). Reproduces the
        // web same-origin race where the profile hydrates after the initial
        // load(), so the first fetch sees a null client.
        final populated = InMemorySessionListRepository()
          ..sessions = [
            const SessionInfo(
              id: 's1',
              tool: 'claude',
              title: 'Late session',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
            ),
          ];
        final empty = InMemorySessionListRepository()..sessions = [];

        final container = ProviderContainer(
          overrides: [
            sessionDisplayPreferencesStoreProvider.overrideWithValue(
              unboundedRosterPreferences(),
            ),
            sessionListRepositoryProvider.overrideWith((ref) async {
              final client = await ref.watch(brokerClientProvider.future);
              return client == null ? empty : populated;
            }),
          ],
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              theme: buildAppTheme(
                themeSpecById(kDefaultThemeId).light,
                Brightness.light,
              ),
              home: const SessionsPage(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // No active profile yet -> null client -> empty roster.
        expect(find.text('Connect to a server'), findsNWidgets(2));
        expect(find.text('Late session'), findsNothing);

        // The async same-origin hydration completes: set the active profile.
        container
            .read(activeBrokerProfileProvider.notifier)
            .state = BrokerProfile(
          id: 'local',
          displayName: 'local',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
        );
        await tester.pumpAndSettle();
        await expandRosterProject(tester);

        // The view reloaded once the client appeared -> roster now populated.
        expect(find.text('Late session'), findsOneWidget);
        expect(find.text('Connect to a server'), findsNothing);
      },
    );

    testWidgets('shows error state on failure', (tester) async {
      fakeRepo.shouldFail = true;

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(
        find.textContaining("Couldn't load sessions"),
        findsOneWidget,
      );
      // The raw exception must not reach the landing tab's error pane.
      expect(find.textContaining('Exception'), findsNothing);
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets('retry button reloads sessions', (tester) async {
      fakeRepo.shouldFail = true;

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text("Couldn't load sessions"), findsOneWidget);

      // Fix the repo and retry.
      fakeRepo
        ..shouldFail = false
        ..sessions = [
          const SessionInfo(
            id: 's1',
            tool: 'claude',
            title: 'My session',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
          ),
        ];

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('My session'), findsOneWidget);
    });

    testWidgets('shows populated session list', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'First session',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
        const SessionInfo(
          id: 's2',
          tool: 'opencode',
          title: 'Second session',
          status: SessionStatus.working,
          attachMode: AttachMode.observe,
          currentAgent: 'build',
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('First session'), findsOneWidget);
      expect(find.text('Second session'), findsOneWidget);
      final claudeRow = find.byKey(const Key('session-row-claude/s1'));
      final openCodeRow = find.byKey(const Key('session-row-opencode/s2'));
      expect(claudeRow, findsOneWidget);
      expect(openCodeRow, findsOneWidget);
      final l10n = AppLocalizations.of(tester.element(claudeRow));
      expect(
        find.descendant(
          of: claudeRow,
          matching: find.text(l10n.sessionRosterAgentClaude),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: openCodeRow,
          matching: find.text(l10n.sessionRosterAgentOpenCode),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-agent-opencode/s2')),
        findsOneWidget,
      );
    });

    testWidgets('falls back to session ID when title is empty', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 'session-abc-123',
          tool: 'claude',
          title: '',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('session-abc-123'), findsOneWidget);
    });

    testWidgets('shows status badge for working status', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'Working session',
          status: SessionStatus.working,
          attachMode: AttachMode.live,
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('Working'), findsOneWidget);
    });

    testWidgets('shows status badge for needs-input status', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'Waiting session',
          status: SessionStatus.needsInput,
          attachMode: AttachMode.live,
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('Needs input'), findsOneWidget);
    });

    testWidgets('shows status badge for idle status', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'Idle session',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('Idle'), findsOneWidget);
    });

    testWidgets('refresh button calls repository', (tester) async {
      fakeRepo.sessions = [];

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Initial load happened.
      final initialCount = fakeRepo.fetchCount;

      // Update sessions.
      fakeRepo.sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'New session',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];

      // Tap refresh.
      await tester.tap(find.byIcon(Icons.refresh));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(fakeRepo.fetchCount, greaterThan(initialCount));
      expect(find.text('New session'), findsOneWidget);
    });

    testWidgets('F5 refreshes the session list', (tester) async {
      fakeRepo.sessions = [];

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final initialCount = fakeRepo.fetchCount;
      fakeRepo.sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'Shortcut session',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ];

      await tester.sendKeyEvent(LogicalKeyboardKey.f5);
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(fakeRepo.fetchCount, greaterThan(initialCount));
      expect(find.text('Shortcut session'), findsOneWidget);
    });

    testWidgets('shows current agent when available', (tester) async {
      final sessions = [
        const SessionInfo(
          id: 's1',
          tool: 'claude',
          title: 'Session',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
          currentAgent: 'research',
        ),
      ];

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.text('research'), findsOneWidget);
    });

    testWidgets('app bar shows refresh button', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.refresh), findsOneWidget);
    });

    testWidgets('shows session count in list', (tester) async {
      final sessions = List.generate(
        5,
        (i) => SessionInfo(
          id: 's$i',
          tool: 'claude',
          title: 'Session $i',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      );

      await tester.pumpWidget(buildSubject(sessions: sessions));
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      for (var i = 0; i < 5; i++) {
        expect(find.text('Session $i'), findsOneWidget);
      }
    });

    testWidgets('keeps primary session controls visible across widths', (
      tester,
    ) async {
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      for (final size in const [Size(320, 640), Size(1280, 800)]) {
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1;

        await tester.pumpWidget(
          buildSubject(
            sessions: const [
              SessionInfo(
                id: 's1',
                tool: 'claude',
                title: 'Responsive session',
                status: SessionStatus.idle,
                attachMode: AttachMode.live,
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();
        await expandRosterProject(tester);

        expect(find.byIcon(Icons.refresh), findsOneWidget);
        expect(find.text('Responsive session'), findsOneWidget);
        expect(find.text('Idle'), findsOneWidget);
      }
    });

    testWidgets('tapping a session opens session detail route', (tester) async {
      await tester.pumpWidget(
        buildRoutedSubject(
          sessions: const [
            SessionInfo(
              id: 'session-abc',
              tool: 'claude',
              title: 'Detail target',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      await tester.tap(find.text('Detail target'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final chatTab = find.byKey(const Key('session-detail-tab-panel-chat'));
      expect(chatTab, findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-bootstrap-blocking')),
        findsOneWidget,
      );
      expect(
        GoRouter.of(
          tester.element(chatTab),
        ).routeInformationProvider.value.uri.toString(),
        sessionDetailLocation(tool: 'claude', sessionId: 'session-abc'),
      );
      // U3: the row the user tapped names the page from the first frame. The
      // route still carries the exact native id — identity is unchanged — but
      // it is never what the user reads.
      expect(find.text('Detail target'), findsWidgets);
      expect(find.text('session-abc'), findsNothing);
    });

    testWidgets(
      'tapping a session preserves special-character tool and session ids',
      (tester) async {
        await tester.pumpWidget(
          buildRoutedSubject(
            sessions: const [
              SessionInfo(
                id: 'session / # ? % 你好',
                tool: 'claude code/pro?%',
                title: 'Special target',
                status: SessionStatus.idle,
                attachMode: AttachMode.live,
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();
        await expandRosterProject(tester);

        await tester.tap(find.text('Special target'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));

        final chatTab = find.byKey(const Key('session-detail-tab-panel-chat'));
        expect(chatTab, findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsOneWidget,
        );
        expect(
          GoRouter.of(
            tester.element(chatTab),
          ).routeInformationProvider.value.uri.toString(),
          sessionDetailLocation(
            tool: 'claude code/pro?%',
            sessionId: 'session / # ? % 你好',
          ),
        );
        // The id round-trips through the route untouched; the visible page is
        // still named by the row that was tapped (U3).
        expect(find.text('Special target'), findsWidgets);
        expect(find.text('session / # ? % 你好'), findsNothing);
      },
    );

    testWidgets(
      'machine-owner Connect cannot activate a profile replaced in the dialog',
      (tester) async {
        final database = AppDatabase(NativeDatabase.memory());
        addTearDown(database.close);
        final profiles = InMemoryBrokerProfileRepository();
        final credentials = InMemoryCredentialStore();
        final aggregator = await profiles.save(
          BrokerProfile(
            id: 'aggregator',
            displayName: 'Aggregator',
            baseUri: Uri.parse('http://aggregator.test:7734'),
            createdAt: DateTime(2026, 7),
          ),
        );
        const ownerId = 'http://peer-a.test:7734';
        const ownerCredentialKey = 'broker-token:$ownerId';
        final ownerA = await profiles.save(
          BrokerProfile(
            id: ownerId,
            displayName: 'Peer A',
            baseUri: Uri.parse(ownerId),
            createdAt: DateTime(2026, 7),
            credentialKey: ownerCredentialKey,
          ),
        );
        await credentials.writeBrokerToken(
          ownerCredentialKey,
          'owner-a-token',
        );
        final machineClient = _MachineOwnerBrokerClient(
          ownerBaseUrl: ownerId,
        );
        final container = ProviderContainer(
          overrides: [
            appDatabaseProvider.overrideWithValue(database),
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
            credentialStoreProvider.overrideWithValue(credentials),
            activeBrokerProfileProvider.overrideWith((_) => aggregator),
            brokerClientProvider.overrideWith((_) async => machineClient),
            sessionListRepositoryProvider.overrideWith(
              (_) async => fakeRepo,
            ),
            sessionDisplayPreferencesStoreProvider.overrideWithValue(
              InMemorySessionDisplayPreferencesStore(),
            ),
            sessionLiveStateViewStoreProvider.overrideWithValue(
              InMemorySessionLiveStateViewStore(),
            ),
            rosterSnapshotRepositoryProvider.overrideWithValue(
              InMemoryRosterSnapshotRepository(),
            ),
          ],
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              theme: buildAppTheme(
                themeSpecById(kDefaultThemeId).light,
                Brightness.light,
              ),
              home: const SessionsPage(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('sessions-machines')));
        await tester.pumpAndSettle();
        // The machine rail follows the same policy as the other two rosters:
        // it is navigation, so it carries no selection region at any level.
        // On web a SelectionArea brings a platform view whose placeholder
        // throws when a scrolling viewport collects it
        // (flutter/flutter#122680, fixed by #186840, absent from the 3.44.3
        // we pin). The reported grey RenderErrorBox is consistent with that
        // failure; no exception was captured, so it is not proven, and
        // dropping SelectionArea removes the mechanism regardless.
        for (final title in ['Peer-owned session', 'Second peer session']) {
          expect(
            find.ancestor(
              of: find.text(title),
              matching: find.byType(SelectableRegion),
            ),
            findsNothing,
            reason: '$title must not sit inside any selectable region',
          );
        }
        expect(
          find.descendant(
            of: find.byKey(const Key('machine-roster-list')),
            matching: find.byType(SelectionArea),
          ),
          findsNothing,
          reason: 'no selection region inside the machine roster either',
        );
        await tester.tap(find.text('Peer-owned session'));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('machine-owner-connect')), findsOneWidget);

        await container
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile(ownerA.id, expectedProfile: ownerA);
        final ownerB = await container
            .read(brokerProfileListProvider.notifier)
            .saveProfile(
              BrokerProfile(
                id: ownerId,
                displayName: 'Replacement Peer B',
                baseUri: Uri.parse(ownerId),
                createdAt: DateTime(2026, 7),
              ),
            );
        expect(ownerB.incarnationId, isNot(ownerA.incarnationId));

        await tester.tap(find.byKey(const Key('machine-owner-connect')));
        await tester.pumpAndSettle();

        expect(container.read(activeBrokerProfileProvider), aggregator);
        expect(find.byType(SessionsPage), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('a cached row keeps its title through compact navigation', (
      tester,
    ) async {
      // Compact routes straight to the location — no working set is seeded
      // on the way — and the Expanded-only redirect helper never runs here.
      // Session Detail therefore has to resolve the identity the user actually
      // tapped, or a named session arrives as its own id.
      tester.view.physicalSize = const Size(420, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final working = _MemoryOpenSessionsStore();
      await tester.pumpWidget(
        buildRoutedSubject(
          openSessions: working,
          // Never answers, so the cached roster stays on screen — the exact
          // window this lane exists for.
          repository: _NeverAnswersSessionListRepository(),
          snapshots: _StubRosterSnapshotRepository(
            SessionRosterSnapshot(
              brokerProfileId: 'local',
              rows: const [
                SessionRosterIdentity(
                  tool: 'claude',
                  sessionId: 'session-abc',
                  title: 'Cached title',
                  machine: 'mac',
                  cwd: '/work/alpha',
                ),
              ],
              capturedAt: DateTime.now(),
              omittedRowCount: 0,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final header = find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith(
              'cached-project-header-',
            ),
      );
      expect(header, findsOneWidget);
      await tester.tap(header);
      await tester.pump();

      expect(find.text('Cached title'), findsOneWidget);
      await tester.tap(find.text('Cached title'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
        reason: 'the cached row still routes on its exact identity',
      );
      final persisted = working.saved['local']!.refs.single;
      expect(persisted.key, 'claude/session-abc');
      expect(persisted.title, 'Cached title');
      expect(
        persisted.status,
        isNull,
        reason: 'identity carried across, activity still unknown',
      );
      expect(
        find.text('Cached title'),
        findsWidgets,
        reason: 'and the name the user tapped is what the tab shows',
      );
    });
  });
}

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('https://$id.example'),
  createdAt: DateTime(2026),
  incarnationId: '$id-generation',
);

TextButton _compactCreateAction(WidgetTester tester) =>
    tester.widget<TextButton>(find.byKey(const Key('sessions-global-new')));

const AgentInfo _creationReadyAgent = AgentInfo(
  id: 'codex',
  displayName: 'Codex',
  capabilities: AgentCapabilities(
    integrationKind: IntegrationKind.jsonrpcStdio,
    attachModes: [AttachMode.resume],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: true,
    permissionGranularity: PermissionGranularity.perSession,
  ),
  canCreateSession: true,
  canRenameNative: false,
  canFork: false,
  canClone: false,
  canTranscriptExport: false,
);

final class _ScriptedCapabilityBrokerClient extends BrokerClient {
  _ScriptedCapabilityBrokerClient(this.responses)
    : super(baseUrl: 'http://test');

  final List<Future<List<AgentInfo>> Function()> responses;
  int listAgentCalls = 0;

  @override
  Future<List<AgentInfo>> listAgents() {
    listAgentCalls += 1;
    return responses.removeAt(0)();
  }

  @override
  Future<AggregatedMachinesResponse> listMachines() async =>
      const AggregatedMachinesResponse(
        ok: true,
        version: 1,
        machine: 'test',
        machineId: 'test',
        generatedAt: 0,
        machines: [],
      );

  @override
  void close() {}
}

final class _AgentCapabilityBrokerClient extends BrokerClient {
  _AgentCapabilityBrokerClient({required this.canCreate})
    : super(baseUrl: 'http://test');

  final bool canCreate;

  @override
  Future<List<AgentInfo>> listAgents() async => [
    AgentInfo(
      id: 'codex',
      displayName: 'Codex',
      capabilities: const AgentCapabilities(
        integrationKind: IntegrationKind.jsonrpcStdio,
        attachModes: [AttachMode.resume],
        supportsObserve: true,
        supportsResume: true,
        supportsLiveAttach: false,
        supportsNativeArtifact: false,
        supportsNativeFileInput: false,
        supportsModelSwitch: true,
        permissionGranularity: PermissionGranularity.perSession,
      ),
      canCreateSession: canCreate,
      canRenameNative: false,
      canFork: false,
      canClone: false,
      canTranscriptExport: false,
    ),
  ];

  @override
  Future<AggregatedMachinesResponse> listMachines() async =>
      const AggregatedMachinesResponse(
        ok: true,
        version: 1,
        machine: 'test',
        machineId: 'test',
        generatedAt: 0,
        machines: [],
      );

  @override
  void close() {}
}

/// Records what the working set actually persisted.
class _MemoryOpenSessionsStore implements OpenSessionsStore {
  final Map<String, OpenSessionsSnapshot> saved = {};

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      saved[profileId] ?? OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    saved[profileId] = snapshot;
  }
}

/// A roster request that never resolves, holding the cached roster on screen.
class _NeverAnswersSessionListRepository implements SessionListRepository {
  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) =>
      Completer<ListSessionsResponse>().future;
}

/// Returns one snapshot for any profile, so the cached roster is the thing
/// under test rather than the store's bounds.
class _StubRosterSnapshotRepository implements RosterSnapshotRepository {
  _StubRosterSnapshotRepository(this.snapshot);

  final SessionRosterSnapshot snapshot;

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async => snapshot;

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) async => snapshot;

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {}
}

class _NeverConnectsSessionDetailConnection implements SessionDetailConnection {
  @override
  Stream<WireEvent> get events => const Stream.empty();

  @override
  SessionDetailConnectionStatus get state =>
      SessionDetailConnectionStatus.disconnected;

  @override
  Stream<SessionDetailConnectionStatus> get stateStream => const Stream.empty();

  @override
  Future<void> close({bool reconnect = false}) async {}

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
  }) async {}

  @override
  void disarmDriveAuthority() {}

  @override
  Future<void> sendHandoff({String? clientMessageId}) async {}

  @override
  Future<void> connect() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    List<PromptFileAttachment> files = const [],
  }) async {}

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) async {}

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendAck(String attachTicket, {String? clientMessageId}) async {}

  @override
  Future<void> sendNack(
    String attachTicket, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendSetAgent(
    String agent, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> rejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) async {}
}

final class _MachineOwnerBrokerClient extends BrokerClient {
  _MachineOwnerBrokerClient({required this.ownerBaseUrl})
    : super(baseUrl: 'http://aggregator.test:7734');

  final String ownerBaseUrl;

  MachineSessionIdentity get _identity => const MachineSessionIdentity(
    machineId: 'peer-a',
    tool: 'codex',
    sessionId: 'peer-session',
    key: 'peer-a/codex/peer-session',
  );

  MachineSessionOwner get _owner => MachineSessionOwner(
    machineId: 'peer-a',
    machine: 'Peer A',
    role: MachineRosterRole.peer,
    route: MachineSessionRouteState.direct,
    authoritative: true,
    baseUrl: ownerBaseUrl,
    requiresIndependentAuthentication: true,
  );

  MachineSessionInfo get _session => MachineSessionInfo(
    session: SessionInfo.fromJson(const {
      'id': 'peer-session',
      'tool': 'codex',
      'title': 'Peer-owned session',
      'status': 'idle',
      'attachMode': 'observe',
    }),
    identity: _identity,
    owner: _owner,
  );

  /// A second row exists so "one selection region for the list" can be told
  /// apart from "one region per row". With a single row an ancestor lookup
  /// finds exactly one region either way.
  MachineSessionInfo get _secondSession => MachineSessionInfo(
    session: SessionInfo.fromJson(const {
      'id': 'peer-session-2',
      'tool': 'codex',
      'title': 'Second peer session',
      'status': 'idle',
      'attachMode': 'observe',
    }),
    identity: const MachineSessionIdentity(
      machineId: 'peer-a',
      tool: 'codex',
      sessionId: 'peer-session-2',
      key: 'peer-a/codex/peer-session-2',
    ),
    owner: _owner,
  );

  @override
  Future<AggregatedMachinesResponse> listMachines() async {
    return AggregatedMachinesResponse(
      ok: true,
      version: 2,
      machine: 'Aggregator',
      machineId: 'aggregator',
      generatedAt: 1,
      machines: [
        MachineRoster(
          machineId: 'peer-a',
          machine: 'Peer A',
          role: MachineRosterRole.peer,
          status: MachineRosterStatus.ok,
          sessions: [_session, _secondSession],
          sessionCount: 2,
          checkedAt: 1,
          freshness: MachineRosterFreshness.fresh,
        ),
      ],
    );
  }

  @override
  Future<MachineSessionResolution> resolveMachineSession({
    required String machineId,
    required String tool,
    required String sessionId,
  }) async {
    return MachineSessionResolution(
      ok: true,
      identity: _identity,
      status: MachineSessionResolutionStatus.resolved,
      session: _session,
      owner: _owner,
    );
  }
}
