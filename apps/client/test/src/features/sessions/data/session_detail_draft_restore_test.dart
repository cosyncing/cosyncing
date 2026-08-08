import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// DR1b round 2: the durable draft must reach the composer, and a composer
/// that never received it must not be able to erase it.
///
/// Both halves are about ONE thing the DR1 suites never expressed: an open
/// session stays resident (OS1), so a composer is routinely built against a
/// controller that is already connected and has already hydrated. Hydration
/// runs on connected transitions, so nothing re-offers the row to that new
/// composer — and the empty composer's ordinary lifecycle flush then writes
/// over the value nobody ever showed the user.
void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  const versionedBroker = BrokerContractIdentity(
    revision: 3,
    minimumClientRevision: 2,
    surfaceHash: 'fnv1a32:abcdef12',
  );

  late FakeSessionDetailConnection connection;
  late ProviderContainer container;
  late AppDatabase database;
  late DriftSessionDraftRepository drafts;

  setUp(() {
    connection = FakeSessionDetailConnection();
    container = buildControllerContainer(
      key,
      connection,
      FakeControllerAttachmentPicker(),
    );
    addTearDown(container.dispose);
    database = container.read(appDatabaseProvider);
    drafts = DriftSessionDraftRepository(database);
  });

  SessionDetailController controller() =>
      container.read(sessionDetailControllerProvider(key).notifier);

  SessionDetailState detailState() =>
      container.read(sessionDetailControllerProvider(key));

  Future<void> attachConnected() async {
    keepSessionDetailAlive(container, key);
    await controller().attach();
    connection
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
          brokerVersion: '1.4.0',
          brokerContract: versionedBroker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.compatible,
            readOnly: false,
            reason: 'compatible',
            broker: versionedBroker,
          ),
        ),
      );
    await drainSessionDetailMicrotasks();
  }

  Future<SessionLocalDraft?> storedRow() => drafts.load(
    brokerProfileId: fakeControllerBrokerScope(),
    sessionKey: key,
  );

  /// [dirty] false models a row the broker has already acknowledged, which
  /// leaves the single publish slot free for what the test itself provokes.
  Future<void> seedDurableRow(String text, {bool dirty = true}) async {
    await drafts.save(
      SessionLocalDraft(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
        text: text,
        localRevision: 1,
        baseBrokerRevision: 0,
        dirty: dirty,
        updatedAt: DateTime.now(),
      ),
    );
  }

  group('a composer built against a resident controller', () {
    test('is re-offered the durable row it never received', () async {
      await attachConnected();
      // The user types and the debounce lands. No surface was ever emitted:
      // hydration found an empty row on connect, and the value arrived after.
      controller().stageLocalDraft('typed while this session was open');
      await controller().recordLocalDraft('typed while this session was open');
      await drainSessionDetailMicrotasks();
      final beforeToken = detailState().draftSurface?.token ?? 0;

      // Leaving and returning to the session rebuilds the composer. The
      // controller never disconnected, so nothing else will offer the row.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      final surface = detailState().draftSurface;
      expect(surface?.text, 'typed while this session was open');
      expect(surface!.token, greaterThan(beforeToken));
      // restoreIfEmpty, so a composer the user is already typing into is left
      // alone rather than overwritten by an older durable value.
      expect(surface.kind, SessionDraftSurfaceKind.restoreIfEmpty);
    });

    test('is offered a row that was durable before this attach', () async {
      await seedDurableRow('typed by a previous document');
      await attachConnected();

      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      expect(
        detailState().draftSurface?.text,
        'typed by a previous document',
      );
    });

    test('is not offered a row still bound to a live send', () async {
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'already sent',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: false,
          submittedClientMessageId: 'send-1',
          updatedAt: DateTime.now(),
        ),
      );
      await attachConnected();
      final before = detailState().draftSurface?.token ?? 0;

      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      expect(detailState().draftSurface?.token ?? 0, before);
    });
  });

  group('an empty composer that never held the durable value', () {
    test('cannot clear it on route disposal', () async {
      await seedDurableRow('typed by a previous document');
      await attachConnected();
      final publishes = connection.sendDraftCount;

      // The page leaves the tree without ever having displayed the row.
      final result = await controller().flushLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect(result.isDurable, isTrue); // navigation is not blocked
      expect((await storedRow())?.text, 'typed by a previous document');
      expect(connection.sendDraftCount, publishes);
    });

    test('cannot clear it through the coalesced edit path either', () async {
      await seedDurableRow('typed by a previous document');
      await attachConnected();
      final publishes = connection.sendDraftCount;

      await controller().recordLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, 'typed by a previous document');
      expect(connection.sendDraftCount, publishes);
    });
  });

  group('authority belongs to the composer that earned it', () {
    test('confirming an EMPTY surface grants nothing', () async {
      // The page confirms a surface whenever it already matches the composer,
      // and empty matches empty. Treating that as "this composer holds the
      // session's content" hands an empty composer the authority to erase
      // content that arrives afterwards from somewhere else.
      final shared = AppDatabase(NativeDatabase.memory());
      addTearDown(shared.close);
      final other = DriftSessionDraftRepository(shared);
      await other.save(
        SessionLocalDraft.create(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'transient',
        ).copyWith(dirty: false),
      );

      final socket = FakeSessionDetailConnection();
      final window = buildControllerContainer(
        key,
        socket,
        FakeControllerAttachmentPicker(),
        appDatabase: shared,
        enableCrossWindowDraftObservation: true,
      );
      addTearDown(window.dispose);
      final live = window.read(sessionDetailControllerProvider(key).notifier);
      keepSessionDetailAlive(window, key);
      await live.attach();
      socket
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
            brokerVersion: '1.4.0',
            brokerContract: versionedBroker,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.compatible,
              readOnly: false,
              reason: 'compatible',
              broker: versionedBroker,
            ),
          ),
        );
      await drainSessionDetailMicrotasks();
      await live.offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      // A shared clear tombstone empties this window's composer — the ordinary
      // way an EMPTY surface is produced.
      socket.emitEvent(const DraftWireEvent(text: '', at: 1, revision: 1));
      SessionDraftSurface? emptySurface;
      for (var i = 0; i < 40 && emptySurface == null; i++) {
        await drainSessionDetailMicrotasks();
        final surface = window
            .read(sessionDetailControllerProvider(key))
            .draftSurface;
        if (surface != null && surface.text.isEmpty) emptySurface = surface;
      }
      expect(emptySurface, isNotNull, reason: 'no empty surface was emitted');
      // The page confirms it, because it already matches the composer.
      await live.confirmDraftSurfaceApplied(emptySurface!.token);

      // Another tab writes real content, which this window observes.
      await other.save(
        SessionLocalDraft.create(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'written by another tab',
        ),
      );
      for (var i = 0; i < 30; i++) {
        await drainSessionDetailMicrotasks();
      }

      // Hide/dispose flushes the STILL-EMPTY composer before the non-empty
      // surface it was just sent could be applied. Confirming emptiness must
      // not have bought the authority to erase what this composer never held.
      await live.flushLocalDraft('');
      await drainSessionDetailMicrotasks();

      final survivor = await other.load(
        brokerProfileId: fakeControllerBrokerScope(),
        sessionKey: key,
      );
      expect(survivor?.text, 'written by another tab');
    });

    test('a later composer cannot clear what an earlier one held', () async {
      await seedDurableRow('held by the first composer', dirty: false);
      await attachConnected();
      // Composer A mounts, is offered the row, and holds it.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      await controller().confirmDraftSurfaceApplied(
        detailState().draftSurface!.token,
      );

      // A leaves. The controller is resident, so it survives. Meanwhile the
      // shared row moves on underneath it.
      await drafts.save(
        (await storedRow())!.copyWith(text: 'written by another tab'),
      );
      // Composer B mounts empty and announces itself.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      final publishes = connection.sendDraftCount;

      // A lifecycle flush fires before B ever applied a surface. A's authority
      // must not authorize clearing text B never held.
      await controller().flushLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, 'written by another tab');
      expect(connection.sendDraftCount, publishes);
    });

    test('a late confirmation cannot authorize a later composer', () async {
      await seedDurableRow('offered to the first composer', dirty: false);
      await attachConnected();

      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      final firstToken = detailState().draftSurface!.token;

      // Composer B announces itself before composer A's post-frame
      // confirmation drains. The old token belongs to A and must not grant B
      // authority to clear content B has never displayed.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      await controller().confirmDraftSurfaceApplied(firstToken);

      await drafts.save(
        (await storedRow())!.copyWith(text: 'written after B mounted'),
      );
      await controller().flushLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, 'written after B mounted');
    });

    test('the current composer still clears what it holds', () async {
      await seedDurableRow('held by the first composer', dirty: false);
      await attachConnected();
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      // Composer B mounts, then genuinely receives and edits the content.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      controller().stageLocalDraft('held by the first composer');
      controller().stageLocalDraft('');
      final publishes = connection.sendDraftCount;

      await controller().flushLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, '');
      expect(connection.sendDraftCount, greaterThan(publishes));
    });
  });

  group('one composer surface per attach', () {
    test('hydration cannot replace newer text after a reconnect', () async {
      // Attach with NOTHING durable yet, so hydration has nothing to surface
      // and this attach's composer surface is still unclaimed.
      await attachConnected();
      // The composer mounts and announces itself.
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();

      // The user types and that value lands durably …
      controller().stageLocalDraft('first');
      await controller().recordLocalDraft('first');
      await drainSessionDetailMicrotasks();
      // … then keeps typing. This tail is staged only: the debounce has not
      // fired, so the ROW still holds the older 'first' that hydration reads.
      // Nothing focuses the composer, so the page's 1.5 s focused-edit guard
      // is not what can save it.
      controller().stageLocalDraft('first, extended');
      final beforeReconnect = detailState().draftSurface?.token ?? 0;

      // The socket drops and returns — a genuine second connected transition,
      // and the moment hydration would re-surface the row it can still see.
      connection
        ..emitState(SessionDetailConnectionStatus.closed)
        ..emitState(SessionDetailConnectionStatus.connected);
      await drainSessionDetailMicrotasks();

      // Hydration may re-offer the row, but never with the strength that
      // overwrites an unfocused composer holding something newer than it.
      final surface = detailState().draftSurface;
      final reSurfaced = (surface?.token ?? 0) > beforeReconnect;
      expect(
        reSurfaced && surface!.kind == SessionDraftSurfaceKind.replace,
        isFalse,
        reason: 'hydration re-surfaced the older row over newer typed text',
      );
      // And the tail is what the coalesced flush still makes durable.
      await controller().flushLocalDraft('first, extended');
      await drainSessionDetailMicrotasks();
      expect((await storedRow())?.text, 'first, extended');
    });

    /// Connects a controller whose composer has already announced itself, so
    /// only the SURFACE is deduped and hydration's other duties still run.
    Future<void> connectAfterAnnounce() async {
      keepSessionDetailAlive(container, key);
      await controller().attach();
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      connection
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
            brokerVersion: '1.4.0',
            brokerContract: versionedBroker,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.compatible,
              readOnly: false,
              reason: 'compatible',
              broker: versionedBroker,
            ),
          ),
        );
      await drainSessionDetailMicrotasks();
    }

    test('hydration still publishes a dirty row it did not surface', () async {
      await seedDurableRow('dirty and unpublished');

      await connectAfterAnnounce();

      // The surface deduped, but the dirty retry is a separate duty.
      expect(connection.sendDraftCount, greaterThan(0));
      expect(connection.lastDraft, 'dirty and unpublished');
    });

    test('hydration still restores a preserved second version', () async {
      await drafts.save(
        SessionLocalDraft(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: key,
          text: 'mine',
          localRevision: 1,
          baseBrokerRevision: 0,
          dirty: false,
          conflictText: 'a preserved second version',
          conflictBrokerRevision: 9,
          updatedAt: DateTime.now(),
        ),
      );

      await connectAfterAnnounce();

      expect(
        detailState().draftConflict?.sharedText,
        'a preserved second version',
      );
    });
  });

  group('a composer that did hold the value', () {
    test('still propagates a real user clear', () async {
      await seedDurableRow('mine', dirty: false);
      await attachConnected();
      final publishes = connection.sendDraftCount;

      // The composer holds it — this is what the user is deleting.
      controller().stageLocalDraft('mine');
      controller().stageLocalDraft('');
      await controller().recordLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, '');
      expect(connection.sendDraftCount, greaterThan(publishes));
      expect(connection.lastDraft, '');
    });

    test('propagates a clear after an applied surface confirmed it', () async {
      await seedDurableRow('restored into the composer', dirty: false);
      await attachConnected();
      await controller().offerDurableDraftToComposer();
      await drainSessionDetailMicrotasks();
      // The page applies the surface and confirms the exact token.
      await controller().confirmDraftSurfaceApplied(
        detailState().draftSurface!.token,
      );
      final publishes = connection.sendDraftCount;

      controller().stageLocalDraft('');
      await controller().recordLocalDraft('');
      await drainSessionDetailMicrotasks();

      expect((await storedRow())?.text, '');
      expect(connection.sendDraftCount, greaterThan(publishes));
      expect(connection.lastDraft, '');
    });

    test('announces itself even when the offer load fails, so hydration '
        'cannot replace newer typed text', () async {
      // The announcement is the composer saying "I exist" — a statement true
      // the moment the offer is called, independent of whether the durability
      // layer answers. Recording it only after a successful load leaves a
      // window where a failed load keeps hydration on `replace`, which
      // overwrites an unfocused composer holding newer text.
      final failing = _FirstLoadFailsRepository(drafts);
      final failingConnection = FakeSessionDetailConnection();
      final failingContainer = buildControllerContainer(
        key,
        failingConnection,
        FakeControllerAttachmentPicker(),
        draftRepository: failing,
        appDatabase: database,
      );
      addTearDown(failingContainer.dispose);
      SessionDetailController failingController() => failingContainer.read(
        sessionDetailControllerProvider(key).notifier,
      );
      SessionDetailState failingState() =>
          failingContainer.read(sessionDetailControllerProvider(key));
      keepSessionDetailAlive(failingContainer, key);

      // The composer mounts and its offer runs first, exactly as the page's
      // post-frame callback fires both; the offer's own load fails.
      final offered = failingController().offerDurableDraftToComposer();
      await failingController().attach();
      failingConnection.emitEvent(
        const HelloWireEvent(
          brokerVersion: '1.4.0',
          brokerContract: versionedBroker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.compatible,
            readOnly: false,
            reason: 'compatible',
            broker: versionedBroker,
          ),
        ),
      );
      await offered;
      await drainSessionDetailMicrotasks();
      expect(failing.failedLoads, greaterThan(0));

      // The user types; the value lands; a newer unstaged tail follows.
      failingController().stageLocalDraft('first');
      await failingController().recordLocalDraft('first');
      await drainSessionDetailMicrotasks();
      failingController().stageLocalDraft('first, extended');
      final before = failingState().draftSurface?.token ?? 0;

      // A reconnect re-runs hydration over the row still holding 'first'.
      failingConnection
        ..emitState(SessionDetailConnectionStatus.closed)
        ..emitState(SessionDetailConnectionStatus.connected);
      await drainSessionDetailMicrotasks();

      final surface = failingState().draftSurface;
      final reSurfaced = (surface?.token ?? 0) > before;
      expect(
        reSurfaced && surface!.kind == SessionDraftSurfaceKind.replace,
        isFalse,
        reason:
            'a failed offer load left hydration free to replace newer '
            'typed text',
      );
    });
  });
}

/// Delegates to the real repository, failing the FIRST load — the offer's own
/// load — the way a transient durability hiccup at mount does.
final class _FirstLoadFailsRepository implements SessionDraftRepository {
  _FirstLoadFailsRepository(this._inner);

  final SessionDraftRepository _inner;
  int failedLoads = 0;
  bool _failNext = true;

  @override
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) {
    if (_failNext) {
      _failNext = false;
      failedLoads++;
      throw StateError('transient durability hiccup at mount');
    }
    return _inner.load(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
    );
  }

  @override
  Future<SessionLocalDraft?> save(SessionLocalDraft draft) =>
      _inner.save(draft);

  @override
  Future<bool> delete({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int expectedMutationVersion,
  }) => _inner.delete(
    brokerProfileId: brokerProfileId,
    sessionKey: sessionKey,
    expectedMutationVersion: expectedMutationVersion,
  );

  @override
  Future<void> deleteForProfile(String brokerProfileId) =>
      _inner.deleteForProfile(brokerProfileId);
}
