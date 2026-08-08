import 'dart:async';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// DR1 controller-level draft durability, reconciliation, and outbox handoff.
///
/// The harness backs providers with a real in-memory Drift database, so these
/// tests exercise the actual durable rows — the same code paths a web refresh
/// or a native process reopen takes.
void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  const versionedBroker = BrokerContractIdentity(
    revision: 3,
    minimumClientRevision: 2,
    surfaceHash: 'fnv1a32:abcdef12',
  );
  const legacyBroker = BrokerContractIdentity(
    revision: 2,
    minimumClientRevision: 2,
    surfaceHash: 'fnv1a32:abcdef12',
  );

  late FakeSessionDetailConnection connection;
  late ProviderContainer container;
  late AppDatabase database;
  late DriftSessionDraftRepository drafts;

  /// Set by the profile-switch test: a profile switch disposes the previous
  /// socket, so the next attach must be handed a fresh one.
  FakeSessionDetailConnection? secondConnection;

  setUp(() {
    connection = FakeSessionDetailConnection();
    secondConnection = null;
    container = buildControllerContainer(
      key,
      connection,
      FakeControllerAttachmentPicker(),
      nextConnection: () => secondConnection ?? connection,
    );
    addTearDown(container.dispose);
    database = container.read(appDatabaseProvider);
    drafts = DriftSessionDraftRepository(database);
  });

  Future<void> emitHello({BrokerContractIdentity contract = versionedBroker}) {
    connection.emitEvent(
      HelloWireEvent(
        brokerVersion: '1.4.0',
        brokerContract: contract,
        compatibility: BrokerClientCompatibility(
          status: BrokerClientCompatibilityStatus.compatible,
          readOnly: false,
          reason: 'compatible',
          broker: contract,
        ),
      ),
    );
    return drainSessionDetailMicrotasks();
  }

  Future<void> grantPromptAuthority() async {
    connection.emitSessionControl(const {
      'drive': {'state': 'driving', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    });
    await drainSessionDetailMicrotasks();
  }

  Future<void> attachConnected() async {
    keepSessionDetailAlive(container, key);
    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await grantPromptAuthority();
    await emitHello();
    await drainSessionDetailMicrotasks();
  }

  /// Connects WITHOUT the hello frame, so the broker's draft capability is
  /// still unnegotiated — the cold-reconnect window.
  Future<void> attachAwaitingHello() async {
    keepSessionDetailAlive(container, key);
    await container
        .read(sessionDetailControllerProvider(key).notifier)
        .attach();
    await grantPromptAuthority();
    await drainSessionDetailMicrotasks();
  }

  SessionDetailController controller() =>
      container.read(sessionDetailControllerProvider(key).notifier);

  SessionDetailState detailState() =>
      container.read(sessionDetailControllerProvider(key));

  Future<void> seedDraft(SessionLocalDraft draft) => drafts.save(draft);

  SessionLocalDraft dirtyDraft(
    String text, {
    int baseBrokerRevision = 0,
    DateTime? updatedAt,
  }) {
    return SessionLocalDraft(
      brokerProfileId: fakeControllerBrokerScope(),
      sessionKey: key,
      text: text,
      localRevision: 1,
      baseBrokerRevision: baseBrokerRevision,
      dirty: true,
      updatedAt: updatedAt ?? DateTime.now(),
    );
  }

  Future<void> exerciseMountedWindowConflictChoice({
    required bool chooseInFirstWindow,
    required bool keepLocal,
  }) async {
    final sharedDatabase = AppDatabase(NativeDatabase.memory());
    addTearDown(sharedDatabase.close);
    final firstRepository = DriftSessionDraftRepository(sharedDatabase);
    final secondRepository = DriftSessionDraftRepository(sharedDatabase);
    final firstSocket = FakeSessionDetailConnection();
    final secondSocket = FakeSessionDetailConnection();
    final firstWindow = buildControllerContainer(
      key,
      firstSocket,
      FakeControllerAttachmentPicker(),
      draftRepository: firstRepository,
      appDatabase: sharedDatabase,
      enableCrossWindowDraftObservation: true,
    );
    final secondWindow = buildControllerContainer(
      key,
      secondSocket,
      FakeControllerAttachmentPicker(),
      draftRepository: secondRepository,
      appDatabase: sharedDatabase,
      enableCrossWindowDraftObservation: true,
    );
    addTearDown(firstWindow.dispose);
    addTearDown(secondWindow.dispose);
    keepSessionDetailAlive(firstWindow, key);
    keepSessionDetailAlive(secondWindow, key);

    final first = firstWindow.read(
      sessionDetailControllerProvider(key).notifier,
    );
    final second = secondWindow.read(
      sessionDetailControllerProvider(key).notifier,
    );
    await first.attach();
    await second.attach();
    firstSocket.emitEvent(defaultControllerHello);
    secondSocket.emitEvent(defaultControllerHello);
    await drainSessionDetailMicrotasks();

    // Both mounted composers contain distinct text before either debounce
    // commits. The first write wakes the second window's row observer, whose
    // staged value wins the CAS and preserves the first as conflictText.
    first.stageLocalDraft('first window text');
    second.stageLocalDraft('second window text');
    await first.recordLocalDraft('first window text');
    for (var i = 0; i < 12; i++) {
      await drainSessionDetailMicrotasks();
    }

    final firstConflict = firstWindow
        .read(sessionDetailControllerProvider(key))
        .draftConflict;
    final secondConflict = secondWindow
        .read(sessionDetailControllerProvider(key))
        .draftConflict;
    expect(firstConflict?.localText, 'first window text');
    expect(firstConflict?.sharedText, 'second window text');
    expect(secondConflict?.localText, 'second window text');
    expect(secondConflict?.sharedText, 'first window text');

    final actor = chooseInFirstWindow ? first : second;
    // Stop the other unresolved composer from immediately reasserting its own
    // staged side after this choice. The assertions above prove both mounted
    // perspectives; the remainder isolates the selected window's action.
    if (chooseInFirstWindow) {
      secondWindow.dispose();
    } else {
      firstWindow.dispose();
    }
    if (keepLocal) {
      await actor.resolveDraftConflictKeepLocal();
    } else {
      await actor.resolveDraftConflictUseShared();
    }
    for (var i = 0; i < 8; i++) {
      await drainSessionDetailMicrotasks();
    }

    final chosenLocal = chooseInFirstWindow
        ? 'first window text'
        : 'second window text';
    final chosenOther = chooseInFirstWindow
        ? 'second window text'
        : 'first window text';
    final row = await firstRepository.load(
      brokerProfileId: fakeControllerBrokerScope(),
      sessionKey: key,
    );
    expect(row?.text, keepLocal ? chosenLocal : chosenOther);
    expect(row?.conflictText, isNull);
  }

  // Every draft-row write is a read-modify-write over a cached row, and the
  // cache is replaced only once the database resolves. These hold one operation
  // open and land another inside that window.
  group('concurrent durable mutations cannot clobber each other', () {
    late _HoldableDraftRepository holdable;
    late FakeSessionDetailConnection socket;
    late ProviderContainer scope;
    late AppDatabase scopedDatabase;
    FakeSessionDetailConnection? nextSocket;

    setUp(() {
      holdable = _HoldableDraftRepository();
      socket = FakeSessionDetailConnection();
      nextSocket = null;
      scope = buildControllerContainer(
        key,
        socket,
        FakeControllerAttachmentPicker(),
        draftRepository: holdable,
        nextConnection: () => nextSocket ?? socket,
      );
      addTearDown(scope.dispose);
      scopedDatabase = scope.read(appDatabaseProvider);
      holdable.inner = DriftSessionDraftRepository(scopedDatabase);
    });

    SessionDetailController scoped() =>
        scope.read(sessionDetailControllerProvider(key).notifier);

    Future<void> connect() async {
      keepSessionDetailAlive(scope, key);
      await scoped().attach();
      socket.emitEvent(defaultControllerHello);
      await drainSessionDetailMicrotasks();
    }

    Future<void> drive() async {
      socket.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await drainSessionDetailMicrotasks();
    }

    test('a replay load resolving late cannot desync the cache', () async {
      // Nothing is cached yet: the hydration load fails, which is the state a
      // replay-time load actually has to fill.
      holdable.failNextLoad = true;
      final outbox = scope.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-replay',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'sent before the crash'},
        ),
      );
      await outbox.markSending('cm-replay');
      await connect();

      // The replay's load is held open after reading the database, so it
      // carries a pre-write answer. Outside the serialized chain that answer
      // lands after the edit below and reinstates "no row" over a row that
      // exists — every later edit then rebuilds from a phantom empty state.
      final held = holdable.holdNextLoad();
      unawaited(drive());
      await drainSessionDetailMicrotasks();
      final edit = scoped().recordLocalDraft('typed while the load was open');
      await drainSessionDetailMicrotasks();
      held.complete();
      await edit;
      await drainSessionDetailMicrotasks();

      await scoped().recordLocalDraft('typed once more');
      await drainSessionDetailMicrotasks();

      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'typed once more');
      expect(
        row.localRevision,
        2,
        reason: 'the second edit must build on the first, not on a phantom',
      );
    });

    /// Moves the container to a second broker profile and attaches there.
    Future<FakeSessionDetailConnection> switchProfile() async {
      final next = FakeSessionDetailConnection();
      nextSocket = next;
      scope.read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
        id: 'other-profile',
        displayName: 'other',
        baseUri: Uri.parse('http://127.0.0.1:7999'),
        createdAt: DateTime(2026, 6, 26),
      );
      await scoped().attach();
      next.emitEvent(defaultControllerHello);
      await drainSessionDetailMicrotasks();
      return next;
    }

    test('a save resolving after a profile switch has no effects', () async {
      await connect();
      await scoped().recordLocalDraft('profile one text');
      await drainSessionDetailMicrotasks();

      // A write for this profile is still open when the controller moves to a
      // different broker profile.
      final held = holdable.holdNextSave();
      final pending = scoped().recordLocalDraft('written during the switch');
      await drainSessionDetailMicrotasks();

      final next = await switchProfile();
      final surfaceBefore = scope
          .read(sessionDetailControllerProvider(key))
          .draftSurface
          ?.token;
      held.complete();
      await pending;
      await drainSessionDetailMicrotasks();

      // Not just the cache: the rest of that mutation must not run either, or
      // one profile's unsent text is relayed over another profile's socket.
      expect(scoped().cachedLocalDraft, isNull);
      expect(
        next.sendDraftCount,
        0,
        reason: "the old profile's text must not publish to the new broker",
      );
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftSurface?.token,
        surfaceBefore,
      );
      expect(
        await holdable.load(
          brokerProfileId: 'other-profile',
          sessionKey: key,
        ),
        isNull,
        reason: 'nothing was written under the new profile',
      );
    });

    test('a draft frame queued across a profile switch is dropped', () async {
      await connect();

      // The frame is accepted by the old socket, then waits in the chain behind
      // a held write while the controller moves to another broker.
      final held = holdable.holdNextSave();
      final pending = scoped().recordLocalDraft('profile one text');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        const DraftWireEvent(
          text: 'from the old broker',
          at: 1,
          revision: 9,
          updateId: 'old-broker-update',
        ),
      );
      await drainSessionDetailMicrotasks();

      await switchProfile();
      held.complete();
      await pending;
      await drainSessionDetailMicrotasks();

      // Applying it now would show one broker's shared draft under another.
      expect(scoped().cachedLocalDraft, isNull);
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftSurface?.text,
        isNot('from the old broker'),
      );
      expect(
        await holdable.load(
          brokerProfileId: 'other-profile',
          sessionKey: key,
        ),
        isNull,
      );
    });

    test('an edit refused twice publishes nothing and keeps the row', () async {
      await connect();
      await scoped().recordLocalDraft('first value');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        DraftWireEvent(
          text: 'first value',
          at: 1,
          revision: 1,
          updateId: socket.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      final publishesBefore = socket.sendDraftCount;

      // Both the write and its bounded retry lose to a concurrent writer. The
      // value was never stored, so relaying it would publish text neither
      // durable copy holds — and mark it clean against nothing.
      holdable.refuseNextSaves = 2;
      final published = await scoped().recordLocalDraft('second value');
      await drainSessionDetailMicrotasks();

      expect(published, isFalse);
      expect(
        socket.sendDraftCount,
        publishesBefore,
        reason: 'an unstored value must never publish',
      );
      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'first value');
      expect(
        scoped().cachedLocalDraft?.text,
        'first value',
        reason: 'the cache follows the surviving row, not the lost value',
      );
    });

    test('a durability flush reports repository refusal distinctly', () async {
      await connect();
      holdable.refuseNextSaves = 2;

      final result = await scoped().flushLocalDraft('must survive navigation');

      expect(result, SessionDraftPersistenceResult.failed);
      expect(socket.sendDraftCount, 0);
      expect(
        await holdable.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        ),
        isNull,
      );
    });

    test('a binding refused twice dispatches no prompt', () async {
      await connect();
      await drive();
      await scoped().recordLocalDraft('device A prompt');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        DraftWireEvent(
          text: 'device A prompt',
          at: 1,
          revision: 1,
          updateId: socket.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // The refusals begin inside the outbox insert, so the pre-send flush is
      // unaffected and only the binding's conditional write loses.
      (scope.read(sessionOutboxRepositoryProvider)
              as RecordingSessionOutboxRepository)
          .onUpsert = () async {
        holdable.refuseNextSaves = 2;
      };
      socket.sendPromptCount = 0;
      final sent = await scoped().sendPrompt('device A prompt');
      await drainSessionDetailMicrotasks();

      expect(sent, isFalse);
      expect(
        socket.sendPromptCount,
        0,
        reason: 'a binding that never became durable must not dispatch',
      );
      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.submittedClientMessageId, isNull);
      final queued =
          (await scope
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single;
      expect(
        queued.isRetryableAt(DateTime.now()),
        isTrue,
        reason: 'the undispatched prompt stays replayable',
      );
    });

    test('a refused pending clear leaves the prompt undelivered', () async {
      await connect();
      await drive();
      await scoped().recordLocalDraft('prompt with failing clear');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        DraftWireEvent(
          text: 'prompt with failing clear',
          at: 1,
          revision: 1,
          updateId: socket.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      await scoped().sendPrompt('prompt with failing clear');
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await scope
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;

      // The broker's failed-clear answer arrives, but the durable pending
      // clear cannot be written. Marking the prompt delivered anyway would
      // reconcile the draft away on reopen and drop the clear's retry.
      holdable.refuseNextSaves = 2;
      socket.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
          draftCleared: false,
          draftRevision: 1,
        ),
      );
      await drainSessionDetailMicrotasks();

      final outboxRow =
          (await scope
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single;
      expect(
        outboxRow.status,
        isNot(SessionOutboxMessageStatus.delivered),
        reason: 'the receipt is only consumed once its draft half is durable',
      );
      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(
        row!.submittedClientMessageId,
        clientMessageId,
        reason: 'the association survives so the replayed receipt can retry',
      );
    });

    test('a refused resolution neither dismisses nor publishes', () async {
      await holdable.inner.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'my local text',
          localRevision: 3,
          baseBrokerRevision: 2,
          dirty: false,
          conflictText: 'their shared text',
          conflictBrokerRevision: 5,
          updatedAt: DateTime.now(),
        ),
      );
      await connect();
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftConflict,
        isNotNull,
      );
      final publishesBefore = socket.sendDraftCount;

      holdable.refuseNextSaves = 2;
      await scoped().resolveDraftConflictKeepLocal();
      await drainSessionDetailMicrotasks();

      // The choice never became durable, so every dependent effect must stay
      // unrun: the banner still offers the choice, nothing was published over
      // the preserved revision, and the row still holds both versions.
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftConflict,
        isNotNull,
        reason: 'an unstored resolution must not dismiss the banner',
      );
      expect(socket.sendDraftCount, publishesBefore);
      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.conflictText, 'their shared text');
      expect(row.dirty, isFalse);
    });

    test('failed-send recovery crossing a switch mutates nothing', () async {
      await connect();
      final outbox =
          scope.read(sessionOutboxRepositoryProvider)
              as RecordingSessionOutboxRepository;
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-failed',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'prompt that failed'},
        ),
      );

      // The nack's recovery is mid-await on the old profile's outbox when the
      // controller moves to another broker. Everything after that await —
      // the row write, the composer surface, the conflict banner — belongs to
      // the profile that no longer exists here.
      final gate = Completer<void>();
      outbox.onLoadForSession = () {
        outbox.onLoadForSession = null;
        return gate.future;
      };
      socket.emitEvent(
        const NackWireEvent(
          code: 'CLIENT_MESSAGE_FAILED',
          message: 'failed',
          clientMessageId: 'cm-failed',
        ),
      );
      await drainSessionDetailMicrotasks();

      final next = await switchProfile();
      final surfaceBefore = scope
          .read(sessionDetailControllerProvider(key))
          .draftSurface
          ?.token;
      gate.complete();
      await drainSessionDetailMicrotasks();
      await drainSessionDetailMicrotasks();

      expect(scoped().cachedLocalDraft, isNull);
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftSurface?.token,
        surfaceBefore,
        reason: "the old profile's failed prompt must not surface here",
      );
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftConflict,
        isNull,
      );
      expect(
        await holdable.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        ),
        isNull,
        reason: 'the aborted recovery wrote nothing, under either profile',
      );
      expect(
        await holdable.load(brokerProfileId: 'other-profile', sessionKey: key),
        isNull,
      );
      expect(next.sendDraftCount, 0);
    });

    test('a receipt whose scope died never marks delivered', () async {
      await connect();
      await drive();
      await scoped().recordLocalDraft('prompt with failing clear');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        DraftWireEvent(
          text: 'prompt with failing clear',
          at: 1,
          revision: 1,
          updateId: socket.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      await scoped().sendPrompt('prompt with failing clear');
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await scope
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;

      // The failed-clear receipt queues behind a held write, and the profile
      // moves on before it runs. Its pending clear was never persisted, so
      // marking the prompt delivered would reconcile the draft away on reopen
      // and silently drop the retry the failed clear created.
      final held = holdable.holdNextSave();
      final blocker = scoped().recordLocalDraft('edit occupying the chain');
      await drainSessionDetailMicrotasks();
      socket.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
          draftCleared: false,
          draftRevision: 1,
        ),
      );
      await drainSessionDetailMicrotasks();
      await switchProfile();
      held.complete();
      await blocker;
      await drainSessionDetailMicrotasks();

      final outboxRow =
          (await scope
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single;
      expect(
        outboxRow.status,
        isNot(SessionOutboxMessageStatus.delivered),
        reason: 'the receipt stays consumable for the idempotent replay',
      );
    });

    test(
      'a pending-clear publish crossing a switch stays unconsumed',
      () async {
        await connect();
        await drive();
        await scoped().recordLocalDraft('prompt with failing clear');
        await drainSessionDetailMicrotasks();
        socket.emitEvent(
          DraftWireEvent(
            text: 'prompt with failing clear',
            at: 1,
            revision: 1,
            updateId: socket.lastDraftUpdateId,
          ),
        );
        await drainSessionDetailMicrotasks();
        await scoped().sendPrompt('prompt with failing clear');
        await drainSessionDetailMicrotasks();
        final clientMessageId =
            (await scope
                    .read(sessionOutboxRepositoryProvider)
                    .loadForSession(
                      key,
                      brokerProfileId: fakeControllerBrokerScope(),
                    ))
                .single
                .clientMessageId;

        // The pending clear is durably persisted, but its publish frame is
        // still in flight when the profile moves on. The receipt must not be
        // consumed by a scope that no longer exists — the broker's idempotent
        // replay re-produces it for the profile's next attach, where the row's
        // cleared association answers it.
        final held = socket.holdNextSendDraft();
        socket.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: clientMessageId,
            draftCleared: false,
            draftRevision: 1,
          ),
        );
        await drainSessionDetailMicrotasks();
        await switchProfile();
        held.complete();
        await drainSessionDetailMicrotasks();

        final outboxRow =
            (await scope
                    .read(sessionOutboxRepositoryProvider)
                    .loadForSession(
                      key,
                      brokerProfileId: fakeControllerBrokerScope(),
                    ))
                .single;
        expect(outboxRow.status, isNot(SessionOutboxMessageStatus.delivered));
      },
    );

    test(
      'an exhausted resolution re-projects the surviving conflict',
      () async {
        await holdable.inner.save(
          SessionLocalDraft(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
            text: 'my local text',
            localRevision: 3,
            baseBrokerRevision: 2,
            dirty: false,
            conflictText: 'old shared version',
            conflictBrokerRevision: 5,
            updatedAt: DateTime.now(),
          ),
        );
        await connect();
        expect(
          scope
              .read(sessionDetailControllerProvider(key))
              .draftConflict
              ?.sharedText,
          'old shared version',
        );

        // Another writer replaces the preserved second version while the banner
        // is up; this controller's cache still projects the old one.
        final current = await holdable.inner.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        await holdable.inner.save(
          current!.copyWith(
            conflictText: 'newer shared version',
            conflictBrokerRevision: 6,
            updatedAt: DateTime.now(),
          ),
        );

        holdable.refuseNextSaves = 2;
        await scoped().resolveDraftConflictKeepLocal();
        await drainSessionDetailMicrotasks();

        // The exhausted retry reloaded the surviving row; a banner still
        // showing the OLD preserved text would resolve values the user was
        // never shown.
        final banner = scope
            .read(sessionDetailControllerProvider(key))
            .draftConflict;
        expect(banner, isNotNull);
        expect(banner!.sharedText, 'newer shared version');
        expect(banner.sharedRevision, 6);
      },
    );

    test('a failed load never rebuilds over a migrated row', () async {
      // A row migrated from schema 13/14 still sits at mutation_version 0 —
      // the same version a fresh create carries — and preserves a second
      // draft version.
      await scopedDatabase
          .into(scopedDatabase.sessionDraftRows)
          .insert(
            SessionDraftRowsCompanion.insert(
              brokerProfileId: fakeControllerBrokerScope(),
              tool: key.tool,
              sessionId: key.sessionId,
              draftText: 'independent unsent text',
              localRevision: const Value(4),
              baseBrokerRevision: const Value(2),
              dirty: const Value(true),
              mutationVersion: const Value(0),
              conflictText: const Value('preserved second version'),
              conflictBrokerRevision: const Value(7),
              updatedAt: DateTime.now(),
            ),
          );
      // Hydration's load fails, so nothing is cached for this profile.
      holdable.failNextLoad = true;
      await connect();
      final outbox =
          scope.read(sessionOutboxRepositoryProvider)
              as RecordingSessionOutboxRepository;
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-nacked',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'failed prompt'},
        ),
      );

      // The recovery's own load fails too. Proceeding with the empty cache
      // would rebuild from "no row" at version 0 — which the migrated row
      // still matches — and blind-overwrite everything it preserves.
      holdable.failNextLoad = true;
      socket.emitEvent(
        const NackWireEvent(
          code: 'CLIENT_MESSAGE_FAILED',
          message: 'failed',
          clientMessageId: 'cm-nacked',
        ),
      );
      await drainSessionDetailMicrotasks();
      await drainSessionDetailMicrotasks();

      final row = await holdable.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'independent unsent text');
      expect(row.conflictText, 'preserved second version');
      expect(row.submittedClientMessageId, isNull);
    });

    test('a maintenance restore reaches the live controller', () async {
      await connect();
      await drive();

      // An abandoned prompt, old enough that the bounded maintenance pass
      // expires it and restores its text as a draft — a write the controller's
      // own serialized chain knows nothing about.
      final stale = DateTime.now().subtract(const Duration(minutes: 5));
      await scopedDatabase
          .into(scopedDatabase.sessionOutboxRows)
          .insert(
            SessionOutboxRowsCompanion.insert(
              clientMessageId: 'cm-abandoned',
              brokerProfileId: Value(fakeControllerBrokerScope()),
              tool: key.tool,
              sessionId: key.sessionId,
              kind: SessionOutboxMessageKind.prompt.name,
              payloadJson: '{"text":"abandoned prompt text"}',
              status: SessionOutboxMessageStatus.sending.name,
              createdAt: stale,
              updatedAt: stale,
            ),
          );

      // Any terminal receipt triggers a pass.
      socket.emitEvent(
        const NackWireEvent(
          code: 'CLIENT_MESSAGE_FAILED',
          message: 'failed',
          clientMessageId: 'cm-unrelated',
        ),
      );
      for (var i = 0; i < 6; i++) {
        await drainSessionDetailMicrotasks();
      }

      // The controller must drop its stale cache and offer the recovered text:
      // a banner nobody is told about is text nobody can recover.
      expect(scoped().cachedLocalDraft?.text, 'abandoned prompt text');
      expect(
        scope.read(sessionDetailControllerProvider(key)).draftSurface?.text,
        'abandoned prompt text',
      );
    });
  });

  test('a lost edit race preserves the other tab, never overwrites', () async {
    // Two REAL database connections over one file — the multi-tab shape: no
    // shared cache, no shared mutation chain, no shared transaction. Tab A is
    // a full controller; tab B is its repository-level equivalent.
    final directory = await Directory.systemTemp.createTemp('dr1-two-ctrl');
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/client.sqlite');
    final tabADatabase = AppDatabase(NativeDatabase(file));
    addTearDown(tabADatabase.close);
    await tabADatabase.customSelect('SELECT 1').get();
    final tabBDatabase = AppDatabase(NativeDatabase(file));
    addTearDown(tabBDatabase.close);
    await tabBDatabase.customSelect('SELECT 1').get();
    final tabB = DriftSessionDraftRepository(tabBDatabase);

    final tabAScope = buildControllerContainer(
      key,
      FakeSessionDetailConnection(),
      FakeControllerAttachmentPicker(),
      draftRepository: DriftSessionDraftRepository(tabADatabase),
    );
    addTearDown(tabAScope.dispose);
    keepSessionDetailAlive(tabAScope, key);
    final tabA = tabAScope.read(sessionDetailControllerProvider(key).notifier);

    // Both tabs edit offline. Tab B replaces tab A's stored value; tab A
    // keeps typing against its now-stale cache.
    await tabA.recordLocalDraft('typed in tab A');
    await drainSessionDetailMicrotasks();
    final theirs = await tabB.load(
      brokerProfileId: fakeControllerBrokerScope(),
      sessionKey: key,
    );
    await tabB.save(
      theirs!.copyWith(
        text: 'typed in tab B',
        localRevision: theirs.localRevision + 1,
        updatedAt: DateTime.now(),
      ),
    );

    await tabA.recordLocalDraft('tab A keeps typing');
    await drainSessionDetailMicrotasks();

    // CAS admitted tab A's retry — but admission is not permission to
    // discard: tab B's value must survive as the preserved second version.
    final merged = await tabB.load(
      brokerProfileId: fakeControllerBrokerScope(),
      sessionKey: key,
    );
    expect(merged!.text, 'tab A keeps typing');
    expect(
      merged.conflictText,
      'typed in tab B',
      reason: "the losing retry carries the other tab's value forward",
    );
    expect(merged.conflictBrokerRevision, isNull);
    final banner = tabAScope
        .read(sessionDetailControllerProvider(key))
        .draftConflict;
    expect(banner, isNotNull);
    expect(banner!.localText, 'tab A keeps typing');
    expect(banner.sharedText, 'typed in tab B');
  });

  group('two mounted windows retain conflict perspective', () {
    for (final firstWindow in [true, false]) {
      for (final keepLocal in [true, false]) {
        test(
          '${firstWindow ? 'first' : 'second'} window '
          '${keepLocal ? 'keeps local' : 'uses shared'}',
          () => exerciseMountedWindowConflictChoice(
            chooseInFirstWindow: firstWindow,
            keepLocal: keepLocal,
          ),
        );
      }
    }
  });

  group('offline durability and reconnect retry', () {
    test(
      'an offline edit is persisted dirty without any broker relay',
      () async {
        await attachConnected();
        connection.emitState(SessionDetailConnectionStatus.reconnecting);
        await drainSessionDetailMicrotasks();

        await controller().recordLocalDraft('offline sentence');
        expect(connection.sendDraftCount, 0);

        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row, isNotNull);
        expect(row!.text, 'offline sentence');
        expect(row.dirty, isTrue);
      },
    );

    test(
      'reconnect republishes one dirty draft without another keystroke',
      () async {
        await seedDraft(
          dirtyDraft('typed while offline', baseBrokerRevision: 4),
        );

        await attachConnected();

        expect(connection.sendDraftCount, 1);
        expect(connection.lastDraft, 'typed while offline');
        expect(connection.lastDraftUpdateId, isNotNull);
        expect(connection.lastDraftBaseRevision, 4);
      },
    );

    test('the local draft row survives a full database reopen', () async {
      await seedDraft(dirtyDraft('persist me'));

      // Simulate process death / page refresh: a brand-new repository over a
      // reopened database sees the same row. (The in-memory database plays the
      // role of the durable file here; reopen is covered by the migration
      // test's file-backed database.)
      final reopened = DriftSessionDraftRepository(database);
      final row = await reopened.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row?.text, 'persist me');
      expect(row?.dirty, isTrue);
    });

    test(
      'hydration surfaces the durable local value once per attach',
      () async {
        await seedDraft(dirtyDraft('recovered draft'));

        await attachConnected();

        final surface = detailState().draftSurface;
        expect(surface, isNotNull);
        expect(surface!.text, 'recovered draft');
        expect(surface.kind, SessionDraftSurfaceKind.replace);
      },
    );
  });

  group('contract negotiation gates publishing', () {
    test(
      'observing stages durably and publishes only after control gain',
      () async {
        await attachConnected();
        connection.emitSessionControl(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        });
        await drainSessionDetailMicrotasks();

        await controller().recordLocalDraft('local observing text');
        expect(connection.sendDraftCount, 0);
        expect(
          (await drafts.load(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
          ))?.text,
          'local observing text',
        );

        await grantPromptAuthority();
        expect(connection.sendDraftCount, 1);
        expect(connection.lastDraft, 'local observing text');
      },
    );

    test(
      'a dirty draft is not relayed before the contract is negotiated',
      () async {
        await seedDraft(
          dirtyDraft('typed while offline', baseBrokerRevision: 4),
        );

        await attachAwaitingHello();

        // The capability is unknown here. Publishing now would take the legacy
        // unversioned path, whose last-writer-wins relay overwrites a newer
        // shared draft with no conflict detection at all.
        expect(connection.sendDraftCount, 0);
      },
    );

    test('the hello frame releases the deferred publish', () async {
      await seedDraft(dirtyDraft('typed while offline', baseBrokerRevision: 4));
      await attachAwaitingHello();
      expect(connection.sendDraftCount, 0);

      await emitHello();

      // No further keystroke was needed.
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, 'typed while offline');
      expect(connection.lastDraftBaseRevision, 4);
      expect(connection.lastDraftUpdateId, isNotNull);
    });

    test('an edit typed before hello is held, then published', () async {
      await attachAwaitingHello();
      await controller().recordLocalDraft('typed during the handshake');
      await drainSessionDetailMicrotasks();
      expect(connection.sendDraftCount, 0);

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'typed during the handshake'); // durable regardless
      expect(row.dirty, isTrue);

      await emitHello();
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraftUpdateId, isNotNull);
    });
  });

  group('negotiated capability is per connection', () {
    const legacyOnlyBroker = BrokerContractIdentity(
      revision: 2,
      minimumClientRevision: 2,
      surfaceHash: 'fnv1a32:abcdef12',
    );

    test('a plain socket reconnect re-negotiates before publishing', () async {
      // Revision 3 is negotiated on the first connect.
      await attachConnected();
      await controller().recordLocalDraft('typed on the new broker');
      await drainSessionDetailMicrotasks();
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraftUpdateId, isNotNull);

      // The socket drops and comes back — same profile, but the broker on the
      // other end may have been rolled back or replaced in between.
      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await drainSessionDetailMicrotasks();
      connection
        ..sendDraftCount = 0
        ..emitState(SessionDetailConnectionStatus.connected);
      await drainSessionDetailMicrotasks();

      // The previous socket's answer must not authorize this one's publish.
      expect(connection.sendDraftCount, 0);

      await grantPromptAuthority();
      connection.emitEvent(
        const HelloWireEvent(
          brokerVersion: '1.3.0',
          brokerContract: legacyBroker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.compatible,
            readOnly: false,
            reason: 'compatible',
            broker: legacyBroker,
          ),
        ),
      );
      await drainSessionDetailMicrotasks();

      // The rolled-back broker gets exactly one unversioned relay.
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, 'typed on the new broker');
      expect(connection.lastDraftUpdateId, isNull);
      expect(connection.lastDraftBaseRevision, isNull);
    });

    test('switching to an older broker re-negotiates first', () async {
      // A dirty row waiting under the SECOND profile, which is an older broker.
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: RosterSource(
            profileId: 'legacy-profile',
            endpoint: RosterSource.normalizedBrokerEndpoint(
              Uri.parse('http://127.0.0.1:7735'),
            ),
          ).storageKey,
          sessionKey: key,
          text: 'dirty on the older broker',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: true,
          updatedAt: DateTime.now(),
        ),
      );

      // Attach to the revision-3 broker first, so capability is known.
      await attachConnected();
      await controller().recordLocalDraft('first broker');
      await drainSessionDetailMicrotasks();
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraftUpdateId, isNotNull);

      // Now genuinely switch brokers and re-attach. Inheriting the revision-3
      // answer here would publish versioned tokens to a broker that applies
      // them as legacy last-writer-wins — the overwrite the gate prevents.
      final legacyConnection = FakeSessionDetailConnection();
      secondConnection = legacyConnection;
      container
          .read(activeBrokerProfileProvider.notifier)
          .state = BrokerProfile(
        id: 'legacy-profile',
        displayName: 'legacy',
        baseUri: Uri.parse('http://127.0.0.1:7735'),
        createdAt: DateTime(2026, 6, 26),
      );
      await controller().attach();
      await drainSessionDetailMicrotasks();

      expect(legacyConnection.sendDraftCount, 0);

      // The revision-2 hello settles it: legacy relay, no version tokens.
      legacyConnection
        ..emitSessionControl(const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        })
        ..emitEvent(
          const HelloWireEvent(
            brokerVersion: '1.3.0',
            brokerContract: legacyOnlyBroker,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.compatible,
              readOnly: false,
              reason: 'compatible',
              broker: legacyOnlyBroker,
            ),
          ),
        );
      await drainSessionDetailMicrotasks();

      expect(legacyConnection.sendDraftCount, 1);
      expect(legacyConnection.lastDraft, 'dirty on the older broker');
      expect(legacyConnection.lastDraftUpdateId, isNull);
      expect(legacyConnection.lastDraftBaseRevision, isNull);
    });
  });

  group('publishing is acknowledgement-driven', () {
    test(
      'a trailing edit waits for the echo instead of racing a stale base',
      () async {
        await attachConnected();
        await controller().recordLocalDraft('first');
        await drainSessionDetailMicrotasks();
        expect(connection.sendDraftCount, 1);
        final firstUpdateId = connection.lastDraftUpdateId;
        expect(connection.lastDraftBaseRevision, 0);

        // A second edit lands while the first publish is still unacknowledged.
        // Sending it now would carry base 0 again — the broker has already
        // moved to revision 1, so it would be rejected as stale and the shared
        // copy would stay one edit behind forever.
        await controller().recordLocalDraft('first and second');
        await drainSessionDetailMicrotasks();
        expect(connection.sendDraftCount, 1);

        // The echo of the first publish settles it and releases the second on
        // the NEW base revision.
        connection.emitEvent(
          DraftWireEvent(
            text: 'first',
            at: 1,
            revision: 1,
            updateId: firstUpdateId,
          ),
        );
        await drainSessionDetailMicrotasks();

        expect(connection.sendDraftCount, 2);
        expect(connection.lastDraft, 'first and second');
        expect(connection.lastDraftBaseRevision, 1);
        expect(connection.lastDraftUpdateId, isNot(firstUpdateId));

        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row!.dirty, isTrue); // still unacknowledged, correctly
        expect(row.text, 'first and second');
      },
    );

    test(
      'a live typing race republishes on the advanced base revision',
      () async {
        await attachConnected();
        await controller().recordLocalDraft('local typing');
        await drainSessionDetailMicrotasks();
        final updateId = connection.lastDraftUpdateId;
        connection.emitEvent(
          DraftWireEvent(
            text: 'local typing',
            at: 1,
            revision: 1,
            updateId: updateId,
          ),
        );
        await drainSessionDetailMicrotasks();

        // Now type again, then have another client's frame arrive first.
        await controller().recordLocalDraft('local typing more');
        await drainSessionDetailMicrotasks();
        final beforeRace = connection.sendDraftCount;
        connection.emitEvent(
          const DraftWireEvent(text: 'other client', at: 2, revision: 2),
        );
        await drainSessionDetailMicrotasks();

        // Adopting revision 2 alone would leave the shared copy holding the
        // other client's text with this device's newer value never resent.
        expect(connection.sendDraftCount, greaterThan(beforeRace));
        expect(connection.lastDraft, 'local typing more');
        expect(connection.lastDraftBaseRevision, 2);
      },
    );

    test('a disconnect abandons the outstanding publish', () async {
      await attachConnected();
      await controller().recordLocalDraft('sent but never answered');
      await drainSessionDetailMicrotasks();
      expect(connection.sendDraftCount, 1);

      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await drainSessionDetailMicrotasks();
      connection.emitState(SessionDetailConnectionStatus.connected);
      await grantPromptAuthority();
      await emitHello();

      // The reconnect retry is not blocked by the publish the dead socket
      // could never acknowledge.
      expect(connection.sendDraftCount, 2);
      expect(connection.lastDraft, 'sent but never answered');
    });

    test('a throwing transport spends the bounded retry budget', () async {
      await attachConnected();

      // Every send throws — the socket is mid-close but the status stream has
      // not caught up. Settling on the throw must spend the same retry budget
      // as an acknowledgement timeout: an unchanged value republishing without
      // a bound is a microtask loop that starves the event loop, so the
      // disconnect that would break it can never be delivered.
      connection
        ..failNextSendDrafts = 100
        ..sendDraftCount = 0;
      await controller().recordLocalDraft('value the socket cannot carry');
      await drainSessionDetailMicrotasks();

      expect(
        connection.sendDraftCount,
        3, // the initial attempt plus _maxDraftPublishRetries
        reason:
            'an unchanged unacknowledged value retries a bounded number '
            'of times, never in an unbounded loop',
      );
      connection.failNextSendDrafts = 0;
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(
        row!.dirty,
        isTrue,
        reason: 'the row stays dirty so the next connect retries it',
      );
    });

    test('an unchanged clean lifecycle flush is a true no-op', () async {
      await attachConnected();
      await controller().recordLocalDraft('synced text');
      await drainSessionDetailMicrotasks();
      connection.emitEvent(
        DraftWireEvent(
          text: 'synced text',
          at: 1,
          revision: 1,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      final before = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(before!.dirty, isFalse);
      connection.sendDraftCount = 0;

      // Focus loss / route change / app hidden / pagehide / pre-Send all land
      // here with the same text. None of them may re-dirty a synchronized row
      // or spend a write and a relay on it.
      await controller().flushLocalDraft('synced text');
      await controller().flushLocalDraft('synced text');
      await drainSessionDetailMicrotasks();

      expect(connection.sendDraftCount, 0);
      final after = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(after!.dirty, isFalse);
      expect(after.localRevision, before.localRevision);
    });
  });

  group('clear tombstones', () {
    test('a clean local row adopts a replayed clear tombstone', () async {
      // The device was offline when another client cleared or sent the draft:
      // its clean row is at an older revision than the clear.
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'stale shared text',
          localRevision: 1,
          baseBrokerRevision: 2,
          dirty: false,
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();

      connection.emitEvent(const DraftWireEvent(text: '', at: 9, revision: 5));
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row, isNull); // the stale draft is gone, not redisplayed
      expect(detailState().draftSurface?.text, '');
      expect(
        detailState().draftSurface?.kind,
        SessionDraftSurfaceKind.replace,
      );
    });

    test('a tombstone older than the local base is ignored', () async {
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'current shared text',
          localRevision: 1,
          baseBrokerRevision: 7,
          dirty: false,
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();

      connection.emitEvent(const DraftWireEvent(text: '', at: 9, revision: 5));
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row?.text, 'current shared text');
    });
  });

  group('stale shared drafts never overwrite dirty local text', () {
    test('a shared frame at an older revision is ignored', () async {
      await attachConnected();
      await controller().recordLocalDraft('new local work');
      await drainSessionDetailMicrotasks();
      // The publish just happened; base is still 0 until the echo.
      connection.emitEvent(
        const DraftWireEvent(text: 'stale shared', at: 1, revision: 0),
      );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'new local work');
      expect(row.dirty, isTrue);
      expect(detailState().draftConflict, isNull);
    });

    test('own echo marks the row clean at the accepted revision', () async {
      await attachConnected();
      await controller().recordLocalDraft('sync me');
      await drainSessionDetailMicrotasks();
      final updateId = connection.lastDraftUpdateId;

      connection.emitEvent(
        DraftWireEvent(text: 'sync me', at: 2, revision: 7, updateId: updateId),
      );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.dirty, isFalse);
      expect(row.baseBrokerRevision, 7);
      expect(detailState().draftConflict, isNull);
    });

    test('a shared clear never conflicts with newer local text', () async {
      await attachConnected();
      await controller().recordLocalDraft('still typing');
      await drainSessionDetailMicrotasks();

      connection.emitEvent(
        const DraftWireEvent(text: '', at: 3, revision: 9),
      );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'still typing');
      expect(row.dirty, isTrue);
      expect(row.baseBrokerRevision, 9);
      expect(detailState().draftConflict, isNull);
    });
  });

  group('conflict preservation and resolution', () {
    test(
      'independent offline edits on both sides preserve both versions',
      () async {
        // A dirty row this device made while away (no recent edit timestamp,
        // so the live-typing guard does not apply).
        await seedDraft(
          dirtyDraft('device A offline edit', baseBrokerRevision: 3),
        );
        await attachConnected();
        connection
          ..sendDraftCount = 0
          ..emitEvent(
            const DraftWireEvent(
              text: 'device B shared edit',
              at: 4,
              revision: 4,
            ),
          );
        await drainSessionDetailMicrotasks();

        final conflict = detailState().draftConflict;
        expect(conflict, isNotNull);
        expect(conflict!.localText, 'device A offline edit');
        expect(conflict.sharedText, 'device B shared edit');
        expect(conflict.sharedRevision, 4);

        // Nothing was published or overwritten; both versions are durable.
        expect(connection.sendDraftCount, 0);
        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row!.text, 'device A offline edit');
        expect(row.conflictText, 'device B shared edit');
        expect(row.conflictBrokerRevision, 4);
      },
    );

    test('keep-local resolution publishes over the shared revision', () async {
      await seedDraft(
        dirtyDraft('device A offline edit', baseBrokerRevision: 3),
      );
      await attachConnected();
      connection.emitEvent(
        const DraftWireEvent(text: 'device B shared edit', at: 4, revision: 4),
      );
      await drainSessionDetailMicrotasks();
      connection.sendDraftCount = 0;

      await controller().resolveDraftConflictKeepLocal();
      await drainSessionDetailMicrotasks();

      expect(detailState().draftConflict, isNull);
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, 'device A offline edit');
      expect(connection.lastDraftBaseRevision, 4);

      var row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.dirty, isTrue); // dirty until the broker echo acknowledges
      // The other version stays DURABLE until the broker accepts this choice.
      // Discarding it on the socket write would lose device B's text if the app
      // died before the echo, with nothing left to re-offer on hydration.
      expect(row.conflictText, 'device B shared edit');

      connection.emitEvent(
        DraftWireEvent(
          text: 'device A offline edit',
          at: 5,
          revision: 5,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();

      row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.dirty, isFalse);
      expect(row.baseBrokerRevision, 5);
      expect(row.conflictText, isNull); // released only on acknowledgement
    });

    test('use-shared resolution adopts the shared text cleanly', () async {
      await seedDraft(
        dirtyDraft('device A offline edit', baseBrokerRevision: 3),
      );
      await attachConnected();
      connection.emitEvent(
        const DraftWireEvent(text: 'device B shared edit', at: 4, revision: 4),
      );
      await drainSessionDetailMicrotasks();

      await controller().resolveDraftConflictUseShared();
      await drainSessionDetailMicrotasks();

      expect(detailState().draftConflict, isNull);
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'device B shared edit');
      expect(row.dirty, isFalse);
      expect(row.baseBrokerRevision, 4);
      expect(row.conflictText, isNull);
      expect(detailState().draftSurface?.text, 'device B shared edit');
    });

    test(
      'a live two-client typing race is not surfaced as a conflict',
      () async {
        await attachConnected();
        await controller().recordLocalDraft('active typing');
        await drainSessionDetailMicrotasks();

        connection.emitEvent(
          const DraftWireEvent(text: 'other client typing', at: 5, revision: 2),
        );
        await drainSessionDetailMicrotasks();

        expect(detailState().draftConflict, isNull);
        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row!.text, 'active typing');
        expect(row.baseBrokerRevision, 2);
      },
    );
  });

  group('clean adoption and legacy behavior', () {
    test('a clean local state adopts a newer shared revision', () async {
      await attachConnected();
      connection.emitEvent(
        const DraftWireEvent(text: 'from another device', at: 6, revision: 2),
      );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'from another device');
      expect(row.dirty, isFalse);
      expect(row.baseBrokerRevision, 2);
      expect(detailState().draftSurface?.text, 'from another device');
    });

    test('a legacy broker keeps the unversioned relay contract', () async {
      await attachConnected();
      connection.emitEvent(
        const HelloWireEvent(
          brokerVersion: '1.3.0',
          brokerContract: legacyBroker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.compatible,
            readOnly: false,
            reason: 'compatible',
            broker: legacyBroker,
          ),
        ),
      );
      await drainSessionDetailMicrotasks();

      await controller().recordLocalDraft('legacy draft');
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraftUpdateId, isNull);
      expect(connection.lastDraftBaseRevision, isNull);

      // And the durable local row still exists offline-first.
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'legacy draft');
      expect(row.dirty, isTrue);
    });
  });

  group('send/outbox handoff', () {
    Future<void> emitDrivingControl() async {
      connection.emitSessionControl(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await drainSessionDetailMicrotasks();
    }

    test(
      'send keeps the draft associated until broker delivery clears it',
      () async {
        await attachConnected();
        await emitDrivingControl();
        await controller().recordLocalDraft('prompt to send');
        await drainSessionDetailMicrotasks();

        final sent = await controller().sendPrompt('prompt to send');
        expect(sent, isTrue);
        await drainSessionDetailMicrotasks();

        // After the durable outbox insert, the draft row is associated with
        // the exact clientMessageId — not deleted yet.
        final outbox = container.read(sessionOutboxRepositoryProvider);
        final messages = await outbox.loadForSession(
          key,
          brokerProfileId: fakeControllerBrokerScope(),
        );
        expect(messages, hasLength(1));
        final clientMessageId = messages.single.clientMessageId;
        var row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row, isNotNull);
        expect(row!.submittedClientMessageId, clientMessageId);
        expect(row.text, 'prompt to send');

        // Broker delivery clears the draft — the handoff's safe point.
        connection.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: clientMessageId,
          ),
        );
        await drainSessionDetailMicrotasks();
        row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row, isNull);
      },
    );

    test('terminal delivery failure restores the unsent text', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt that will fail');
      await drainSessionDetailMicrotasks();

      await controller().sendPrompt('prompt that will fail');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final messages = await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      );
      final clientMessageId = messages.single.clientMessageId;

      connection.emitEvent(
        NackWireEvent(
          code: 'PROMPT_REJECTED',
          message: 'the agent rejected it',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row, isNotNull);
      expect(row!.text, 'prompt that will fail');
      expect(row.dirty, isTrue);
      expect(row.submittedClientMessageId, isNull);
      expect(
        detailState().draftSurface?.kind,
        SessionDraftSurfaceKind.restoreIfEmpty,
      );
      expect(detailState().draftSurface?.text, 'prompt that will fail');
    });

    test('an oversized prompt that nacks is offered back', () async {
      await attachConnected();
      await emitDrivingControl();

      // Too long for either durable copy, so it rides only the outbox payload.
      final oversized = 'y' * (maxLocalDraftTextChars + 1);
      await controller().sendPrompt(oversized);
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await container
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;

      connection.emitEvent(
        NackWireEvent(
          code: 'PROMPT_REJECTED',
          message: 'the agent rejected it',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // The terminal nack must still RESTORE the text, not merely retain it
      // in a failed outbox row no UI reads: the composer gets it back in
      // memory, where the too-long status explains its reduced durability.
      expect(detailState().draftSurface?.text, oversized);
      expect(
        detailState().draftSurface?.kind,
        SessionDraftSurfaceKind.restoreIfEmpty,
      );
      expect(
        await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        ),
        isNull,
        reason: 'the durable row never stores oversized text',
      );
    });

    test('an oversized send never adopts the older short draft', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('short draft');
      await drainSessionDetailMicrotasks();
      connection.emitEvent(
        DraftWireEvent(
          text: 'short draft',
          at: 1,
          revision: 1,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();

      final oversized = 'z' * (maxLocalDraftTextChars + 1);
      await controller().sendPrompt(oversized);
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await container
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;

      // The flush could not make the row carry the prompt, so the short row
      // is NOT the draft this send contained and must not be associated with
      // it — its delivery would erase, and its failure would "restore", text
      // the prompt never carried.
      var row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.submittedClientMessageId, isNull);
      expect(row.text, 'short draft');

      connection.emitEvent(
        NackWireEvent(
          code: 'PROMPT_REJECTED',
          message: 'rejected',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // Reopen — the same hydration path a fresh attach takes. The failed
      // oversized prompt is offered from its outbox row, beside — never
      // instead of, never overwritten by — the short draft.
      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await drainSessionDetailMicrotasks();
      connection.emitState(SessionDetailConnectionStatus.connected);
      await emitHello();
      await drainSessionDetailMicrotasks();

      final offer = detailState().draftConflict;
      expect(offer, isNotNull);
      expect(offer!.sharedText, oversized);
      expect(offer.localText, 'short draft');
      expect(offer.recoveredPromptId, clientMessageId);
      row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'short draft');
    });

    test('an expired oversized prompt is offered back on reopen', () async {
      // Maintenance expired the prompt while no controller was alive: the
      // failed outbox row is the only surviving copy.
      final oversized = 'w' * (maxLocalDraftTextChars + 1);
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-expired-oversized',
          kind: SessionOutboxMessageKind.prompt,
          payload: {'text': oversized},
        ),
      );
      await outbox.markSending('cm-expired-oversized');
      await outbox.markFailed('cm-expired-oversized', 'expired');

      await attachConnected();

      final offer = detailState().draftConflict;
      expect(
        offer,
        isNotNull,
        reason: 'reopen must expose a recovery action for the stranded text',
      );
      expect(offer!.sharedText, oversized);
      expect(offer.recoveredPromptId, 'cm-expired-oversized');

      // The recovery action surfaces the full prompt — but no page exists
      // here to apply it, which is exactly the unmount/crash window: the
      // resolved row is the only durable copy and must survive until some
      // page confirms the surface demonstrably reached a composer.
      await controller().resolveDraftConflictUseShared();
      await drainSessionDetailMicrotasks();
      expect(detailState().draftSurface?.text, oversized);
      expect(detailState().draftConflict, isNull);
      expect(
        (await outbox.loadForSession(
          key,
          brokerProfileId: fakeControllerBrokerScope(),
        )).single.clientMessageId,
        'cm-expired-oversized',
        reason: 'an unconfirmed restoration must not delete the only copy',
      );

      // Reopen again: the unapplied restoration is simply offered again.
      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await drainSessionDetailMicrotasks();
      connection.emitState(SessionDetailConnectionStatus.connected);
      await emitHello();
      await drainSessionDetailMicrotasks();
      expect(
        detailState().draftConflict?.recoveredPromptId,
        'cm-expired-oversized',
        reason: 'the failed prompt stays recoverable across reopens',
      );

      // This time a page confirms the applied surface; only that completes
      // the removal (retention contract: resolved failed rows are deleted).
      await controller().resolveDraftConflictUseShared();
      await drainSessionDetailMicrotasks();
      await controller().confirmDraftSurfaceApplied(
        detailState().draftSurface!.token,
      );
      await drainSessionDetailMicrotasks();
      expect(
        await outbox.loadForSession(
          key,
          brokerProfileId: fakeControllerBrokerScope(),
        ),
        isEmpty,
      );
    });

    test('a failed send restores the draft after an app restart too', () async {
      // The durable row mid-handoff: submitted to an outbox row that failed
      // while the app was gone.
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-restart-1',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'failed while away'},
        ),
      );
      await outbox.markFailed('cm-restart-1', 'nack');
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'failed while away',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: false,
          submittedClientMessageId: 'cm-restart-1',
          updatedAt: DateTime.now(),
        ),
      );

      await attachConnected();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.dirty, isTrue);
      expect(row.submittedClientMessageId, isNull);
      expect(
        detailState().draftSurface?.kind,
        SessionDraftSurfaceKind.restoreIfEmpty,
      );
    });

    test('a failed prompt kept beside newer text is offered back', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt that will fail');
      await drainSessionDetailMicrotasks();
      await controller().sendPrompt('prompt that will fail');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final clientMessageId = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single.clientMessageId;

      // The user types something new before the terminal failure arrives, so
      // the failed prompt cannot simply replace the composer.
      await controller().recordLocalDraft('something else entirely');
      await drainSessionDetailMicrotasks();

      connection.emitEvent(
        NackWireEvent(
          code: 'PROMPT_REJECTED',
          message: 'the agent rejected it',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // Preserving it only in SQLite is text the user can never recover, so
      // the choice has to be visible.
      final conflict = detailState().draftConflict;
      expect(conflict, isNotNull);
      expect(conflict!.kind, SessionDraftConflictKind.unsentPrompt);
      expect(conflict.localText, 'something else entirely');
      expect(conflict.sharedText, 'prompt that will fail');
      expect(conflict.sharedRevision, isNull);

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'something else entirely');
      expect(row.conflictText, 'prompt that will fail');
    });

    test(
      'a preserved failed prompt is re-offered after an app restart',
      () async {
        await seedDraft(
          SessionLocalDraft(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
            text: 'newer composer text',
            localRevision: 2,
            baseBrokerRevision: 0,
            dirty: true,
            conflictText: 'prompt that failed while away',
            updatedAt: DateTime.now(),
          ),
        );

        await attachConnected();

        final conflict = detailState().draftConflict;
        expect(conflict, isNotNull);
        expect(conflict!.kind, SessionDraftConflictKind.unsentPrompt);
        expect(conflict.sharedText, 'prompt that failed while away');
      },
    );

    test('recovering a failed prompt restores it to the composer', () async {
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'newer composer text',
          localRevision: 2,
          baseBrokerRevision: 0,
          dirty: true,
          conflictText: 'prompt that failed while away',
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();

      await controller().resolveDraftConflictUseShared();
      await drainSessionDetailMicrotasks();

      expect(detailState().draftConflict, isNull);
      expect(
        detailState().draftSurface?.text,
        'prompt that failed while away',
      );
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'prompt that failed while away');
      expect(row.conflictText, isNull);
      expect(row.dirty, isTrue); // a recovered prompt is unsent local text
    });

    test('discarding a recovered prompt keeps the newer text', () async {
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'newer composer text',
          localRevision: 2,
          baseBrokerRevision: 0,
          dirty: true,
          conflictText: 'prompt that failed while away',
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();

      await controller().resolveDraftConflictKeepLocal();
      await drainSessionDetailMicrotasks();

      expect(detailState().draftConflict, isNull);
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'newer composer text');
      expect(row.conflictText, isNull);
    });

    test('send during an unacknowledged publish carries its token', () async {
      await attachConnected();
      await emitDrivingControl();

      // Type, then press Send inside the debounce window — the common case.
      // The draft frame goes out and is NOT yet acknowledged.
      await controller().recordLocalDraft('typed then sent immediately');
      await drainSessionDetailMicrotasks();
      final draftUpdateId = connection.lastDraftUpdateId;
      expect(draftUpdateId, isNotNull);

      await controller().sendPrompt('typed then sent immediately');
      await drainSessionDetailMicrotasks();

      // The reported revision is necessarily stale (the echo has not arrived),
      // so the token is what lets the broker recognize the shared draft as this
      // device's own and clear it. Without it the sent prompt would survive as
      // the shared unsent draft.
      expect(connection.lastPromptDraftRevision, 0);
      expect(connection.lastPromptDraftUpdateId, draftUpdateId);
    });

    test('a delayed draft echo does not strand the outbox handoff', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('typed then sent immediately');
      await drainSessionDetailMicrotasks();
      final draftUpdateId = connection.lastDraftUpdateId;

      await controller().sendPrompt('typed then sent immediately');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final clientMessageId = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single.clientMessageId;

      // The draft echo lands AFTER the outbox handoff. Adopting it must not
      // drop the association: delivery could then no longer clear the row and
      // the already-sent prompt would rehydrate into the composer.
      connection.emitEvent(
        DraftWireEvent(
          text: 'typed then sent immediately',
          at: 1,
          revision: 1,
          updateId: draftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      var row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row?.submittedClientMessageId, clientMessageId);

      // Broker-side clear (the prompt's own) followed by the prompt receipt.
      connection.emitEvent(
        const DraftWireEvent(text: '', at: 2, revision: 2),
      );
      await drainSessionDetailMicrotasks();
      connection.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // Both copies end empty: nothing of the sent prompt lingers as a draft.
      row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row, isNull);
      expect(detailState().draftConflict, isNull);
    });

    test('an unclearable shared draft is retried, not abandoned', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt whose clear fails');
      await drainSessionDetailMicrotasks();
      connection.emitEvent(
        DraftWireEvent(
          text: 'prompt whose clear fails',
          at: 1,
          revision: 1,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();

      await controller().sendPrompt('prompt whose clear fails');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final clientMessageId = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single.clientMessageId;
      // The prompt reached the agent, but the broker could not durably store
      // the clear tombstone. Completing the handoff here would leave the sent
      // text to be replayed as an unsent draft after a restart.
      connection
        ..sendDraftCount = 0
        ..emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: clientMessageId,
            draftCleared: false,
          ),
        );
      await drainSessionDetailMicrotasks();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row, isNotNull, reason: 'the row must survive to retry the clear');
      expect(row!.text, isEmpty);
      expect(row.dirty, isTrue);
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, isEmpty);

      // Once the broker confirms the tombstone, the row finally goes.
      connection.emitEvent(
        DraftWireEvent(
          text: '',
          at: 2,
          revision: 2,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      expect(
        await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        ),
        isNull,
      );
    });

    test('a pending clear never overwrites a newer foreign draft', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('device A prompt');
      await drainSessionDetailMicrotasks();
      connection.emitEvent(
        DraftWireEvent(
          text: 'device A prompt',
          at: 1,
          revision: 1,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();

      await controller().sendPrompt('device A prompt');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final clientMessageId = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single.clientMessageId;

      // The prompt reached the agent, but the tombstone could not be stored:
      // the shared record still holds the sent text at revision 1.
      connection.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
          draftCleared: false,
          draftRevision: 1,
        ),
      );
      await drainSessionDetailMicrotasks();
      var row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.pendingClearRevision, 1);
      expect(
        connection.lastDraftBaseRevision,
        1,
        reason: 'the retry is conditional on the record it targets',
      );

      // Device B publishes newer text before the retry is acknowledged, so the
      // broker rejects the empty write as stale-base and answers with B's
      // record. A's sent text is no longer the shared draft.
      connection
        ..sendDraftCount = 0
        ..emitEvent(
          const DraftWireEvent(
            text: 'device B unsent text',
            at: 2,
            revision: 2,
            updateId: 'device-b-update',
          ),
        );
      await drainSessionDetailMicrotasks();

      // Nothing of A's is left to clear, so the pending clear retires. It must
      // not republish over B, and must not ask the user to arbitrate between
      // '' and B's text — a choice they never made.
      expect(
        connection.sendDraftCount,
        0,
        reason: 'no unconditional empty overwrite',
      );
      expect(detailState().draftConflict, isNull);
      row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'device B unsent text');
      expect(row.dirty, isFalse);
      expect(row.pendingClearRevision, isNull);
      expect(row.baseBrokerRevision, 2);
      expect(detailState().draftSurface?.text, 'device B unsent text');
    });

    test('a pending clear that cannot be stored blocks delivery', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt with an unwritable clear');
      await drainSessionDetailMicrotasks();

      await controller().sendPrompt('prompt with an unwritable clear');
      await drainSessionDetailMicrotasks();
      final outbox = container.read(sessionOutboxRepositoryProvider);
      final clientMessageId = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single.clientMessageId;

      // Local durability is gone — the same way process death takes it.
      await database.close();
      connection.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
          draftCleared: false,
          draftRevision: 1,
        ),
      );
      await drainSessionDetailMicrotasks();

      // Marking the prompt delivered here would strand the failed clear:
      // reopening reconciles a delivered send by deleting its still-submitted
      // draft row, and the retry would go with it. Leaving the send unsettled
      // replays it instead, which the broker deduplicates by client message id.
      final settled = (await outbox.loadForSession(
        key,
        brokerProfileId: fakeControllerBrokerScope(),
      )).single;
      expect(settled.status, isNot(SessionOutboxMessageStatus.delivered));
    });

    test('a pending clear survives a reopen and retries its target', () async {
      // Exactly the crash aftermath the write ordering produces: the pending
      // clear is durable, and the prompt that created it is still unsettled
      // because the app died before the outbox could be marked delivered.
      await container
          .read(sessionOutboxRepositoryProvider)
          .upsert(
            SessionOutboxMessage.create(
              sessionKey: key,
              brokerProfileId: fakeControllerBrokerScope(),
              clientMessageId: 'cm-pending-clear',
              kind: SessionOutboxMessageKind.prompt,
              payload: const {'text': 'sent before the crash'},
            ),
          );
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: '',
          localRevision: 3,
          baseBrokerRevision: 5,
          dirty: true,
          pendingClearRevision: 5,
          updatedAt: DateTime.now(),
        ),
      );

      await attachConnected();

      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, isEmpty);
      expect(connection.lastDraftBaseRevision, 5);
      expect(
        detailState().draftSurface,
        isNull,
        reason: 'a pending clear has no text to rehydrate',
      );

      connection.emitEvent(
        DraftWireEvent(
          text: '',
          at: 6,
          revision: 6,
          updateId: connection.lastDraftUpdateId,
        ),
      );
      await drainSessionDetailMicrotasks();
      expect(
        await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        ),
        isNull,
      );
    });

    // The broker fingerprints every field of a mutating frame except the client
    // message id, so a replay must reproduce the original frame exactly. If the
    // draft ownership tokens are recomputed (or dropped) the retry hashes
    // differently and comes back as a conflicting reuse of the id rather than
    // the cached acknowledgement — turning an already-executed prompt into a
    // terminal failure that restores the sent text into the composer.
    test('a sent prompt persists the draft tokens it carried', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt sent mid-publish');
      await drainSessionDetailMicrotasks();
      final publishId = connection.lastDraftUpdateId;

      // Sent while the publish is still unacknowledged, so BOTH tokens ride.
      await controller().sendPrompt('prompt sent mid-publish');
      await drainSessionDetailMicrotasks();

      expect(connection.lastPromptDraftUpdateId, publishId);
      final sent =
          (await container
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single;
      expect(sent.payload['draftRevision'], connection.lastPromptDraftRevision);
      expect(sent.payload['draftUpdateId'], connection.lastPromptDraftUpdateId);
    });

    test('a replayed prompt re-sends its stored draft tokens', () async {
      // The crash aftermath: the failed clear is durable, the prompt is still
      // unsettled, and reconnecting replays it.
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-replayed',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {
            'text': 'sent before the crash',
            'draftRevision': 4,
            'draftUpdateId': 'ca.publish-token',
          },
        ),
      );
      await outbox.markSending('cm-replayed');
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: '',
          localRevision: 3,
          baseBrokerRevision: 4,
          dirty: true,
          pendingClearRevision: 4,
          updatedAt: DateTime.now(),
        ),
      );

      await attachConnected();

      expect(connection.lastPrompt, 'sent before the crash');
      expect(connection.lastPromptDraftRevision, 4);
      expect(connection.lastPromptDraftUpdateId, 'ca.publish-token');
      expect(connection.sendPromptCount, 1, reason: 'one replay, not a resend');
      expect(
        await outbox.loadForSession(
          key,
          brokerProfileId: fakeControllerBrokerScope(),
        ),
        hasLength(1),
      );
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(
        row?.pendingClearRevision,
        4,
        reason: 'the clear is still pending',
      );
    });

    test('a prompt stored before the tokens replays unchanged', () async {
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-legacy-replay',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'queued by an older build'},
        ),
      );
      await outbox.markSending('cm-legacy-replay');

      await attachConnected();
      await emitDrivingControl(); // the authoritative frame replay waits for

      // A row written before the payload carried tokens must stay
      // byte-identical to its first send, or its replay would conflict.
      expect(connection.lastPrompt, 'queued by an older build');
      expect(connection.lastPromptDraftRevision, isNull);
      expect(connection.lastPromptDraftUpdateId, isNull);
    });

    // The handoff boundary. The draft a prompt carries must be bound to that
    // prompt BEFORE the frame is written, or the binding runs against whatever
    // row the durable insert's awaits left current — which a foreign draft
    // frame can replace.
    group('the sent draft is bound before dispatch', () {
      /// Lands [event] inside the durable outbox insert, the window between
      /// persisting the send and writing its frame.
      void emitDuringPersist(DraftWireEvent event) {
        (container.read(sessionOutboxRepositoryProvider)
                as RecordingSessionOutboxRepository)
            .onUpsert = () async {
          connection.emitEvent(event);
          await drainSessionDetailMicrotasks();
        };
      }

      test('a foreign draft arriving mid-send is never bound', () async {
        await attachConnected();
        await emitDrivingControl();
        await controller().recordLocalDraft('device A prompt');
        await drainSessionDetailMicrotasks();
        connection.emitEvent(
          DraftWireEvent(
            text: 'device A prompt',
            at: 1,
            revision: 1,
            updateId: connection.lastDraftUpdateId,
          ),
        );
        await drainSessionDetailMicrotasks();

        // Device B's draft lands while the prompt is being persisted, so the
        // row the old code would have bound is no longer the one being sent.
        emitDuringPersist(
          const DraftWireEvent(
            text: 'device B unsent text',
            at: 2,
            revision: 2,
            updateId: 'device-b-update',
          ),
        );
        expect(await controller().sendPrompt('device A prompt'), isTrue);
        await drainSessionDetailMicrotasks();

        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row!.text, 'device B unsent text');
        expect(
          row.submittedClientMessageId,
          isNull,
          reason: "another device's draft is not this prompt's handoff",
        );
        // The prompt still reports the revision it actually observed, so the
        // broker's conditional clear skips the record that moved on.
        expect(connection.lastPromptDraftRevision, 1);
      });

      test("a foreign draft survives the earlier prompt's receipt", () async {
        await attachConnected();
        await emitDrivingControl();
        await controller().recordLocalDraft('device A prompt');
        await drainSessionDetailMicrotasks();
        connection.emitEvent(
          DraftWireEvent(
            text: 'device A prompt',
            at: 1,
            revision: 1,
            updateId: connection.lastDraftUpdateId,
          ),
        );
        await drainSessionDetailMicrotasks();

        emitDuringPersist(
          const DraftWireEvent(
            text: 'device B unsent text',
            at: 2,
            revision: 2,
            updateId: 'device-b-update',
          ),
        );
        await controller().sendPrompt('device A prompt');
        await drainSessionDetailMicrotasks();
        final clientMessageId =
            (await container
                    .read(sessionOutboxRepositoryProvider)
                    .loadForSession(
                      key,
                      brokerProfileId: fakeControllerBrokerScope(),
                    ))
                .single
                .clientMessageId;

        connection.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: clientMessageId,
          ),
        );
        await drainSessionDetailMicrotasks();

        // Delivering this prompt must not delete unsent text it never carried.
        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row?.text, 'device B unsent text');
      });

      test('an acknowledgement racing the frame settles the row', () async {
        await attachConnected();
        await emitDrivingControl();
        await controller().recordLocalDraft('prompt acked instantly');
        await drainSessionDetailMicrotasks();

        // The broker answers on the same turn the frame is written — the
        // binding must already be durable or this receipt finds nothing.
        connection.onSendPrompt = () {
          connection.emitEvent(
            AckWireEvent(
              ackKind: 'client-message',
              clientMessageId: connection.lastPromptClientMessageId,
            ),
          );
        };
        await controller().sendPrompt('prompt acked instantly');
        await drainSessionDetailMicrotasks();

        expect(
          await drafts.load(
            brokerProfileId: fakeControllerBrokerScope(),
            sessionKey: key,
          ),
          isNull,
          reason: 'the delivered prompt cleared the draft it carried',
        );
      });

      test('a foreign draft inside the bind write cannot win', () async {
        await attachConnected();
        await emitDrivingControl();
        await controller().recordLocalDraft('device A prompt');
        await drainSessionDetailMicrotasks();

        // Emitted WITHOUT draining, so the frame's handler interleaves with the
        // binding's own database write instead of completing before it. Both
        // then read the same pre-write row, and the later write wins — which
        // used to be the foreign frame's, silently discarding the binding.
        (container.read(sessionOutboxRepositoryProvider)
                as RecordingSessionOutboxRepository)
            .onUpsert = () async {
          connection.emitEvent(
            const DraftWireEvent(
              text: 'device B unsent text',
              at: 2,
              revision: 2,
              updateId: 'device-b-update',
            ),
          );
        };

        connection.sendDraftCount = 0;
        await controller().sendPrompt('device A prompt');
        await drainSessionDetailMicrotasks();
        await drainSessionDetailMicrotasks();

        // The sent prompt must never be republished as the shared draft: it
        // would land on every device as unsent text AND overwrite device B's.
        expect(
          connection.sendDraftCount,
          0,
          reason: 'the sent prompt must not become the shared draft',
        );
        final row = await drafts.load(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
        );
        expect(row!.dirty, isFalse);
        expect(
          row.submittedClientMessageId,
          isNotNull,
          reason: 'the binding must survive the concurrent frame',
        );
      });

      test('a binding that cannot be stored sends no prompt', () async {
        await seedDraft(dirtyDraft('prompt with unwritable handoff'));
        await attachConnected();
        await emitDrivingControl();
        connection.sendPromptCount = 0;

        // Local durability is gone before the send begins.
        await database.close();
        final sent = await controller().sendPrompt(
          'prompt with unwritable handoff',
        );

        expect(sent, isFalse);
        expect(
          connection.sendPromptCount,
          0,
          reason: 'an unbindable draft must not dispatch its prompt',
        );
        final queued =
            (await container
                    .read(sessionOutboxRepositoryProvider)
                    .loadForSession(
                      key,
                      brokerProfileId: fakeControllerBrokerScope(),
                    ))
                .single;
        expect(queued.isRetryableAt(DateTime.now()), isTrue);
      });
    });

    test('a send before hello still reports what it observed', () async {
      // The capability tri-state must never degrade to legacy here. Omitting
      // the revision asks a revision-3 broker for an unconditional clear, which
      // erases whatever another device typed; a broker that predates the field
      // ignores it and behaves exactly as before.
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'synced before the reconnect',
          localRevision: 1,
          baseBrokerRevision: 6,
          dirty: false,
          updatedAt: DateTime.now(),
        ),
      );
      await attachAwaitingHello();
      await controller().sendPrompt('synced before the reconnect');
      await drainSessionDetailMicrotasks();

      expect(connection.lastPromptDraftRevision, 6);
    });

    test('a prompt awaiting its receipt is not offered back', () async {
      // Reopening the session inside the receipt round trip — or across the
      // whole retry window when the ack is lost — must not put the prompt the
      // user already sent back in the composer as unsent text.
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-in-flight',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'already on its way'},
        ),
      );
      await outbox.markSending('cm-in-flight');
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'already on its way',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: false,
          submittedClientMessageId: 'cm-in-flight',
          updatedAt: DateTime.now(),
        ),
      );

      await attachConnected();

      expect(detailState().draftSurface, isNull);
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(
        row?.submittedClientMessageId,
        'cm-in-flight',
        reason: 'the row still awaits its receipt',
      );
    });

    test('sending under a conflict banner keeps the relay alive', () async {
      // Seeded rather than typed, so this device has no recent keystroke and
      // the foreign frame is arbitrated as an independent edit rather than a
      // live typing race — which is what raises the banner.
      await seedDraft(dirtyDraft('my unsent text'));
      await attachConnected();
      await emitDrivingControl();

      connection.emitEvent(
        const DraftWireEvent(
          text: 'their unsent text',
          at: 2,
          revision: 2,
          updateId: 'device-b-update',
        ),
      );
      await drainSessionDetailMicrotasks();
      expect(detailState().draftConflict, isNotNull);

      // Nothing blocks the composer, so sending under the banner is ordinary.
      await controller().sendPrompt('my unsent text');
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await container
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;
      connection.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();

      // The row the banner resolved against is gone, so the banner must go too:
      // every publish path refuses to run under an unresolved conflict, and
      // "keep mine" needs a row, so a stale banner silently ends draft sync on
      // this device for the rest of the session.
      expect(detailState().draftConflict, isNull);
      connection.sendDraftCount = 0;
      await controller().recordLocalDraft('typed after the send');
      await drainSessionDetailMicrotasks();
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, 'typed after the send');
    });

    test('a failed prompt never overwrites an adopted draft', () async {
      await attachConnected();
      await emitDrivingControl();
      await controller().recordLocalDraft('prompt that will fail');
      await drainSessionDetailMicrotasks();
      await controller().sendPrompt('prompt that will fail');
      await drainSessionDetailMicrotasks();
      final clientMessageId =
          (await container
                  .read(sessionOutboxRepositoryProvider)
                  .loadForSession(
                    key,
                    brokerProfileId: fakeControllerBrokerScope(),
                  ))
              .single
              .clientMessageId;

      // Another device's draft is adopted while the prompt is in flight, so the
      // row is CLEAN — the case the dirty-only guard used to fall through.
      connection.emitEvent(
        const DraftWireEvent(
          text: 'their live shared draft',
          at: 2,
          revision: 2,
          updateId: 'device-b-update',
        ),
      );
      await drainSessionDetailMicrotasks();

      connection
        ..sendDraftCount = 0
        ..emitEvent(
          NackWireEvent(
            code: 'CLIENT_MESSAGE_OUTCOME_UNKNOWN',
            message: 'unknown outcome',
            clientMessageId: clientMessageId,
          ),
        );
      await drainSessionDetailMicrotasks();

      // Overwriting keeps the current shared revision, so the next publish
      // would replace that device's unsent text everywhere.
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row!.text, 'their live shared draft');
      expect(row.conflictText, 'prompt that will fail');
      expect(connection.sendDraftCount, 0);
      expect(detailState().draftConflict, isNotNull);
    });

    test('a late echo of superseded text never returns', () async {
      await attachConnected();
      await emitDrivingControl();

      // Publish A, then replace it with B before A is acknowledged.
      await controller().recordLocalDraft('draft A');
      await drainSessionDetailMicrotasks();
      final updateIdA = connection.lastDraftUpdateId;
      await controller().recordLocalDraft('draft B');
      await drainSessionDetailMicrotasks();

      // Send B. The handoff releases the publish slot A was occupying — but
      // A's frame is already on the wire and will still be echoed.
      await controller().sendPrompt('draft B');
      await drainSessionDetailMicrotasks();
      final surfaceBefore = detailState().draftSurface?.token;

      connection.emitEvent(
        DraftWireEvent(
          text: 'draft A',
          at: 1,
          revision: 1,
          updateId: updateIdA,
        ),
      );
      await drainSessionDetailMicrotasks();

      // A is this device's own superseded text, not another device's draft:
      // it must not be adopted, surfaced, or allowed to strand the handoff.
      expect(detailState().draftSurface?.token, surfaceBefore);
      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row?.text, isNot('draft A'));
      expect(row?.submittedClientMessageId, isNotNull);
    });

    test('a send reports the shared revision it was based on', () async {
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'draft synced at revision 4',
          localRevision: 1,
          baseBrokerRevision: 4,
          dirty: false,
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();
      await emitDrivingControl();

      await controller().sendPrompt('draft synced at revision 4');
      await drainSessionDetailMicrotasks();

      // The broker clears only this draft. Without the revision it would clear
      // unconditionally and could erase newer text from another device.
      expect(connection.lastPromptDraftRevision, 4);
    });

    test('a delivered outbox handoff clears the draft after restart', () async {
      final outbox = container.read(sessionOutboxRepositoryProvider);
      await outbox.upsert(
        SessionOutboxMessage.create(
          sessionKey: key,
          brokerProfileId: fakeControllerBrokerScope(),
          clientMessageId: 'cm-restart-2',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'delivered while away'},
        ),
      );
      await outbox.markDelivered('cm-restart-2');
      await seedDraft(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'delivered while away',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: false,
          submittedClientMessageId: 'cm-restart-2',
          updatedAt: DateTime.now(),
        ),
      );

      await attachConnected();

      final row = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(row, isNull);
    });
  });

  group('isolation', () {
    test('profile, tool, and session identities stay isolated', () async {
      await seedDraft(dirtyDraft('profile local / claude / session-1'));
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: 'other-profile',
          sessionKey: key,
          text: 'other profile draft',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: true,
          updatedAt: DateTime.now(),
        ),
      );
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: const SessionDetailKey(
            tool: 'codex',
            sessionId: 'session-1',
          ),
          text: 'other tool draft',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: true,
          updatedAt: DateTime.now(),
        ),
      );

      final own = await drafts.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(own!.text, 'profile local / claude / session-1');

      await attachConnected();
      // Only this profile/tool/session's row hydrated and retried.
      expect(connection.lastDraft, 'profile local / claude / session-1');
    });
  });
}

/// A draft repository whose database operations can be held open, so a test can
/// land another mutation inside one operation's window.
final class _HoldableDraftRepository implements SessionDraftRepository {
  late SessionDraftRepository inner;
  bool failNextLoad = false;

  /// Refuses this many conditional writes as if a concurrent writer changed
  /// the row first — the repository's null/false answer, not an exception.
  int refuseNextSaves = 0;
  Completer<void>? _loadGate;
  Completer<void>? _saveGate;

  Completer<void> holdNextLoad() => _loadGate = Completer<void>();

  Completer<void> holdNextSave() => _saveGate = Completer<void>();

  @override
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    if (failNextLoad) {
      failNextLoad = false;
      throw StateError('draft load failed');
    }
    // Read FIRST, then hold: the answer this returns is the pre-write one, so
    // releasing it late models a slow database round trip rather than a
    // conveniently re-read one.
    final row = await inner.load(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
    );
    final gate = _loadGate;
    if (gate != null) {
      _loadGate = null;
      await gate.future;
    }
    return row;
  }

  @override
  Future<SessionLocalDraft?> save(SessionLocalDraft draft) async {
    final gate = _saveGate;
    if (gate != null) {
      _saveGate = null;
      await gate.future;
    }
    if (refuseNextSaves > 0) {
      refuseNextSaves--;
      return null;
    }
    return inner.save(draft);
  }

  @override
  Future<bool> delete({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int expectedMutationVersion,
  }) => inner.delete(
    brokerProfileId: brokerProfileId,
    sessionKey: sessionKey,
    expectedMutationVersion: expectedMutationVersion,
  );

  @override
  Future<void> deleteForProfile(String brokerProfileId) =>
      inner.deleteForProfile(brokerProfileId);
}
