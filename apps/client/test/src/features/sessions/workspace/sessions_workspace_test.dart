import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/sessions_workspace.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_split_sash.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/roster_expansion.dart';

SessionInfo _session(String tool, String id, {String title = 'title'}) =>
    SessionInfo(
      id: id,
      tool: tool,
      title: title,
      status: SessionStatus.idle,
      attachMode: AttachMode.observe,
    );

void main() {
  Widget buildSubject(
    List<SessionInfo> sessions, {
    SessionListStatus status = SessionListStatus.loaded,
    String? error,
    int unreadCount = 0,
    _StubSessionListController? controller,
    _FakeWorkspacePrefsStore? prefsStore,
    BrokerClient? brokerClient,
    NewSessionConnectionPreparer? connectionPreparer,
    Brightness brightness = Brightness.light,
    bool hasBrokerClient = true,
  }) {
    final listController =
        controller ??
        _StubSessionListController(
          SessionListState(
            status: status,
            sessions: sessions,
            error: error,
          ),
        );
    // Default to an already-open roster so the split resizer does not change
    // what the pre-existing workspace assertions see. First-run behaviour (an
    // empty store) is covered explicitly in the split-resizer group.
    final prefs =
        prefsStore ??
        _FakeWorkspacePrefsStore(
          const WorkspaceRosterPrefs(
            width: SessionsWorkspace.defaultListPaneWidth,
            collapsed: false,
          ),
        );
    final effectiveBrokerClient = hasBrokerClient
        ? brokerClient ?? _CreateSessionFakeBrokerClient()
        : null;
    return ProviderScope(
      overrides: [
        sessionListControllerProvider.overrideWith(
          () => listController,
        ),
        workspacePrefsStoreProvider.overrideWithValue(prefs),
        attentionUnreadCountProvider.overrideWith((ref) => unreadCount),
        openSessionsStoreProvider.overrideWithValue(_FakeOpenSessionsStore()),
        // The create flow persists app-created Drive provenance before
        // navigating; the real store would open a Drift database inside the
        // widget test and its timers would never let pumpAndSettle settle.
        sessionDriveIntentStoreProvider.overrideWithValue(
          _NoopDriveIntentStore(),
        ),
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: 'p1',
            displayName: 'p1',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026),
          ),
        ),
        brokerClientProvider.overrideWith((ref) async => effectiveBrokerClient),
        if (connectionPreparer != null)
          newSessionConnectionPreparerProvider.overrideWithValue(
            connectionPreparer,
          ),
        // The create flow builds an operation-owned client from the captured
        // profile through this factory.
        if (effectiveBrokerClient case final client?)
          brokerClientFactoryProvider.overrideWith(
            (ref) =>
                (profile) async => client,
          ),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          InMemorySessionDisplayPreferencesStore()..sessionRosterWindow = 'all',
        ),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          brightness == Brightness.light
              ? themeSpecById(kDefaultThemeId).light
              : themeSpecById(kDefaultThemeId).dark,
          brightness,
        ),
        home: Scaffold(
          body: SessionsWorkspace(
            detailBuilder: (context, ref) => Text('DETAIL ${ref.key}'),
          ),
        ),
      ),
    );
  }

  /// Pumps past the async prefs restore without settling.
  ///
  /// The roster renders collapsed until [WorkspacePrefsStore.loadRoster]
  /// resolves, so a single frame shows no roster at all. Tests whose subject
  /// animates forever (loading spinners) cannot use `pumpAndSettle` to get
  /// there.
  Future<void> pumpRestored(WidgetTester tester) async {
    await tester.pump();
    await tester.pump();
  }

  group('SessionsWorkspace', () {
    testWidgets('shows the roster and a placeholder until one is opened', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject([_session('claude', 'a'), _session('codex', 'b')]),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(find.byKey(const Key('session-row-claude/a')), findsOneWidget);
      expect(find.byKey(const Key('session-row-codex/b')), findsOneWidget);
      expect(find.text('Select a session to open it here.'), findsOneWidget);
    });

    testWidgets('opening rows fills the detail pane and grows the tab strip', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject([_session('claude', 'a'), _session('codex', 'b')]),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      await tester.tap(find.byKey(const Key('session-row-claude/a')));
      await tester.pumpAndSettle();
      expect(find.text('DETAIL claude/a'), findsOneWidget);
      // Tab strip stays hidden while a single session is open.
      expect(find.byKey(const Key('open-session-tab-claude/a')), findsNothing);

      await tester.tap(find.byKey(const Key('session-row-codex/b')));
      await tester.pumpAndSettle();
      expect(find.text('DETAIL codex/b'), findsOneWidget);
      // Now two tabs are open, so the strip appears.
      expect(
        find.byKey(const Key('open-session-tab-claude/a')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('open-session-tab-codex/b')), findsOneWidget);
    });

    testWidgets('expanded tab strip reflects an accepted rename immediately', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject([
          _session('claude', 'a', title: 'Before'),
          _session('codex', 'b', title: 'Other'),
        ]),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);
      await tester.tap(find.byKey(const Key('session-row-claude/a')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-row-codex/b')));
      await tester.pumpAndSettle();

      final context = tester.element(find.byType(SessionsWorkspace));
      ProviderScope.containerOf(context)
          .read(openSessionsControllerProvider.notifier)
          .renameSessionTitle('claude', 'a', 'After');
      await tester.pumpAndSettle();

      expect(
        find.descendant(
          of: find.byKey(const Key('open-session-tab-claude/a')),
          matching: find.text('After'),
        ),
        findsOneWidget,
      );
    });

    // The roster starts collapsed and only the async prefs restore opens it, so
    // these states need a frame past the restore. pumpAndSettle is not an
    // option here: the loading spinner animates forever.
    testWidgets('shows loading for initial and empty refresh states', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(const [], status: SessionListStatus.loading),
      );
      await pumpRestored(tester);

      expect(find.byKey(const Key('session-roster-loading')), findsOneWidget);
      expect(
        find.text('No sessions on this server yet. Create one to get started.'),
        findsNothing,
      );

      await tester.pumpWidget(
        buildSubject(const [], status: SessionListStatus.refreshing),
      );
      await pumpRestored(tester);

      expect(find.byKey(const Key('session-roster-loading')), findsOneWidget);
      expect(find.text('No sessions on this broker yet.'), findsNothing);
    });

    testWidgets(
      'shows broker connection actions after a completed empty load',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSubject(const [], hasBrokerClient: false),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('session-roster-loading')), findsNothing);
        expect(
          find.text('Connect to a server to see its sessions.'),
          findsNWidgets(2),
        );
        expect(find.text('Connect to a server'), findsNWidgets(2));
        expect(find.byKey(const Key('sessions-empty-title')), findsOneWidget);
        expect(find.byKey(const Key('sessions-empty-connect')), findsOneWidget);
        expect(
          find.text(
            'No sessions on this server yet. Create one to get started.',
          ),
          findsNothing,
        );
      },
    );

    testWidgets('keeps the connected empty workspace copy', (tester) async {
      await tester.pumpWidget(
        buildSubject(
          const [],
          brokerClient: _CreateSessionFakeBrokerClient(),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('No sessions on this server yet. Create one to get started.'),
        findsNWidgets(2),
      );
      final create = tester.widget<IconButton>(
        find.byKey(const Key('sessions-workspace-global-new')),
      );
      expect(create.onPressed, isNotNull);
      expect(find.text('Select a session to open it here.'), findsNothing);
      expect(find.byKey(const Key('sessions-empty-connect')), findsNothing);
    });

    testWidgets(
      'connected empty workspace disables creation when no agent is ready',
      (tester) async {
        await tester.pumpWidget(
          buildSubject(
            const [],
            brokerClient: _NoCreateSessionBrokerClient(),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(
            'No registered agent on this server is ready to create sessions.',
          ),
          findsNWidgets(2),
        );
        expect(find.textContaining('Create one'), findsNothing);
        expect(find.text('Select a session to open it here.'), findsNothing);
        final create = tester.widget<IconButton>(
          find.byKey(const Key('sessions-workspace-global-new')),
        );
        expect(create.onPressed, isNull);
      },
    );

    testWidgets(
      'connected empty workspace reports readiness while checking',
      (tester) async {
        final heldReadiness = Completer<List<AgentInfo>>();
        final client = _ScriptedWorkspaceCapabilityClient([
          () => heldReadiness.future,
        ]);
        await tester.pumpWidget(buildSubject(const [], brokerClient: client));
        await tester.pump();
        await tester.pump();

        expect(
          find.text(
            'Checking whether a registered agent can create sessions…',
          ),
          findsNWidgets(2),
        );
        expect(
          find.textContaining('No registered agent on this server is ready'),
          findsNothing,
        );
        expect(_expandedCreateAction(tester).onPressed, isNull);

        heldReadiness.complete(const []);
        await tester.pumpAndSettle();
      },
    );

    testWidgets(
      'connected empty workspace reports a readiness check failure',
      (tester) async {
        final client = _ScriptedWorkspaceCapabilityClient([
          () => Future<List<AgentInfo>>.error(StateError('starting')),
        ]);
        await tester.pumpWidget(buildSubject(const [], brokerClient: client));
        await tester.pumpAndSettle();

        expect(
          find.text(
            "Couldn't check whether an agent can create sessions. Refresh to "
            'try again.',
          ),
          findsNWidgets(2),
        );
        expect(
          find.textContaining('No registered agent on this server is ready'),
          findsNothing,
        );
        expect(_expandedCreateAction(tester).onPressed, isNull);
      },
    );

    testWidgets(
      'periodic Sessions refresh recovers creation readiness without '
      'remounting',
      (tester) async {
        final client = _ScriptedWorkspaceCapabilityClient([
          () async => const [],
          () async => const [_workspaceCreationReadyAgent],
        ]);
        await tester.pumpWidget(
          buildSubject(const [], brokerClient: client),
        );
        await tester.pumpAndSettle();
        expect(_expandedCreateAction(tester).onPressed, isNull);

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionsWorkspace)),
        );
        await container.read(sessionRosterResumeRefreshProvider)();
        await tester.pumpAndSettle();

        expect(_expandedCreateAction(tester).onPressed, isNotNull);
        expect(find.textContaining('Create one'), findsNWidgets(2));
      },
    );

    testWidgets('expanded creation readiness retries after request failure', (
      tester,
    ) async {
      final client = _ScriptedWorkspaceCapabilityClient([
        () => Future<List<AgentInfo>>.error(StateError('starting')),
        () async => const [_workspaceCreationReadyAgent],
      ]);
      await tester.pumpWidget(buildSubject(const [], brokerClient: client));
      await tester.pumpAndSettle();
      expect(_expandedCreateAction(tester).onPressed, isNull);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionsWorkspace)),
      );
      await container.read(sessionCreationReadyProvider.notifier).refresh();
      await tester.pumpAndSettle();

      expect(_expandedCreateAction(tester).onPressed, isNotNull);
      expect(client.listAgentCalls, 2);
    });

    testWidgets('expanded manual refresh rechecks creation readiness', (
      tester,
    ) async {
      final client = _ScriptedWorkspaceCapabilityClient([
        () async => const [_workspaceCreationReadyAgent],
        () async => const [],
      ]);
      await tester.pumpWidget(buildSubject(const [], brokerClient: client));
      await tester.pumpAndSettle();
      expect(_expandedCreateAction(tester).onPressed, isNotNull);

      await tester.tap(find.byKey(const Key('roster-freshness-refresh')));
      await tester.pumpAndSettle();

      expect(_expandedCreateAction(tester).onPressed, isNull);
      expect(client.listAgentCalls, 2);
    });

    testWidgets(
      'expanded readiness rejects an old server result after switching',
      (tester) async {
        final heldA = Completer<List<AgentInfo>>();
        final client = _ScriptedWorkspaceCapabilityClient([
          () => heldA.future,
          () async => const [_workspaceCreationReadyAgent],
        ]);
        await tester.pumpWidget(buildSubject(const [], brokerClient: client));
        await tester.pump();
        await tester.pump();

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionsWorkspace)),
        );
        container
            .read(activeBrokerProfileProvider.notifier)
            .state = BrokerProfile(
          id: 'server-b',
          displayName: 'server-b',
          baseUri: Uri.parse('https://server-b.example'),
          createdAt: DateTime(2026),
          incarnationId: 'server-b-generation',
        );
        await tester.pumpAndSettle();
        expect(_expandedCreateAction(tester).onPressed, isNotNull);

        heldA.complete(const []);
        await tester.pumpAndSettle();

        expect(_expandedCreateAction(tester).onPressed, isNotNull);
        expect(
          container.read(sessionCreationReadyProvider).source?.profileId,
          'server-b',
        );
      },
    );

    testWidgets('renders the broker connection empty state in dark mode', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          const [],
          brightness: Brightness.dark,
          hasBrokerClient: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Connect to a server'), findsNWidgets(2));
      expect(find.byKey(const Key('sessions-empty-title')), findsOneWidget);
      expect(find.byKey(const Key('sessions-empty-connect')), findsOneWidget);
    });

    testWidgets(
      'a failed refresh over retained rows states it once, in the slot',
      (tester) async {
        // Expanded used to add its own `session-roster-stale-error` banner with
        // a second Retry while the shared slot span forever, and Compact had no
        // counterpart at all. One failure, one owner, both layouts (R0b).
        final controller = _StubSessionListController(
          SessionListState(
            status: SessionListStatus.error,
            error: "Couldn't load sessions.",
            sessions: [_session('claude', 'kept', title: 'Kept session')],
          ),
        );
        await tester.pumpWidget(
          buildSubject(
            [_session('claude', 'kept', title: 'Kept session')],
            status: SessionListStatus.error,
            error: "Couldn't load sessions.",
            controller: controller,
          ),
        );
        await pumpRestored(tester);
        await expandRosterProject(tester, settle: false);

        expect(find.text('Kept session'), findsOneWidget);
        expect(
          find.byKey(const Key('session-roster-stale-error')),
          findsNothing,
        );
        expect(find.byKey(const Key('roster-freshness-busy')), findsNothing);
        expect(find.byKey(const Key('roster-freshness-retry')), findsOneWidget);

        final before = controller.loadCount;
        await tester.tap(find.byKey(const Key('roster-freshness-retry')));
        await tester.pump();
        expect(controller.loadCount, before + 1);
      },
    );

    testWidgets('shows an initial-load error with retry', (tester) async {
      final controller = _StubSessionListController(
        const SessionListState(
          status: SessionListStatus.error,
          error: 'broker unavailable',
        ),
      );
      await tester.pumpWidget(
        buildSubject(
          const [],
          status: SessionListStatus.error,
          error: 'broker unavailable',
          controller: controller,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-roster-error')), findsOneWidget);
      expect(find.text('broker unavailable'), findsOneWidget);
      expect(
        find.widgetWithText(SelectableText, 'broker unavailable'),
        findsOneWidget,
      );
      final initialLoads = controller.loadCount;
      await tester.tap(find.byKey(const Key('session-roster-retry')));
      await tester.pump();
      expect(controller.loadCount, initialLoads + 1);
    });

    testWidgets('keeps stale sessions visible while refreshing', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          [_session('claude', 'stale')],
          status: SessionListStatus.refreshing,
        ),
      );
      // The shared status slot animates while busy, so this state never
      // settles; pump explicit frames instead.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      await expandRosterProject(tester, settle: false);

      expect(find.byKey(const Key('session-row-claude/stale')), findsOneWidget);
      // R0b: one owner. The Expanded-only `Updating…` subtitle is gone; the
      // shared top-right slot is the single place that reports the refresh.
      expect(
        find.byKey(const Key('roster-freshness-busy')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('session-roster-loading')), findsNothing);
    });

    testWidgets('refresh status does not move header actions or roster', (
      tester,
    ) async {
      final controller = _StubSessionListController(
        SessionListState(
          status: SessionListStatus.loaded,
          sessions: [_session('claude', 'stable')],
        ),
      );
      await tester.pumpWidget(
        buildSubject(
          [_session('claude', 'stable')],
          controller: controller,
        ),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      final attention = find.byKey(
        const Key('sessions-workspace-attention'),
      );
      final rosterRow = find.byKey(const Key('session-row-claude/stable'));
      final statusSlot = find.byKey(const Key('roster-freshness-slot'));
      final actionCenterBefore = tester.getCenter(attention);
      final rosterTopBefore = tester.getTopLeft(rosterRow);
      final slotCenterBefore = tester.getCenter(statusSlot);
      final slotSizeBefore = tester.getSize(statusSlot);

      expect(find.byKey(const Key('roster-freshness-refresh')), findsOneWidget);
      controller.setStatus(SessionListStatus.refreshing);
      await tester.pump();

      // R0b: the same slot, in the same place, at the same size — Refresh is
      // replaced in place by one progress glyph, so nothing around it moves.
      expect(find.byKey(const Key('roster-freshness-busy')), findsOneWidget);
      expect(find.byKey(const Key('roster-freshness-refresh')), findsNothing);
      expect(tester.getCenter(attention), actionCenterBefore);
      expect(tester.getTopLeft(rosterRow), rosterTopBefore);
      expect(tester.getCenter(statusSlot), slotCenterBefore);
      expect(tester.getSize(statusSlot), slotSizeBefore);
    });

    testWidgets('header exposes contextual actions and unread badge', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(const [], unreadCount: 3));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('sessions-workspace-attention')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-settings')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-global-new')),
        findsOneWidget,
      );
      expect(find.text('3'), findsOneWidget);
    });

    // The roster is HTTP-only, so a session that finishes while the list is on
    // screen keeps a stale "Working" label until something refetches it.
    testWidgets('polls the roster while the workspace is foregrounded', (
      tester,
    ) async {
      final controller = _StubSessionListController(
        SessionListState(
          status: SessionListStatus.loaded,
          sessions: [_session('claude', 's1')],
        ),
      );
      await tester.pumpWidget(buildSubject(const [], controller: controller));
      await tester.pump();
      final afterMount = controller.loadCount;

      await tester.pump(SessionsWorkspace.rosterPollInterval);
      expect(controller.loadCount, afterMount + 1);
      await tester.pump(SessionsWorkspace.rosterPollInterval);
      expect(controller.loadCount, afterMount + 2);

      // Background refreshes must not flash the "Updating…" affordance.
      expect(controller.silentLoadCount, 2);
    });

    // Re-flagged item 30: creating a session used to await a full roster
    // reload before opening the result, which on a large broker meant seconds
    // of nothing after the sheet closed (and no open at all if the widget
    // unmounted mid-reload). The created session must appear immediately,
    // with the roster catching up in the background.
    testWidgets(
      'a created session opens before the roster reload completes',
      (tester) async {
        final preparedSessions = <SessionInfo>[];
        final controller = _HangingLoadSessionListController(
          SessionListState(
            status: SessionListStatus.loaded,
            sessions: [_session('claude', 'a')],
          ),
        );
        await tester.pumpWidget(
          buildSubject(
            [_session('claude', 'a')],
            controller: controller,
            brokerClient: _CreateSessionFakeBrokerClient(),
            connectionPreparer: (container, session) async {
              preparedSessions.add(session);
              return NewSessionConnectionHandoff(() {});
            },
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('sessions-workspace-global-new')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('new-session-submit')));
        await tester.pumpAndSettle();

        // The detail pane shows the new session even though the roster
        // reload will never complete in this test.
        expect(find.text('DETAIL codex/created'), findsOneWidget);
        expect(
          preparedSessions.map((session) => '${session.tool}/${session.id}'),
          ['codex/created'],
        );
        // And the roster refresh was requested in the background, silently
        // (no "Updating…" flash for a create the user already saw succeed).
        expect(controller.silentLoadCount, greaterThanOrEqualTo(1));
      },
    );

    testWidgets(
      'a created tab opens while its Drive handoff is still connecting',
      (tester) async {
        final connecting = Completer<NewSessionConnectionHandoff>();
        await tester.pumpWidget(
          buildSubject(
            const [],
            brokerClient: _CreateSessionFakeBrokerClient(),
            connectionPreparer: (container, session) => connecting.future,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('sessions-workspace-global-new')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('new-session-submit')));
        for (var frame = 0; frame < 4; frame += 1) {
          await tester.pump();
        }

        expect(find.text('DETAIL codex/created'), findsOneWidget);
        expect(
          find.byKey(const Key('new-session-launch-page')),
          findsNothing,
        );

        connecting.complete(NewSessionConnectionHandoff(() {}));
        await tester.pump();
        await tester.pump();

        expect(find.text('DETAIL codex/created'), findsOneWidget);
        expect(
          find.byKey(const Key('new-session-launch-page')),
          findsNothing,
        );
      },
    );

    testWidgets('refetches the roster immediately on lifecycle resume', (
      tester,
    ) async {
      final controller = _StubSessionListController(
        SessionListState(
          status: SessionListStatus.loaded,
          sessions: [_session('claude', 's1')],
        ),
      );
      await tester.pumpWidget(buildSubject(const [], controller: controller));
      await tester.pump();

      // Hiding the tab stops the poll (browsers throttle hidden-tab timers to
      // >=1min anyway, so the poll is not what makes this feel fixed).
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      final whileHidden = controller.loadCount;
      await tester.pump(SessionsWorkspace.rosterPollInterval * 3);
      expect(
        controller.loadCount,
        whileHidden,
        reason: 'a hidden workspace should not poll',
      );

      // Returning to the tab refetches at once rather than waiting out the
      // interval — this is the path that clears the stale status on return.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(controller.loadCount, whileHidden + 1);

      // ...and polling resumes with it.
      await tester.pump(SessionsWorkspace.rosterPollInterval);
      expect(controller.loadCount, whileHidden + 2);
    });
  });

  group('SessionsWorkspace split resizer', () {
    final sash = find.byKey(const Key('workspace-split-sash'));
    final rosterPane = find.byKey(const Key('workspace-roster-pane'));
    final expandTab = find.byKey(const Key('workspace-roster-expand-tab'));

    double rosterWidth(WidgetTester tester) => tester.getSize(rosterPane).width;

    /// Widens the surface so the roster has room to reach its 480dp ceiling.
    /// At the stock 800dp test surface the window rule (`width - 480`) would
    /// cap the roster at 320 and mask the real clamp.
    Future<void> useWideSurface(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(1200, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
    }

    Future<void> dragSash(WidgetTester tester, double dx) async {
      await tester.drag(sash, Offset(dx, 0));
      await tester.pumpAndSettle();
    }

    // The owner's override on the spec: the side session list starts closed,
    // and only a saved preference reopens it.
    testWidgets('defaults to a collapsed roster on first run', (tester) async {
      await tester.pumpWidget(
        buildSubject(
          [_session('claude', 'a')],
          prefsStore: _FakeWorkspacePrefsStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterPane, findsNothing);
      expect(sash, findsNothing);
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);
      expect(expandTab, findsOneWidget);
      // The detail pane still fills the workspace.
      expect(find.text('Select a session to open it here.'), findsOneWidget);
    });

    // Restoring never writes, so a user who keeps the roster closed keeps null
    // prefs forever. If the roster defaulted to open, that user would see the
    // 320dp roster flash on *every* launch, not just the first — so there must
    // be no expanded frame at all before the store read lands.
    testWidgets('never renders an expanded roster before the restore lands', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          [_session('claude', 'a')],
          prefsStore: _FakeWorkspacePrefsStore(),
        ),
      );

      // The very first frame, before the async restore has resolved.
      expect(rosterPane, findsNothing);
      expect(sash, findsNothing);
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);

      // And it stays that way once the (empty) store has been read.
      await tester.pumpAndSettle();
      expect(rosterPane, findsNothing);
      expect(expandTab, findsOneWidget);
    });

    // The mirror of the above: an expanded roster is a restored preference, not
    // a default, so it only appears after the store read.
    testWidgets('a saved expanded roster appears only after the restore', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          const [],
          prefsStore: _FakeWorkspacePrefsStore(
            const WorkspaceRosterPrefs(
              width: SessionsWorkspace.defaultListPaneWidth,
              collapsed: false,
            ),
          ),
        ),
      );
      expect(rosterPane, findsNothing);

      await tester.pumpAndSettle();
      expect(rosterPane, findsOneWidget);
      expect(rosterWidth(tester), SessionsWorkspace.defaultListPaneWidth);
    });

    // Collapsing must not strand Attention/Settings: the Expanded layout has no
    // bottom nav and no command surface, so the rail is their only route while
    // the roster is closed. router_test covers the navigation itself.
    testWidgets('the collapsed rail keeps the workspace actions reachable', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          const [],
          unreadCount: 3,
          prefsStore: _FakeWorkspacePrefsStore(),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterPane, findsNothing);
      expect(expandTab, findsOneWidget);
      expect(
        find.byKey(const Key('sessions-workspace-attention')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-settings')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-global-new')),
        findsOneWidget,
      );
      // The unread badge survives the collapse.
      expect(find.text('3'), findsOneWidget);
    });

    // The header sheds Attention/Settings only once they genuinely stop
    // fitting, so the sliver roster keeps them for as long as it can.
    testWidgets('a sliver roster keeps its actions until they cannot fit', (
      tester,
    ) async {
      await useWideSurface(tester);
      await tester.pumpWidget(
        buildSubject(
          const [],
          prefsStore: _FakeWorkspacePrefsStore(
            const WorkspaceRosterPrefs(
              width: SessionsWorkspace.compactHeaderWidth,
              collapsed: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterWidth(tester), SessionsWorkspace.compactHeaderWidth);
      expect(
        find.byKey(const Key('sessions-workspace-attention')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-settings')),
        findsOneWidget,
      );
    });

    // At the 120dp floor the three buttons no longer fit; the header drops the
    // secondary pair rather than overflowing. New session, the roster's own
    // action, stays.
    testWidgets('the 120dp floor sheds secondary actions without overflow', (
      tester,
    ) async {
      await useWideSurface(tester);
      await tester.pumpWidget(
        buildSubject(
          const [],
          prefsStore: _FakeWorkspacePrefsStore(
            const WorkspaceRosterPrefs(
              width: SessionsWorkspace.minListPaneWidth,
              collapsed: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterWidth(tester), SessionsWorkspace.minListPaneWidth);
      expect(
        find.byKey(const Key('sessions-workspace-global-new')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('sessions-workspace-attention')),
        findsNothing,
      );
    });

    testWidgets('the expand tab reopens the roster at the default width', (
      tester,
    ) async {
      final store = _FakeWorkspacePrefsStore();
      await tester.pumpWidget(
        buildSubject([_session('claude', 'a')], prefsStore: store),
      );
      await tester.pumpAndSettle();

      await tester.tap(expandTab);
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      expect(rosterPane, findsOneWidget);
      expect(rosterWidth(tester), SessionsWorkspace.defaultListPaneWidth);
      expect(find.byKey(const Key('session-row-claude/a')), findsOneWidget);
      expect(expandTab, findsNothing);

      // Expanding is a choice, so it is now the saved preference.
      await tester.pump(SessionsWorkspace.resizePersistDebounce);
      expect(store.saved?.collapsed, isFalse);
      expect(store.saved?.width, SessionsWorkspace.defaultListPaneWidth);
    });

    testWidgets('a saved split is restored on mount', (tester) async {
      await useWideSurface(tester);
      await tester.pumpWidget(
        buildSubject(
          const [],
          prefsStore: _FakeWorkspacePrefsStore(
            const WorkspaceRosterPrefs(width: 420, collapsed: false),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterWidth(tester), 420);
    });

    // A window narrower than the one the width was saved on must not starve the
    // detail pane: 900 - 480 leaves the roster 420.
    testWidgets('a restored split is clamped to the current window', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(900, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        buildSubject(
          const [],
          prefsStore: _FakeWorkspacePrefsStore(
            const WorkspaceRosterPrefs(width: 470, collapsed: false),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(rosterWidth(tester), 420);
    });

    testWidgets('dragging right grows the roster and clamps at 480', (
      tester,
    ) async {
      await useWideSurface(tester);
      await tester.pumpWidget(buildSubject(const []));
      await tester.pumpAndSettle();
      expect(rosterWidth(tester), SessionsWorkspace.defaultListPaneWidth);

      await dragSash(tester, 60);
      expect(rosterWidth(tester), greaterThan(320));
      expect(rosterWidth(tester), lessThanOrEqualTo(480));

      await dragSash(tester, 1000);
      expect(rosterWidth(tester), SessionsWorkspace.maxListPaneWidth);
    });

    testWidgets('split sash stays neutral while hovered', (tester) async {
      await tester.pumpWidget(buildSubject(const []));
      await tester.pumpAndSettle();

      const lineKey = Key('workspace-split-sash-line');
      final restingLine = tester.widget<Container>(find.byKey(lineKey));
      final restingColor = restingLine.color;
      expect(restingLine.constraints?.maxWidth, 1);

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(sash));
      await tester.pump();

      final hoveredLine = tester.widget<Container>(find.byKey(lineKey));
      expect(hoveredLine.constraints?.maxWidth, 2);
      expect(hoveredLine.color, restingColor);
    });

    // Arrow keys step the split without the touch slop a drag carries, so this
    // is where the 120dp floor is asserted exactly.
    testWidgets('arrow keys step the split and clamp at the 120dp floor', (
      tester,
    ) async {
      await useWideSurface(tester);
      await tester.pumpWidget(buildSubject(const []));
      await tester.pumpAndSettle();

      tester
          .state<WorkspaceSplitSashState>(find.byType(WorkspaceSplitSash))
          .focusForTest();
      await tester.pump();

      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump();
      expect(rosterWidth(tester), 304);

      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump();
      expect(rosterWidth(tester), 320);

      // Shift coarsens the step to 64dp; four of them run into the floor.
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      for (var i = 0; i < 4; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
        await tester.pump();
      }
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      expect(rosterWidth(tester), SessionsWorkspace.minListPaneWidth);

      // Home resets to the default split.
      await tester.sendKeyEvent(LogicalKeyboardKey.home);
      await tester.pump();
      expect(rosterWidth(tester), SessionsWorkspace.defaultListPaneWidth);
    });

    testWidgets('dragging past the snap collapses the roster', (tester) async {
      await useWideSurface(tester);
      await tester.pumpWidget(buildSubject([_session('claude', 'a')]));
      await tester.pumpAndSettle();

      await dragSash(tester, -1000);

      expect(rosterPane, findsNothing);
      expect(find.byKey(const Key('session-row-claude/a')), findsNothing);
      expect(expandTab, findsOneWidget);
    });

    // Reopening restores the width the collapse drag started from, not the
    // floor the pointer dragged through on its way past the snap.
    testWidgets('expanding restores the pre-collapse width', (tester) async {
      await useWideSurface(tester);
      await tester.pumpWidget(buildSubject(const []));
      await tester.pumpAndSettle();

      await dragSash(tester, 1000);
      expect(rosterWidth(tester), SessionsWorkspace.maxListPaneWidth);

      await dragSash(tester, -1000);
      expect(expandTab, findsOneWidget);

      await tester.tap(expandTab);
      await tester.pumpAndSettle();
      expect(rosterWidth(tester), SessionsWorkspace.maxListPaneWidth);
    });

    testWidgets('double-clicking the sash resets to the default width', (
      tester,
    ) async {
      await useWideSurface(tester);
      await tester.pumpWidget(buildSubject(const []));
      await tester.pumpAndSettle();

      await dragSash(tester, 1000);
      expect(rosterWidth(tester), SessionsWorkspace.maxListPaneWidth);

      await tester.tap(sash);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(sash);
      await tester.pumpAndSettle();

      expect(rosterWidth(tester), SessionsWorkspace.defaultListPaneWidth);
    });

    testWidgets('a resize is persisted once it settles', (tester) async {
      await useWideSurface(tester);
      final store = _FakeWorkspacePrefsStore(
        const WorkspaceRosterPrefs(
          width: SessionsWorkspace.defaultListPaneWidth,
          collapsed: false,
        ),
      );
      await tester.pumpWidget(buildSubject(const [], prefsStore: store));
      await tester.pumpAndSettle();
      final savesBefore = store.saveCount;

      await dragSash(tester, 1000);
      // Debounced: nothing is written while the drag is still settling.
      expect(store.saveCount, savesBefore);

      await tester.pump(SessionsWorkspace.resizePersistDebounce);
      expect(store.saveCount, savesBefore + 1);
      expect(store.saved?.width, SessionsWorkspace.maxListPaneWidth);
      expect(store.saved?.collapsed, isFalse);
    });

    testWidgets('collapsing is persisted', (tester) async {
      await useWideSurface(tester);
      final store = _FakeWorkspacePrefsStore(
        const WorkspaceRosterPrefs(width: 400, collapsed: false),
      );
      await tester.pumpWidget(buildSubject(const [], prefsStore: store));
      await tester.pumpAndSettle();

      await dragSash(tester, -1000);
      await tester.pump(SessionsWorkspace.resizePersistDebounce);

      expect(store.saved?.collapsed, isTrue);
      // The reopen width survives the collapse.
      expect(store.saved?.width, 400);
    });
  });
}

class _StubSessionListController extends SessionListController {
  _StubSessionListController(this._preset);

  final SessionListState _preset;
  int loadCount = 0;
  int silentLoadCount = 0;

  @override
  SessionListState build() => _preset;

  // The workspace triggers an initial load(); keep the preset roster instead of
  // hitting the real repository.
  @override
  Future<void> load({bool silent = false}) async {
    loadCount += 1;
    if (silent) silentLoadCount += 1;
  }

  void setStatus(SessionListStatus status) {
    state = state.copyWith(status: status);
  }
}

/// Records load requests but never completes them, so tests can prove the
/// workspace no longer serializes anything behind a roster reload.
class _HangingLoadSessionListController extends _StubSessionListController {
  _HangingLoadSessionListController(super.preset);

  @override
  Future<void> load({bool silent = false}) {
    loadCount += 1;
    if (silent) silentLoadCount += 1;
    return Completer<void>().future;
  }
}

IconButton _expandedCreateAction(WidgetTester tester) =>
    tester.widget<IconButton>(
      find.byKey(const Key('sessions-workspace-global-new')),
    );

const AgentInfo _workspaceCreationReadyAgent = AgentInfo(
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

final class _ScriptedWorkspaceCapabilityClient extends BrokerClient {
  _ScriptedWorkspaceCapabilityClient(this.responses)
    : super(baseUrl: 'http://test');

  final List<Future<List<AgentInfo>> Function()> responses;
  int listAgentCalls = 0;

  @override
  Future<List<AgentInfo>> listAgents() {
    listAgentCalls += 1;
    return responses.removeAt(0)();
  }

  @override
  void close() {}
}

/// Minimal broker client for the New Session sheet: one creatable agent and an
/// immediate create that returns `codex/created`.
final class _CreateSessionFakeBrokerClient extends BrokerClient {
  _CreateSessionFakeBrokerClient() : super(baseUrl: 'http://test');

  @override
  Future<List<AgentInfo>> listAgents() async => const [
    AgentInfo(
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
      canSelectModelAtCreation: true,
      canRenameNative: false,
      canFork: false,
      canClone: false,
      canTranscriptExport: false,
    ),
  ];

  @override
  Future<ModelCatalogResponse> listAgentModels(String tool) async =>
      ModelCatalogResponse(tool: tool, models: const [], refreshedAt: 1);

  @override
  Future<CreateSessionResponse> createSession(
    String tool, {
    String? directory,
    String? title,
    SessionCurrentModel? model,
  }) async {
    return CreateSessionResponse(
      session: SessionInfo(
        id: 'created',
        tool: tool,
        title: title ?? '',
        status: SessionStatus.idle,
        attachMode: AttachMode.resume,
      ),
      attachMode: 'resume',
    );
  }

  @override
  void close() {}
}

final class _NoCreateSessionBrokerClient extends BrokerClient {
  _NoCreateSessionBrokerClient() : super(baseUrl: 'http://test');

  @override
  Future<List<AgentInfo>> listAgents() async => const [];
}

class _FakeWorkspacePrefsStore implements WorkspacePrefsStore {
  _FakeWorkspacePrefsStore([this.saved]);

  /// The persisted split; null means nothing has ever been saved (first run).
  WorkspaceRosterPrefs? saved;
  int saveCount = 0;

  @override
  Future<WorkspaceRosterPrefs?> loadRoster() async => saved;

  @override
  Future<void> saveRoster(WorkspaceRosterPrefs prefs) async {
    saved = prefs;
    saveCount += 1;
  }
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

class _NoopDriveIntentStore implements SessionDriveIntentStore {
  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async => null;

  @override
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}

  @override
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}
}
