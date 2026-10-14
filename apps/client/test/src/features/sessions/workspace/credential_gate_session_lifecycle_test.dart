import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  testWidgets(
    'mounting the handoff shell never reads or rebuilds a controller '
    'invalidated before the retirement pump',
    (tester) async {
      const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
      final observer = _DetailProviderActivityObserver(key);
      final connections = <_GatedCloseConnection>[];
      final mountPage = ValueNotifier<bool>(true);
      addTearDown(mountPage.dispose);

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: InMemoryOpenSessionsStore(
            snapshot: const OpenSessionsSnapshot(
              refs: [
                SessionRef(
                  tool: 'claude',
                  id: 'session-1',
                  title: 'Session',
                  status: SessionStatus.idle,
                ),
              ],
              activeKey: 'claude/session-1',
            ),
          ),
          connectionFactory:
              ({required resolver, required sessionId, required tool}) {
                final connection = _GatedCloseConnection(
                  resolverToken: resolver.token,
                );
                connections.add(connection);
                return connection;
              },
          observers: [observer],
          homeBuilder: (sessionDetailPage) => ValueListenableBuilder<bool>(
            key: const Key('handoff-mount-toggle'),
            valueListenable: mountPage,
            builder: (_, mounted, _) =>
                mounted ? sessionDetailPage : const SizedBox.shrink(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(connections, hasLength(1));

      final container = ProviderScope.containerOf(
        tester.element(find.byKey(const Key('handoff-mount-toggle'))),
      );

      // The outgoing incarnation unmounts, and its retirement — sequenced
      // exactly like the supervisor's _suspendAndCloseLease — has issued the
      // closing invalidate but Riverpod's deferred dispose pass has not run:
      // the ledger key is held, and the element is invalidated, not destroyed.
      mountPage.value = false;
      await tester.pump();
      final retirement = Completer<void>();
      unawaited(
        container
            .read(sessionDetailRetirementLedgerProvider)
            .register(key, retirement.future),
      );
      container.invalidate(sessionDetailControllerProvider(key));
      observer.startRecording();

      // Remount inside the invalidate → dispose-pass window. The page must
      // come up as the subscription-free handoff shell without touching the
      // session's detail provider: a read here either flushes the invalidated
      // element — rebuilding the retired notifier in place — or builds a
      // premature replacement the retirement contract says may not exist yet.
      mountPage.value = true;
      await tester.pump();

      expect(
        find.byKey(const Key('session-detail-retirement-handoff')),
        findsOneWidget,
      );
      expect(
        observer.violations,
        isEmpty,
        reason:
            'mounting the handoff shell must neither rebuild the invalidated '
            'controller nor build a replacement before the key is free',
      );
      expect(connections, hasLength(1));

      // The dispose pass runs. The invalidated element must be destroyed —
      // not revived by anything the shell did — and the page must still not
      // touch the provider until the ledger key clears.
      await container.pump();
      await tester.pump();
      expect(observer.disposals, 1);
      expect(observer.violations, isEmpty);
      expect(connections, hasLength(1));

      // Retirement settles: only now may the page build the fresh controller
      // and attach it. Production residency belongs to the supervisor, which
      // re-leases the key the moment its retirement completes; without that
      // lease the controller the page reads mid-cascade has no listener yet
      // and autoDispose would reap it before the page's build watches it, so
      // the test holds the equivalent lease itself.
      observer.stopRecording();
      retirement.complete();
      final residency = container.listen(
        sessionDetailControllerProvider(key),
        (_, _) {},
      );
      addTearDown(residency.close);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-retirement-handoff')),
        findsNothing,
      );
      expect(
        connections,
        hasLength(2),
        reason: 'the fresh controller attaches only after the handoff',
      );
      expect(
        connections.last.state,
        SessionDetailConnectionStatus.connected,
      );
      expect(
        container.read(sessionDetailControllerProvider(key)).connectionStatus,
        SessionDetailConnectionStatus.connected,
        reason: 'the fresh controller owns the live transport',
      );
      expect(observer.disposals, 1);
    },
  );
}

/// Records every lifecycle event Riverpod reports for one session's detail
/// provider, so a test can prove a window contained NO builds of it.
///
/// While recording, any didAddProvider (a premature replacement was built) or
/// didUpdateProvider (the invalidated element was flushed and the retired
/// notifier rebuilt in place) for the watched key is a violation. Disposals
/// are counted separately: the retirement's invalidate must end in exactly
/// one real element destruction.
final class _DetailProviderActivityObserver extends ProviderObserver {
  _DetailProviderActivityObserver(this.key);

  final SessionDetailKey key;
  final List<String> violations = [];
  int disposals = 0;
  bool _recording = false;

  void startRecording() => _recording = true;
  void stopRecording() => _recording = false;

  bool _isWatchedProvider(ProviderBase<Object?> provider) =>
      identical(provider.from, sessionDetailControllerProvider) &&
      provider.argument == key;

  @override
  void didAddProvider(
    ProviderBase<Object?> provider,
    Object? value,
    ProviderContainer container,
  ) {
    if (_recording && _isWatchedProvider(provider)) {
      violations.add('didAddProvider');
    }
  }

  @override
  void didUpdateProvider(
    ProviderBase<Object?> provider,
    Object? previousValue,
    Object? newValue,
    ProviderContainer container,
  ) {
    if (_recording && _isWatchedProvider(provider)) {
      violations.add('didUpdateProvider');
    }
  }

  @override
  void didDisposeProvider(
    ProviderBase<Object?> provider,
    ProviderContainer container,
  ) {
    if (_isWatchedProvider(provider)) {
      disposals++;
    }
  }
}

/// A scripted connection whose [close] can be held open, modelling a
/// retirement stuck tearing down a slow or dead socket.
final class _GatedCloseConnection extends ScriptedSessionDetailConnection {
  _GatedCloseConnection({required this.resolverToken})
    : super(events: const []);

  final String? resolverToken;
  Completer<void>? closeGate;
  int reattachCount = 0;

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
  }) async {
    reattachCount++;
    await super.reattach(mode: mode, reason: reason);
  }

  @override
  Future<void> close({bool reconnect = false}) async {
    final gate = closeGate;
    if (gate != null) {
      await gate.future;
    }
    await super.close(reconnect: reconnect);
  }
}
