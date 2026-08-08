import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_auth_barrier.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/view/open_session_sync_supervisor.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  testWidgets(
    'a gate-refresh remount under delayed retirement rebinds exactly one '
    'token-bearing socket with no anonymous reconnection',
    (tester) async {
      final database = AppDatabase(NativeDatabase.memory());
      final profile = await DriftBrokerProfileRepository(
        database,
      ).save(createTestBrokerProfile());
      final credentialStore = InMemoryCredentialStore();
      final probe = _ScriptedAuthProbe()
        ..initialVerdict = Completer<BrokerGateState>();
      final connections = <_GatedCloseConnection>[];

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          database: database,
          brokerProfile: profile,
          credentialStore: credentialStore,
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
          brokerClientLoader: (ref) async {
            final credentialKey = ref
                .watch(activeBrokerProfileProvider)
                ?.credentialKey;
            final token = credentialKey == null
                ? null
                : await credentialStore.readBrokerToken(credentialKey);
            return FakeBrokerClient(token: token);
          },
          connectionFactory:
              ({required resolver, required sessionId, required tool}) {
                final connection = _GatedCloseConnection(
                  resolverToken: resolver.token,
                );
                connections.add(connection);
                return connection;
              },
          extraOverrides: [
            brokerAuthProbeProvider.overrideWithValue(probe),
          ],
          // The production shape at the credential gate: the REAL barrier
          // owns the whole Sessions subtree, the supervisor owns background
          // residency, the deep-session page attaches interactively inside.
          homeBuilder: (sessionDetailPage) => BrokerAuthBarrier(
            child: OpenSessionSyncSupervisor(child: sessionDetailPage),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Cold start: the gate probe is still unresolved, so the barrier falls
      // through and the session attaches anonymously — its connection owns
      // the pre-token resolver.
      expect(connections, hasLength(1));
      final anonymous = connections.single;
      expect(anonymous.resolverToken, isNull);
      expect(anonymous.state, SessionDetailConnectionStatus.connected);
      final anonymousConnectsBeforeGate = anonymous.connectCount;
      final anonymousReattachesBeforeGate = anonymous.reattachCount;

      // The broker's verdict lands: unauthorized. The barrier unmounts the
      // Sessions subtree while this session's retirement is deliberately held
      // open at the transport close.
      anonymous.closeGate = Completer<void>();
      probe.initialVerdict!.complete(
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('broker-auth-barrier')), findsOneWidget);
      expect(find.byType(SessionDetailPage), findsNothing);

      // Save the token. The committed profile mutation re-runs the gate, the
      // barrier falls through on the refresh, and the subtree remounts while
      // the previous incarnation's retirement is still pending.
      final container = ProviderScope.containerOf(
        tester.element(find.byKey(const Key('broker-auth-barrier'))),
      );
      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .saveToken('fresh-token');
      await container.read(brokerGateControllerProvider.notifier).refresh();
      await tester.pump();
      await tester.pump();

      expect(find.byType(SessionDetailPage), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-retirement-handoff')),
        findsOneWidget,
        reason: 'the remounted page must not own the key mid-retirement',
      );
      await tester.pump(const Duration(seconds: 2));
      expect(
        connections,
        hasLength(1),
        reason: 'no attach may run before the retirement handoff completes',
      );
      expect(
        anonymous.connectCount,
        anonymousConnectsBeforeGate,
        reason: 'the pre-token connection must not reconnect anonymously',
      );
      expect(anonymous.reattachCount, anonymousReattachesBeforeGate);

      // Release the held close: the retirement finishes, the handoff clears,
      // and exactly one replacement socket attaches with the fresh token.
      anonymous.closeGate!.complete();
      await tester.pumpAndSettle();

      expect(connections, hasLength(2));
      final rebound = connections.last;
      expect(
        rebound.resolverToken,
        'fresh-token',
        reason: 'the replacement socket must carry the saved credential',
      );
      expect(rebound.state, SessionDetailConnectionStatus.connected);
      expect(
        find.byKey(const Key('session-detail-retirement-handoff')),
        findsNothing,
      );
      expect(
        anonymous.connectCount,
        anonymousConnectsBeforeGate,
        reason: 'the pre-token resolver must never reconnect after the save',
      );
      expect(anonymous.reattachCount, anonymousReattachesBeforeGate);
      expect(anonymous.disposeCount, 1);
      final survivors = connections
          .where(
            (connection) =>
                connection.state == SessionDetailConnectionStatus.connected,
          )
          .toList(growable: false);
      expect(
        survivors,
        hasLength(1),
        reason: 'exactly one live session socket may survive the handoff',
      );
      expect(survivors.single.resolverToken, 'fresh-token');
    },
  );

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

final class _ScriptedAuthProbe implements BrokerAuthProbe {
  /// Holds the first verdict open so the app renders ungated — and attaches
  /// anonymously — until the test lands the unauthorized classification.
  Completer<BrokerGateState>? initialVerdict;

  @override
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind = BrokerCredentialKind.sharedToken,
  }) {
    final held = initialVerdict;
    if (held != null && !held.isCompleted) {
      return held.future;
    }
    return Future.value(
      credential == null
          ? const BrokerGateState.unauthorized(
              credentialIssue: BrokerGateCredentialIssue.missing,
            )
          : const BrokerGateState.connected(),
    );
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
  Future<void> reattach({String? mode, String? reason}) async {
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
