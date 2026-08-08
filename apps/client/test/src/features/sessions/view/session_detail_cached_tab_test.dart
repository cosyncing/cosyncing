import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// N3: opening a session whose authoritative metadata has not arrived.
///
/// This is the ordinary path for a row opened from the bounded local snapshot,
/// and for any deep link that lands before the roster resolves. The detail page
/// ensures a tab for the session it is showing, and at that moment it knows the
/// identity and nothing else.
void main() {
  testWidgets(
    'a session opened before the broker responds claims no status',
    (tester) async {
      final store = InMemoryOpenSessionsStore();

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          openSessionsStore: store,
        ),
      );
      await tester.pumpAndSettle();

      final ref = store.snapshot.refs.single;
      expect(ref.key, 'claude/session-1');
      expect(
        ref.status,
        isNull,
        reason:
            'a fabricated idle would persist a claim this client never '
            'received, and a working session would be drawn as finished',
      );
    },
  );

  testWidgets('an unresolved session keeps the title it was opened with', (
    tester,
  ) async {
    // The working set already carries the cached title the row was opened from.
    // Overwriting it with the raw session id turns a named session into a
    // fingerprint the moment the user opens it.
    final store = InMemoryOpenSessionsStore(
      snapshot: const OpenSessionsSnapshot(
        refs: [
          SessionRef(
            tool: 'claude',
            id: 'session-1',
            title: 'Cached title',
            status: SessionStatus.needsInput,
          ),
        ],
        activeKey: 'claude/session-1',
      ),
    );

    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        autoConnect: false,
        openSessionsStore: store,
      ),
    );
    await tester.pumpAndSettle();

    final ref = store.snapshot.refs.single;
    expect(ref.title, 'Cached title');
    expect(
      ref.status,
      isNull,
      reason: 'a status persisted before the last restart is not current',
    );
  });
}
