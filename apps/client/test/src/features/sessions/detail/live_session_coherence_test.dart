import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// Batch A cumulative client reproduction — one live turn, one status.
///
/// Every lane in this file reads the SAME canonical identities as the broker's
/// `packages/typescript/broker/test/broker/test-live-session-coherence.ts`: one session
/// (`claude/session-1`), one prompt key, one assistant key, one turn id, one
/// run-summary key. A fix that satisfies the roster while invalidating the open
/// detail (or the reverse) fails here rather than in the app.
///
/// The reproduction that matters most is the first one: before R0b the roster
/// could only learn a turn boundary by completing a bounded delta round trip,
/// so an open Session Detail and the roster disagreed for as long as that took
/// — and whenever the feed was not running, until a page refresh.
const kSession = 'session-1';
const kTool = 'claude';

SessionInfo session(SessionStatus status, {String id = kSession}) =>
    SessionInfo(
      id: id,
      tool: kTool,
      title: 'Batch A coherence',
      status: status,
      attachMode: AttachMode.live,
    );

SessionInfo wireSession(SessionStatus status) => SessionInfo.fromJson({
  'id': kSession,
  'tool': kTool,
  'title': 'Batch A coherence',
  'status': sessionStatusWireValue(status),
  'attachMode': 'live',
  'control': const {
    'drive': {'state': 'driving', 'supported': true},
    'terminalSync': {
      'supported': false,
      'syncAvailable': false,
      'active': false,
    },
  },
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late InMemorySessionListRepository repository;
  late ProviderContainer container;

  final profile = BrokerProfile(
    id: 'local',
    displayName: 'local',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026, 7, 28),
  );

  late AppDatabase database;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    repository = InMemorySessionListRepository()
      ..sessions = [session(SessionStatus.idle)];
    container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(database),
        sessionListRepositoryProvider.overrideWith((ref) async => repository),
        activeBrokerProfileHydrationProvider.overrideWith((ref) async {}),
        activeBrokerProfileProvider.overrideWith((ref) => profile),
      ],
    );
  });

  tearDown(() async {
    container.dispose();
    await database.close();
  });

  RosterSource? currentSource() =>
      container.read(sessionListControllerProvider).source;

  SessionStatus rosterStatus() => container
      .read(rosterSessionsProvider)
      .firstWhere((row) => row.id == kSession)
      .status;

  group('Batch A — one authoritative Working/Idle state', () {
    test(
      'a live transition reaches the roster without a delta round trip',
      () async {
        await container.read(sessionListControllerProvider.notifier).load();
        expect(rosterStatus(), SessionStatus.idle);

        // The open Session Detail's own socket sees the turn start first —
        // exactly what the roster used to wait for a delta to learn.
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: currentSource(),
              tool: kTool,
              sessionId: kSession,
              status: SessionStatus.working,
              rosterRevisionFloor: container
                  .read(sessionListControllerProvider)
                  .revision,
            );

        expect(
          rosterStatus(),
          SessionStatus.working,
          reason: 'the roster must converge in the same frame as the detail',
        );
        expect(
          container.read(sessionListControllerProvider).sessions.single.status,
          SessionStatus.idle,
          reason: 'roster membership/metadata is untouched; only status moves',
        );
      },
    );

    test(
      'a stale roster snapshot cannot regress a newer live transition',
      () async {
        await container.read(sessionListControllerProvider.notifier).load();
        final revision = container.read(sessionListControllerProvider).revision;

        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: currentSource(),
              tool: kTool,
              sessionId: kSession,
              status: SessionStatus.idle,
              rosterRevisionFloor: revision,
            );

        // A roster response generated BEFORE that live frame lands afterwards.
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishRoster(
              source: currentSource(),
              revision: revision,
              sessions: [session(SessionStatus.working)],
            );

        expect(
          rosterStatus(),
          SessionStatus.idle,
          reason: 'same revision, older arrival — the live fact stands',
        );
      },
    );

    test(
      'a newer roster revision supersedes an older live observation',
      () async {
        await container.read(sessionListControllerProvider.notifier).load();
        final revision = container.read(sessionListControllerProvider).revision;

        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: currentSource(),
              tool: kTool,
              sessionId: kSession,
              status: SessionStatus.working,
              rosterRevisionFloor: revision,
            );
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishRoster(
              source: currentSource(),
              revision: revision + 1,
              sessions: [session(SessionStatus.needsInput)],
            );

        expect(rosterStatus(), SessionStatus.needsInput);
      },
    );

    test('a query-window namespace accepts a lower roster revision', () async {
      await container.read(sessionListControllerProvider.notifier).load();
      final registry = container.read(sessionStatusRegistryProvider.notifier);
      // ignore: cascade_invocations -- the assertion below checks pre-reset state.
      registry.publishRoster(
        source: currentSource(),
        revision: 8,
        sessions: [session(SessionStatus.working)],
      );
      expect(rosterStatus(), SessionStatus.working);

      registry
        ..resetRevisionNamespace(
          source: currentSource(),
          revision: 1,
          preserveLiveAfterSequence: registry.captureRevisionAdmission(),
        )
        ..publishRoster(
          source: currentSource(),
          revision: 1,
          sessions: [session(SessionStatus.idle)],
        );

      expect(rosterStatus(), SessionStatus.idle);
    });

    test(
      'observations are profile-qualified and dropped on a source change',
      () async {
        await container.read(sessionListControllerProvider.notifier).load();
        container
            .read(sessionStatusRegistryProvider.notifier)
            .publishLive(
              source: currentSource(),
              tool: kTool,
              sessionId: kSession,
              status: SessionStatus.working,
              rosterRevisionFloor: 0,
            );
        expect(rosterStatus(), SessionStatus.working);

        container
            .read(sessionStatusRegistryProvider.notifier)
            .adoptSource(
              const RosterSource(
                profileId: 'other',
                endpoint: 'http://other.invalid',
              ),
            );

        expect(
          container.read(sessionStatusRegistryProvider).observations,
          isEmpty,
          reason: "another broker's Working must not survive the switch",
        );
        expect(rosterStatus(), SessionStatus.idle);
      },
    );

    test(
      'an endpoint change under one profile id never relabels old frames',
      () async {
        // A broker profile's id survives an endpoint edit, so deriving the
        // source when a frame LANDS attributed the retired broker's status to
        // the new machine — and, because the registry adopts whatever source it
        // is handed, wiped the new broker's observations to do it.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final endpointA = Uri.parse('http://alpha.invalid:7734');
        final endpointB = Uri.parse('http://beta.invalid:7734');
        final sourceA = RosterSource(
          profileId: 'local',
          endpoint: RosterSource.normalizedBrokerEndpoint(endpointA),
        );
        final sourceB = RosterSource(
          profileId: 'local',
          endpoint: RosterSource.normalizedBrokerEndpoint(endpointB),
        );
        final connection = FakeSessionDetailConnection();
        final roster = _RosterAtSource();
        final detailContainer = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => BrokerProfile(
                id: 'local',
                displayName: 'local',
                baseUri: endpointA,
                createdAt: DateTime(2026, 7, 28),
              ),
            ),
            brokerClientProvider.overrideWith(
              (ref) async => FakeControllerBrokerClient(),
            ),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) =>
                  connection
                    ..sessionId = sessionId
                    ..tool = tool,
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              FakeControllerAttachmentPicker(),
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              FakeControllerArtifactFileService(),
            ),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
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
            sessionListControllerProvider.overrideWith(() => roster),
          ],
        );
        addTearDown(detailContainer.dispose);
        keepSessionDetailAlive(detailContainer, key);
        detailContainer.read(sessionListControllerProvider);
        roster.moveTo(sourceA);
        await detailContainer
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        connection
          ..emitState(SessionDetailConnectionStatus.connected)
          ..emitEvent(SessionWireEvent(info: session(SessionStatus.working)));
        await drainSessionDetailMicrotasks();

        final registry = detailContainer.read(sessionStatusRegistryProvider);
        expect(registry.source, sourceA);
        expect(
          registry.statusFor(tool: kTool, sessionId: kSession),
          SessionStatus.working,
        );

        // The profile is re-pointed at another machine, keeping its id. The
        // roster adopts the new endpoint first; this socket is still the OLD
        // broker's and delivers one more authoritative frame in that window.
        roster.moveTo(sourceB);
        connection.emitEvent(
          SessionWireEvent(info: session(SessionStatus.idle)),
        );
        await drainSessionDetailMicrotasks();

        final after = detailContainer.read(sessionStatusRegistryProvider);
        expect(
          after.source,
          sourceA,
          reason: "the retired broker's frame must not adopt the new endpoint",
        );
        expect(
          after.statusFor(tool: kTool, sessionId: kSession),
          SessionStatus.working,
          reason: 'nothing the old socket says is published as the new truth',
        );
      },
    );

    test(
      'an attach that resolves after the endpoint moved never opens the '
      'retired machine’s socket',
      () async {
        // Every await inside the bootstrap is a window in which the user can
        // re-point the profile. The guards after those awaits compared profile
        // ids, which an endpoint edit does not change, so the attach for the
        // OLD machine walked straight through them and opened its socket.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final client = Completer<BrokerClient?>();
        final connections = <FakeSessionDetailConnection>[];
        final detailContainer = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => fakeControllerBrokerProfile(
                baseUri: Uri.parse('http://alpha.invalid:7734'),
              ),
            ),
            // Parks the attach exactly where a real one parks: waiting for the
            // broker client this profile resolves to.
            brokerClientProvider.overrideWith((ref) => client.future),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                final created = FakeSessionDetailConnection()
                  ..sessionId = sessionId
                  ..tool = tool;
                connections.add(created);
                return created;
              },
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              FakeControllerAttachmentPicker(),
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              FakeControllerArtifactFileService(),
            ),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            sessionOutboxRepositoryProvider.overrideWithValue(
              RecordingSessionOutboxRepository(),
            ),
            sessionTranscriptRepositoryProvider.overrideWithValue(
              RecordingSessionTranscriptRepository(),
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
          ],
        );
        addTearDown(detailContainer.dispose);
        keepSessionDetailAlive(detailContainer, key);
        final controller = detailContainer.read(
          sessionDetailControllerProvider(key).notifier,
        );

        final attaching = controller.attach();
        await drainSessionDetailMicrotasks();
        detailContainer
            .read(activeBrokerProfileProvider.notifier)
            .state = fakeControllerBrokerProfile(
          baseUri: Uri.parse('http://beta.invalid:7734'),
        );
        client.complete(FakeControllerBrokerClient());
        await attaching;

        expect(
          connections,
          isEmpty,
          reason: 'the retired machine never gets a socket',
        );
        expect(
          detailContainer.read(sessionDetailControllerProvider(key)).source,
          isNull,
          reason: 'nor does its provenance survive on the state',
        );
      },
    );

    test(
      'an endpoint edit under one profile id is never coalesced onto the '
      'attach still connecting to the old machine',
      () async {
        // Attach admission used to compare profile ids. An edit that re-points
        // a profile keeps its id, so a second attach was handed back the FIRST
        // one's future: the app went on using the connection to the machine the
        // user had just navigated away from, and nothing ever re-ran for the
        // new one.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final connection = FakeSessionDetailConnection();
        final detailContainer = buildControllerContainer(
          key,
          connection,
          FakeControllerAttachmentPicker(),
          nextConnection: FakeSessionDetailConnection.new,
        );
        addTearDown(detailContainer.dispose);
        keepSessionDetailAlive(detailContainer, key);
        final controller = detailContainer.read(
          sessionDetailControllerProvider(key).notifier,
        );

        // No await between these calls: the first attach is still in flight.
        final first = controller.attach();
        expect(
          identical(controller.attach(), first),
          isTrue,
          reason: 'the same broker must not start a second attach',
        );

        detailContainer
            .read(activeBrokerProfileProvider.notifier)
            .state = fakeControllerBrokerProfile(
          baseUri: Uri.parse('http://beta.invalid:7734'),
        );
        final afterEdit = controller.attach();
        expect(
          identical(afterEdit, first),
          isFalse,
          reason: 'another machine needs its own attach, not the old future',
        );

        await first;
        await afterEdit;
        await drainSessionDetailMicrotasks();
        expect(
          detailContainer
              .read(sessionDetailControllerProvider(key))
              .source
              ?.endpoint,
          contains('beta.invalid'),
          reason: 'the settled state belongs to the machine now selected',
        );
      },
    );

    test(
      'no broker-bound row seeded under endpoint A is displayed, sent, or '
      'restored after the profile moves to endpoint B',
      () async {
        // The cumulative endpoint-move reproduction. Every durable store that
        // records what broker A said — or what the app may do to broker A —
        // is seeded exactly as the app would have left it, and then the SAME
        // profile id reopens pointed at machine B. Qualification by profile
        // id alone passes every one of these seeds through: the transcript
        // displays, the created-session intent and app-created provenance
        // silently restore Drive, and the draft surfaces into B's composer.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final fx = _endpointMoveFixture();

        await fx.transcripts.upsert(
          SessionTranscriptSnapshot(
            brokerProfileId: fx.scopeA,
            sessionKey: key,
            messages: const [
              AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {'type': 'endpoint-a-cached-transcript'},
              ),
            ],
            hasEarlier: false,
            updatedAt: DateTime(2026, 7, 28),
          ),
        );
        await fx.drafts.save(
          SessionLocalDraft(
            brokerProfileId: fx.scopeA,
            sessionKey: key,
            text: 'endpoint A draft',
            localRevision: 1,
            baseBrokerRevision: 0,
            dirty: true,
            updatedAt: DateTime.now(),
          ),
        );
        await fx.driveIntents.rememberAppCreated(
          brokerProfileId: fx.scopeA,
          tool: key.tool,
          sessionId: key.sessionId,
        );
        await fx.outbox.upsert(
          SessionOutboxMessage.create(
            sessionKey: key,
            brokerProfileId: fx.scopeA,
            clientMessageId: 'cm-endpoint-a',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'endpoint A draft'},
          ),
        );
        await fx.outbox.markRetryable(
          'cm-endpoint-a',
          'offline before the edit',
        );
        // The created-session intent, exactly as the create flow records it.
        fx.container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(fx.scopeA, key);
        keepSessionDetailAlive(fx.container, key);

        await fx.container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        await drainSessionDetailMicrotasks();

        final attached = fx.container.read(
          sessionDetailControllerProvider(key),
        );
        expect(
          attached.messageEvents,
          isEmpty,
          reason: "A's cached transcript must not display as B's session",
        );
        expect(attached.bootstrapState.hasCachedMessages, isFalse);
        expect(
          fx.connection.reattachModes,
          isEmpty,
          reason:
              "neither A's created-session intent nor its app-created "
              'provenance may restore Drive on B',
        );

        // B's broker grants Drive of its own accord — the one control state
        // in which a retryable prompt WOULD replay. The A-scoped row still
        // must not.
        fx.connection
          ..emitState(SessionDetailConnectionStatus.connected)
          ..emitEvent(SessionWireEvent(info: wireSession(SessionStatus.idle)));
        await drainSessionDetailMicrotasks();

        expect(
          fx.connection.sendPromptCount,
          0,
          reason: "A's queued prompt must never replay into B's session",
        );
        expect(
          fx.container.read(sessionDetailControllerProvider(key)).draftSurface,
          isNull,
          reason: "A's draft must not surface into B's composer",
        );
        expect(fx.connection.sendDraftCount, 0);
      },
    );

    test(
      'a prompt queued against endpoint A never replays into endpoint B',
      () async {
        // The replay lane in isolation. In the cumulative test above the
        // pre-qualification failure retires this row as a side effect of
        // restoring Drive, which masks the replay leak; without any Drive
        // authority seeded, the SAME id-only qualification replays the
        // A-queued prompt straight into B's identically-named session the
        // moment B grants Drive.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final fx = _endpointMoveFixture();

        // The interrupted send exactly as DR1 leaves it: the outbox row and
        // the durable draft carry the same text, so replay's
        // bind-before-dispatch guarantee is satisfied and only the store
        // qualification stands between this row and B.
        await fx.drafts.save(
          SessionLocalDraft(
            brokerProfileId: fx.scopeA,
            sessionKey: key,
            text: 'endpoint A queued prompt',
            localRevision: 1,
            baseBrokerRevision: 0,
            dirty: true,
            updatedAt: DateTime.now(),
          ),
        );
        await fx.outbox.upsert(
          SessionOutboxMessage.create(
            sessionKey: key,
            brokerProfileId: fx.scopeA,
            clientMessageId: 'cm-endpoint-a',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'endpoint A queued prompt'},
          ),
        );
        await fx.outbox.markRetryable(
          'cm-endpoint-a',
          'offline before the edit',
        );
        keepSessionDetailAlive(fx.container, key);

        await fx.container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fx.connection
          ..emitState(SessionDetailConnectionStatus.connected)
          ..emitEvent(SessionWireEvent(info: wireSession(SessionStatus.idle)));
        await drainSessionDetailMicrotasks();

        expect(
          fx.connection.sendPromptCount,
          0,
          reason: "A's queued prompt must never replay into B's session",
        );
        final rows = await fx.outbox.loadForSession(key);
        expect(
          rows.single.status,
          SessionOutboxMessageStatus.retryable,
          reason:
              "the row stays A's to replay — B neither sends nor touches "
              'it',
        );
      },
    );

    test(
      'deleting the profile removes its durable authority: a re-added '
      'profile with the SAME id and endpoint displays, restores, and sends '
      'nothing',
      () async {
        // Delete → re-add is the strongest form of the leak: the re-added
        // profile derives the IDENTICAL scope key, so scope qualification
        // alone cannot refuse the deleted profile's rows — only
        // deletion-time cleanup can. Runs the REAL manager deleteProfile
        // against the fixture's database.
        const key = SessionDetailKey(tool: kTool, sessionId: kSession);
        final fx = _endpointMoveFixture();
        final profileAtA = BrokerProfile(
          id: 'local',
          displayName: 'local',
          baseUri: Uri.parse('http://alpha.invalid:7734'),
          createdAt: DateTime(2026, 7, 28),
        );
        // This test lives entirely at endpoint A, where the seeds are
        // written — unlike the move tests above, nothing about the source
        // changes across the deletion.
        fx.container.read(activeBrokerProfileProvider.notifier).state =
            profileAtA;
        await fx.container
            .read(brokerProfileRepositoryProvider)
            .save(profileAtA);

        await fx.transcripts.upsert(
          SessionTranscriptSnapshot(
            brokerProfileId: fx.scopeA,
            sessionKey: key,
            messages: const [
              AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {'type': 'cached-before-deletion'},
              ),
            ],
            hasEarlier: false,
            updatedAt: DateTime(2026, 7, 28),
          ),
        );
        await fx.drafts.save(
          SessionLocalDraft(
            brokerProfileId: fx.scopeA,
            sessionKey: key,
            text: 'queued before deletion',
            localRevision: 1,
            baseBrokerRevision: 0,
            dirty: true,
            updatedAt: DateTime.now(),
          ),
        );
        await fx.driveIntents.rememberAppCreated(
          brokerProfileId: fx.scopeA,
          tool: key.tool,
          sessionId: key.sessionId,
        );
        await fx.outbox.upsert(
          SessionOutboxMessage.create(
            sessionKey: key,
            brokerProfileId: fx.scopeA,
            clientMessageId: 'cm-before-deletion',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'queued before deletion'},
          ),
        );
        await fx.outbox.markRetryable('cm-before-deletion', 'offline');
        fx.container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(fx.scopeA, key);

        await fx.container
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile('local');

        // Re-add: the same id at the same endpoint — the same scope key.
        fx.container.read(activeBrokerProfileProvider.notifier).state =
            profileAtA;
        keepSessionDetailAlive(fx.container, key);
        await fx.container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        await drainSessionDetailMicrotasks();

        final attached = fx.container.read(
          sessionDetailControllerProvider(key),
        );
        expect(
          attached.messageEvents,
          isEmpty,
          reason: 'no cached transcript survives the deletion',
        );
        expect(attached.bootstrapState.hasCachedMessages, isFalse);
        expect(
          fx.connection.reattachModes,
          isEmpty,
          reason:
              'neither the app-created provenance nor the created-session '
              'intent may restore Drive after delete → re-add',
        );

        fx.connection
          ..emitState(SessionDetailConnectionStatus.connected)
          ..emitEvent(SessionWireEvent(info: wireSession(SessionStatus.idle)));
        await drainSessionDetailMicrotasks();
        expect(
          fx.connection.sendPromptCount,
          0,
          reason: 'no queued prompt replays after delete → re-add',
        );
        expect(
          fx.container.read(sessionDetailControllerProvider(key)).draftSurface,
          isNull,
          reason: 'no draft surfaces after delete → re-add',
        );
      },
    );

    test('the registry stays bounded and evicts the least recent first', () {
      final registry = container.read(sessionStatusRegistryProvider.notifier);
      const source = RosterSource(
        profileId: 'local',
        endpoint: 'http://127.0.0.1:7734',
      );
      const overflow = SessionStatusRegistry.maxObservations + 8;
      for (var index = 0; index < overflow; index++) {
        registry.publishLive(
          source: source,
          tool: kTool,
          sessionId: 'bulk-$index',
          status: SessionStatus.working,
          rosterRevisionFloor: 0,
        );
      }
      final snapshot = container.read(sessionStatusRegistryProvider);
      expect(
        snapshot.observations,
        hasLength(SessionStatusRegistry.maxObservations),
      );
      expect(
        snapshot.statusFor(tool: kTool, sessionId: 'bulk-0'),
        isNull,
        reason: 'the oldest observation is the one evicted',
      );
      expect(
        snapshot.statusFor(tool: kTool, sessionId: 'bulk-${overflow - 1}'),
        SessionStatus.working,
      );
    });
  });
}

/// A roster whose source can be moved without re-running an attach, so a test
/// can reproduce the window where the roster has already adopted the new
/// endpoint while the open detail socket still belongs to the old one.
class _RosterAtSource extends SessionListController {
  @override
  SessionListState build() => const SessionListState();

  void moveTo(RosterSource source) {
    state = SessionListState(
      status: SessionListStatus.loaded,
      source: source,
    );
  }

  @override
  Future<void> load({bool silent = false}) async {}
}

/// One shared database of REAL drift-backed stores, and a detail controller
/// whose active profile is `local` pointed at endpoint B — while every seed a
/// test writes uses the fixture's `scopeA`, the same profile's scope at
/// endpoint A. The in-memory controller fakes ignore parts of the key and
/// would pass vacuously; these are the production stores.
typedef _EndpointMoveFixture = ({
  ProviderContainer container,
  FakeSessionDetailConnection connection,
  DriftSessionOutboxRepository outbox,
  DriftSessionTranscriptRepository transcripts,
  DriftSessionDriveIntentStore driveIntents,
  DriftSessionDraftRepository drafts,
  String scopeA,
});

_EndpointMoveFixture _endpointMoveFixture() {
  final endpointA = Uri.parse('http://alpha.invalid:7734');
  final endpointB = Uri.parse('http://beta.invalid:7734');
  final scopeA = RosterSource(
    profileId: 'local',
    endpoint: RosterSource.normalizedBrokerEndpoint(endpointA),
  ).storageKey;

  final db = AppDatabase(NativeDatabase.memory());
  addTearDown(db.close);
  final transcripts = DriftSessionTranscriptRepository(db);
  final outbox = DriftSessionOutboxRepository(db);
  final driveIntents = DriftSessionDriveIntentStore(db);
  final drafts = DriftSessionDraftRepository(db);

  final connection = FakeSessionDetailConnection();
  final container = ProviderContainer(
    overrides: [
      appDatabaseProvider.overrideWithValue(db),
      activeBrokerProfileProvider.overrideWith(
        (ref) => BrokerProfile(
          id: 'local',
          displayName: 'local',
          baseUri: endpointB,
          createdAt: DateTime(2026, 7, 28),
        ),
      ),
      brokerClientProvider.overrideWith(
        (ref) async => FakeControllerBrokerClient(),
      ),
      sessionDetailConnectionFactoryProvider.overrideWithValue(
        ({required resolver, required sessionId, required tool}) => connection
          ..sessionId = sessionId
          ..tool = tool,
      ),
      sessionAttachmentPickerProvider.overrideWithValue(
        FakeControllerAttachmentPicker(),
      ),
      sessionArtifactFileServiceProvider.overrideWithValue(
        FakeControllerArtifactFileService(),
      ),
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionOutboxRepositoryProvider.overrideWithValue(outbox),
      sessionTranscriptRepositoryProvider.overrideWithValue(transcripts),
      sessionDriveIntentStoreProvider.overrideWithValue(driveIntents),
      sessionNotificationLifecycleMonitorProvider.overrideWithValue(
        StubBrokerAppLifecycleMonitor(
          currentState: BrokerAppLifecycleState.paused,
        ),
      ),
      sessionNotificationSinkProvider.overrideWithValue(
        CollectingNotificationSink(),
      ),
    ],
  );
  addTearDown(container.dispose);
  return (
    container: container,
    connection: connection,
    outbox: outbox,
    transcripts: transcripts,
    driveIntents: driveIntents,
    drafts: drafts,
    scopeA: scopeA,
  );
}
