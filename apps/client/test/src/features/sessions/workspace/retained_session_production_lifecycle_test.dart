import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_auth_barrier.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/open_session_sync_supervisor.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/retained_session_pages.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  testWidgets(
    'production retained pages preserve one lifecycle owner through switches, '
    'eviction, source replacement, and credential recovery',
    (tester) async {
      final database = AppDatabase(NativeDatabase.memory());
      final repository = DriftBrokerProfileRepository(database);
      final profile = await repository.save(createTestBrokerProfile());
      final credentialStore = InMemoryCredentialStore();
      final authProbe = _HeldAuthProbe();
      final connections = _ConnectionLedger();
      final providers = _DetailProviderLedger();
      final openStore = InMemoryOpenSessionsStore(
        snapshot: const OpenSessionsSnapshot(
          refs: [_a, _b],
          activeKey: 'claude/a',
        ),
      );
      final driveIntents = DriftSessionDriveIntentStore(database);
      await driveIntents.rememberAppCreated(
        brokerProfileId: RosterSource.ofProfile(profile).storageKey,
        tool: _a.tool,
        sessionId: _a.id,
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          database: database,
          brokerProfile: profile,
          credentialStore: credentialStore,
          openSessionsStore: openStore,
          driveIntentStore: driveIntents,
          observers: [providers],
          brokerClientLoader: (ref) async {
            final active = ref.watch(activeBrokerProfileProvider);
            if (active == null) return null;
            final credentialKey = active.credentialKey;
            final token = credentialKey == null
                ? null
                : await credentialStore.readBrokerToken(credentialKey);
            return _LifecycleBrokerClient(profile: active, token: token);
          },
          connectionFactory:
              ({required resolver, required sessionId, required tool}) =>
                  connections.create(
                    baseUrl: resolver.baseUrl,
                    token: resolver.token,
                    tool: tool,
                    sessionId: sessionId,
                  ),
          extraOverrides: [
            brokerAuthProbeProvider.overrideWithValue(authProbe),
          ],
          homeBuilder: (_) => const BrokerAuthBarrier(
            child: OpenSessionSyncSupervisor(
              child: _ProductionRetainedSessionHost(),
            ),
          ),
        ),
      );

      await _pumpUntil(
        tester,
        () =>
            connections.forSession(_a.key).length == 1 &&
            connections.forSession(_b.key).length == 1 &&
            connections.latest(_a.key).attachCount == 2 &&
            connections.latest(_b.key).attachCount == 1,
      );
      final container = ProviderScope.containerOf(
        tester.element(find.byType(_ProductionRetainedSessionHost)),
      );
      final open = container.read(openSessionsControllerProvider.notifier);
      const aKey = SessionDetailKey(tool: 'claude', sessionId: 'a');
      const bKey = SessionDetailKey(tool: 'claude', sessionId: 'b');
      final originalA = connections.latest(_a.key);
      final originalB = connections.latest(_b.key);
      final originalAProvider = container.read(
        sessionDetailControllerProvider(aKey).notifier,
      );
      final originalBProvider = container.read(
        sessionDetailControllerProvider(bKey).notifier,
      );

      expect(providers.adds[aKey], 1);
      expect(providers.adds[bKey], 1);
      expect(originalA.reattachModes, ['resume']);
      expect(originalA.reattachReasons, [kDriveAttachReasonAppRestore]);
      expect(originalA.connectCount, 1);
      expect(originalA.attachCount, 2);
      expect(originalB.reattachModes, isEmpty);
      expect(originalB.attachCount, 1);
      expect(_canMutate(container, aKey), isTrue);

      // A → B → A changes only presentation. Both production controllers and
      // their sockets remain the exact same objects, and A keeps Drive.
      open.activate(_b.key);
      await tester.pump();
      open.activate(_a.key);
      await tester.pump();
      expect(connections.latest(_a.key), same(originalA));
      expect(connections.latest(_b.key), same(originalB));
      expect(originalA.attachCount, 2);
      expect(originalB.attachCount, 1);
      expect(providers.adds[aKey], 1);
      expect(providers.adds[bKey], 1);
      expect(
        container.read(sessionDetailControllerProvider(aKey).notifier),
        same(originalAProvider),
      );
      expect(
        container.read(sessionDetailControllerProvider(bKey).notifier),
        same(originalBProvider),
      );
      expect(_canMutate(container, aKey), isTrue);

      // Closing B is a lifecycle operation, not a cache operation: its
      // supervisor lease closes the socket and retires the provider once.
      open.close(_b.key);
      await _pumpUntil(
        tester,
        () => providers.disposals[bKey] == 1 && originalB.disposeCount == 1,
      );
      expect(originalB.closeCount, 1);
      expect(providers.adds[bKey], 1);
      expect(originalA.closeCount, 0);

      // Fill the five-page UI budget, then exceed it. A's SessionDetailPage is
      // evicted, but OpenSessionSyncSupervisor still owns its production
      // controller and socket.
      for (final session in _evictionRefs) {
        open.open(session);
        await _pumpUntil(
          tester,
          () =>
              connections.forSession(session.key).length == 1 &&
              connections.latest(session.key).attachCount == 1,
        );
      }
      expect(
        find.byKey(
          const Key('retained-session-page-claude/a'),
          skipOffstage: false,
        ),
        findsNothing,
      );
      expect(providers.adds[aKey], 1);
      expect(providers.disposals[aKey] ?? 0, 0);
      expect(
        container.read(sessionDetailControllerProvider(aKey).notifier),
        same(originalAProvider),
      );
      expect(originalA.closeCount, 0);
      expect(originalA.attachCount, 2);

      // Returning to evicted A cold-mounts only its page tree. The same
      // provider, socket, and Drive authority are adopted without reattach.
      open.activate(_a.key);
      await tester.pump();
      expect(
        find.byKey(const Key('retained-session-page-claude/a')),
        findsOneWidget,
      );
      expect(connections.latest(_a.key), same(originalA));
      expect(originalA.attachCount, 2);
      expect(providers.adds[aKey], 1);
      expect(
        container.read(sessionDetailControllerProvider(aKey).notifier),
        same(originalAProvider),
      );
      expect(_canMutate(container, aKey), isTrue);

      // Retire the eviction fixtures so source and credential transitions have
      // one exact key whose counts stay easy to audit.
      for (final session in _evictionRefs) {
        open.close(session.key);
      }
      await _pumpUntil(
        tester,
        () => _evictionRefs.every((session) {
          final key = SessionDetailKey(
            tool: session.tool,
            sessionId: session.id,
          );
          return providers.disposals[key] == 1 &&
              connections.latest(session.key).disposeCount == 1;
        }),
      );
      expect(openStore.snapshot.refs, [_a]);

      // Re-point the saved profile. The equal session key must wait for the
      // old provider/socket retirement, then attach once against the new
      // endpoint with a fresh provider. Drive provenance is source-qualified,
      // so the new machine must fail closed to Observe.
      final replacementProfile = await repository.save(
        profile.copyWith(baseUri: Uri.parse('http://127.0.0.1:8834')),
      );
      container.read(activeBrokerProfileProvider.notifier).state =
          replacementProfile;
      await _pumpUntil(
        tester,
        () =>
            connections.forSession(_a.key).length == 2 &&
            connections.latest(_a.key).attachCount == 1,
      );
      for (var settle = 0; settle < 20; settle++) {
        await tester.pump(const Duration(milliseconds: 1));
      }
      final sourceReboundA = connections.latest(_a.key);
      expect(connections.forSession(_a.key), hasLength(2));
      expect(providers.adds[aKey], 2);
      expect(providers.disposals[aKey], 1);
      expect(originalA.closeCount, 1);
      expect(originalA.disposeCount, 1);
      expect(sourceReboundA.baseUrl, 'http://127.0.0.1:8834');
      expect(sourceReboundA.token, isNull);
      expect(sourceReboundA.connectCount, 1);
      expect(sourceReboundA.reattachModes, isEmpty);
      expect(sourceReboundA.attachCount, 1);
      expect(_canMutate(container, aKey), isFalse);

      // Take over on the replacement source records new, exact-source Drive
      // provenance through the production controller flow. Credential
      // recovery below must restore this authority without consulting the old
      // endpoint's record.
      final takeover = container
          .read(sessionDetailControllerProvider(aKey).notifier)
          .takeOver();
      await _pumpUntil(
        tester,
        () => sourceReboundA.reattachReasons.length == 1,
      );
      expect(await takeover, isTrue);
      expect(sourceReboundA.reattachModes, ['resume']);
      expect(sourceReboundA.reattachReasons, [kDriveAttachReasonTakeover]);
      expect(sourceReboundA.attachCount, 2);
      expect(_canMutate(container, aKey), isTrue);
      final replacementProvenance = await _waitForProvenance(
        tester,
        driveIntents,
        brokerProfileId: RosterSource.ofProfile(
          replacementProfile,
        ).storageKey,
        tool: _a.tool,
        sessionId: _a.id,
      );
      expect(
        replacementProvenance.kind,
        SessionDriveProvenanceKind.terminalTakeover,
      );

      // Refuse the anonymous credential while holding the source-rebound
      // socket close. A gate recovery may remount the production tree, but it
      // cannot build a provider or socket until that retirement completes.
      sourceReboundA.closeGate = Completer<void>();
      authProbe.initialVerdict.complete(
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );
      await _pumpUntil(
        tester,
        () =>
            find
                .byKey(const Key('broker-auth-barrier'))
                .evaluate()
                .isNotEmpty &&
            sourceReboundA.closeStarted == 1,
      );
      expect(find.byType(SessionDetailPage), findsNothing);
      expect(connections.forSession(_a.key), hasLength(2));

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
      );
      expect(
        connections.forSession(_a.key),
        hasLength(2),
        reason: 'credential recovery must wait for provider retirement',
      );

      sourceReboundA.closeGate!.complete();
      await _pumpUntil(
        tester,
        () => connections.forSession(_a.key).length == 3,
      );
      await _pumpUntil(
        tester,
        () => find
            .byKey(const Key('session-detail-retirement-handoff'))
            .evaluate()
            .isEmpty,
      );
      final credentialReboundA = connections.latest(_a.key);
      await _pumpUntil(
        tester,
        () => credentialReboundA.reattachModes.length == 1,
      );
      expect(providers.adds[aKey], 3);
      expect(providers.disposals[aKey], 2);
      expect(sourceReboundA.closeCount, 1);
      expect(sourceReboundA.disposeCount, 1);
      expect(credentialReboundA.baseUrl, 'http://127.0.0.1:8834');
      expect(credentialReboundA.token, 'fresh-token');
      expect(credentialReboundA.connectCount, 1);
      expect(credentialReboundA.reattachModes, ['resume']);
      expect(credentialReboundA.reattachReasons, [
        kDriveAttachReasonLeaseRestore,
      ]);
      expect(credentialReboundA.attachCount, 2);
      expect(_canMutate(container, aKey), isTrue);
      expect(
        connections.forSession(_a.key).where((connection) {
          return connection.state == SessionDetailConnectionStatus.connected;
        }),
        hasLength(1),
      );
    },
  );
}

bool _canMutate(ProviderContainer container, SessionDetailKey key) =>
    SessionControlView.fromSessionInfo(
      container.read(sessionDetailControllerProvider(key)).sessionInfo,
    ).canMutate;

Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  int limit = 120,
}) async {
  for (var attempt = 0; attempt < limit; attempt++) {
    if (condition()) return;
    await tester.pump(const Duration(milliseconds: 1));
  }
  expect(
    condition(),
    isTrue,
    reason: 'condition did not settle in $limit pumps',
  );
}

Future<SessionDriveProvenance> _waitForProvenance(
  WidgetTester tester,
  SessionDriveIntentStore store, {
  required String brokerProfileId,
  required String tool,
  required String sessionId,
}) async {
  for (var attempt = 0; attempt < 120; attempt++) {
    final provenance = await store.read(
      brokerProfileId: brokerProfileId,
      tool: tool,
      sessionId: sessionId,
    );
    if (provenance != null) return provenance;
    await tester.pump(const Duration(milliseconds: 1));
  }
  throw TestFailure('Drive provenance did not settle');
}

class _ProductionRetainedSessionHost extends ConsumerWidget {
  const _ProductionRetainedSessionHost();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    final openAsync = ref.watch(openSessionsControllerProvider);
    final open = openAsync.isLoading || openAsync.hasError
        ? const OpenSessionsState()
        : openAsync.valueOrNull ?? const OpenSessionsState();
    return Scaffold(
      body: RetainedSessionPages(
        source: source,
        open: open,
        builder: (context, session) => SessionDetailPage(
          key: ValueKey<SessionDetailKey>(
            SessionDetailKey(tool: session.tool, sessionId: session.id),
          ),
          tool: session.tool,
          sessionId: session.id,
          embedded: true,
        ),
      ),
    );
  }
}

final class _HeldAuthProbe implements BrokerAuthProbe {
  final Completer<BrokerGateState> initialVerdict =
      Completer<BrokerGateState>();

  @override
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind = BrokerCredentialKind.sharedToken,
  }) {
    if (!initialVerdict.isCompleted) return initialVerdict.future;
    return Future.value(
      credential == null
          ? const BrokerGateState.unauthorized(
              credentialIssue: BrokerGateCredentialIssue.missing,
            )
          : const BrokerGateState.connected(),
    );
  }
}

final class _LifecycleBrokerClient extends BrokerClient {
  _LifecycleBrokerClient({required BrokerProfile profile, super.token})
    : super(
        baseUrl: profile.baseUri.toString(),
        clientProfileId: profile.id,
        clientProfileIncarnation: profile.incarnationId,
      );

  @override
  Future<List<AgentInfo>> listAgents() async => [fakeAgentInfo()];

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async => const ScheduleListResponse(schedules: []);
}

final class _ConnectionLedger {
  final List<_LifecycleConnection> connections = [];

  _LifecycleConnection create({
    required String baseUrl,
    required String? token,
    required String tool,
    required String sessionId,
  }) {
    final connection = _LifecycleConnection(
      baseUrl: baseUrl,
      token: token,
      tool: tool,
      sessionId: sessionId,
    );
    connections.add(connection);
    return connection;
  }

  List<_LifecycleConnection> forSession(String key) => connections
      .where((connection) => connection.key == key)
      .toList(growable: false);

  _LifecycleConnection latest(String key) => forSession(key).last;
}

final class _LifecycleConnection extends FakeSessionDetailConnection {
  _LifecycleConnection({
    required this.baseUrl,
    required this.token,
    required String tool,
    required String sessionId,
  }) {
    this.tool = tool;
    this.sessionId = sessionId;
  }

  final String baseUrl;
  final String? token;
  Completer<void>? closeGate;
  int closeStarted = 0;
  bool _bootstrapped = false;

  String get key => '$tool/$sessionId';
  int get attachCount => connectCount + reattachModes.length;

  @override
  Future<void> connect() async {
    await super.connect();
    _publishBootstrap(driving: false);
  }

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    SessionOwnerRevision? ownerRevision,
  }) async {
    await super.reattach(mode: mode, reason: reason);
    _publishBootstrap(driving: mode == 'resume');
  }

  @override
  Future<void> close({bool reconnect = false}) async {
    closeStarted++;
    final gate = closeGate;
    if (gate != null) await gate.future;
    await super.close(reconnect: reconnect);
  }

  void _publishBootstrap({required bool driving}) {
    if (!_bootstrapped) {
      _bootstrapped = true;
      emitEvent(defaultControllerHello);
      emitEvent(const HistoryWireEvent(messages: []));
    }
    emitEvent(
      SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': sessionId,
          'tool': tool,
          'title': 'Lifecycle $sessionId',
          'status': 'idle',
          'attachMode': driving ? 'resume' : 'observe',
          'control': {
            'drive': {
              'state': driving ? 'driving' : 'observing',
              'supported': true,
            },
            'terminalSync': const {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
        }),
      ),
    );
  }
}

final class _DetailProviderLedger extends ProviderObserver {
  final Map<SessionDetailKey, int> adds = {};
  final Map<SessionDetailKey, int> disposals = {};

  SessionDetailKey? _key(ProviderBase<Object?> provider) {
    if (!identical(provider.from, sessionDetailControllerProvider)) return null;
    return provider.argument as SessionDetailKey?;
  }

  @override
  void didAddProvider(
    ProviderBase<Object?> provider,
    Object? value,
    ProviderContainer container,
  ) {
    final key = _key(provider);
    if (key != null) adds[key] = (adds[key] ?? 0) + 1;
  }

  @override
  void didDisposeProvider(
    ProviderBase<Object?> provider,
    ProviderContainer container,
  ) {
    final key = _key(provider);
    if (key != null) disposals[key] = (disposals[key] ?? 0) + 1;
  }
}

const _a = SessionRef(
  tool: 'claude',
  id: 'a',
  title: 'A',
  status: SessionStatus.idle,
);
const _b = SessionRef(
  tool: 'claude',
  id: 'b',
  title: 'B',
  status: SessionStatus.idle,
);
const _evictionRefs = <SessionRef>[
  SessionRef(
    tool: 'claude',
    id: 'c',
    title: 'C',
    status: SessionStatus.idle,
  ),
  SessionRef(
    tool: 'claude',
    id: 'd',
    title: 'D',
    status: SessionStatus.idle,
  ),
  SessionRef(
    tool: 'claude',
    id: 'e',
    title: 'E',
    status: SessionStatus.idle,
  ),
  SessionRef(
    tool: 'claude',
    id: 'f',
    title: 'F',
    status: SessionStatus.idle,
  ),
  SessionRef(
    tool: 'claude',
    id: 'g',
    title: 'G',
    status: SessionStatus.idle,
  ),
];
