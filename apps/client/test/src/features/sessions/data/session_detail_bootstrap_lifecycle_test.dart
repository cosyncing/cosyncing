import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

class FailingLoadSessionTranscriptRepository
    implements SessionTranscriptRepository {
  FailingLoadSessionTranscriptRepository({this.failLoad = false});

  bool failLoad;
  final RecordingSessionTranscriptRepository _delegate =
      RecordingSessionTranscriptRepository();

  @override
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    if (failLoad) {
      throw StateError('transcript cache unavailable');
    }
    return _delegate.load(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
    );
  }

  @override
  Future<void> upsert(SessionTranscriptSnapshot snapshot) {
    return _delegate.upsert(snapshot);
  }
}

class HeldLoadSessionTranscriptRepository
    implements SessionTranscriptRepository {
  final loadStarted = Completer<void>();
  final loadResult = Completer<SessionTranscriptSnapshot?>();

  @override
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    if (!loadStarted.isCompleted) loadStarted.complete();
    return loadResult.future;
  }

  @override
  Future<void> upsert(SessionTranscriptSnapshot snapshot) async {}
}

class HeldConnectSessionDetailConnection extends FakeSessionDetailConnection {
  final connectStarted = Completer<void>();
  final releaseConnect = Completer<void>();

  @override
  Future<void> connect() async {
    connectCount++;
    emitState(SessionDetailConnectionStatus.connecting);
    connectStarted.complete();
    await releaseConnect.future;
    emitState(SessionDetailConnectionStatus.connected);
  }
}

class HeldReattachSessionDetailConnection extends FakeSessionDetailConnection {
  final reattachStarted = Completer<void>();
  final releaseReattach = Completer<void>();

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
  }) async {
    reattachModes.add(mode);
    reattachReasons.add(reason);
    emitState(SessionDetailConnectionStatus.connecting);
    reattachStarted.complete();
    await releaseReattach.future;
    emitState(SessionDetailConnectionStatus.connected);
  }
}

class RetainingDisposedSessionDetailConnection
    extends FakeSessionDetailConnection {
  @override
  Future<void> dispose() async {
    disposeCount++;
  }
}

class HeldListAgentsBrokerClient extends FakeControllerBrokerClient {
  final listAgentsStarted = Completer<void>();
  final listAgentsResult = Completer<List<AgentInfo>>();

  @override
  Future<List<AgentInfo>> listAgents() {
    listAgentsCount++;
    if (listAgentsCount > 1) return Future<List<AgentInfo>>.value(agents);
    if (!listAgentsStarted.isCompleted) listAgentsStarted.complete();
    return listAgentsResult.future;
  }
}

ProviderContainer _buildBootstrapControllerContainer({
  required FakeSessionDetailConnection connection,
  required SessionTranscriptRepository transcriptRepository,
  Object? brokerClientFailure,
  Future<BrokerClient?>? brokerClientFuture,
  Future<BrokerClient?> Function()? brokerClientLoader,
  BrokerProfile? activeProfile,
  Duration timeout = const Duration(milliseconds: 25),
  SessionDetailConnection Function()? connectionFactory,
}) {
  final profile = activeProfile ?? fakeControllerBrokerProfile();
  final fakeBrokerClient = FakeControllerBrokerClient();

  return ProviderContainer(
    overrides: [
      ...dr1DurableDraftTestOverrides(),
      activeBrokerProfileProvider.overrideWith((ref) => profile),
      if (brokerClientLoader != null)
        brokerClientProvider.overrideWith((ref) => brokerClientLoader())
      else if (brokerClientFuture != null)
        brokerClientProvider.overrideWith((ref) => brokerClientFuture)
      else if (brokerClientFailure == null)
        brokerClientProvider.overrideWith((ref) async => fakeBrokerClient)
      else
        brokerClientProvider.overrideWith(
          (ref) => Future<BrokerClient?>.error(brokerClientFailure),
        ),
      sessionDetailConnectionFactoryProvider.overrideWithValue(
        ({required resolver, required sessionId, required tool}) {
          final created = connectionFactory?.call() ?? connection;
          if (created is FakeSessionDetailConnection) {
            created
              ..sessionId = sessionId
              ..tool = tool;
          }
          return created;
        },
      ),
      sessionArtifactFileServiceProvider.overrideWithValue(
        FakeControllerArtifactFileService(),
      ),
      sessionAttachmentPickerProvider.overrideWithValue(
        FakeControllerAttachmentPicker(),
      ),
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionOutboxRepositoryProvider.overrideWithValue(
        RecordingSessionOutboxRepository(),
      ),
      sessionTranscriptRepositoryProvider.overrideWithValue(
        transcriptRepository,
      ),
      sessionDriveIntentStoreProvider.overrideWithValue(
        InMemoryControllerDriveIntentStore(),
      ),
      sessionNotificationLifecycleMonitorProvider.overrideWithValue(
        StubBrokerAppLifecycleMonitor(
          currentState: BrokerAppLifecycleState.paused,
        ),
      ),
      sessionNotificationSinkProvider.overrideWithValue(
        CollectingNotificationSink(),
      ),
      sessionDetailInitialHistoryTimeoutProvider.overrideWith(
        (ref) => timeout,
      ),
    ],
  );
}

void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  final profile = BrokerProfile(
    id: 'local',
    displayName: 'Local',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026, 6, 26),
  );

  test(
    'holds resolvingProfile until broker client resolution completes',
    () async {
      final connection = FakeSessionDetailConnection();
      final clientResolution = Completer<BrokerClient?>();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: RecordingSessionTranscriptRepository(),
        brokerClientFuture: clientResolution.future,
        activeProfile: profile,
        timeout: const Duration(milliseconds: 100),
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final attach = container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      await drainSessionDetailMicrotasks();

      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.resolvingProfile,
      );
      expect(connection.connectCount, 0);

      clientResolution.complete(FakeControllerBrokerClient());
      await attach;
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );
    },
  );

  test('holds hydratingCachedTranscript at the cache boundary', () async {
    final connection = FakeSessionDetailConnection();
    final transcriptRepository = HeldLoadSessionTranscriptRepository();
    final container = _buildBootstrapControllerContainer(
      connection: connection,
      transcriptRepository: transcriptRepository,
      activeProfile: profile,
      timeout: const Duration(milliseconds: 100),
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);

    final attach = container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await transcriptRepository.loadStarted.future;

    expect(
      container
          .read(sessionDetailControllerProvider(key))
          .bootstrapState
          .readiness,
      SessionDetailBootstrapReadiness.hydratingCachedTranscript,
    );
    expect(connection.connectCount, 0);

    transcriptRepository.loadResult.complete(
      SessionTranscriptSnapshot(
        brokerProfileId: RosterSource.ofProfile(profile).storageKey,
        sessionKey: key,
        messages: const [
          AgentMessage(
            type: AgentMessageType.userMessage,
            raw: {'type': 'cached-user'},
          ),
        ],
        hasEarlier: false,
        updatedAt: DateTime(2026, 6, 26),
      ),
    );
    await attach;

    final state = container.read(sessionDetailControllerProvider(key));
    expect(
      state.bootstrapState.readiness,
      SessionDetailBootstrapReadiness.awaitingInitialHistory,
    );
    expect(state.bootstrapState.hasCachedMessages, isTrue);
    expect(state.bootstrapState.keepShowingMessages, isTrue);
  });

  test(
    'stale held cache work cannot overwrite a newer profile attempt',
    () async {
      final connection = FakeSessionDetailConnection();
      final transcriptRepository = HeldLoadSessionTranscriptRepository();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: transcriptRepository,
        activeProfile: profile,
        timeout: const Duration(milliseconds: 100),
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      final oldAttach = controller.attach();
      await transcriptRepository.loadStarted.future;

      final nextProfile = BrokerProfile(
        id: 'next',
        displayName: 'Next',
        baseUri: Uri.parse('http://127.0.0.1:8834'),
        createdAt: DateTime(2026, 6, 27),
      );
      container.read(activeBrokerProfileProvider.notifier).state = nextProfile;
      final newAttach = controller.attach();
      transcriptRepository.loadResult.complete(null);

      await oldAttach;
      await newAttach;

      final state = container.read(sessionDetailControllerProvider(key));
      expect(
        state.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );
      expect(state.bootstrapState.attempt, 2);
      expect(connection.connectCount, 1);
    },
  );

  test('accepts authoritative history emitted while connect is held', () async {
    final connection = HeldConnectSessionDetailConnection();
    final container = _buildBootstrapControllerContainer(
      connection: connection,
      transcriptRepository: RecordingSessionTranscriptRepository(),
      activeProfile: profile,
      timeout: const Duration(milliseconds: 20),
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);

    final attach = container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await connection.connectStarted.future;
    expect(
      container
          .read(sessionDetailControllerProvider(key))
          .bootstrapState
          .readiness,
      SessionDetailBootstrapReadiness.attachingSocket,
    );

    connection.emitEvent(const HistoryWireEvent(messages: [], reset: true));
    await drainSessionDetailMicrotasks();
    expect(
      container
          .read(sessionDetailControllerProvider(key))
          .bootstrapState
          .readiness,
      SessionDetailBootstrapReadiness.ready,
    );

    connection.releaseConnect.complete();
    await attach;
    await Future<void>.delayed(const Duration(milliseconds: 35));
    expect(
      container
          .read(sessionDetailControllerProvider(key))
          .bootstrapState
          .readiness,
      SessionDetailBootstrapReadiness.ready,
    );
  });

  test(
    'initial history timeout is independent of held agent action refresh',
    () async {
      final connection = RetainingDisposedSessionDetailConnection();
      final retryConnection = FakeSessionDetailConnection();
      var connectionCreationCount = 0;
      final brokerClient = HeldListAgentsBrokerClient();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: RecordingSessionTranscriptRepository(),
        brokerClientFuture: Future<BrokerClient?>.value(brokerClient),
        activeProfile: profile,
        timeout: const Duration(milliseconds: 50),
        connectionFactory: () =>
            connectionCreationCount++ == 0 ? connection : retryConnection,
      );
      addTearDown(container.dispose);
      container
          .read(createdSessionAttachIntentsProvider)
          .rememberResume(RosterSource.ofProfile(profile).storageKey, key);
      keepSessionDetailAlive(container, key);
      addTearDown(() async {
        if (!brokerClient.listAgentsResult.isCompleted) {
          brokerClient.listAgentsResult.complete(const []);
        }
        await drainSessionDetailMicrotasks();
      });

      final attach = container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      var attachCompleted = false;
      unawaited(
        attach.then<void>((_) {
          attachCompleted = true;
        }),
      );
      await brokerClient.listAgentsStarted.future;

      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );
      expect(
        container.read(sessionDetailControllerProvider(key)).driveRestorePhase,
        SessionDriveRestorePhase.restoring,
      );
      expect(brokerClient.listAgentsResult.isCompleted, isFalse);
      expect(attachCompleted, isFalse);

      await Future<void>.delayed(const Duration(milliseconds: 80));
      await attach;

      final timedOut = container.read(sessionDetailControllerProvider(key));
      expect(
        timedOut.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.historyTimeout,
      );
      expect(timedOut.connectionStatus, SessionDetailConnectionStatus.closed);
      expect(timedOut.driveRestorePhase, SessionDriveRestorePhase.idle);
      expect(connection.disposeCount, 1);
      expect(brokerClient.listAgentsResult.isCompleted, isFalse);
      expect(attachCompleted, isTrue);

      final retry = container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      await retry;

      final retried = container.read(sessionDetailControllerProvider(key));
      expect(retried.bootstrapState.attempt, 2);
      expect(
        retried.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );
      expect(retryConnection.connectCount, 1);
      expect(retried.agentActions?.canTranscriptExport, isTrue);
      expect(brokerClient.listAgentsCount, 2);

      retryConnection.emitEvent(
        const HistoryWireEvent(messages: [], reset: true),
      );
      await drainSessionDetailMicrotasks();
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.ready,
      );
    },
  );

  test(
    'preserves visible transcript and accepts history while reattach is held',
    () async {
      final connection = HeldReattachSessionDetailConnection();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: RecordingSessionTranscriptRepository(),
        activeProfile: profile,
        timeout: const Duration(milliseconds: 100),
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      connection.emitEvent(
        const HistoryWireEvent(
          messages: [
            AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {'type': 'first-history'},
            ),
          ],
          reset: true,
        ),
      );
      await drainSessionDetailMicrotasks();
      final firstReady = container.read(sessionDetailControllerProvider(key));
      expect(firstReady.bootstrapState.hasCachedMessages, isTrue);
      expect(firstReady.bootstrapState.keepShowingMessages, isTrue);

      final retry = controller.attach(force: true);
      await connection.reattachStarted.future;
      final attaching = container.read(sessionDetailControllerProvider(key));
      expect(
        attaching.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.attachingSocket,
      );
      expect(attaching.bootstrapState.hasCachedMessages, isTrue);
      expect(attaching.bootstrapState.keepShowingMessages, isTrue);

      connection.emitEvent(const HistoryWireEvent(messages: [], reset: true));
      await drainSessionDetailMicrotasks();
      final replacement = container.read(sessionDetailControllerProvider(key));
      expect(
        replacement.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.ready,
      );
      expect(replacement.bootstrapState.hasCachedMessages, isFalse);
      expect(replacement.bootstrapState.keepShowingMessages, isFalse);

      connection.releaseReattach.complete();
      await retry;
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.ready,
      );
    },
  );

  test(
    'advances through bootstrap lifecycle and becomes ready on empty '
    'authoritative history',
    () async {
      final connection = FakeSessionDetailConnection();
      final transcriptRepository = RecordingSessionTranscriptRepository()
        ..stored = SessionTranscriptSnapshot(
          brokerProfileId: RosterSource.ofProfile(profile).storageKey,
          sessionKey: key,
          messages: const [
            AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {'type': 'user'},
            ),
          ],
          hasEarlier: false,
          updatedAt: DateTime(2026, 6, 26),
        );
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: transcriptRepository,
        timeout: const Duration(milliseconds: 100),
        activeProfile: profile,
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final observed = <SessionDetailBootstrapReadiness>[];
      final subscription = container.listen<SessionDetailState>(
        sessionDetailControllerProvider(key),
        (prev, next) {
          final readiness = next.bootstrapState.readiness;
          if (observed.isEmpty || observed.last != readiness) {
            observed.add(readiness);
          }
        },
      );
      addTearDown(subscription.close);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      await drainSessionDetailMicrotasks();

      expect(
        observed,
        containsAllInOrder(<SessionDetailBootstrapReadiness>[
          SessionDetailBootstrapReadiness.resolvingProfile,
          SessionDetailBootstrapReadiness.hydratingCachedTranscript,
          SessionDetailBootstrapReadiness.attachingSocket,
          SessionDetailBootstrapReadiness.awaitingInitialHistory,
        ]),
      );
      final beforeHistoryState = container.read(
        sessionDetailControllerProvider(key),
      );
      expect(
        beforeHistoryState.bootstrapState.hasCachedMessages,
        isTrue,
      );
      expect(
        beforeHistoryState.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );

      connection.emitEvent(const HistoryWireEvent(messages: [], reset: true));
      await drainSessionDetailMicrotasks();

      final readyState = container.read(sessionDetailControllerProvider(key));
      expect(
        readyState.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.ready,
      );
      expect(readyState.bootstrapState.hasCachedMessages, isFalse);
      expect(readyState.bootstrapState.keepShowingMessages, isFalse);
      expect(readyState.bootstrapState.hasFailed, isFalse);
      expect(readyState.messageEvents, isEmpty);
    },
  );

  test('no-profile failure retains an already-visible transcript', () async {
    final connection = FakeSessionDetailConnection();
    final nextConnection = FakeSessionDetailConnection();
    var connectionCreationCount = 0;
    final transcriptRepository = RecordingSessionTranscriptRepository();
    final nextClientResolution = Completer<BrokerClient?>();
    var clientResolutionCount = 0;
    final container = _buildBootstrapControllerContainer(
      connection: connection,
      transcriptRepository: transcriptRepository,
      activeProfile: profile,
      connectionFactory: () =>
          connectionCreationCount++ == 0 ? connection : nextConnection,
      brokerClientLoader: () => clientResolutionCount++ == 0
          ? Future<BrokerClient?>.value(FakeControllerBrokerClient())
          : nextClientResolution.future,
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);

    final controller = container.read(
      sessionDetailControllerProvider(key).notifier,
    );
    await controller.attach();
    connection.emitEvent(
      const HistoryWireEvent(
        messages: [
          AgentMessage(
            type: AgentMessageType.userMessage,
            raw: {'type': 'retained-before-no-profile'},
          ),
        ],
        reset: true,
      ),
    );
    await drainSessionDetailMicrotasks();

    container.read(activeBrokerProfileProvider.notifier).state = null;
    await controller.attach();
    await drainSessionDetailMicrotasks();

    final state = container.read(sessionDetailControllerProvider(key));
    expect(
      state.bootstrapState.readiness,
      SessionDetailBootstrapReadiness.failed,
    );
    expect(
      state.bootstrapState.failureSource,
      SessionDetailBootstrapFailureSource.noProfile,
    );
    expect(
      state.connectionStatus,
      SessionDetailConnectionStatus.disconnected,
    );
    expect(state.error, 'Connect to a server before attaching to a session.');
    expect(state.messageEvents, hasLength(1));
    expect(
      state.messageEvents.single.raw['type'],
      'retained-before-no-profile',
    );
    expect(state.bootstrapState.hasCachedMessages, isTrue);
    expect(state.bootstrapState.keepShowingMessages, isTrue);
    expect(connection.connectCount, 1);
    expect(connection.disposeCount, 1);

    final nextProfile = BrokerProfile(
      id: 'next',
      displayName: 'Next',
      baseUri: Uri.parse('http://127.0.0.1:8834'),
      createdAt: DateTime(2026, 6, 27),
    );
    transcriptRepository.stored = SessionTranscriptSnapshot(
      brokerProfileId: RosterSource.ofProfile(nextProfile).storageKey,
      sessionKey: key,
      messages: const [
        AgentMessage(
          type: AgentMessageType.userMessage,
          raw: {'type': 'next-profile-cache'},
        ),
      ],
      hasEarlier: false,
      updatedAt: DateTime(2026, 6, 27),
    );
    container.read(activeBrokerProfileProvider.notifier).state = nextProfile;
    container.invalidate(brokerClientProvider);
    await drainSessionDetailMicrotasks();
    final switchedAttach = controller.attach();
    await drainSessionDetailMicrotasks();

    final resolvingNext = container.read(sessionDetailControllerProvider(key));
    expect(
      resolvingNext.bootstrapState.readiness,
      SessionDetailBootstrapReadiness.resolvingProfile,
    );
    expect(resolvingNext.messageEvents, isEmpty);
    expect(resolvingNext.bootstrapState.hasCachedMessages, isFalse);

    nextClientResolution.complete(FakeControllerBrokerClient());
    await switchedAttach;

    final switched = container.read(sessionDetailControllerProvider(key));
    expect(switched.messageEvents, hasLength(1));
    expect(switched.messageEvents.single.raw['type'], 'next-profile-cache');
    expect(
      switched.messageEvents.where(
        (message) => message.raw['type'] == 'retained-before-no-profile',
      ),
      isEmpty,
    );
    expect(switched.bootstrapState.hasCachedMessages, isTrue);
    expect(nextConnection.connectCount, 1);
  });

  test(
    'client-resolution failure retains an already-visible transcript',
    () async {
      final connection = FakeSessionDetailConnection();
      final nextConnection = FakeSessionDetailConnection();
      var connectionCreationCount = 0;
      final brokerClient = FakeControllerBrokerClient();
      final nextClientResolution = Completer<BrokerClient?>();
      var resolutionCount = 0;
      final transcriptRepository = RecordingSessionTranscriptRepository();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: transcriptRepository,
        activeProfile: profile,
        brokerClientLoader: () {
          final resolution = resolutionCount++;
          if (resolution == 0) {
            return Future<BrokerClient?>.value(brokerClient);
          }
          if (resolution > 1) return nextClientResolution.future;
          return Future<BrokerClient?>.error(
            const BrokerException(message: 'offline'),
          );
        },
        connectionFactory: () =>
            connectionCreationCount++ == 0 ? connection : nextConnection,
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      connection.emitEvent(
        const HistoryWireEvent(
          messages: [
            AgentMessage(
              type: AgentMessageType.modelOutput,
              raw: {'type': 'retained-before-client-failure'},
            ),
          ],
          reset: true,
        ),
      );
      await drainSessionDetailMicrotasks();

      container.invalidate(brokerClientProvider);
      await drainSessionDetailMicrotasks();
      await controller.attach(force: true);

      final state = container.read(sessionDetailControllerProvider(key));
      expect(
        state.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.failed,
      );
      expect(
        state.bootstrapState.failureSource,
        SessionDetailBootstrapFailureSource.attach,
      );
      expect(state.bootstrapState.failureKind, FailureKind.offline);
      expect(
        state.connectionStatus,
        SessionDetailConnectionStatus.disconnected,
      );
      expect(state.messageEvents, hasLength(1));
      expect(
        state.messageEvents.single.raw['type'],
        'retained-before-client-failure',
      );
      expect(state.bootstrapState.hasCachedMessages, isTrue);
      expect(state.bootstrapState.keepShowingMessages, isTrue);
      expect(connection.disposeCount, 1);

      final nextProfile = BrokerProfile(
        id: 'next',
        displayName: 'Next',
        baseUri: Uri.parse('http://127.0.0.1:8834'),
        createdAt: DateTime(2026, 6, 27),
      );
      transcriptRepository.stored = SessionTranscriptSnapshot(
        brokerProfileId: RosterSource.ofProfile(nextProfile).storageKey,
        sessionKey: key,
        messages: const [
          AgentMessage(
            type: AgentMessageType.modelOutput,
            raw: {'type': 'next-profile-cache-after-client-failure'},
          ),
        ],
        hasEarlier: false,
        updatedAt: DateTime(2026, 6, 27),
      );
      container.read(activeBrokerProfileProvider.notifier).state = nextProfile;
      container.invalidate(brokerClientProvider);
      await drainSessionDetailMicrotasks();
      final switchedAttach = controller.attach();
      await drainSessionDetailMicrotasks();

      final resolvingNext = container.read(
        sessionDetailControllerProvider(key),
      );
      expect(
        resolvingNext.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.resolvingProfile,
      );
      expect(resolvingNext.messageEvents, isEmpty);
      expect(resolvingNext.bootstrapState.hasCachedMessages, isFalse);

      nextClientResolution.complete(brokerClient);
      await switchedAttach;

      final switched = container.read(sessionDetailControllerProvider(key));
      expect(switched.messageEvents, hasLength(1));
      expect(
        switched.messageEvents.single.raw['type'],
        'next-profile-cache-after-client-failure',
      );
      expect(
        switched.messageEvents.where(
          (message) => message.raw['type'] == 'retained-before-client-failure',
        ),
        isEmpty,
      );
      expect(switched.bootstrapState.hasCachedMessages, isTrue);
      expect(nextConnection.connectCount, 1);
    },
  );

  test('keeps attaching after cache read failure', () async {
    final connection = FakeSessionDetailConnection();
    final transcriptRepository = FailingLoadSessionTranscriptRepository(
      failLoad: true,
    );
    final container = _buildBootstrapControllerContainer(
      connection: connection,
      transcriptRepository: transcriptRepository,
      activeProfile: profile,
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);

    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await drainSessionDetailMicrotasks();

    final state = container.read(sessionDetailControllerProvider(key));
    expect(
      state.bootstrapState.readiness,
      isNot(SessionDetailBootstrapReadiness.failed),
    );
    expect(
      state.bootstrapState.readiness,
      SessionDetailBootstrapReadiness.awaitingInitialHistory,
    );
    expect(state.bootstrapState.hasCachedMessages, isFalse);

    connection.emitEvent(const HistoryWireEvent(messages: [], reset: true));
    await drainSessionDetailMicrotasks();
    expect(
      container
          .read(sessionDetailControllerProvider(key))
          .bootstrapState
          .readiness,
      SessionDetailBootstrapReadiness.ready,
    );
  });

  test('classifies attach/connect failures in bootstrap model', () async {
    final connection = FakeSessionDetailConnection();
    final container = _buildBootstrapControllerContainer(
      connection: connection,
      transcriptRepository: RecordingSessionTranscriptRepository(),
      brokerClientFailure: const BrokerException(message: 'offline'),
      activeProfile: profile,
    );
    addTearDown(container.dispose);
    keepSessionDetailAlive(container, key);

    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await drainSessionDetailMicrotasks();

    final state = container.read(sessionDetailControllerProvider(key));
    expect(
      state.bootstrapState.readiness,
      SessionDetailBootstrapReadiness.failed,
    );
    expect(
      state.bootstrapState.failureSource,
      SessionDetailBootstrapFailureSource.attach,
    );
    expect(state.bootstrapState.failureKind, FailureKind.offline);
    expect(state.bootstrapState.hasFailed, isTrue);
  });

  test(
    'times out waiting for initial history, then retries with fresh attempt',
    () async {
      final oldConnection = RetainingDisposedSessionDetailConnection();
      final retryConnection = FakeSessionDetailConnection();
      var connectionCreationCount = 0;
      final container = _buildBootstrapControllerContainer(
        connection: oldConnection,
        transcriptRepository: RecordingSessionTranscriptRepository(),
        activeProfile: profile,
        timeout: const Duration(milliseconds: 20),
        connectionFactory: () =>
            connectionCreationCount++ == 0 ? oldConnection : retryConnection,
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      await Future<void>.delayed(const Duration(milliseconds: 35));

      final timedOut = container.read(sessionDetailControllerProvider(key));
      expect(
        timedOut.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.historyTimeout,
      );
      expect(
        timedOut.bootstrapState.failureSource,
        SessionDetailBootstrapFailureSource.historyTimeout,
      );
      expect(
        timedOut.connectionStatus,
        SessionDetailConnectionStatus.closed,
      );
      await drainSessionDetailMicrotasks();
      expect(oldConnection.disposeCount, 1);

      await controller.attach();
      await drainSessionDetailMicrotasks();
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );
      expect(retryConnection.connectCount, 1);

      // The retired connection can still deliver a delayed frame in this
      // adversarial fake, but it must not satisfy the fresh attempt.
      oldConnection.emitEvent(
        const HistoryWireEvent(
          messages: [
            AgentMessage(
              type: AgentMessageType.modelOutput,
              raw: {'type': 'model-output'},
            ),
          ],
          reset: true,
        ),
      );
      await drainSessionDetailMicrotasks();
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .bootstrapState
            .readiness,
        SessionDetailBootstrapReadiness.awaitingInitialHistory,
      );

      retryConnection.emitEvent(
        const HistoryWireEvent(messages: [], reset: true),
      );
      await drainSessionDetailMicrotasks();
      final retried = container.read(sessionDetailControllerProvider(key));
      expect(
        retried.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.ready,
      );
      expect(retried.bootstrapState.hasCachedMessages, isFalse);
    },
  );

  test(
    'retries start a new attempt and keep attempts idempotent while in flight',
    () async {
      final connection = FakeSessionDetailConnection();
      final container = _buildBootstrapControllerContainer(
        connection: connection,
        transcriptRepository: RecordingSessionTranscriptRepository(),
        activeProfile: profile,
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);

      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      final first = controller.attach();
      final second = controller.attach();
      expect(identical(first, second), isTrue);

      await first;

      connection.emitEvent(const HistoryWireEvent(messages: [], reset: true));
      await drainSessionDetailMicrotasks();

      final state = container.read(sessionDetailControllerProvider(key));
      expect(
        state.bootstrapState.readiness,
        SessionDetailBootstrapReadiness.ready,
      );
    },
  );
}
