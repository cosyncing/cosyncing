import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/view/visible_attention_session_scope.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/open_session_sync_supervisor.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  const a = SessionRef(
    tool: 'claude',
    id: 'a',
    title: 'A',
    status: SessionStatus.working,
  );
  const b = SessionRef(
    tool: 'codex',
    id: 'b',
    title: 'B',
    status: SessionStatus.idle,
  );
  const c = SessionRef(
    tool: 'claude',
    id: 'c',
    title: 'C',
    status: SessionStatus.working,
  );
  const d = SessionRef(
    tool: 'codex',
    id: 'd',
    title: 'D',
    status: SessionStatus.idle,
  );

  testWidgets(
    'open members stay resident as Observe and release exactly on close',
    (tester) async {
      final tracker = _DetailTracker();
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a, b],
          activeKey: 'claude/a',
        );
      final resident = ValueNotifier<bool>(true);
      addTearDown(resident.dispose);
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionDetailControllerProvider.overrideWith(
              () => _TrackingDetailController(tracker),
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return MaterialApp(
                home: ValueListenableBuilder<bool>(
                  valueListenable: resident,
                  builder: (context, enabled, _) => enabled
                      ? const OpenSessionSyncSupervisor(
                          child: _SelectedStateProbe(),
                        )
                      : const SizedBox.shrink(),
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tracker.intents['claude/a'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(tracker.intents['codex/b'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(find.text('claude/a:disconnected'), findsOneWidget);

      // B is the only mounted probe. A still receives state through its
      // resident lease, and its final projection is ready on the first frame
      // after activation.
      tracker.controllers['claude/a']!.publishedState =
          const SessionDetailState(
            tool: 'claude',
            sessionId: 'a',
            connectionStatus: SessionDetailConnectionStatus.connected,
          );
      container
          .read(openSessionsControllerProvider.notifier)
          .activate('codex/b');
      await tester.pump();
      expect(tracker.intents['codex/b'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      container
          .read(openSessionsControllerProvider.notifier)
          .activate('claude/a');
      await tester.pump();
      expect(find.text('claude/a:connected'), findsOneWidget);

      // Once both sessions have been interactive, switching is a pure
      // visibility change: no attach/bootstrap work repeats.
      for (var index = 0; index < 3; index++) {
        container
            .read(openSessionsControllerProvider.notifier)
            .activate('codex/b');
        await tester.pump();
        container
            .read(openSessionsControllerProvider.notifier)
            .activate('claude/a');
        await tester.pump();
      }
      expect(tracker.intents['claude/a']!.length, 1);
      expect(tracker.intents['codex/b']!.length, 1);

      final source = RosterSource.ofProfile(
        container.read(activeBrokerProfileProvider)!,
      );
      final viewportKey = SessionViewportKey.forSource(
        source: source,
        tool: a.tool,
        sessionId: a.id,
      );
      final registry = container.read(
        sessionViewportRegistryProvider.notifier,
      );
      final generation = registry.membershipGenerationFor(viewportKey)!;
      registry.capture(
        key: viewportKey,
        membershipGeneration: generation,
        followTail: false,
        anchorMessageKey: 'user-message:id:a-40',
        anchorViewportTop: 24,
      );

      unawaited(
        container.read(openSessionsControllerProvider.notifier).close(a.key),
      );
      await tester.pump();
      await tester.pump();

      expect(tracker.disposed, contains('claude/a'));
      expect(tracker.disposed, isNot(contains('codex/b')));
      expect(
        container.read(sessionViewportRegistryProvider),
        isNot(contains(viewportKey)),
      );

      // Fail-proof resident lease: deleting the supervisor disposes B.
      // Re-adding it creates a fresh controller/bootstrap. Removing the lease
      // from production would make ordinary A/B switching take this path.
      final buildsBefore = tracker.builds['codex/b']!;
      resident.value = false;
      await tester.pump();
      await tester.pump();
      expect(tracker.disposed, contains('codex/b'));

      resident.value = true;
      await tester.pumpAndSettle();
      expect(tracker.builds['codex/b'], buildsBefore + 1);
      expect(
        tracker.intents['codex/b']!.last,
        SessionDetailAttachIntent.backgroundObserve,
      );
    },
  );

  testWidgets('one hung attach leaves the second admission lane available', (
    tester,
  ) async {
    final gate = Completer<void>();
    final tracker = _DetailTracker(hungKey: 'claude/a', hungGate: gate);
    final store = _OpenStore()
      ..snapshots['p1'] = const OpenSessionsSnapshot(
        refs: [a, b],
        activeKey: 'claude/a',
      );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          activeBrokerProfileProvider.overrideWith(
            (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
          ),
          openSessionsStoreProvider.overrideWithValue(store),
          sessionDetailControllerProvider.overrideWith(
            () => _TrackingDetailController(tracker),
          ),
        ],
        child: const MaterialApp(
          home: OpenSessionSyncSupervisor(child: SizedBox.shrink()),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(tracker.intents['claude/a'], isNotEmpty);
    expect(
      tracker.intents['codex/b'],
      [SessionDetailAttachIntent.backgroundObserve],
      reason: 'A hung attach must not serialize unrelated session B',
    );
    gate.complete();
    await tester.pump();
  });

  testWidgets(
    'source replacement waits for retired transport before creating a lease',
    (tester) async {
      final tracker = _DetailTracker();
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a],
          activeKey: 'claude/a',
        );
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionDetailControllerProvider.overrideWith(
              () => _TrackingDetailController(tracker),
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return const MaterialApp(
                home: OpenSessionSyncSupervisor(child: SizedBox.shrink()),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tracker.builds['claude/a'], 1);
      expect(tracker.intents['claude/a'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);

      tracker.suspendGate = Completer<void>();
      container.read(activeBrokerProfileProvider.notifier).state = _profile(
        endpoint: 'http://127.0.0.1:8834',
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(tracker.suspended, contains('claude/a'));
      expect(
        tracker.builds['claude/a'],
        1,
        reason: 'the replacement source must not reuse the retiring provider',
      );
      expect(tracker.intents['claude/a'], hasLength(1));

      tracker.suspendGate!.complete();
      await tester.pumpAndSettle();
      expect(tracker.builds['claude/a'], 2);
      expect(tracker.intents['claude/a'], [
        SessionDetailAttachIntent.backgroundObserve,
        SessionDetailAttachIntent.backgroundObserve,
      ]);
    },
  );

  testWidgets(
    'hide waits for real transport cancellation before reusing attach lanes',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final transport = _CancellableAttachTracker();
      final roster = _ResumeRosterController();
      final transcriptRepository = RecordingSessionTranscriptRepository();
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a, b, c, d],
          activeKey: 'claude/a',
        );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              transcriptRepository,
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemoryControllerDriveIntentStore(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionListControllerProvider.overrideWith(() => roster),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) =>
                  transport.connectionFor('$tool/$sessionId'),
            ),
          ],
          child: const MaterialApp(
            home: OpenSessionSyncSupervisor(child: SizedBox.shrink()),
          ),
        ),
      );
      await _pumpUntil(tester, () => transport.outstanding == 2);
      expect(transport.maxOutstanding, 2);
      expect(transport.started, 2);

      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await _pumpUntil(tester, () => transport.pendingCancellations == 2);
      lifecycle.emit(BrokerAppLifecycleState.resumed);
      await tester.pump();
      await tester.pump();

      expect(roster.loadCount, 1);
      expect(transport.outstanding, 2);
      expect(
        transport.started,
        2,
        reason: 'retiring a counter must not admit replacement work',
      );

      transport.releaseOneCancellation();
      await _pumpUntil(tester, () => transport.started == 3);
      expect(transport.outstanding, 2);
      expect(transport.maxOutstanding, 2);

      transport.releaseOneCancellation();
      await _pumpUntil(tester, () => transport.started == 4);
      expect(transport.outstanding, 2);
      expect(transport.maxOutstanding, 2);

      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await _pumpUntil(tester, () => transport.pendingCancellations == 2);
      transport.releaseAllCancellations();
      await _pumpUntil(tester, () => transport.outstanding == 0);
      expect(transport.maxOutstanding, 2);
    },
  );

  testWidgets(
    'visible production controller keeps Drive through hide resume hide',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final roster = _ResumeRosterController();
      final driveIntents = InMemoryControllerDriveIntentStore()
        ..seedAppCreated(a.tool, a.id);
      final connections = <String, FakeSessionDetailConnection>{};
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a, b],
          activeKey: 'claude/a',
        );
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(driveIntents),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionListControllerProvider.overrideWith(() => roster),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                return connections.putIfAbsent(
                    '$tool/$sessionId',
                    FakeSessionDetailConnection.new,
                  )
                  ..tool = tool
                  ..sessionId = sessionId;
              },
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return const MaterialApp(
                home: OpenSessionSyncSupervisor(
                  child: VisibleAttentionSessionScope(
                    tool: 'claude',
                    sessionId: 'a',
                    child: SizedBox.shrink(),
                  ),
                ),
              );
            },
          ),
        ),
      );
      await _pumpUntil(
        tester,
        () =>
            connections['claude/a']?.connectCount == 1 &&
            connections['codex/b']?.connectCount == 1,
      );

      const aKey = SessionDetailKey(tool: 'claude', sessionId: 'a');
      final aController = container.read(
        sessionDetailControllerProvider(aKey).notifier,
      );
      await aController.attach();
      await tester.pump();
      final aConnection = connections['claude/a']!;
      final bConnection = connections['codex/b']!;
      expect(aConnection.connectCount, 1);
      expect(aConnection.reattachModes, ['resume']);
      expect(aConnection.reattachReasons, ['app-restore']);

      aConnection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      }, status: 'working');
      await tester.pump();
      expect(
        SessionControlView.fromSessionInfo(
          container.read(sessionDetailControllerProvider(aKey)).sessionInfo,
        ).canMutate,
        isTrue,
      );

      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await _pumpUntil(tester, () => bConnection.closeCount == 1);
      expect(aConnection.closeCount, 0);

      lifecycle.emit(BrokerAppLifecycleState.resumed);
      await _pumpUntil(
        tester,
        () => roster.loadCount == 1 && bConnection.reattachModes.length == 1,
      );
      expect(bConnection.reattachModes, [null]);
      expect(aConnection.closeCount, 0);
      expect(aConnection.reattachModes, ['resume']);

      // No tab or open-session mutation occurs between these lifecycle edges.
      // The same exact onstage claim must survive the resumed reconciliation.
      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await _pumpUntil(tester, () => bConnection.closeCount == 2);
      expect(
        aConnection.closeCount,
        0,
        reason: 'the second hide must still preserve the visible transport',
      );
      expect(aConnection.connectCount, 1);
      expect(aConnection.reattachModes, ['resume']);
      expect(aConnection.disarmDriveAuthorityCount, 0);
      expect(
        SessionControlView.fromSessionInfo(
          container.read(sessionDetailControllerProvider(aKey)).sessionInfo,
        ).canMutate,
        isTrue,
        reason: 'lifecycle reconciliation must not downgrade Drive authority',
      );
    },
  );

  testWidgets(
    'deferred reconciliation rereads lifecycle and visibility in both orders',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final roster = _ResumeRosterController();
      final connection = FakeSessionDetailConnection();
      final racePhase = ValueNotifier<int>(0);
      addTearDown(racePhase.dispose);
      var routeIsOnstage = true;
      var scheduledPhase = 0;
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a],
          activeKey: 'claude/a',
        );
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemoryControllerDriveIntentStore(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionListControllerProvider.overrideWith(() => roster),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) =>
                  connection
                    ..tool = tool
                    ..sessionId = sessionId,
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return MaterialApp(
                home: ValueListenableBuilder<int>(
                  valueListenable: racePhase,
                  builder: (context, phase, _) {
                    if (phase != scheduledPhase) {
                      scheduledPhase = phase;
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (phase == 1) {
                          routeIsOnstage = false;
                          lifecycle.emit(BrokerAppLifecycleState.hidden);
                        } else if (phase == 2) {
                          routeIsOnstage = true;
                          lifecycle.emit(BrokerAppLifecycleState.resumed);
                        }
                      });
                    }
                    return const OpenSessionSyncSupervisor(
                      child: SizedBox.shrink(),
                    );
                  },
                ),
              );
            },
          ),
        ),
      );
      await _pumpUntil(tester, () => connection.connectCount == 1);

      final source = RosterSource.ofProfile(
        container.read(activeBrokerProfileProvider)!,
      );
      container
          .read(visibleAttentionSessionProvider.notifier)
          .state = VisibleAttentionSession(
        source: source,
        tool: a.tool,
        sessionId: a.id,
        owner: Object(),
        isStillVisible: () => routeIsOnstage,
      );
      await tester.pump();

      const key = SessionDetailKey(tool: 'claude', sessionId: 'a');
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      expect(connection.connectCount, 1);
      expect(connection.reattachModes, isEmpty);

      // The parent callback is registered before the supervisor builds. The
      // supervisor therefore queues a resumed/visible reconciliation, then the
      // earlier callback makes the route stale and hides the app in the gap
      // before that reconciliation runs.
      racePhase.value = 1;
      await tester.pump();
      await _pumpUntil(tester, () => connection.closeCount == 1);
      await tester.pump(const Duration(minutes: 10));
      expect(
        connection.closeCount,
        1,
        reason: 'the old visible transport must stay suspended while hidden',
      );
      expect(connection.connectCount, 1);
      expect(connection.reattachModes, isEmpty);
      expect(
        roster.loadCount,
        0,
        reason: 'a stale resumed callback must not start resume refresh',
      );

      // Invert the race: the supervisor queues hidden/no-visible truth, then an
      // earlier callback makes A visible and resumes before it runs.
      racePhase.value = 2;
      await tester.pump();
      await _pumpUntil(
        tester,
        () => roster.loadCount == 1 && connection.reattachModes.length == 1,
      );
      expect(connection.closeCount, 1);
      expect(connection.connectCount, 1);
      expect(connection.reattachModes, [null]);
      expect(
        lifecycle.currentState,
        BrokerAppLifecycleState.resumed,
      );
    },
  );

  testWidgets(
    'a hide before a queued reconcile admits no cold background attach',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final roster = _ResumeRosterController();
      final connections = <String, FakeSessionDetailConnection>{};
      final racePhase = ValueNotifier<int>(0);
      addTearDown(racePhase.dispose);
      var scheduledPhase = 0;
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a],
          activeKey: 'claude/a',
        );
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
            ),
            sessionDriveIntentStoreProvider.overrideWithValue(
              InMemoryControllerDriveIntentStore(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionListControllerProvider.overrideWith(() => roster),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                return connections.putIfAbsent(
                    '$tool/$sessionId',
                    FakeSessionDetailConnection.new,
                  )
                  ..tool = tool
                  ..sessionId = sessionId;
              },
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return MaterialApp(
                home: ValueListenableBuilder<int>(
                  valueListenable: racePhase,
                  builder: (context, phase, _) {
                    if (phase != scheduledPhase) {
                      scheduledPhase = phase;
                      // Registered before the supervisor below builds, so it
                      // runs before the supervisor's queued reconciliation.
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (phase != 1) return;
                        lifecycle.emit(BrokerAppLifecycleState.hidden);
                        container
                            .read(openSessionsControllerProvider.notifier)
                            .open(b);
                      });
                    }
                    // Not const: SessionsBranchScreen rebuilds the supervisor
                    // the same way, so it queues a reconcile in this frame. A
                    // const instance would be skipped by updateChild and the
                    // race this test pins would never be set up.
                    // ignore: prefer_const_constructors
                    return OpenSessionSyncSupervisor(
                      child: const SizedBox.shrink(),
                    );
                  },
                ),
              );
            },
          ),
        ),
      );
      await _pumpUntil(
        tester,
        () => connections['claude/a']?.connectCount == 1,
      );
      expect(connections['codex/b'], isNull);

      racePhase.value = 1;
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));

      expect(lifecycle.currentState, BrokerAppLifecycleState.hidden);
      expect(
        connections['codex/b']?.connectCount ?? 0,
        0,
        reason: 'a hidden app must not warm a newly opened background member',
      );
    },
  );

  testWidgets(
    'an attach completing in the hide turn drains no queued cold attach',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final tracker = _DetailTracker()..holdAttaches = true;
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a, b, c],
          activeKey: 'claude/a',
        );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionDetailControllerProvider.overrideWith(
              () => _TrackingDetailController(tracker),
            ),
          ],
          child: const MaterialApp(
            home: OpenSessionSyncSupervisor(child: SizedBox.shrink()),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // Both lanes are busy; C is queued behind them and has never attached.
      expect(tracker.intents.keys, containsAll(['claude/a', 'codex/b']));
      expect(tracker.intents['claude/c'], isNull);
      expect(tracker.attachInFlight, 2);

      // The platform hides the app in the same turn that A's attach settles.
      // A's continuation is queued ahead of the lifecycle broadcast, so the
      // supervisor frees a lane while its listener still believes resumed.
      tracker.releaseOneAttach();
      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));

      expect(lifecycle.currentState, BrokerAppLifecycleState.hidden);
      expect(
        tracker.suspended,
        containsAll(['claude/a', 'codex/b']),
        reason: 'the hide itself must still land',
      );
      expect(
        tracker.intents['claude/c'],
        isNull,
        reason: 'a freed lane must not admit a queued cold attach while hidden',
      );
    },
  );

  testWidgets(
    'hidden releases backgrounds, preserves selected and records, then '
    'refreshes once before a two-lane rewarm',
    (tester) async {
      final lifecycle = _LifecycleMonitor();
      addTearDown(lifecycle.dispose);
      final tracker = _DetailTracker(publishConnectedOnAttach: true);
      final roster = _ResumeRosterController();
      final store = _OpenStore()
        ..snapshots['p1'] = const OpenSessionsSnapshot(
          refs: [a, b, c, d],
          activeKey: 'claude/a',
        );
      late ProviderContainer container;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            activeBrokerProfileProvider.overrideWith(
              (ref) => _profile(endpoint: 'http://127.0.0.1:7734'),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            openSessionsStoreProvider.overrideWithValue(store),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              lifecycle,
            ),
            sessionListControllerProvider.overrideWith(() => roster),
            sessionDetailControllerProvider.overrideWith(
              () => _TrackingDetailController(tracker),
            ),
          ],
          child: Builder(
            builder: (context) {
              container = ProviderScope.containerOf(context);
              return const MaterialApp(
                home: OpenSessionSyncSupervisor(
                  child: _VisibleSelectedStateProbe(),
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tracker.intents['claude/a'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(tracker.intents['codex/b'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(tracker.intents['claude/c'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(tracker.intents['codex/d'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);

      final source = RosterSource.ofProfile(
        container.read(activeBrokerProfileProvider)!,
      );
      final registry = container.read(
        sessionViewportRegistryProvider.notifier,
      );
      for (final session in [a, b, c, d]) {
        final key = SessionViewportKey.forSource(
          source: source,
          tool: session.tool,
          sessionId: session.id,
        );
        registry.capture(
          key: key,
          membershipGeneration: registry.membershipGenerationFor(key)!,
          followTail: session == a,
          anchorMessageKey: 'user-message:id:${session.id}-40',
          anchorViewportTop: 24,
        );
      }
      final viewportBeforeHide = container.read(
        sessionViewportRegistryProvider,
      );
      container.read(attentionFeedDeliveryActiveProvider.notifier).state =
          const {'p1'};

      final intentsBeforeHide = {
        for (final entry in tracker.intents.entries)
          entry.key: entry.value.length,
      };
      tracker
        ..holdAttaches = true
        ..resetAttachConcurrency();
      roster.resumeGate = Completer<void>();

      lifecycle.emit(BrokerAppLifecycleState.hidden);
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));

      expect(
        tracker.suspended,
        containsAll(['codex/b', 'claude/c', 'codex/d']),
      );
      expect(
        tracker.suspended,
        isNot(contains('claude/a')),
        reason: 'the selected connection must survive browser backgrounding',
      );
      expect(tracker.intents['claude/a'], [
        SessionDetailAttachIntent.backgroundObserve,
      ]);
      expect(
        container.read(sessionViewportRegistryProvider),
        viewportBeforeHide,
      );
      expect(
        container.read(attentionFeedDeliveryActiveProvider),
        const {'p1'},
        reason: 'Attention remains the intentional background sync channel',
      );

      await tester.pump(const Duration(minutes: 10));
      expect(
        {
          for (final entry in tracker.intents.entries)
            entry.key: entry.value.length,
        },
        intentsBeforeHide,
        reason: 'hidden background sessions must issue no attach or reconnect',
      );
      expect(
        roster.loadCount,
        0,
        reason: 'the hidden app does not poll roster',
      );

      lifecycle.emit(BrokerAppLifecycleState.resumed);
      await tester.pump();
      await tester.pump();
      expect(roster.loadCount, 1);
      expect(
        tracker.attachInFlight,
        0,
        reason: 'rewarm waits for the one resume roster refresh',
      );

      roster.resumeGate!.complete();
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(tracker.attachInFlight, 2);
      expect(tracker.maxConcurrentAttaches, 2);
      expect(tracker.pendingAttachGates, hasLength(2));

      tracker.releaseOneAttach();
      await tester.pump();
      await tester.pump();
      expect(tracker.maxConcurrentAttaches, 2);
      expect(tracker.attachInFlight, 2);
      tracker.releaseAllAttaches();
      await tester.pumpAndSettle();
      tracker.holdAttaches = false;

      expect(tracker.builds['claude/a'], 1);
      expect(tracker.builds['codex/b'], 1);
      expect(tracker.builds['claude/c'], 1);
      expect(tracker.builds['codex/d'], 1);
      expect(
        container.read(sessionViewportRegistryProvider),
        viewportBeforeHide,
      );

      // A rehydrated background projection is already current when selected;
      // selection upgrades authority but does not wait for another replay.
      container
          .read(openSessionsControllerProvider.notifier)
          .activate('codex/d');
      await tester.pump();
      expect(find.text('codex/d:connected'), findsOneWidget);
      container
          .read(openSessionsControllerProvider.notifier)
          .activate('claude/a');
      await tester.pump();

      // Repeated cycles reuse the same bounded controllers and never duplicate
      // viewport records, transport work, or selected work.
      for (var cycle = 0; cycle < 2; cycle++) {
        final buildsBeforeCycle = Map<String, int>.of(tracker.builds);
        final suspensionsBeforeCycle = {
          for (final key in ['claude/a', 'codex/b', 'claude/c', 'codex/d'])
            key: tracker.suspended.where((entry) => entry == key).length,
        };
        lifecycle.emit(BrokerAppLifecycleState.hidden);
        await tester.pump();
        await tester.pump();
        expect(
          tracker.suspended.where((entry) => entry == 'claude/a').length,
          suspensionsBeforeCycle['claude/a'],
          reason: 'the selected lease must survive every hide, not only first',
        );
        for (final key in ['codex/b', 'claude/c', 'codex/d']) {
          expect(
            tracker.suspended.where((entry) => entry == key).length,
            suspensionsBeforeCycle[key]! + 1,
          );
        }
        lifecycle.emit(BrokerAppLifecycleState.resumed);
        await tester.pumpAndSettle();

        expect(roster.loadCount, cycle + 2);
        expect(tracker.builds['claude/a'], buildsBeforeCycle['claude/a']);
        for (final key in ['codex/b', 'claude/c', 'codex/d']) {
          expect(tracker.builds[key], buildsBeforeCycle[key]);
        }
        expect(
          container.read(sessionViewportRegistryProvider),
          viewportBeforeHide,
        );
        expect(tracker.attachInFlight, 0);
      }
    },
  );

  test(
    'viewport admission rejects late close captures and is window-local',
    () {
      final firstWindow = ProviderContainer();
      final secondWindow = ProviderContainer();
      addTearDown(firstWindow.dispose);
      addTearDown(secondWindow.dispose);
      const key = SessionViewportKey(
        sourceKey: 'p@http%3A%2F%2Fbroker#one',
        tool: 'claude',
        sessionId: 'a',
      );

      final first = firstWindow.read(sessionViewportRegistryProvider.notifier)
        ..synchronize({key});
      final oldGeneration = first.membershipGenerationFor(key)!;
      first
        ..capture(
          key: key,
          membershipGeneration: oldGeneration,
          followTail: false,
          anchorMessageKey: 'user-message:id:a-1',
          anchorViewportTop: 12,
        )
        ..synchronize({})
        ..capture(
          key: key,
          membershipGeneration: oldGeneration,
          followTail: false,
          anchorMessageKey: 'user-message:id:late',
          anchorViewportTop: 0,
        );

      expect(firstWindow.read(sessionViewportRegistryProvider), isEmpty);
      expect(secondWindow.read(sessionViewportRegistryProvider), isEmpty);

      first.synchronize({key});
      expect(first.membershipGenerationFor(key), isNot(oldGeneration));
      expect(
        firstWindow.read(sessionViewportRegistryProvider),
        isEmpty,
        reason: 'closing and reopening intentionally starts at the tail',
      );
    },
  );

  test('resume roster refresh coalesces concurrent lifecycle owners', () async {
    final roster = _ResumeRosterController()..resumeGate = Completer<void>();
    final container = ProviderContainer(
      overrides: [
        sessionListControllerProvider.overrideWith(() => roster),
      ],
    );
    addTearDown(container.dispose);

    final refresh = container.read(sessionRosterResumeRefreshProvider);
    final supervisorRefresh = refresh();
    final workspaceRefresh = refresh();

    expect(roster.loadCount, 1);
    roster.resumeGate!.complete();
    await Future.wait([supervisorRefresh, workspaceRefresh]);

    await refresh();
    expect(roster.loadCount, 2);
  });
}

BrokerProfile _profile({required String endpoint}) => BrokerProfile(
  id: 'p1',
  displayName: 'P1',
  baseUri: Uri.parse(endpoint),
  incarnationId: 'incarnation-1',
  createdAt: DateTime(2026),
);

final class _DetailTracker {
  _DetailTracker({
    this.hungKey,
    this.hungGate,
    this.publishConnectedOnAttach = false,
  });

  final String? hungKey;
  final Completer<void>? hungGate;
  final bool publishConnectedOnAttach;
  final Map<String, List<SessionDetailAttachIntent>> intents = {};
  final Map<String, int> builds = {};
  final Map<String, _TrackingDetailController> controllers = {};
  final List<String> disposed = [];
  final List<String> suspended = [];
  final List<Completer<void>> _attachGates = [];
  Completer<void>? suspendGate;
  bool holdAttaches = false;
  int attachInFlight = 0;
  int maxConcurrentAttaches = 0;

  List<Completer<void>> get pendingAttachGates =>
      _attachGates.where((gate) => !gate.isCompleted).toList(growable: false);

  void resetAttachConcurrency() {
    attachInFlight = 0;
    maxConcurrentAttaches = 0;
    _attachGates.clear();
  }

  void releaseOneAttach() {
    pendingAttachGates.first.complete();
  }

  void releaseAllAttaches() {
    for (final gate in pendingAttachGates) {
      gate.complete();
    }
  }
}

final class _TrackingDetailController extends SessionDetailController {
  _TrackingDetailController(this.tracker);

  final _DetailTracker tracker;
  late String workingSetKey;

  @override
  SessionDetailState build(SessionDetailKey arg) {
    workingSetKey = '${arg.tool}/${arg.sessionId}';
    tracker
      ..builds[workingSetKey] = (tracker.builds[workingSetKey] ?? 0) + 1
      ..controllers[workingSetKey] = this;
    ref.onDispose(() => tracker.disposed.add(workingSetKey));
    return SessionDetailState(tool: arg.tool, sessionId: arg.sessionId);
  }

  @override
  Future<void> attach({
    SessionDetailAttachIntent intent = SessionDetailAttachIntent.interactive,
    bool force = false,
  }) async {
    tracker.intents.putIfAbsent(workingSetKey, () => []).add(intent);
    if (tracker.hungKey == workingSetKey) {
      await tracker.hungGate!.future;
    }
    tracker.attachInFlight++;
    if (tracker.attachInFlight > tracker.maxConcurrentAttaches) {
      tracker.maxConcurrentAttaches = tracker.attachInFlight;
    }
    try {
      if (tracker.holdAttaches) {
        final gate = Completer<void>();
        tracker._attachGates.add(gate);
        await gate.future;
      }
      if (tracker.publishConnectedOnAttach) {
        state = SessionDetailState(
          tool: state.tool,
          sessionId: state.sessionId,
          connectionStatus: SessionDetailConnectionStatus.connected,
        );
      }
    } finally {
      tracker.attachInFlight--;
    }
  }

  @override
  Future<void> suspendTransport() async {
    tracker.suspended.add(workingSetKey);
    await tracker.suspendGate?.future;
  }

  SessionDetailState get publishedState => state;

  set publishedState(SessionDetailState next) => state = next;
}

final class _ResumeRosterController extends SessionListController {
  int loadCount = 0;
  Completer<void>? resumeGate;

  @override
  SessionListState build() =>
      const SessionListState(status: SessionListStatus.loaded);

  @override
  Future<void> load({bool silent = false}) async {
    loadCount++;
    await resumeGate?.future;
  }
}

final class _LifecycleMonitor implements BrokerAppLifecycleMonitor {
  /// Mirrors `FlutterBrokerAppLifecycleMonitor`: [currentState] moves
  /// synchronously while subscribers are notified a microtask later. A
  /// synchronous fake would hide every admission that races that gap.
  _LifecycleMonitor()
    : _changes = StreamController<BrokerAppLifecycleState>.broadcast();

  final StreamController<BrokerAppLifecycleState> _changes;

  @override
  BrokerAppLifecycleState currentState = BrokerAppLifecycleState.resumed;

  @override
  Stream<BrokerAppLifecycleState> get stateChanges => _changes.stream;

  void emit(BrokerAppLifecycleState next) {
    currentState = next;
    _changes.add(next);
  }

  @override
  void dispose() {
    unawaited(_changes.close());
  }
}

Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() predicate,
) async {
  for (var attempt = 0; attempt < 50 && !predicate(); attempt++) {
    await tester.pump();
  }
  expect(predicate(), isTrue);
}

final class _CancellableAttachTracker {
  final Map<String, _CancellableAttachConnection> _connections = {};
  final List<Completer<void>> _cancellationGates = [];
  int outstanding = 0;
  int maxOutstanding = 0;
  int started = 0;

  int get pendingCancellations =>
      _cancellationGates.where((gate) => !gate.isCompleted).length;

  SessionDetailConnection connectionFor(String key) => _connections.putIfAbsent(
    key,
    () => _CancellableAttachConnection(this),
  );

  void begin() {
    started++;
    outstanding++;
    maxOutstanding = maxOutstanding < outstanding
        ? outstanding
        : maxOutstanding;
  }

  Completer<void> beginCancellation() {
    final gate = Completer<void>();
    _cancellationGates.add(gate);
    return gate;
  }

  void end() {
    outstanding--;
  }

  void releaseOneCancellation() {
    _cancellationGates.firstWhere((gate) => !gate.isCompleted).complete();
  }

  void releaseAllCancellations() {
    for (final gate in _cancellationGates) {
      if (!gate.isCompleted) gate.complete();
    }
  }
}

final class _CancellableAttachConnection extends FakeSessionDetailConnection {
  _CancellableAttachConnection(this.tracker);

  final _CancellableAttachTracker tracker;
  Completer<void>? _attempt;
  Future<void>? _closeInFlight;

  @override
  Future<void> connect() => _beginAttempt();

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
  }) {
    reattachModes.add(mode);
    reattachReasons.add(reason);
    return _beginAttempt();
  }

  Future<void> _beginAttempt() async {
    final attempt = Completer<void>();
    _attempt = attempt;
    tracker.begin();
    emitState(SessionDetailConnectionStatus.connecting);
    await attempt.future;
  }

  @override
  Future<void> close({bool reconnect = false}) {
    final inFlight = _closeInFlight;
    if (inFlight != null) return inFlight;
    final attempt = _attempt;
    if (attempt == null || attempt.isCompleted) {
      emitState(SessionDetailConnectionStatus.closed);
      return Future<void>.value();
    }
    final operation = () async {
      final gate = tracker.beginCancellation();
      await gate.future;
      tracker.end();
      attempt.complete();
      _attempt = null;
      emitState(SessionDetailConnectionStatus.closed);
    }();
    _closeInFlight = operation.whenComplete(() => _closeInFlight = null);
    return _closeInFlight!;
  }

  @override
  Future<void> dispose() async {
    final attempt = _attempt;
    if (attempt != null && !attempt.isCompleted) {
      tracker.end();
      attempt.complete();
      _attempt = null;
    }
    await super.dispose();
  }
}

final class _OpenStore implements OpenSessionsStore {
  final Map<String, OpenSessionsSnapshot> snapshots = {};

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      snapshots[profileId] ?? OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    snapshots[profileId] = snapshot;
  }
}

class _SelectedStateProbe extends ConsumerWidget {
  const _SelectedStateProbe();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = ref.watch(openSessionsControllerProvider).valueOrNull;
    final active = open?.active;
    if (active == null) return const SizedBox.shrink();
    final state = ref.watch(
      sessionDetailControllerProvider(
        SessionDetailKey(tool: active.tool, sessionId: active.id),
      ),
    );
    return Text('${active.key}:${state.connectionStatus.name}');
  }
}

class _VisibleSelectedStateProbe extends ConsumerWidget {
  const _VisibleSelectedStateProbe();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final active = ref
        .watch(openSessionsControllerProvider)
        .valueOrNull
        ?.active;
    if (active == null) return const SizedBox.shrink();
    return VisibleAttentionSessionScope(
      tool: active.tool,
      sessionId: active.id,
      child: const _SelectedStateProbe(),
    );
  }
}
