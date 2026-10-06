import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/open_session_sync_supervisor.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('Session Detail bootstrap UI', () {
    testWidgets(
      'live-only page releases hidden transport and restores only after '
      'fresh foreground roster',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final connection = _LiveOnlyPageConnection();
        final roster = _LiveOnlyPageRoster();
        var refreshes = 0;
        Completer<void>? refreshGate;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: FakeBrokerClient(
              agents: [fakeControllerAgentInfo(supportsObserve: false)],
            ),
            extraOverrides: [
              sessionListControllerProvider.overrideWith(() => roster),
              sessionRosterResumeRefreshProvider.overrideWithValue(() async {
                refreshes++;
                await refreshGate?.future;
              }),
            ],
          ),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        expect(connection.refusedBare, 0);
        final prompt = find.byKey(const Key('session-detail-prompt-input'));
        await tester.enterText(prompt, 'unsent foreground draft');
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pumpAndSettle();
        expect(connection.closeCalls, 0);
        expect(connection.reattachModes, ['live']);
        expect(refreshes, 0);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.hidden,
        );
        await tester.pumpAndSettle();
        expect(connection.closeCalls, 1);
        expect(connection.reattachModes, ['live']);
        refreshGate = Completer<void>();
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        await tester.pump();
        expect(refreshes, 1);
        expect(connection.reattachModes, ['live']);
        refreshGate.complete();
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live', 'live']);
        expect(connection.refusedBare, 0);
        expect(find.text('Retained live-only transcript'), findsOneWidget);
        expect(find.text('unsent foreground draft'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      },
    );

    testWidgets(
      'visible inactive page attaches and restores without focus reconnects',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        final connection = _LiveOnlyPageConnection();
        var refreshes = 0;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: FakeBrokerClient(
              agents: [fakeControllerAgentInfo(supportsObserve: false)],
            ),
            extraOverrides: [
              sessionListControllerProvider.overrideWith(
                _LiveOnlyPageRoster.new,
              ),
              sessionRosterResumeRefreshProvider.overrideWithValue(() async {
                refreshes++;
              }),
            ],
          ),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        expect(connection.closeCalls, 0);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        expect(refreshes, 0);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.hidden,
        );
        await tester.pumpAndSettle();
        expect(connection.closeCalls, 1);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live', 'live']);
        expect(refreshes, 1);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live', 'live']);
        expect(refreshes, 1);
        expect(connection.refusedBare, 0);
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      },
    );

    testWidgets(
      'offstage live-only page rejects a late foreground roster completion',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final connection = _LiveOnlyPageConnection();
        final onstage = ValueNotifier<bool>(true);
        addTearDown(onstage.dispose);
        Completer<void>? refreshGate;
        var refreshes = 0;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: FakeBrokerClient(
              agents: [fakeControllerAgentInfo(supportsObserve: false)],
            ),
            extraOverrides: [
              sessionListControllerProvider.overrideWith(
                _LiveOnlyPageRoster.new,
              ),
              sessionRosterResumeRefreshProvider.overrideWithValue(() async {
                refreshes++;
                await refreshGate?.future;
              }),
            ],
            homeBuilder: (page) => ValueListenableBuilder<bool>(
              valueListenable: onstage,
              builder: (context, visible, _) => TickerMode(
                enabled: visible,
                child: Offstage(offstage: !visible, child: page),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        onstage.value = false;
        await tester.pumpAndSettle();
        expect(connection.closeCalls, 1);
        refreshGate = Completer<void>();
        onstage.value = true;
        await tester.pump();
        await tester.pump();
        expect(refreshes, 1);
        onstage.value = false;
        await tester.pump();
        refreshGate.complete();
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        refreshGate = null;
        onstage.value = true;
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live', 'live']);
        expect(connection.refusedBare, 0);
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      },
    );
    testWidgets(
      'initial offstage page cannot join before fresh foreground roster',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final connection = _LiveOnlyPageConnection();
        final onstage = ValueNotifier<bool>(false);
        addTearDown(onstage.dispose);
        final refreshGate = Completer<void>();
        var refreshes = 0;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: FakeBrokerClient(
              agents: [fakeControllerAgentInfo(supportsObserve: false)],
            ),
            extraOverrides: [
              sessionListControllerProvider.overrideWith(
                _LiveOnlyPageRoster.new,
              ),
              sessionRosterResumeRefreshProvider.overrideWithValue(() async {
                refreshes++;
                await refreshGate.future;
              }),
            ],
            homeBuilder: (page) => ValueListenableBuilder<bool>(
              valueListenable: onstage,
              builder: (context, visible, _) => TickerMode(
                enabled: visible,
                child: Offstage(offstage: !visible, child: page),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, isEmpty);
        expect(connection.refusedBare, 0);
        onstage.value = true;
        await tester.pump();
        await tester.pump();
        expect(refreshes, 1);
        expect(connection.reattachModes, isEmpty);
        refreshGate.complete();
        await tester.pumpAndSettle();
        expect(connection.reattachModes, ['live']);
        expect(connection.refusedBare, 0);
        expect(find.text('Retained live-only transcript'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      },
    );

    testWidgets(
      'credential save in initially offstage page waits for foreground roster',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final database = AppDatabase(NativeDatabase.memory());
        final profile = await DriftBrokerProfileRepository(
          database,
        ).save(createTestBrokerProfile());
        final credentials = InMemoryCredentialStore();
        final connections = <_LiveOnlyPageConnection>[];
        final onstage = ValueNotifier<bool>(false);
        addTearDown(onstage.dispose);
        final refreshGate = Completer<void>();
        var refreshes = 0;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            database: database,
            brokerProfile: profile,
            credentialStore: credentials,
            brokerClientLoader: (ref) async {
              final key = ref.watch(activeBrokerProfileProvider)?.credentialKey;
              return FakeBrokerClient(
                agents: [fakeControllerAgentInfo(supportsObserve: false)],
                token: key == null
                    ? null
                    : await credentials.readBrokerToken(key),
              );
            },
            connectionFactory:
                ({required resolver, required sessionId, required tool}) {
                  final connection = _LiveOnlyPageConnection();
                  connections.add(connection);
                  return connection;
                },
            extraOverrides: [
              sessionListControllerProvider.overrideWith(
                _LiveOnlyPageRoster.new,
              ),
              sessionRosterResumeRefreshProvider.overrideWithValue(() async {
                refreshes++;
                await refreshGate.future;
              }),
            ],
            homeBuilder: (page) => ValueListenableBuilder<bool>(
              valueListenable: onstage,
              builder: (context, visible, _) => TickerMode(
                enabled: visible,
                child: Offstage(offstage: !visible, child: page),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(connections, isEmpty);
        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage, skipOffstage: false)),
        );
        await container
            .read(brokerCredentialsControllerProvider.notifier)
            .saveToken('fixture-token');
        await tester.pumpAndSettle();
        expect(connections, isEmpty);
        onstage.value = true;
        await tester.pump();
        await tester.pump();
        expect(refreshes, 1);
        expect(connections, isEmpty);
        refreshGate.complete();
        await tester.pumpAndSettle();
        expect(connections, hasLength(1));
        expect(connections.single.reattachModes, ['live']);
        expect(connections.single.refusedBare, 0);
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      },
    );

    testWidgets('blocks uncached history in narrow light and wide dark', (
      tester,
    ) async {
      for (final layout in const [
        (Size(360, 760), Brightness.light),
        (Size(1280, 800), Brightness.dark),
      ]) {
        _setViewport(tester, layout.$1);
        const state = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          bootstrapState: SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.awaitingInitialHistory,
            attempt: 1,
          ),
          connectionStatus: SessionDetailConnectionStatus.connected,
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: SeededSessionDetailController(state),
            theme: _theme(layout.$2),
          ),
        );
        await tester.pump();

        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsOneWidget,
        );
        expect(find.text('Loading session history…'), findsOneWidget);
        expect(
          find.text(
            'Connecting to the session. Its history will appear here when '
            'it arrives.',
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-prompt-input')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      }
    });

    testWidgets('keeps cached messages visible while reconnecting', (
      tester,
    ) async {
      for (final layout in const [
        (Size(360, 760), Brightness.dark),
        (Size(1280, 800), Brightness.light),
      ]) {
        _setViewport(tester, layout.$1);
        const state = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          bootstrapState: SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.awaitingInitialHistory,
            attempt: 1,
            hasCachedMessages: true,
          ),
          connectionStatus: SessionDetailConnectionStatus.reconnecting,
          events: [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'text': 'Saved transcript message',
                },
              ),
            ),
          ],
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: SeededSessionDetailController(state),
            theme: _theme(layout.$2),
          ),
        );
        await tester.pump();

        expect(find.text('Saved transcript message'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-bootstrap-inline')),
          findsOneWidget,
        );
        expect(
          find.text('Showing saved messages while the session reconnects…'),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-prompt-input')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      }
    });

    testWidgets(
      'manual detach keeps transcript and local drafting without progress',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'text': 'Retained after detach',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: _theme(Brightness.dark),
          ),
        );
        await tester.pumpAndSettle();

        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-detach-button'),
        );
        await tester.tap(
          find.byKey(const Key('session-detail-detach-button')),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-chat');

        expect(find.text('Retained after detach'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-transcript-empty')),
          findsNothing,
        );
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .enabled,
          isTrue,
        );
        expect(
          find.byKey(const Key('session-detail-send-button')),
          findsOneWidget,
        );
        await openComposerMenu(tester);
        expect(
          tester
              .widget<PopupMenuItem<String>>(
                find.byKey(const Key('session-detail-attach-button')),
              )
              .enabled,
          isFalse,
        );
        await tester.tapAt(const Offset(4, 4));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-inline')),
          findsNothing,
        );
        expect(find.byType(CircularProgressIndicator), findsNothing);
      },
    );

    testWidgets(
      'manual detach keeps authoritative empty and local drafting '
      'without progress',
      (tester) async {
        _setViewport(tester, const Size(360, 760));
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: _theme(Brightness.light),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-transcript-empty')),
          findsOneWidget,
        );
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-detach-button'),
        );
        await tester.tap(
          find.byKey(const Key('session-detail-detach-button')),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-chat');

        expect(
          find.byKey(const Key('session-detail-transcript-empty')),
          findsOneWidget,
        );
        expect(find.text('No messages in this session yet.'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .enabled,
          isTrue,
        );
        expect(
          find.byKey(const Key('session-detail-send-button')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-inline')),
          findsNothing,
        );
        expect(find.byType(CircularProgressIndicator), findsNothing);
      },
    );

    testWidgets(
      'manual detach before initial history does not claim empty',
      (tester) async {
        _setViewport(tester, const Size(360, 760));
        const detachedBeforeHistory = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          connectionStatus: SessionDetailConnectionStatus.closed,
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: SeededSessionDetailController(
              detachedBeforeHistory,
            ),
            theme: _theme(Brightness.dark),
          ),
        );
        await tester.pump();

        expect(
          find.byKey(const Key('session-detail-transcript-empty')),
          findsNothing,
        );
        expect(find.text('No messages in this session yet.'), findsNothing);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .enabled,
          isTrue,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-inline')),
          findsNothing,
        );
        expect(find.byType(CircularProgressIndicator), findsNothing);
      },
    );

    testWidgets('shows genuine empty only after authoritative empty history', (
      tester,
    ) async {
      _setViewport(tester, const Size(360, 760));
      const waiting = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-1',
        bootstrapState: SessionDetailBootstrapState(
          readiness: SessionDetailBootstrapReadiness.awaitingInitialHistory,
          attempt: 1,
        ),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          seededController: SeededSessionDetailController(waiting),
          theme: _theme(Brightness.light),
        ),
      );
      await tester.pump();
      expect(find.text('No messages in this session yet.'), findsNothing);
      await _resetApp(tester);

      _setViewport(tester, const Size(1280, 800));
      const ready = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-1',
        bootstrapState: SessionDetailBootstrapState(
          readiness: SessionDetailBootstrapReadiness.ready,
          attempt: 1,
        ),
        connectionStatus: SessionDetailConnectionStatus.connected,
        events: [HistoryWireEvent(messages: [], reset: true)],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          seededController: SeededSessionDetailController(ready),
          theme: _theme(Brightness.dark),
        ),
      );
      await tester.pump();

      expect(
        find.byKey(const Key('session-detail-transcript-empty')),
        findsOneWidget,
      );
      expect(find.text('No messages in this session yet.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows plain failure and timeout recovery copy', (
      tester,
    ) async {
      final cases = [
        (
          const Size(360, 760),
          Brightness.light,
          const SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.failed,
            attempt: 1,
            failureKind: FailureKind.offline,
            failureSource: SessionDetailBootstrapFailureSource.attach,
          ),
          "Couldn't load this session",
          "Couldn't connect to this session. The server didn't respond.",
        ),
        (
          const Size(1280, 800),
          Brightness.dark,
          const SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.historyTimeout,
            attempt: 1,
            failureKind: FailureKind.offline,
            failureSource: SessionDetailBootstrapFailureSource.historyTimeout,
          ),
          'Session history is taking too long',
          "The session connected, but its history didn't arrive.",
        ),
      ];

      for (final testCase in cases) {
        _setViewport(tester, testCase.$1);
        final state = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          bootstrapState: testCase.$3,
          error: const LocalizedFailure(
            lead: FailureLead.connectSession,
            kind: FailureKind.offline,
            detail: 'raw transport exception must stay hidden',
          ),
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: SeededSessionDetailController(state),
            theme: _theme(testCase.$2),
          ),
        );
        await tester.pump();

        expect(find.text(testCase.$4), findsOneWidget);
        expect(find.textContaining(testCase.$5), findsOneWidget);
        expect(
          find.ancestor(
            of: find.byKey(const Key('session-detail-bootstrap-title')),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        expect(
          find.ancestor(
            of: find.byKey(const Key('session-detail-bootstrap-message')),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        expect(
          find.text('raw transport exception must stay hidden'),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-retry')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await _resetApp(tester);
      }
    });

    testWidgets('Retry calls attach once while the retry is in flight', (
      tester,
    ) async {
      _setViewport(tester, const Size(360, 760));
      final retryRelease = Completer<void>();
      const state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-1',
        bootstrapState: SessionDetailBootstrapState(
          readiness: SessionDetailBootstrapReadiness.historyTimeout,
          attempt: 1,
          failureKind: FailureKind.offline,
          failureSource: SessionDetailBootstrapFailureSource.historyTimeout,
          hasCachedMessages: true,
        ),
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.modelOutput,
              raw: {
                'type': 'model-output',
                'text': 'Still visible after timeout',
              },
            ),
          ),
        ],
      );
      final controller = SeededSessionDetailController(
        state,
        onAttach: (callCount) async {
          if (callCount > 1) await retryRelease.future;
        },
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          seededController: controller,
          theme: _theme(Brightness.dark),
        ),
      );
      await tester.pump();
      expect(controller.attachCallCount, 1);

      expect(find.text('Still visible after timeout'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.byKey(
            const Key('session-detail-bootstrap-inline-message'),
          ),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      final retry = find.byKey(
        const Key('session-detail-bootstrap-inline-retry'),
      );
      await tester.tap(retry);
      await tester.pump();
      await tester.tap(retry);
      await tester.pump();

      expect(controller.attachCallCount, 2);
      expect(find.text('Retrying…'), findsOneWidget);
      expect(tester.widget<TextButton>(retry).onPressed, isNull);

      retryRelease.complete();
      await tester.pumpAndSettle();
      expect(tester.widget<TextButton>(retry).onPressed, isNotNull);
    });

    testWidgets(
      'resident Observe restores visible Drive without a tab remount',
      (tester) async {
        _setViewport(tester, const Size(1280, 800));
        final clientReadyProvider = StateProvider<bool>((ref) => false);
        final driveIntents = InMemoryControllerDriveIntentStore()
          ..seedAppCreated('claude', 'session-1');
        final openSessions = _GatedOpenSessionsStore();
        final connection = ScriptedSessionDetailConnection(
          events: [
            SessionWireEvent(
              info: SessionInfo.fromJson(const {
                'id': 'session-1',
                'tool': 'claude',
                'title': 'Refresh race',
                'status': 'idle',
                'attachMode': 'observe',
                'control': {
                  'drive': {'state': 'observing', 'supported': true},
                  'terminalSync': {
                    'supported': true,
                    'syncAvailable': true,
                    'active': false,
                  },
                },
              }),
            ),
          ],
          reattachEvents: [
            SessionWireEvent(
              info: SessionInfo.fromJson(const {
                'id': 'session-1',
                'tool': 'claude',
                'title': 'Refresh race',
                'status': 'idle',
                'attachMode': 'resume',
                'control': {
                  'drive': {'state': 'driving', 'supported': true},
                  'terminalSync': {
                    'supported': false,
                    'syncAvailable': false,
                    'active': false,
                  },
                },
              }),
            ),
          ],
        );
        late ProviderContainer container;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            driveIntentStore: driveIntents,
            openSessionsStore: openSessions,
            brokerClientLoader: (ref) async =>
                ref.watch(clientReadyProvider) ? FakeBrokerClient() : null,
            extraOverrides: [
              sessionNotificationLifecycleMonitorProvider.overrideWithValue(
                StubBrokerAppLifecycleMonitor(
                  currentState: BrokerAppLifecycleState.resumed,
                ),
              ),
            ],
            theme: _theme(Brightness.light),
            homeBuilder: (page) => Builder(
              builder: (context) {
                container = ProviderScope.containerOf(context);
                return OpenSessionSyncSupervisor(child: page);
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, isEmpty);

        // Reproduce refresh ordering: the page's mount-time request has
        // settled without a client, then the resident supervisor connects its
        // background Observe socket after broker and working-set hydration.
        container.read(clientReadyProvider.notifier).state = true;
        await tester.pumpAndSettle();
        openSessions.complete(
          const OpenSessionsSnapshot(
            refs: [
              SessionRef(
                tool: 'claude',
                id: 'session-1',
                title: 'Refresh race',
                status: SessionStatus.idle,
              ),
            ],
            activeKey: 'claude/session-1',
          ),
        );
        await tester.pumpAndSettle();

        const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
        expect(connection.connectCount, 1);
        expect(connection.reattachModes, ['resume']);
        expect(connection.reattachReasons, ['app-restore']);
        expect(
          SessionControlView.fromSessionInfo(
            container.read(sessionDetailControllerProvider(key)).sessionInfo,
          ).canMutate,
          isTrue,
          reason: 'the visible session must return to Driving without remount',
        );
      },
    );
  });
}

ThemeData _theme(Brightness brightness) {
  final spec = themeSpecById(kDefaultThemeId);
  final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
  return buildAppTheme(tokens, brightness);
}

void _setViewport(WidgetTester tester, Size size) {
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
}

Future<void> _resetApp(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

final class _GatedOpenSessionsStore implements OpenSessionsStore {
  final Completer<OpenSessionsSnapshot> _load = Completer();

  void complete(OpenSessionsSnapshot snapshot) => _load.complete(snapshot);

  @override
  Future<OpenSessionsSnapshot> load(String profileId) => _load.future;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {}
}

const _liveOnlyPageInfo = SessionInfo(
  id: 'session-1',
  tool: 'claude',
  title: 'Live-only fixture',
  status: SessionStatus.idle,
  attachMode: AttachMode.live,
);

final class _LiveOnlyPageRoster extends StubSessionListController {
  @override
  SessionListState build() => const SessionListState(
    status: SessionListStatus.loaded,
    sessions: [_liveOnlyPageInfo],
  );
}

final class _LiveOnlyPageConnection extends ScriptedSessionDetailConnection {
  _LiveOnlyPageConnection()
    : super(
        events: const [],
        reattachEvents: const [
          SessionWireEvent(info: _liveOnlyPageInfo),
          HistoryWireEvent(
            reset: true,
            messages: [
              AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'text': 'Retained live-only transcript',
                },
              ),
            ],
          ),
        ],
      );
  int refusedBare = 0;
  int closeCalls = 0;
  @override
  Future<void> connect() async {
    refusedBare++;
    throw StateError('explicit foreground live attach required');
  }

  @override
  Future<void> close({bool reconnect = false}) async {
    closeCalls++;
    await super.close(reconnect: reconnect);
  }
}
