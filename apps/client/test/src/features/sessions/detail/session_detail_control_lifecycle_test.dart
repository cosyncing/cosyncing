// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/created_session_attach_intents.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

void main() {
  late FakeSessionDetailConnection fakeConnection;
  late FakeControllerArtifactFileService fakeArtifactFileService;
  late FakeControllerAttachmentPicker fakeAttachmentPicker;
  late FakeControllerBrokerClient fakeBrokerClient;
  late RecordingSessionOutboxRepository fakeOutboxRepository;
  late RecordingSessionTranscriptRepository fakeTranscriptRepository;
  late InMemoryControllerDriveIntentStore fakeDriveIntentStore;
  late InMemorySessionListRepository fakeSessionListRepository;
  late StubSessionListController fakeSessionListController;
  late FakeControllerBrokerClient? alternateBrokerClient;
  late Completer<BrokerClient?>? brokerClientResolution;
  late ProviderContainer container;

  late List<Override> baseOverrides;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
    fakeArtifactFileService = FakeControllerArtifactFileService();
    fakeAttachmentPicker = FakeControllerAttachmentPicker();
    fakeBrokerClient = FakeControllerBrokerClient();
    fakeOutboxRepository = RecordingSessionOutboxRepository();
    fakeTranscriptRepository = RecordingSessionTranscriptRepository();
    fakeDriveIntentStore = InMemoryControllerDriveIntentStore();
    fakeSessionListRepository = InMemorySessionListRepository();
    fakeSessionListController = StubSessionListController();
    alternateBrokerClient = null;
    brokerClientResolution = null;
    baseOverrides = [
      ...dr1DurableDraftTestOverrides(),
      activeBrokerProfileProvider.overrideWith(
        (ref) => fakeControllerBrokerProfile(),
      ),
      brokerClientProvider.overrideWith(
        (ref) {
          final profile = ref.watch(activeBrokerProfileProvider);
          final resolution = brokerClientResolution;
          if (resolution != null) return resolution.future;
          final alternate = alternateBrokerClient;
          if (alternate != null && profile?.baseUri.port == 17734) {
            return Future.value(alternate);
          }
          return Future.value(fakeBrokerClient);
        },
      ),
      sessionNotificationLifecycleMonitorProvider.overrideWithValue(
        StubBrokerAppLifecycleMonitor(
          currentState: BrokerAppLifecycleState.paused,
        ),
      ),
      sessionNotificationSinkProvider.overrideWithValue(
        CollectingNotificationSink(),
      ),
      sessionDetailConnectionFactoryProvider.overrideWithValue(
        ({required resolver, required sessionId, required tool}) {
          fakeConnection
            ..sessionId = sessionId
            ..tool = tool;
          return fakeConnection;
        },
      ),
      sessionArtifactFileServiceProvider.overrideWithValue(
        fakeArtifactFileService,
      ),
      sessionAttachmentPickerProvider.overrideWithValue(
        fakeAttachmentPicker,
      ),
      sessionArtifactTransferRepositoryProvider.overrideWithValue(
        InMemorySessionArtifactTransferRepository(),
      ),
      sessionOutboxRepositoryProvider.overrideWithValue(
        fakeOutboxRepository,
      ),
      sessionTranscriptRepositoryProvider.overrideWithValue(
        fakeTranscriptRepository,
      ),
      sessionDriveIntentStoreProvider.overrideWithValue(
        fakeDriveIntentStore,
      ),
      sessionListRepositoryProvider.overrideWith(
        (ref) async => fakeSessionListRepository,
      ),
      sessionListControllerProvider.overrideWith(
        () => fakeSessionListController,
      ),
    ];
    container = ProviderContainer(overrides: baseOverrides);
  });

  tearDown(() {
    container.dispose();
  });
  group('SessionDetailController', () {
    const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

    test('starts disconnected with selected session identity', () {
      keepSessionDetailAlive(container, key);

      final state = container.read(sessionDetailControllerProvider(key));

      expect(state.tool, 'claude');
      expect(state.sessionId, 'session-1');
      expect(
        state.connectionStatus,
        SessionDetailConnectionStatus.disconnected,
      );
      expect(state.events, isEmpty);
    });

    test('coalesces concurrent attach requests for the same profile', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );

      final first = controller.attach();
      final second = controller.attach();

      expect(identical(first, second), isTrue);
      await Future.wait([first, second]);
      expect(fakeConnection.connectCount, 1);
      expect(fakeConnection.reattachModes, isEmpty);
    });

    test('clearing the active profile disposes the old connection', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();

      container.read(activeBrokerProfileProvider.notifier).state = null;
      await controller.attach();

      expect(fakeConnection.disposeCount, 1);
      final state = container.read(sessionDetailControllerProvider(key));
      expect(
        state.connectionStatus,
        SessionDetailConnectionStatus.disconnected,
      );
      expect(state.error, contains('Connect to a server'));
    });

    test('takeOver re-attaches in resume (Drive) mode', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);

      final takeover = controller.takeOver();
      await Future<void>.delayed(Duration.zero);
      expect(fakeConnection.reattachModes, ['resume']);
      expect(fakeConnection.reattachReasons, ['takeover']);

      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      final succeeded = await takeover;
      await Future<void>.delayed(Duration.zero);
      expect(succeeded, isTrue);
      expect(
        fakeDriveIntentStore.intents['claude/session-1'],
        SessionDriveProvenanceKind.terminalTakeover,
      );
    });

    test('takeOver attaches in the mode the broker declared', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      // A demoted Kimi generation. It is not drivable now — `supported: false`,
      // `unavailable` — and a re-takeover has to attach `live`, because there
      // is no cosyncing-owned process to resume into. Sending the historical
      // `resume` here would attach to nothing and fail.
      fakeConnection.emitSessionControl(const {
        'drive': {
          'state': 'unavailable',
          'supported': false,
          'takeoverAvailable': true,
          'takeoverMode': 'live',
        },
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);

      unawaited(controller.takeOver());
      await Future<void>.delayed(Duration.zero);
      expect(fakeConnection.reattachModes, ['live']);
      expect(fakeConnection.reattachReasons, ['takeover']);
    });

    test('takeOver refuses a mode it cannot reason about', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      // A future attach mode. Taking over means attaching in a specific mode,
      // and guessing `resume` on a session that needs something else seizes
      // Drive the wrong way rather than not at all.
      fakeConnection.emitSessionControl(const {
        'drive': {
          'state': 'observing',
          'supported': true,
          'takeoverAvailable': true,
          'takeoverMode': 'teleport',
        },
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);

      final succeeded = await controller.takeOver();
      await Future<void>.delayed(Duration.zero);
      expect(succeeded, isFalse);
      expect(fakeConnection.reattachModes, isEmpty);
    });

    test('new-session resume instruction is consumed exactly once', () async {
      container
          .read(createdSessionAttachIntentsProvider)
          .rememberResume(fakeControllerBrokerScope(), key);
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );

      await controller.attach();
      expect(fakeConnection.reattachModes, ['resume']);
      expect(fakeConnection.reattachReasons, ['create']);

      await controller.attach();
      expect(
        fakeConnection.reattachModes,
        ['resume'],
        reason: 'an already-interactive resident attach is a no-op',
      );
    });

    test(
      'new-session live instruction is foreground-only and consumed once',
      () async {
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberLive(fakeControllerBrokerScope(), key);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );
        expect(fakeConnection.connectCount, 1);
        expect(fakeConnection.reattachModes, isEmpty);

        await controller.promoteBackgroundObserveToInteractive();
        expect(fakeConnection.reattachModes, ['live']);
        expect(fakeConnection.reattachReasons, [null]);
        expect(
          container
              .read(createdSessionAttachIntentsProvider)
              .takeMode(fakeControllerBrokerScope(), key),
          isNull,
        );
      },
    );

    test(
      'fresh live roster row requests live only for interactive attach',
      () async {
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Live owner',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach();

        expect(fakeConnection.reattachModes, ['live']);
        expect(fakeConnection.reattachReasons, [null]);
      },
    );

    test(
      'an unrecognized roster attach mode attaches read-only, not merely bare',
      () async {
        // The decode side is covered in broker_contract; this is the
        // behavioural half. `AttachMode.unknown` is what a FUTURE broker mode
        // decodes to, and the client cannot know what authority it carries.
        //
        // Omitting the mode is NOT sufficient and this is the test that says
        // so: a bare attach is read-only for one adapter, refused by another,
        // and full-authority for a third (opencode's shared serve is mutable
        // however it was opened). So the client declares `readOnly` and the
        // broker enforces it; asserting only the absent mode would lock in the
        // weaker property.
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Future owner',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach();

        expect(
          fakeConnection.requiredReadOnly,
          isTrue,
          reason: 'the declaration has to reach the broker to be enforced',
        );
        expect(
          fakeConnection.reattachModes,
          isEmpty,
          reason: 'and it must not smuggle an unrecognized mode along with it',
        );
        expect(
          fakeConnection.connectCount,
          1,
          reason:
              'declared before connecting, so no mutable socket ever exists',
        );
      },
    );

    test(
      'an unreadable attach mode dominates a pending create instruction',
      () async {
        // The two paths that carry the MOST authority were the two that used to
        // skip the check, because both return before the roster is consulted.
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberLive(fakeControllerBrokerScope(), key);
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Future owner',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach();

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(
          fakeConnection.reattachModes,
          isEmpty,
          reason: 'the create instruction must not become a live attach',
        );
        expect(
          container
              .read(createdSessionAttachIntentsProvider)
              .takeMode(fakeControllerBrokerScope(), key),
          'live',
          reason: 'declining to act on the one-shot is not spending it',
        );
      },
    );

    test(
      'an unreadable attach mode dominates a Drive restore',
      () async {
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(fakeControllerBrokerScope(), key);
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Future owner',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach();

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(
          fakeConnection.reattachReasons,
          isEmpty,
          reason: 'no reason-tagged resume may ride an unreadable row',
        );
      },
    );

    test(
      'an unreadable attach mode applies to a BACKGROUND attach too',
      () async {
        // A background attach asks for no authority, but it still opens a bare
        // socket — and a bare socket is full-authority on some adapters.
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Future owner',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(fakeConnection.connectCount, 1);
      },
    );

    test(
      'a row that becomes unreadable DURING the restore lookup still attaches '
      'read-only',
      () async {
        // The decision is taken before an async provenance read and used after
        // it; a roster refresh inside that window used to dispatch resume with
        // no declaration at all. The recheck sits immediately before dispatch,
        // with nothing awaited in between.
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Readable for now',
            status: SessionStatus.idle,
            attachMode: AttachMode.observe,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        final gate = fakeDriveIntentStore.holdNextRead();
        final attaching = controller.attach();
        await Future<void>.delayed(Duration.zero);

        // The broker's answer changes while the lookup is parked.
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Now unreadable',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        gate.complete();
        await attaching;

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(
          fakeConnection.reattachModes,
          isEmpty,
          reason: 'the stale decision must not dispatch a resume attach',
        );
      },
    );

    test(
      'a promote whose row becomes unreadable mid-flight declares read-only',
      () async {
        // Same race on the other dispatch path: a background attach promoted to
        // interactive re-reads the roster around its own async lookup.
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Readable for now',
            status: SessionStatus.idle,
            attachMode: AttachMode.observe,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );
        expect(fakeConnection.requiredReadOnly, isFalse);

        final gate = fakeDriveIntentStore.holdNextRead();
        final promoting = controller.attach();
        await Future<void>.delayed(Duration.zero);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Now unreadable',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        gate.complete();
        await promoting;

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(
          fakeConnection.reattachReadOnly,
          contains(true),
          reason: 'the promote must tell the broker, not just latch locally',
        );
      },
    );

    test(
      'a row that becomes unreadable during OUTBOX RETIREMENT is caught too',
      () async {
        // The promote path rechecks before retiring the outbox, but retirement
        // is itself an await — so the recheck that matters is the one after it,
        // with nothing awaited before the dispatch.
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Readable for now',
            status: SessionStatus.idle,
            attachMode: AttachMode.live,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );

        final gate = fakeOutboxRepository.holdNextRetryableLoad();
        final promoting = controller.attach();
        await Future<void>.delayed(Duration.zero);
        fakeSessionListController.setSessions(const [
          SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Now unreadable',
            status: SessionStatus.idle,
            attachMode: AttachMode.unknown,
          ),
        ]);
        gate.complete();
        await promoting;

        expect(fakeConnection.requiredReadOnly, isTrue);
        expect(
          fakeConnection.reattachModes,
          isNot(contains('live')),
          reason: 'the live attach decided before retirement must not dispatch',
        );
        expect(fakeConnection.reattachReadOnly, contains(true));
      },
    );

    test('fresh live roster row cannot arm a background attach', () async {
      container.read(sessionListControllerProvider);
      fakeSessionListController.setSessions(const [
        SessionInfo(
          id: 'session-1',
          tool: 'claude',
          title: 'Live owner',
          status: SessionStatus.idle,
          attachMode: AttachMode.live,
        ),
      ]);
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );

      await controller.attach(
        intent: SessionDetailAttachIntent.backgroundObserve,
      );
      expect(fakeConnection.connectCount, 1);
      expect(fakeConnection.reattachModes, isEmpty);

      await controller.promoteBackgroundObserveToInteractive();
      expect(fakeConnection.reattachModes, ['live']);
    });

    test('live demotion disarms reconnect authority', () async {
      container
          .read(createdSessionAttachIntentsProvider)
          .rememberLive(fakeControllerBrokerScope(), key);
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();

      fakeConnection.emitSessionControl(
        const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
        authority: const SessionConnectionAuthority(
          canMutate: true,
          prompt: SessionPromptAuthority.full,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(fakeConnection.disarmDriveAuthorityCount, 0);

      fakeConnection.emitSessionControl(
        const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
        authority: const SessionConnectionAuthority(
          canMutate: false,
          prompt: SessionPromptAuthority.none,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(fakeConnection.disarmDriveAuthorityCount, 1);
    });

    test(
      'new-session Connecting phase establishes Drive before handoff completes',
      () async {
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(fakeControllerBrokerScope(), key);

        final handoff = await prepareCreatedSessionConnection(
          container,
          const SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Created session',
            status: SessionStatus.idle,
            attachMode: AttachMode.observe,
          ),
        );

        expect(fakeConnection.reattachModes, ['resume']);
        expect(fakeConnection.reattachReasons, ['create']);
        expect(
          container
              .read(createdSessionAttachIntentsProvider)
              .takeResume(fakeControllerBrokerScope(), key),
          isFalse,
          reason: 'the launch handoff consumed its one-shot create intent',
        );
        handoff.release();
      },
    );

    test(
      'new-session Drive controller stays resident until detail claims it',
      () async {
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(fakeControllerBrokerScope(), key);

        final handoff = await prepareCreatedSessionConnection(
          container,
          const SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Created session',
            status: SessionStatus.idle,
            attachMode: AttachMode.observe,
          ),
        );
        await drainSessionDetailMicrotasks();

        expect(
          fakeConnection.disposeCount,
          0,
          reason: 'launch must not release Drive before navigation mounts',
        );

        final detailLease = container.listen(
          sessionDetailControllerProvider(key),
          (previous, next) {},
          fireImmediately: true,
        );
        handoff.release();
        await drainSessionDetailMicrotasks();

        expect(
          fakeConnection.disposeCount,
          0,
          reason: 'the destination watch owns the same live controller',
        );

        detailLease.close();
        await drainSessionDetailMicrotasks();
        expect(fakeConnection.disposeCount, 1);
      },
    );

    test(
      'background observe never restores Drive and interactive upgrades once',
      () async {
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );

        expect(fakeConnection.connectCount, 1);
        expect(fakeConnection.reattachModes, isEmpty);
        expect(fakeConnection.reattachReasons, isEmpty);
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.appCreated,
          reason: 'background observation must not consume local authority',
        );

        await controller.attach();
        expect(fakeConnection.connectCount, 1);
        expect(fakeConnection.reattachModes, ['resume']);
        expect(fakeConnection.reattachReasons, ['app-restore']);

        await controller.attach();
        expect(
          fakeConnection.reattachModes,
          ['resume'],
          reason: 'later tab visibility changes reuse the upgraded attach',
        );
      },
    );

    test(
      'Pi background Observe joins the exact existing driver only after '
      'promotion',
      () async {
        const piKey = SessionDetailKey(tool: 'pi', sessionId: 'session-1');
        const revision = SessionOwnerRevision(epoch: 'broker-epoch', seq: 8);
        keepSessionDetailAlive(container, piKey);
        final controller = container.read(
          sessionDetailControllerProvider(piKey).notifier,
        );

        await fakeOutboxRepository.upsert(
          SessionOutboxMessage.create(
            sessionKey: piKey,
            brokerProfileId: fakeControllerBrokerScope(),
            clientMessageId: 'ca.retry.before-join',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'belongs to the earlier owner'},
          ).copyWith(status: SessionOutboxMessageStatus.retryable),
        );

        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );
        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: revision,
            state: SessionOwnerState.drive,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
          joinExisting: const SessionJoinExistingAction(
            ownerRevision: revision,
          ),
        );
        await drainSessionDetailMicrotasks();

        expect(fakeConnection.reattachModes, isEmpty);
        expect(
          SessionControlView.fromSessionDetailState(
            container.read(sessionDetailControllerProvider(piKey)),
          ).pill,
          SessionControlPill.driverActive,
        );

        await controller.attach();
        expect(fakeConnection.reattachModes, ['resume']);
        expect(fakeConnection.reattachReasons, ['join-existing']);
        expect(
          fakeConnection.reattachOwnerRevisions.single?.epoch,
          'broker-epoch',
        );
        expect(fakeConnection.reattachOwnerRevisions.single?.seq, 8);
        expect(
          fakeOutboxRepository.messageById('ca.retry.before-join')?.status,
          SessionOutboxMessageStatus.failed,
          reason: 'ownerless retry rows must never cross a join boundary',
        );
        expect(fakeConnection.sendPromptCount, 0);

        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: revision,
            state: SessionOwnerState.drive,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: true,
            prompt: SessionPromptAuthority.full,
          ),
        );
        await drainSessionDetailMicrotasks();
        expect(
          fakeDriveIntentStore.intents,
          isNot(contains('pi/session-1')),
          reason: 'joining does not invent app-created local provenance',
        );

        // A repeated frame for the same owner revision cannot start a loop.
        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: revision,
            state: SessionOwnerState.drive,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
          joinExisting: const SessionJoinExistingAction(
            ownerRevision: revision,
          ),
        );
        await drainSessionDetailMicrotasks();
        expect(fakeConnection.reattachModes, hasLength(1));
      },
    );

    test(
      'lower same-epoch owner frames cannot reintroduce a stale join',
      () async {
        const piKey = SessionDetailKey(tool: 'pi', sessionId: 'session-1');
        keepSessionDetailAlive(container, piKey);
        final controller = container.read(
          sessionDetailControllerProvider(piKey).notifier,
        );
        await controller.attach();

        void emitOwner(int seq, {bool offerJoin = true}) {
          final revision = SessionOwnerRevision(
            epoch: 'broker-epoch',
            seq: seq,
          );
          fakeConnection.emitSessionControl(
            const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            },
            sessionOwner: SessionOwnerProjection(
              revision: revision,
              state: SessionOwnerState.drive,
            ),
            authority: const SessionConnectionAuthority(
              canMutate: false,
              prompt: SessionPromptAuthority.none,
            ),
            joinExisting: offerJoin
                ? SessionJoinExistingAction(ownerRevision: revision)
                : null,
          );
        }

        emitOwner(10, offerJoin: false);
        await drainSessionDetailMicrotasks();
        emitOwner(9);
        await drainSessionDetailMicrotasks();

        final state = container.read(sessionDetailControllerProvider(piKey));
        expect(state.sessionInfo?.sessionOwner?.revision.seq, 10);
        expect(state.joinExisting, isNull);
        expect(fakeConnection.reattachModes, isEmpty);

        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: SessionOwnerRevision(
              epoch: 'restarted-broker',
              seq: 0,
            ),
            state: SessionOwnerState.none,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
        );
        await drainSessionDetailMicrotasks();
        final restarted = container.read(
          sessionDetailControllerProvider(piKey),
        );
        expect(
          restarted.sessionInfo?.sessionOwner?.revision.epoch,
          'restarted-broker',
        );
        expect(restarted.sessionInfo?.sessionOwner?.revision.seq, 0);
      },
    );

    test(
      'interactive promotion without Drive provenance keeps the Observe socket',
      () async {
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );

        await controller.attach(
          intent: SessionDetailAttachIntent.backgroundObserve,
        );
        final resetGeneration = container
            .read(sessionDetailControllerProvider(key))
            .transcriptResetGeneration;

        await controller.attach();

        expect(fakeConnection.connectCount, 1);
        expect(fakeConnection.reattachModes, isEmpty);
        expect(fakeConnection.reattachReasons, isEmpty);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .transcriptResetGeneration,
          resetGeneration,
          reason: 'promotion must not bootstrap or replay the transcript',
        );
      },
    );

    test('handoffToTerminal uses the current Drive socket', () async {
      fakeDriveIntentStore.seedTakeover('claude', 'session-1');
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection.reattachModes.clear();
      fakeConnection.reattachReasons.clear();
      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);

      final handoff = controller.handoffToTerminal();
      await Future<void>.delayed(Duration.zero);
      expect(fakeConnection.sendHandoffCount, 1);
      expect(fakeConnection.lastHandoffClientMessageId, isNotNull);
      fakeConnection.emitSessionControl(
        const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
        sessionOwner: const SessionOwnerProjection(
          revision: SessionOwnerRevision(epoch: 'handoff-epoch', seq: 2),
          state: SessionOwnerState.none,
        ),
        authority: const SessionConnectionAuthority(
          canMutate: false,
          prompt: SessionPromptAuthority.none,
        ),
      );
      final succeeded = await handoff;

      expect(succeeded, isTrue);
      expect(fakeConnection.reattachModes, isEmpty);
      expect(fakeConnection.disarmDriveAuthorityCount, 1);
      expect(fakeDriveIntentStore.intents, isNot(contains('claude/session-1')));
    });

    test(
      'handoff does not report success while Drive remains active',
      () async {
        fakeDriveIntentStore.seedTakeover('claude', 'session-1');
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        final handoff = controller.handoffToTerminal();
        await Future<void>.delayed(Duration.zero);
        fakeConnection.emitEvent(
          NackWireEvent(
            code: 'DRIVE_OWNERSHIP_CONFLICT',
            message: 'Another foreground client is still driving.',
            clientMessageId: fakeConnection.lastHandoffClientMessageId,
          ),
        );

        expect(await handoff, isFalse);
        expect(fakeConnection.disarmDriveAuthorityCount, 0);
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.terminalTakeover,
        );
      },
    );

    test(
      'unknown owner truth cannot confirm a pending handoff',
      () async {
        fakeDriveIntentStore.seedTakeover('claude', 'session-1');
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        var completed = false;
        final handoff = controller.handoffToTerminal();
        unawaited(handoff.whenComplete(() => completed = true));
        await Future<void>.delayed(Duration.zero);
        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: SessionOwnerRevision(epoch: 'future-owner', seq: 1),
            state: SessionOwnerState.unknown,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
        );
        await drainSessionDetailMicrotasks();
        expect(completed, isFalse);

        fakeConnection.emitEvent(
          NackWireEvent(
            code: 'DRIVE_OWNERSHIP_CONFLICT',
            message: 'The owner kind is not understood.',
            clientMessageId: fakeConnection.lastHandoffClientMessageId,
          ),
        );
        expect(await handoff, isFalse);
        expect(fakeConnection.disarmDriveAuthorityCount, 0);
      },
    );

    test(
      'restore provenance retires stale outbox before the reason attach',
      () async {
        fakeDriveIntentStore.seedTakeover('claude', 'session-1');
        await fakeOutboxRepository.upsert(
          SessionOutboxMessage.create(
            sessionKey: key,
            brokerProfileId: fakeControllerBrokerScope(),
            clientMessageId: 'ca.retry.auto-resume',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'must not fork'},
          ).copyWith(status: SessionOutboxMessageStatus.retryable),
        );
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        expect(fakeConnection.connectCount, 0);
        expect(fakeConnection.reattachModes, ['resume']);
        expect(fakeConnection.reattachReasons, ['lease-restore']);
        // The ownership decision moved into the broker's atomic attach: the
        // reopen must not fetch a roster (or transcript) to decide.
        expect(fakeSessionListController.loadCount, 0);
        expect(fakeSessionListRepository.fetchCount, 0);
        expect(fakeConnection.sendPromptCount, 0);
        expect(
          fakeOutboxRepository.messageById('ca.retry.auto-resume')?.status,
          SessionOutboxMessageStatus.failed,
        );
        expect(
          fakeOutboxRepository.messageById('ca.retry.auto-resume')?.lastError,
          contains('ownership change'),
        );
      },
    );

    test(
      'app-created provenance restores with app-restore and no roster fetch',
      () async {
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        expect(fakeConnection.connectCount, 0);
        expect(fakeConnection.reattachModes, ['resume']);
        expect(fakeConnection.reattachReasons, ['app-restore']);
        expect(fakeSessionListRepository.fetchCount, 0);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .driveRestorePhase,
          SessionDriveRestorePhase.restoring,
        );

        // The broker confirms the reconstructed owner: Restoring settles to
        // idle and the durable preference is refreshed, not narrowed.
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .driveRestorePhase,
          SessionDriveRestorePhase.idle,
        );
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.appCreated,
        );
      },
    );

    test(
      'attach-conflict ends Restoring honestly and preserves provenance',
      () async {
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        expect(fakeConnection.reattachReasons, ['app-restore']);

        fakeConnection
          ..emitEvent(
            const AttachConflictWireEvent(
              requestedMode: 'resume',
              reason: 'app-restore',
              code: 'DRIVE_OWNERSHIP_CONFLICT',
              message: 'A terminal is running this session privately.',
            ),
          )
          // The broker continues the socket as Observe; the session frame
          // that follows must neither erase the durable preference nor blank
          // the just-surfaced denial note.
          ..emitSessionControl(const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          });
        await Future<void>.delayed(Duration.zero);

        final state = container.read(sessionDetailControllerProvider(key));
        // The denial stays visible through the ordinary Observe fallback
        // frame — the broker always sends one right after attach-conflict,
        // so clearing on it would flash the note for a single frame.
        expect(state.driveRestorePhase, SessionDriveRestorePhase.conflict);
        expect(
          state.driveRestoreConflict?.code,
          'DRIVE_OWNERSHIP_CONFLICT',
        );
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.appCreated,
        );
        // The honest Observe answer still leaves manual Drive reachable.
        expect(
          SessionControlView.fromSessionInfo(state.sessionInfo).canTakeOver,
          isTrue,
        );

        // Only genuinely restored mutability settles the note: a confirmed
        // Driving frame clears it and returns the phase to idle.
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);
        final restored = container.read(sessionDetailControllerProvider(key));
        expect(restored.driveRestorePhase, SessionDriveRestorePhase.idle);
        expect(restored.driveRestoreConflict, isNull);
      },
    );

    for (final code in const [
      'DRIVE_OWNERSHIP_UNKNOWN',
      'DRIVE_NATIVE_SESSION_UNRESUMABLE',
    ]) {
      test(
        '$code remains visible through the Observe fallback',
        () async {
          fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
          keepSessionDetailAlive(container, key);

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          fakeConnection
            ..emitEvent(
              AttachConflictWireEvent(
                requestedMode: 'resume',
                reason: 'app-restore',
                code: code,
                message: 'Drive attach refused safely.',
              ),
            )
            ..emitSessionControl(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': false,
                'action': 'join',
                'command': 'codex resume --remote socket thread',
              },
            });
          await Future<void>.delayed(Duration.zero);

          final state = container.read(sessionDetailControllerProvider(key));
          expect(state.driveRestorePhase, SessionDriveRestorePhase.conflict);
          expect(state.driveRestoreConflict?.code, code);
          expect(
            state.sessionInfo?.control?.drive.state,
            DriveState.observing,
          );
          expect(
            SessionControlView.fromSessionInfo(state.sessionInfo).canTakeOver,
            isTrue,
          );
          expect(
            fakeDriveIntentStore.intents['claude/session-1'],
            SessionDriveProvenanceKind.appCreated,
          );
        },
      );
    }

    test(
      'non-driving arbitration answer preserves provenance for later reopens',
      () async {
        // e.g. the broker joined an active shared owner instead of Resume: a
        // cold Observing/synced frame is not proof against the preference.
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'unavailable', 'supported': false},
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': true,
          },
        });
        await Future<void>.delayed(Duration.zero);

        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .driveRestorePhase,
          SessionDriveRestorePhase.idle,
        );
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.appCreated,
        );
      },
    );

    test(
      'unreadable provenance storage attaches bare and preserves records',
      () async {
        fakeDriveIntentStore
          ..seedTakeover('claude', 'session-1')
          ..failRead = true;
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        expect(fakeConnection.connectCount, 1);
        expect(fakeConnection.reattachModes, isEmpty);
        expect(fakeDriveIntentStore.intents, contains('claude/session-1'));
      },
    );

    test(
      'transient automatic restore failure preserves app-created provenance',
      () async {
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        fakeConnection.failNextReattach = true;
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final state = container.read(sessionDetailControllerProvider(key));
        expect(state.bootstrapState.hasFailed, isTrue);
        expect(state.driveRestorePhase, SessionDriveRestorePhase.idle);
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.appCreated,
        );
      },
    );

    test('real app mutation slides an existing takeover lease', () async {
      fakeDriveIntentStore.seedTakeover('claude', 'session-1');
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();

      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);
      expect(fakeDriveIntentStore.takeoverRefreshCount, 1);

      expect(await controller.sendPrompt('slide the lease'), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(fakeDriveIntentStore.takeoverRefreshCount, 2);
    });

    test('a session-ended frame clears Drive provenance', () async {
      fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();

      fakeConnection.emitEvent(const EndedWireEvent(reason: 'quit'));
      await Future<void>.delayed(Duration.zero);

      expect(fakeDriveIntentStore.intents, isNot(contains('claude/session-1')));
      fakeConnection.reattachModes.clear();
      fakeConnection.reattachReasons.clear();
      await controller.attach();
      expect(fakeConnection.reattachModes, [null]);
      expect(fakeConnection.reattachReasons, [null]);
    });

    test(
      'after explicit handoff a reopen is Observe-first (no auto-restore)',
      () async {
        fakeDriveIntentStore.seedAppCreated('claude', 'session-1');
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        final handoff = controller.handoffToTerminal();
        await Future<void>.delayed(Duration.zero);
        fakeConnection.emitSessionControl(
          const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
          sessionOwner: const SessionOwnerProjection(
            revision: SessionOwnerRevision(epoch: 'handoff-epoch', seq: 3),
            state: SessionOwnerState.none,
          ),
          authority: const SessionConnectionAuthority(
            canMutate: false,
            prompt: SessionPromptAuthority.none,
          ),
        );
        expect(await handoff, isTrue);
        expect(
          fakeDriveIntentStore.intents,
          isNot(contains('claude/session-1')),
        );

        // A later reopen must not silently re-claim Drive: the reused
        // connection resets to a bare Observe attach with no drive reason.
        fakeConnection.reattachModes.clear();
        fakeConnection.reattachReasons.clear();
        await controller.attach();
        expect(fakeConnection.reattachModes, [null]);
        expect(fakeConnection.reattachReasons, [null]);
      },
    );

    test('explicit disconnect clears Drive intent', () async {
      fakeDriveIntentStore.seedTakeover('claude', 'session-1');
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();

      await controller.disconnect();

      expect(fakeDriveIntentStore.intents, isNot(contains('claude/session-1')));
    });

    test(
      'disconnect clears Drive intent even before transport creation',
      () async {
        fakeDriveIntentStore.seedTakeover('claude', 'session-1');
        keepSessionDetailAlive(container, key);

        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .disconnect();

        expect(fakeConnection.closeCount, 0);
        expect(
          fakeDriveIntentStore.intents,
          isNot(contains('claude/session-1')),
        );
      },
    );

    test('handoff proceeds when Drive-intent storage is unavailable', () async {
      fakeDriveIntentStore.seedTakeover('claude', 'session-1');
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection.reattachModes.clear();
      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);
      fakeDriveIntentStore.failClear = true;

      final handoff = controller.handoffToTerminal();
      await Future<void>.delayed(Duration.zero);
      fakeConnection.emitSessionControl(
        const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
        sessionOwner: const SessionOwnerProjection(
          revision: SessionOwnerRevision(epoch: 'handoff-epoch', seq: 4),
          state: SessionOwnerState.none,
        ),
        authority: const SessionConnectionAuthority(
          canMutate: false,
          prompt: SessionPromptAuthority.none,
        ),
      );
      final succeeded = await handoff;

      expect(succeeded, isTrue);
      expect(fakeConnection.reattachModes, isEmpty);
    });

    test('takeOver is a no-op before attach', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );

      final succeeded = await controller.takeOver();

      expect(succeeded, isFalse);
      expect(fakeConnection.reattachModes, isEmpty);
    });

    test('takeOver refuses to arm during reconnect', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection
        ..emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        })
        ..emitState(SessionDetailConnectionStatus.reconnecting);
      await Future<void>.delayed(Duration.zero);

      final succeeded = await controller.takeOver();

      expect(succeeded, isFalse);
      expect(fakeConnection.reattachModes, isEmpty);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains('Reconnect before taking over'),
      );
    });

    test('takeOver surfaces a failed reattach', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection
        ..emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        })
        ..failNextReattach = true;
      await Future<void>.delayed(Duration.zero);

      final succeeded = await controller.takeOver();

      expect(succeeded, isFalse);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains("Couldn't take over this session."),
      );
      // The one-shot takeover request must not survive on the transport,
      // where a later automatic reconnect would silently retry it.
      expect(fakeConnection.disarmDriveAuthorityCount, 1);
    });

    test(
      'unconfirmed takeover disarms the transport and keeps the note',
      () async {
        final container = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            ...baseOverrides,
            sessionTakeoverConfirmTimeoutProvider.overrideWithValue(
              const Duration(milliseconds: 50),
            ),
          ],
        );
        addTearDown(container.dispose);
        keepSessionDetailAlive(container, key);
        final controller = container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        await controller.attach();
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);

        // The broker never answers with driving or attach-conflict.
        final succeeded = await controller.takeOver();

        expect(succeeded, isFalse);
        // The timeout is definitive: disarming shapes the NEXT reconnect,
        // but the armed resume socket is also actively replaced with a bare
        // Observe attach so a late grant cannot land half-applied.
        expect(fakeConnection.reattachModes, ['resume', null]);
        expect(fakeConnection.reattachReasons, ['takeover', null]);
        expect(fakeConnection.disarmDriveAuthorityCount, 1);
        final state = container.read(sessionDetailControllerProvider(key));
        expect(state.driveRestorePhase, SessionDriveRestorePhase.conflict);
        expect(state.driveRestoreConflict?.code, 'DRIVE_RESTORE_TIMEOUT');

        // Delayed-Driving regression: a Driving frame straggling in after
        // the timeout (a slow Codex resume can outlive the window) must not
        // persist a takeover lease — the settled attempt is over, and the
        // user was already told the session stays in Observe.
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          fakeDriveIntentStore.intents,
          isNot(contains('claude/session-1')),
        );

        // A fresh explicit attempt from Observe still works normally and
        // persists its lease only on a broker-confirmed Driving frame.
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await Future<void>.delayed(Duration.zero);
        final retry = controller.takeOver();
        await Future<void>.delayed(Duration.zero);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .driveRestoreConflict,
          isNull,
        );
        fakeConnection.emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        expect(await retry, isTrue);
        expect(
          fakeDriveIntentStore.intents['claude/session-1'],
          SessionDriveProvenanceKind.terminalTakeover,
        );
      },
    );

    test('takeOver fails when the broker denies the takeover', () async {
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      await controller.attach();
      fakeConnection.emitSessionControl(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await Future<void>.delayed(Duration.zero);

      final takeover = controller.takeOver();
      await Future<void>.delayed(Duration.zero);
      fakeConnection
        ..emitEvent(
          const AttachConflictWireEvent(
            requestedMode: 'resume',
            reason: 'takeover',
            code: 'DRIVE_OWNERSHIP_CONFLICT',
            message: 'A terminal owns this session.',
          ),
        )
        ..emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': true,
          },
        });

      expect(await takeover, isFalse);
      await Future<void>.delayed(Duration.zero);
      final state = container.read(sessionDetailControllerProvider(key));
      expect(state.sessionInfo?.control?.drive.state, DriveState.observing);
      expect(state.driveRestoreConflict, isNull);
    });

    test('attach opens the connection and mirrors connection state', () async {
      keepSessionDetailAlive(container, key);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      expect(fakeConnection.connectCount, 1);
      expect(fakeConnection.tool, 'claude');
      expect(fakeConnection.sessionId, 'session-1');
      expect(
        container.read(sessionDetailControllerProvider(key)).connectionStatus,
        SessionDetailConnectionStatus.connected,
      );
      expect(
        container
            .read(sessionDetailControllerProvider(key))
            .agentActions
            ?.canTranscriptExport,
        isTrue,
      );
    });

    test('transcript export preflight stores confirmation state', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final preflight = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .prepareTranscriptExport();

      expect(preflight?.nonce, 'nonce-1');
      expect(fakeBrokerClient.prepareTranscriptExportCount, 1);
      final exportState = container
          .read(sessionDetailControllerProvider(key))
          .transcriptExportActionState;
      expect(
        exportState.phase,
        TranscriptExportActionPhase.awaitingConfirmation,
      );
      expect(exportState.preflight?.confirm.format, 'html');
    });

    test(
      'transcript export appends returned artifact to session messages',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final exported = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .exportTranscript(nonce: ' nonce-1 ');

        expect(exported, isTrue);
        expect(fakeBrokerClient.exportTranscriptCount, 1);
        expect(fakeBrokerClient.lastExportNonce, 'nonce-1');
        final state = container.read(sessionDetailControllerProvider(key));
        expect(
          state.transcriptExportActionState.phase,
          TranscriptExportActionPhase.exported,
        );
        expect(state.fileArtifactDescriptors, hasLength(1));
        expect(
          state.fileArtifactDescriptors.single.deliveryClass,
          SessionArtifactDeliveryClass.exportAttachment,
        );
        expect(state.fileArtifactDescriptors.single.format, 'html');
      },
    );

    test(
      'transcript export maps stale confirmation error distinctly',
      () async {
        fakeBrokerClient.exportError = const BrokerException(
          message: 'Export failed',
          statusCode: 409,
          error: BrokerError(
            error: 'confirmation nonce expired',
            code: 'CONFIRMATION_STALE',
          ),
        );
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final exported = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .exportTranscript(nonce: 'nonce-1');

        expect(exported, isFalse);
        final state = container.read(sessionDetailControllerProvider(key));
        expect(
          state.transcriptExportActionState.errorCode,
          'CONFIRMATION_STALE',
        );
        expect(
          state.error,
          contains('confirmation expired or changed'),
        );
      },
    );

    test(
      'forkSession passes the message boundary and stores action state',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession(messageId: 'message-42');

        expect(created, isNotNull);
        expect(fakeBrokerClient.forkSessionCount, 1);
        expect(fakeBrokerClient.lastForkMessageId, 'message-42');
        expect(created?.id, 'session-1-fork');
        final actionState = container
            .read(sessionDetailControllerProvider(key))
            .forkSessionActionState;
        expect(actionState.phase, SessionActionPhase.success);
        expect(actionState.createdSessionId, 'session-1-fork');
        expect(actionState.createdSessionTitle, 'Forked Session');
        expect(actionState.message, contains('Forked session'));
      },
    );

    test(
      'forkSession refuses an agent-owned session without reaching the broker',
      () async {
        // CR4 backstop, at the coordinator. Both affordances are already
        // withheld for this shape (status-panel tile disabled, message-context
        // "Fork from here" absent), so this covers what those cannot: a
        // programmatic caller — a restored intent, a deep link, a stale widget
        // — invoking the action anyway.
        //
        // The TOOL capability deliberately says YES here (the default fake
        // agent has `canFork: true`), so the only thing that can refuse is the
        // per-SESSION fact `origin == subagent`. Without that separation this
        // test would pass against the pre-existing "not available for this
        // agent" gate and prove nothing.
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Spawned by a parent run',
              'status': 'idle',
              'attachMode': 'observe',
              'origin': 'subagent',
              'parentThreadId': 'parent-thread',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .agentActions
              ?.canFork,
          isTrue,
          reason: 'the global capability must still say fork is available',
        );

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession();

        // Asserted FIRST because it is the claim the backstop exists to make:
        // no request the broker would only answer with 409 SESSION_AGENT_OWNED
        // is ever posted. A later position would be masked by the return-value
        // check below whenever the gate regresses.
        expect(fakeBrokerClient.forkSessionCount, 0);
        expect(fakeBrokerClient.lastForkSessionId, isNull);
        expect(created, isNull);
        final actionState = container
            .read(sessionDetailControllerProvider(key))
            .forkSessionActionState;
        expect(actionState.phase, SessionActionPhase.failed);
        // Typed, not a sentence: the copy is resolved by the view in the user's
        // language (`AppLocalizations.sessionForkAgentOwnedRefusal`), so state
        // must carry the reason rather than the words.
        expect(actionState.refusal, SessionActionRefusal.agentOwnedSession);
        expect(actionState.message, isNull);
      },
    );

    test(
      'forkSession still forks an exec-origin session',
      () async {
        // Narrowness control for the refusal above. `exec` is an automated
        // LAUNCH with no owning parent session, so it stays forkable — without
        // this, a gate that refused every non-human origin would pass.
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Started by codex exec',
              'status': 'idle',
              'attachMode': 'observe',
              'origin': 'exec',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession();

        expect(created?.id, 'session-1-fork');
        expect(fakeBrokerClient.forkSessionCount, 1);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .forkSessionActionState
              .refusal,
          isNull,
        );
      },
    );

    test(
      'forkSession converts the broker 409 SESSION_AGENT_OWNED into the typed '
      'refusal',
      () async {
        // CR4 / the SECOND refuser. The local `origin` gate cannot fire here on
        // purpose: this session frame carries no `origin` at all, which is the
        // shape of a roster row that is stale, absent, or served by a peer. The
        // broker is then the only refuser, and its 409 used to fall into the
        // generic catch — writing the broker's English sentence into
        // `state.error` as primary UI copy, in a client that ships two
        // languages.
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Lineage this client never learned',
              'status': 'idle',
              'attachMode': 'observe',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();
        // Preconditions. Without these the test could pass against the
        // pre-existing local gate (or a missing capability) and prove nothing
        // about the broker path.
        final before = container.read(sessionDetailControllerProvider(key));
        expect(
          before.isAgentOwnedSession,
          isFalse,
          reason:
              'the LOCAL origin gate must be inert for this to test the '
              'broker path',
        );
        expect(before.agentActions?.canFork, isTrue);

        // An ordinary transport failure first: it leaves a generic English
        // sentence in `state.error`, rendered as a page-level banner. The
        // refusal must clear it rather than sit under stale, unrelated copy.
        fakeBrokerClient.forkError = const BrokerException(
          message: 'Broker unreachable.',
          statusCode: 503,
        );
        expect(
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .forkSession(),
          isNull,
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNotNull,
        );

        // Now the broker answers with the typed refusal.
        fakeBrokerClient.forkError = const BrokerException(
          message: 'Broker rejected the fork.',
          statusCode: 409,
          error: BrokerError(
            error:
                'This session was spawned by another agent session; fork '
                'its parent instead.',
            code: 'SESSION_AGENT_OWNED',
          ),
        );
        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession();

        expect(created, isNull);
        expect(fakeBrokerClient.forkSessionCount, 2);
        final state = container.read(sessionDetailControllerProvider(key));
        expect(
          state.forkSessionActionState.refusal,
          SessionActionRefusal.agentOwnedSession,
        );
        // The broker's English sentence must never become primary UI copy: the
        // view resolves the typed refusal in the user's own language. A
        // non-null `message` here would be exactly that leak, because the view
        // falls back to it whenever there is no refusal.
        expect(state.forkSessionActionState.message, isNull);
        expect(state.error, isNull);

        // The refusal stands until an authoritative frame invalidates it, so a
        // retry must not re-post a request the broker can only answer 409.
        expect(
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .forkSession(),
          isNull,
        );
        expect(fakeBrokerClient.forkSessionCount, 2);
      },
    );

    test(
      'a newer authoritative session frame clears a standing agent-owned fork '
      'refusal',
      () async {
        // CR4. `sessionInfo` is replaced wholesale on every session frame, so a
        // session later reclassified as ordinary re-enables the Fork tile (the
        // chrome reads `isAgentOwnedSession`) while the refusal underneath it
        // survived — an enabled control above a status line saying it is
        // impossible. Worse, the coordinator's standing-refusal gate would keep
        // refusing locally a session the broker would now happily fork.
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Spawned by a parent run',
              'status': 'idle',
              'attachMode': 'observe',
              'origin': 'subagent',
              'parentThreadId': 'parent-thread',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();

        // An unrelated earlier failure leaves an English sentence in
        // `state.error`, rendered as a page-level banner. The LOCAL gate below
        // returns before the in-progress write that would otherwise clear it,
        // so recording the refusal has to clear it itself — otherwise the
        // localized refusal renders directly under stale, unlocalized copy
        // about a different action.
        fakeBrokerClient.cloneError = const BrokerException(
          message: 'Clone failed.',
          statusCode: 500,
        );
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .cloneSession();
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNotNull,
        );

        expect(
          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .forkSession(),
          isNull,
        );
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .forkSessionActionState
              .refusal,
          SessionActionRefusal.agentOwnedSession,
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          isNull,
        );
        expect(fakeBrokerClient.forkSessionCount, 0);

        // A NEWER authoritative frame that no longer classifies the session as
        // `subagent`.
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Reclassified by the broker',
              'status': 'idle',
              'attachMode': 'observe',
              'origin': 'exec',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();

        final state = container.read(sessionDetailControllerProvider(key));
        expect(state.isAgentOwnedSession, isFalse);
        expect(state.forkSessionActionState.refusal, isNull);
        expect(state.forkSessionActionState.phase, SessionActionPhase.idle);

        // And the action genuinely works again — the standing-refusal gate is
        // released, not merely hidden.
        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession();
        expect(created?.id, 'session-1-fork');
        expect(fakeBrokerClient.forkSessionCount, 1);
      },
    );

    test('renameSession updates title from the broker response', () async {
      await container.read(openSessionsControllerProvider.future);
      container
          .read(openSessionsControllerProvider.notifier)
          .open(
            const SessionRef(
              tool: 'claude',
              id: 'session-1',
              title: 'Before',
              status: SessionStatus.needsInput,
            ),
          );
      container.read(sessionListControllerProvider);
      fakeSessionListController.setSessions([
        const SessionInfo(
          id: 'session-1',
          tool: 'claude',
          title: 'Before',
          status: SessionStatus.working,
          attachMode: AttachMode.live,
        ),
      ]);
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      fakeConnection.emitEvent(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'session-1',
            'tool': 'claude',
            'title': 'Before',
            'status': 'idle',
            'attachMode': 'observe',
          }),
        ),
      );
      await Future<void>.delayed(Duration.zero);

      final renamed = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .renameSession('  After  ');

      expect(renamed, isTrue);
      expect(fakeBrokerClient.renameSessionCount, 1);
      expect(fakeBrokerClient.lastRenameTitle, 'After');
      final current = container.read(sessionDetailControllerProvider(key));
      expect(current.sessionInfo?.title, 'After');
      expect(
        current.renameSessionActionState.phase,
        SessionActionPhase.success,
      );
      await drainSessionDetailMicrotasks();
      final openRef = container
          .read(openSessionsControllerProvider)
          .value!
          .refs
          .single;
      expect(openRef.title, 'After');
      expect(openRef.status, SessionStatus.needsInput);
      final roster = container
          .read(sessionListControllerProvider)
          .sessions
          .single;
      expect(roster.title, 'After');
      expect(roster.status, SessionStatus.working);
      expect(roster.attachMode, AttachMode.live);
    });

    test(
      'rename attached to A cannot start while B is active',
      () async {
        final serverBClient = FakeControllerBrokerClient();
        alternateBrokerClient = serverBClient;
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Server A detail',
              'status': 'idle',
              'attachMode': 'observe',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .agentActions
              ?.canRenameNative,
          isTrue,
          reason: 'server A supplied the stale rename capability',
        );

        container
            .read(activeBrokerProfileProvider.notifier)
            .state = fakeControllerBrokerProfile(
          baseUri: Uri.parse('http://127.0.0.1:17734'),
        );
        await Future<void>.delayed(Duration.zero);
        final renamed = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .renameSession('Must not reach server B');

        expect(renamed, isFalse);
        expect(fakeBrokerClient.renameSessionCount, 0);
        expect(serverBClient.renameSessionCount, 0);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .sessionInfo
              ?.title,
          'Server A detail',
        );
      },
    );

    test(
      'rename does not reach a client resolved after a source switch',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Old server detail',
              'status': 'idle',
              'attachMode': 'observe',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();

        brokerClientResolution = Completer<BrokerClient?>();
        container.invalidate(brokerClientProvider);
        final rename = container
            .read(sessionDetailControllerProvider(key).notifier)
            .renameSession('Wrong server title');
        await Future<void>.delayed(Duration.zero);

        container
            .read(activeBrokerProfileProvider.notifier)
            .state = fakeControllerBrokerProfile(
          baseUri: Uri.parse('http://127.0.0.1:17734'),
        );
        brokerClientResolution!.complete(fakeBrokerClient);

        expect(await rename, isFalse);
        expect(fakeBrokerClient.renameSessionCount, 0);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .sessionInfo
              ?.title,
          'Old server detail',
        );
      },
    );

    test(
      'delayed rename cannot cross a repointed broker source',
      () async {
        final store = container.read(openSessionsStoreProvider);
        expect(store, isA<LosslessOpenSessionsStore>());
        final losslessStore = store as LosslessOpenSessionsStore;
        final oldProfile = fakeControllerBrokerProfile();
        final newProfile = fakeControllerBrokerProfile(
          baseUri: Uri.parse('http://127.0.0.1:17734'),
        );
        final oldSource = RosterSource.ofProfile(oldProfile);
        final newSource = RosterSource.ofProfile(newProfile);

        await container.read(openSessionsControllerProvider.future);
        container
            .read(openSessionsControllerProvider.notifier)
            .open(
              const SessionRef(
                tool: 'claude',
                id: 'session-1',
                title: 'Old server tab',
                status: SessionStatus.needsInput,
              ),
            );
        container.read(sessionListControllerProvider);
        fakeSessionListController.setSessions([
          const SessionInfo(
            id: 'session-1',
            tool: 'claude',
            title: 'Old server roster',
            status: SessionStatus.working,
            attachMode: AttachMode.live,
          ),
        ]);
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        fakeConnection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Old server detail',
              'status': 'idle',
              'attachMode': 'observe',
            }),
          ),
        );
        await drainSessionDetailMicrotasks();

        fakeBrokerClient.renameResponseCompleter =
            Completer<RenameSessionResponse>();
        final rename = container
            .read(sessionDetailControllerProvider(key).notifier)
            .renameSession('Wrong server title');
        await Future<void>.delayed(Duration.zero);
        expect(fakeBrokerClient.renameSessionCount, 1);

        container.read(activeBrokerProfileProvider.notifier).state = newProfile;
        await container.read(openSessionsControllerProvider.future);
        container
            .read(openSessionsControllerProvider.notifier)
            .open(
              const SessionRef(
                tool: 'claude',
                id: 'session-1',
                title: 'New server tab',
                status: SessionStatus.idle,
              ),
            );
        await drainSessionDetailMicrotasks();

        fakeBrokerClient.renameResponseCompleter!.complete(
          const RenameSessionResponse(ok: true, title: 'Wrong server title'),
        );

        expect(await rename, isFalse);
        await drainSessionDetailMicrotasks();
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .sessionInfo
              ?.title,
          'Old server detail',
          reason: 'the retired response must not change Session Detail',
        );
        expect(
          container.read(sessionListControllerProvider).sessions.single.title,
          'Old server roster',
          reason: 'the retired response must not change the current roster',
        );
        expect(
          container
              .read(openSessionsControllerProvider)
              .value!
              .refs
              .single
              .title,
          'New server tab',
          reason: 'the retired response must not change the active tab strip',
        );
        expect(
          (await losslessStore.loadLossless(
            newSource.storageKey,
            legacyProfileId: newProfile.id,
          )).refs.single.title,
          'New server tab',
          reason: 'the retired response must not change durable tabs',
        );
        expect(
          (await losslessStore.loadLossless(
            oldSource.storageKey,
            legacyProfileId: oldProfile.id,
          )).refs.single.title,
          'Old server tab',
        );
      },
    );

    test('renameSession sends null to clear the native title', () async {
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();
      fakeConnection.emitEvent(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'session-1',
            'tool': 'claude',
            'title': 'Before',
            'status': 'idle',
            'attachMode': 'observe',
          }),
        ),
      );
      await Future<void>.delayed(Duration.zero);

      final renamed = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .renameSession('   ');

      expect(renamed, isTrue);
      expect(fakeBrokerClient.lastRenameTitle, isNull);
      expect(
        container.read(sessionDetailControllerProvider(key)).sessionInfo?.title,
        isEmpty,
      );
    });

    test(
      'cloneSession creates a cloned session and stores action state',
      () async {
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .cloneSession();

        expect(created, isNotNull);
        expect(fakeBrokerClient.cloneSessionCount, 1);
        expect(created?.id, 'session-1-clone');
        final actionState = container
            .read(sessionDetailControllerProvider(key))
            .cloneSessionActionState;
        expect(actionState.phase, SessionActionPhase.success);
        expect(actionState.createdSessionId, 'session-1-clone');
        expect(actionState.createdSessionTitle, 'Cloned Session');
        expect(actionState.message, contains('Cloned session'));
      },
    );

    test(
      'forkSession reports unavailable capability as action failure',
      () async {
        container = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => fakeControllerBrokerProfile(),
            ),
            brokerClientProvider.overrideWith((ref) async => fakeBrokerClient),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              StubBrokerAppLifecycleMonitor(
                currentState: BrokerAppLifecycleState.paused,
              ),
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                fakeConnection
                  ..sessionId = sessionId
                  ..tool = tool;
                return fakeConnection;
              },
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              fakeArtifactFileService,
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              fakeAttachmentPicker,
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
          ],
        );
        fakeBrokerClient.agents = [fakeControllerAgentInfo(canFork: false)];
        addTearDown(container.dispose);

        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .forkSession();

        expect(created, isNull);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .forkSessionActionState
              .phase,
          SessionActionPhase.failed,
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('not available for this agent'),
        );
      },
    );

    test(
      'cloneSession reports unavailable capability as action failure',
      () async {
        container = ProviderContainer(
          overrides: [
            ...dr1DurableDraftTestOverrides(),
            activeBrokerProfileProvider.overrideWith(
              (ref) => fakeControllerBrokerProfile(),
            ),
            brokerClientProvider.overrideWith((ref) async => fakeBrokerClient),
            sessionNotificationLifecycleMonitorProvider.overrideWithValue(
              StubBrokerAppLifecycleMonitor(
                currentState: BrokerAppLifecycleState.paused,
              ),
            ),
            sessionNotificationSinkProvider.overrideWithValue(
              CollectingNotificationSink(),
            ),
            sessionDetailConnectionFactoryProvider.overrideWithValue(
              ({required resolver, required sessionId, required tool}) {
                fakeConnection
                  ..sessionId = sessionId
                  ..tool = tool;
                return fakeConnection;
              },
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(
              fakeArtifactFileService,
            ),
            sessionAttachmentPickerProvider.overrideWithValue(
              fakeAttachmentPicker,
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
          ],
        );
        fakeBrokerClient.agents = [fakeControllerAgentInfo(canClone: false)];
        addTearDown(container.dispose);

        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        final created = await container
            .read(sessionDetailControllerProvider(key).notifier)
            .cloneSession();

        expect(created, isNull);
        expect(
          container
              .read(sessionDetailControllerProvider(key))
              .cloneSessionActionState
              .phase,
          SessionActionPhase.failed,
        );
        expect(
          container.read(sessionDetailControllerProvider(key)).error,
          contains('not available for this agent'),
        );
      },
    );

    test('forkSession requires an active broker client', () async {
      final disconnectedContainer = ProviderContainer(
        overrides: [
          ...dr1DurableDraftTestOverrides(),
          activeBrokerProfileProvider.overrideWith((ref) => null),
          brokerClientProvider.overrideWith((ref) async => null),
          sessionNotificationLifecycleMonitorProvider.overrideWithValue(
            StubBrokerAppLifecycleMonitor(
              currentState: BrokerAppLifecycleState.paused,
            ),
          ),
          sessionNotificationSinkProvider.overrideWithValue(
            CollectingNotificationSink(),
          ),
          sessionDetailConnectionFactoryProvider.overrideWithValue(
            ({required resolver, required sessionId, required tool}) {
              fakeConnection
                ..sessionId = sessionId
                ..tool = tool;
              return fakeConnection;
            },
          ),
          sessionArtifactFileServiceProvider.overrideWithValue(
            fakeArtifactFileService,
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
          sessionAttachmentPickerProvider.overrideWithValue(
            fakeAttachmentPicker,
          ),
          sessionDriveIntentStoreProvider.overrideWithValue(
            InMemoryControllerDriveIntentStore(),
          ),
        ],
      );
      addTearDown(disconnectedContainer.dispose);
      keepSessionDetailAlive(disconnectedContainer, key);

      await disconnectedContainer
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final created = await disconnectedContainer
          .read(sessionDetailControllerProvider(key).notifier)
          .forkSession();

      expect(created, isNull);
      expect(
        disconnectedContainer
            .read(sessionDetailControllerProvider(key))
            .forkSessionActionState
            .phase,
        SessionActionPhase.failed,
      );
      expect(
        disconnectedContainer.read(sessionDetailControllerProvider(key)).error,
        contains('Connect to a server before forking'),
      );
    });

    test('forkSession surfaces broker errors in action state', () async {
      fakeBrokerClient.forkError = const BrokerException(
        message: 'Fork blocked',
        statusCode: 500,
      );
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final created = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .forkSession();

      expect(created, isNull);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains("Couldn't fork this session."),
      );
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNot(contains('Fork blocked')),
      );
      expect(fakeBrokerClient.forkSessionCount, 1);
    });

    test('cloneSession surfaces broker errors in action state', () async {
      fakeBrokerClient.cloneError = const BrokerException(
        message: 'Clone blocked',
        statusCode: 500,
      );
      keepSessionDetailAlive(container, key);
      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      final created = await container
          .read(sessionDetailControllerProvider(key).notifier)
          .cloneSession();

      expect(created, isNull);
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        contains("Couldn't clone this session."),
      );
      expect(
        container.read(sessionDetailControllerProvider(key)).error,
        isNot(contains('Clone blocked')),
      );
      expect(fakeBrokerClient.cloneSessionCount, 1);
    });

    test('records typed wire events in arrival order', () async {
      keepSessionDetailAlive(container, key);

      await container
          .read(sessionDetailControllerProvider(key).notifier)
          .attach();

      fakeConnection
        ..emitEvent(
          const NoticeWireEvent(message: 'attached'),
        )
        ..emitEvent(
          const HistoryWireEvent(
            messages: [
              AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message'},
              ),
            ],
            reset: true,
            cursor: 'cursor-1',
          ),
        );
      await Future<void>.delayed(Duration.zero);

      final state = container.read(sessionDetailControllerProvider(key));
      expect(state.events, hasLength(2));
      expect(state.eventSummaries, ['notice: attached', 'history: 1 message']);
    });

    test(
      'invokes notification hook for actionable live events and ignores replay/history',
      () async {
        final localConnection = FakeSessionDetailConnection();
        final fakeSink = CollectingNotificationSink();
        final localContainer = buildControllerContainerWithNotificationHooks(
          key: key,
          connection: localConnection,
          picker: FakeControllerAttachmentPicker(),
          sink: fakeSink,
        );
        addTearDown(localContainer.dispose);
        keepSessionDetailAlive(localContainer, key);

        await localContainer
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        localConnection
          ..emitEvent(
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {'type': 'permission-request'},
              ),
            ),
          )
          ..emitEvent(
            const MessageWireEvent(
              seq: 0,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {'type': 'permission-request'},
              ),
            ),
          )
          ..emitEvent(
            const MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output'},
              ),
            ),
          )
          ..emitEvent(
            const NoticeWireEvent(message: 'status update'),
          )
          ..emitEvent(
            const HistoryWireEvent(
              messages: [
                AgentMessage(
                  type: AgentMessageType.userMessage,
                  raw: {'type': 'user-message'},
                ),
              ],
              reset: true,
            ),
          );
        await Future<void>.delayed(Duration.zero);

        final state = localContainer.read(sessionDetailControllerProvider(key));
        expect(state.events, hasLength(5));
        expect(fakeSink.requests, hasLength(1));
        expect(
          fakeSink.requests.single.category,
          BrokerNotificationCategory.actionRequired,
        );
      },
    );

    test(
      'does not block event recording when notification sink throws',
      () async {
        final localConnection = FakeSessionDetailConnection();
        final failingSink = CollectingNotificationSink(
          shouldThrowOnShow: true,
        );
        final localContainer = buildControllerContainerWithNotificationHooks(
          key: key,
          connection: localConnection,
          picker: FakeControllerAttachmentPicker(),
          sink: failingSink,
        );
        addTearDown(localContainer.dispose);
        keepSessionDetailAlive(localContainer, key);

        await localContainer
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();

        localConnection.emitEvent(
          const MessageWireEvent(
            seq: 3,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {'type': 'permission-request'},
            ),
          ),
        );
        await Future<void>.delayed(Duration.zero);

        final state = localContainer.read(sessionDetailControllerProvider(key));
        expect(state.events, hasLength(1));
        expect(state.eventSummaries, ['message: permission-request']);
        expect(failingSink.requests, hasLength(1));
        expect(
          failingSink.requests.single.title,
          'Session requires your response',
        );
      },
    );

    test(
      'suppresses legacy live notifications while durable feed delivery is '
      'active',
      () async {
        final localConnection = FakeSessionDetailConnection();
        final fakeSink = CollectingNotificationSink();
        final localContainer = buildControllerContainerWithNotificationHooks(
          key: key,
          connection: localConnection,
          picker: FakeControllerAttachmentPicker(),
          sink: fakeSink,
        );
        addTearDown(localContainer.dispose);
        localContainer
            .read(attentionFeedDeliveryActiveProvider.notifier)
            .state = const {
          'local',
        };
        keepSessionDetailAlive(localContainer, key);

        await localContainer
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        localConnection.emitEvent(
          const MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {'type': 'permission-request'},
            ),
          ),
        );
        await Future<void>.delayed(Duration.zero);

        expect(
          localContainer.read(sessionDetailControllerProvider(key)).events,
          hasLength(1),
        );
        expect(fakeSink.requests, isEmpty);
      },
    );
  });
}
