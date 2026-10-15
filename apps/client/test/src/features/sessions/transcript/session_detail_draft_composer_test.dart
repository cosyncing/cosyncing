// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// DR1 page-level durable draft coverage: offline persistence, hydration on
/// reopen, reconnect retry, and the conflict-resolution surface.
void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
  const versionedBroker = BrokerContractIdentity(
    revision: 3,
    minimumClientRevision: 2,
    surfaceHash: 'fnv1a32:abcdef12',
  );

  Future<void> emitVersionedHello(
    ScriptedSessionDetailConnection connection,
  ) async {
    connection.emitEvent(
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
  }

  ProviderContainer containerOf(WidgetTester tester) =>
      ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );

  SessionLocalDraft dirtyRow(String text, {int baseBrokerRevision = 0}) {
    return SessionLocalDraft(
      brokerProfileId: testBrokerScope(),
      sessionKey: key,
      text: text,
      localRevision: 1,
      baseBrokerRevision: baseBrokerRevision,
      dirty: true,
      updatedAt: DateTime.now(),
    );
  }

  testWidgets('explicit restore beats the recent-typing guard', (
    tester,
  ) async {
    final connection = ScriptedSessionDetailConnection(events: const []);
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    await emitVersionedHello(connection);
    await tester.pump();

    // The stranded recovery copy: a failed oversized prompt whose only
    // surviving text is its outbox row.
    final oversized = 'q' * (maxLocalDraftTextChars + 1);
    final outbox = containerOf(tester).read(sessionOutboxRepositoryProvider);
    await outbox.upsert(
      SessionOutboxMessage.create(
        sessionKey: key,
        brokerProfileId: testBrokerScope(),
        clientMessageId: 'cm-oversized-restore',
        kind: SessionOutboxMessageKind.prompt,
        payload: {'text': oversized},
      ),
    );
    await outbox.markSending('cm-oversized-restore');
    await outbox.markFailed('cm-oversized-restore', 'expired');

    // Reopen-equivalent: hydration re-runs and offers the recovery banner.
    connection.emitState(SessionDetailConnectionStatus.reconnecting);
    await tester.pump();
    connection.emitState(SessionDetailConnectionStatus.connected);
    await emitVersionedHello(connection);
    // Re-arm the composer: the reconnect cleared the session control facts,
    // and a control-less composer refuses focus, which would make the typing
    // below a silent no-op instead of the race this test exists to pin.
    connection.emitSessionControl(const {
      'drive': {'state': 'driving', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    });
    await tester.pumpAndSettle();
    final restoreButton = find.byKey(
      const Key('session-detail-draft-conflict-use-shared'),
    );
    expect(restoreButton, findsOneWidget);

    // The user is mid-keystroke when they click Restore: composer focused
    // and edited inside the 1.5-second remote-draft guard. The guard exists
    // to stop REMOTE content from stealing the composer — the user's own
    // explicit choice must win it, because the resolution also deletes the
    // recovered prompt's outbox row.
    final input = find.byKey(const Key('session-detail-prompt-input'));
    await tester.enterText(input, 'still typing');
    expect(tester.widget<TextField>(input).controller!.text, 'still typing');
    expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(restoreButton);

    // No frame has been pumped, so nothing has applied the surface yet — the
    // exact window in which an unmount or crash would otherwise orphan an
    // eager deletion. The only durable copy must still exist.
    expect(
      (await outbox.loadForSession(
        key,
        brokerProfileId: testBrokerScope(),
      )).single.clientMessageId,
      'cm-oversized-restore',
      reason: 'deletion must wait for the surface to demonstrably apply',
    );

    await tester.pump();
    await tester.pump();

    expect(
      tester.widget<TextField>(input).controller!.text,
      oversized,
      reason:
          'the explicit restore must replace the composer, not lose to '
          'the recent-typing guard while the outbox row is deleted',
    );
    expect(
      await outbox.loadForSession(key, brokerProfileId: testBrokerScope()),
      isEmpty,
      reason:
          'the resolved recovery row is removed only alongside a surface '
          'that actually applied',
    );
  });

  testWidgets('restore torn down before the frame keeps the copy', (
    tester,
  ) async {
    final connection = ScriptedSessionDetailConnection(events: const []);
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    await emitVersionedHello(connection);
    await tester.pump();

    final oversized = 'r' * (maxLocalDraftTextChars + 1);
    final outbox = containerOf(tester).read(sessionOutboxRepositoryProvider);
    await outbox.upsert(
      SessionOutboxMessage.create(
        sessionKey: key,
        brokerProfileId: testBrokerScope(),
        clientMessageId: 'cm-torn-down',
        kind: SessionOutboxMessageKind.prompt,
        payload: {'text': oversized},
      ),
    );
    await outbox.markSending('cm-torn-down');
    await outbox.markFailed('cm-torn-down', 'expired');

    connection.emitState(SessionDetailConnectionStatus.reconnecting);
    await tester.pump();
    connection.emitState(SessionDetailConnectionStatus.connected);
    await emitVersionedHello(connection);
    await tester.pumpAndSettle();
    final restoreButton = find.byKey(
      const Key('session-detail-draft-conflict-use-shared'),
    );
    expect(restoreButton, findsOneWidget);

    // The user clicks Restore and the page goes away before any frame runs
    // the post-frame apply — a navigation or crash in that instant. The
    // composer never showed the text, so its only durable copy must survive
    // for the next open to offer again.
    await tester.tap(restoreButton);
    await tester.pumpWidget(const SizedBox.shrink());

    expect(
      (await outbox.loadForSession(
        key,
        brokerProfileId: testBrokerScope(),
      )).single.clientMessageId,
      'cm-torn-down',
      reason: 'an unapplied restoration must never consume the only copy',
    );
  });

  testWidgets('conflict banner renders in the dark theme', (tester) async {
    final connection = ScriptedSessionDetailConnection(events: const []);
    final database = AppDatabase(NativeDatabase.memory());
    await DriftSessionDraftRepository(
      database,
    ).save(dirtyRow('device draft', baseBrokerRevision: 3));
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        connection: connection,
        database: database,
        theme: ThemeData(
          splashFactory: InkRipple.splashFactory,
          extensions: [themeSpecById(kDefaultThemeId).dark],
        ),
      ),
    );
    await tester.pumpAndSettle();
    await emitVersionedHello(connection);
    connection.emitEvent(
      const DraftWireEvent(text: 'shared draft', at: 9, revision: 4),
    );
    await tester.pumpAndSettle();

    expect(find.text('Resolve draft conflict'), findsOneWidget);
    expect(
      find.byKey(const Key('session-detail-draft-conflict-keep-local')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('session-detail-draft-conflict-use-shared')),
      findsOneWidget,
    );
  });

  group('lifecycle durability boundaries', () {
    // Each boundary is a point where the composer's text can be lost before the
    // 300 ms coalescing debounce fires. The flush has to be durable at that
    // instant, not one frame later.

    testWidgets('route disposal flushes the composer on the way out', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      final database = AppDatabase(NativeDatabase.memory());
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          database: database,
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'typed then navigated away',
      );
      await tester.pump(const Duration(milliseconds: 50));

      // Navigate away mid-debounce: the session page is disposed while the app
      // (and its provider scope) keeps running — a real route pop, not a
      // whole-tree teardown.
      final context = tester.element(find.byType(SessionDetailPage));
      unawaited(
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(builder: (_) => const SizedBox.shrink()),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SessionDetailPage), findsNothing);

      // The row is read from the same database the disposed page wrote to.
      final row = await DriftSessionDraftRepository(
        database,
      ).load(brokerProfileId: testBrokerScope(), sessionKey: key);
      expect(row, isNotNull);
      expect(row!.text, 'typed then navigated away');
    });

    testWidgets('route disposal transfers a held save past page teardown', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      final database = AppDatabase(NativeDatabase.memory());
      final inner = DriftSessionDraftRepository(database);
      final held = _HeldSaveDraftRepository(inner)..holdNextSave();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          database: database,
          draftRepository: held,
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'owned beyond route teardown',
      );
      await tester.pump(const Duration(milliseconds: 50));
      final context = tester.element(find.byType(SessionDetailPage));
      unawaited(
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(builder: (_) => const SizedBox.shrink()),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(SessionDetailPage), findsNothing);

      // The controller would auto-dispose here without the page's temporary
      // lease. Release the database only after the composer is gone.
      held.releaseSave();
      await held.saveFinished.future;
      await tester.pump();
      final row = await inner.load(
        brokerProfileId: testBrokerScope(),
        sessionKey: key,
      );
      expect(row?.text, 'owned beyond route teardown');
    });
  });
}

final class _HeldSaveDraftRepository implements SessionDraftRepository {
  _HeldSaveDraftRepository(this.inner);

  final SessionDraftRepository inner;
  Completer<void>? _saveGate;
  Completer<void>? _activeSaveGate;
  final Completer<void> saveFinished = Completer<void>();

  void holdNextSave() => _saveGate = Completer<void>();

  void releaseSave() => (_activeSaveGate ?? _saveGate)?.complete();

  @override
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) => inner.load(brokerProfileId: brokerProfileId, sessionKey: sessionKey);

  @override
  Future<SessionLocalDraft?> save(SessionLocalDraft draft) async {
    final gate = _saveGate;
    _saveGate = null;
    _activeSaveGate = gate;
    if (gate != null) await gate.future;
    _activeSaveGate = null;
    final stored = await inner.save(draft);
    if (!saveFinished.isCompleted) saveFinished.complete();
    return stored;
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
