import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/view/foreground_attention_host.dart';
import 'package:cosyncing_client/src/features/attention/view/visible_attention_session_scope.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

const String _tool = 'codex';
const String _sessionA = 'session-a';

final ProviderFamily<_AttentionWiring, BrokerProfile> _attentionWiringProvider =
    Provider.family<_AttentionWiring, BrokerProfile>((ref, profile) {
      return _AttentionWiring(
        focusMatcher: attentionRunFailureFocusMatcher(ref, profile),
        foregroundHandler: attentionForegroundHandler(ref, profile),
      );
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'exact onstage terminal events are consumed while Needs input presents',
    (tester) async {
      final harness = await _pumpHarness(tester);

      expect(
        harness.container.read(visibleAttentionSessionProvider)?.source,
        RosterSource.ofProfile(harness.profileA),
      );

      final completion = _event(
        id: 'visible-completion',
        cursor: 1,
        kind: 'run-finished',
      );
      await harness.deliver(completion);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
      expect(harness.notifications.shown, isEmpty);
      await _expectConsumedButUnread(
        harness.repository,
        scope: harness.scopeA,
        eventId: completion.id,
      );

      final failure = _event(
        id: 'visible-failure',
        cursor: 2,
        kind: 'run-failed',
      );
      await harness.deliver(failure);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
      await _expectConsumedButUnread(
        harness.repository,
        scope: harness.scopeA,
        eventId: failure.id,
      );

      final needsInput = _event(
        id: 'visible-needs-input',
        cursor: 3,
        kind: 'permission-required',
      );
      await harness.deliver(needsInput);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      expect(find.text('Codex: Session A needs input'), findsOneWidget);
    },
  );

  testWidgets(
    'navigating from A to B presents A exactly once '
    'and revision replay is quiet',
    (tester) async {
      final harness = await _pumpHarness(tester);
      final completion = _event(
        id: 'completion-after-session-switch',
        cursor: 1,
        kind: 'run-finished',
      );
      var foregroundWrites = 0;
      final subscription = harness.container.listen(
        foregroundAttentionEventProvider,
        (_, next) {
          if (next?.event.id == completion.id) foregroundWrites++;
        },
      );
      addTearDown(subscription.close);

      harness.router.go('/sessions/session-b');
      await tester.pumpAndSettle();
      expect(
        harness.container.read(visibleAttentionSessionProvider)?.sessionId,
        'session-b',
      );

      await harness.deliver(completion);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      expect(foregroundWrites, 1);

      await tester.tap(
        find.byKey(const Key('foreground-attention-close-button')),
      );
      await tester.pump();
      await harness.deliver(completion);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
      expect(foregroundWrites, 1);
      await _expectConsumedButUnread(
        harness.repository,
        scope: harness.scopeA,
        eventId: completion.id,
      );
    },
  );

  testWidgets(
    'a revision consumed while exact A is watched never replays after leaving',
    (tester) async {
      final harness = await _pumpHarness(tester);
      final completion = _event(
        id: 'watched-completion-does-not-replay',
        cursor: 1,
        kind: 'run-finished',
      );

      await harness.deliver(completion);
      await tester.pump(foregroundAttentionCoalesceWindow);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );

      harness.router.go('/sessions/session-b');
      await tester.pumpAndSettle();
      await harness.deliver(completion);
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
      await _expectConsumedButUnread(
        harness.repository,
        scope: harness.scopeA,
        eventId: completion.id,
      );
    },
  );

  testWidgets(
    'navigating from A to the roster presents A exactly once',
    (tester) async {
      final harness = await _pumpHarness(tester);

      harness.router.go('/sessions');
      await tester.pumpAndSettle();
      expect(harness.container.read(visibleAttentionSessionProvider), isNull);

      await harness.deliver(
        _event(
          id: 'completion-after-roster-navigation',
          cursor: 1,
          kind: 'run-finished',
        ),
      );
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      expect(
        find.text('Codex: Session A is ready to review.'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'the same tool and session on another exact broker source '
    'is not suppressed',
    (tester) async {
      final harness = await _pumpHarness(tester);
      final profileB = BrokerProfile(
        id: harness.profileA.id,
        displayName: 'Broker B',
        baseUri: Uri.parse('http://broker-b.invalid:7734'),
        createdAt: harness.profileA.createdAt,
        incarnationId: harness.profileA.incarnationId,
      );

      await harness.deliver(
        _event(
          id: 'completion-from-source-b',
          cursor: 1,
          kind: 'run-finished',
        ),
        profile: profileB,
      );
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        harness.container.read(visibleAttentionSessionProvider)?.source,
        RosterSource.ofProfile(harness.profileA),
      );
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      await _expectConsumedButUnread(
        harness.repository,
        scope: RosterSource.ofProfile(profileB).storageKey,
        eventId: 'completion-from-source-b',
      );
    },
  );

  testWidgets(
    'a profile mutation replaces the exact-source claim without suppressing '
    'the retired source',
    (tester) async {
      final harness = await _pumpHarness(tester);
      final profileB = BrokerProfile(
        id: harness.profileA.id,
        displayName: 'Broker B',
        baseUri: harness.profileA.baseUri,
        createdAt: harness.profileA.createdAt,
        incarnationId: 'inc-b',
      );

      harness.container.read(activeBrokerProfileProvider.notifier).state =
          profileB;
      await tester.pump();
      await tester.pump();

      expect(
        harness.container.read(visibleAttentionSessionProvider)?.source,
        RosterSource.ofProfile(profileB),
      );

      await harness.deliver(
        _event(
          id: 'completion-from-retired-incarnation',
          cursor: 1,
          kind: 'run-finished',
        ),
      );
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      await _expectConsumedButUnread(
        harness.repository,
        scope: harness.scopeA,
        eventId: 'completion-from-retired-incarnation',
      );
    },
  );

  testWidgets(
    'a responsively removed Session Detail cannot retain visibility',
    (tester) async {
      final harness = await _pumpHarness(
        tester,
        initialLocation: '/responsive',
        size: const Size(1100, 800),
      );
      expect(
        find.byKey(const Key('responsive-session-detail')),
        findsOneWidget,
      );
      expect(
        harness.container.read(visibleAttentionSessionProvider)?.sessionId,
        _sessionA,
      );

      tester.view.physicalSize = const Size(500, 800);
      await tester.pump();
      await tester.pump();

      expect(
        find.byKey(const Key('responsive-session-detail')),
        findsNothing,
      );
      expect(harness.container.read(visibleAttentionSessionProvider), isNull);

      await harness.deliver(
        _event(
          id: 'completion-after-responsive-removal',
          cursor: 1,
          kind: 'run-finished',
        ),
      );
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'background completion preserves OS delivery without '
    'a foreground aggregate',
    (tester) async {
      final harness = await _pumpHarness(tester);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(
        harness.lifecycle.currentState,
        BrokerAppLifecycleState.paused,
      );

      await harness.deliver(
        _event(
          id: 'background-completion',
          cursor: 1,
          kind: 'run-finished',
        ),
      );
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(harness.notifications.shown, hasLength(1));
      expect(
        harness.notifications.shown.single.payload['eventId'],
        'background-completion',
      );
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
    },
  );
}

Future<_PresentationHarness> _pumpHarness(
  WidgetTester tester, {
  String initialLocation = '/sessions/$_sessionA',
  Size size = const Size(500, 800),
}) async {
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
  addTearDown(() {
    tester.view
      ..resetPhysicalSize()
      ..resetDevicePixelRatio();
  });

  final database = AppDatabase(NativeDatabase.memory());
  addTearDown(database.close);
  final repository = DriftAttentionRepository(database);
  final profile = BrokerProfile(
    id: 'profile-a',
    displayName: 'Broker A',
    baseUri: Uri.parse('http://broker-a.invalid:7734'),
    createdAt: DateTime(2026),
    incarnationId: 'inc-a',
  );
  final lifecycle = FlutterBrokerAppLifecycleMonitor(
    initialState: BrokerAppLifecycleState.resumed,
  );
  addTearDown(lifecycle.dispose);
  final notifications = _CollectingNotificationSink();
  final container = ProviderContainer(
    overrides: [
      activeBrokerProfileProvider.overrideWith((_) => profile),
    ],
  );
  addTearDown(container.dispose);
  late final GoRouter router;
  router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) => navigationShell,
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/sessions',
                builder: (context, state) => const Scaffold(
                  body: Center(child: Text('Session roster')),
                ),
                routes: [
                  GoRoute(
                    path: ':id',
                    builder: (context, state) {
                      final id = state.pathParameters['id']!;
                      return VisibleAttentionSessionScope(
                        tool: _tool,
                        sessionId: id,
                        child: Scaffold(
                          body: Center(
                            child: Text(
                              id,
                              key: Key('session-detail-$id'),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/other',
                builder: (context, state) => const Scaffold(
                  body: Center(child: Text('Other destination')),
                ),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/responsive',
                builder: (context, state) => const _ResponsiveSessionSurface(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        builder: (context, child) => ForegroundAttentionHost(
          onOpen: () {},
          child: child ?? const SizedBox.shrink(),
        ),
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  return _PresentationHarness(
    container: container,
    repository: repository,
    profileA: profile,
    lifecycle: lifecycle,
    notifications: notifications,
    router: router,
  );
}

final class _PresentationHarness {
  const _PresentationHarness({
    required this.container,
    required this.repository,
    required this.profileA,
    required this.lifecycle,
    required this.notifications,
    required this.router,
  });

  final ProviderContainer container;
  final DriftAttentionRepository repository;
  final BrokerProfile profileA;
  final FlutterBrokerAppLifecycleMonitor lifecycle;
  final _CollectingNotificationSink notifications;
  final GoRouter router;

  String get scopeA => RosterSource.ofProfile(profileA).storageKey;

  Future<void> deliver(
    AttentionEventView event, {
    BrokerProfile? profile,
  }) async {
    final sourceProfile = profile ?? profileA;
    final wiring = container.read(_attentionWiringProvider(sourceProfile));
    final scope = RosterSource.ofProfile(sourceProfile).storageKey;
    await repository.persistAttentionEventsPage(
      brokerProfileId: scope,
      page: AttentionEventsPage(
        events: [event],
        cursor: event.cursor,
        reset: false,
        hasMore: false,
      ),
    );
    final client = BrokerClient(baseUrl: 'http://127.0.0.1:7734');
    final processor = AttentionFeedDeliveryProcessor(
      repository: repository,
      brokerProfileId: sourceProfile.id,
      brokerScopeKey: scope,
      lifecycleMonitor: lifecycle,
      notificationSink: notifications,
      focusMatcher: wiring.focusMatcher,
      onForegroundEvent: wiring.foregroundHandler,
    );
    try {
      await processor.reconcile(
        brokerClient: client,
        clientId: 'f4c-production-wiring',
      );
    } finally {
      client.close();
    }
  }
}

final class _AttentionWiring {
  const _AttentionWiring({
    required this.focusMatcher,
    required this.foregroundHandler,
  });

  final AttentionFeedRunFailureFocusMatcher focusMatcher;
  final AttentionFeedForegroundHandler foregroundHandler;
}

final class _ResponsiveSessionSurface extends StatelessWidget {
  const _ResponsiveSessionSurface();

  @override
  Widget build(BuildContext context) {
    if (!WindowSizeClass.of(context).showListDetail) {
      return const Scaffold(body: Center(child: Text('Responsive roster')));
    }
    return const VisibleAttentionSessionScope(
      tool: _tool,
      sessionId: _sessionA,
      child: Scaffold(
        key: Key('responsive-session-detail'),
        body: Center(child: Text(_sessionA)),
      ),
    );
  }
}

final class _CollectingNotificationSink implements BrokerNotificationSink {
  final List<BrokerNotificationRequest> shown = [];

  @override
  Future<void> show(BrokerNotificationRequest request) async {
    shown.add(request);
  }

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {}

  @override
  Future<void> clearAll() async {}
}

AttentionEventView _event({
  required String id,
  required int cursor,
  required String kind,
}) {
  final needsInput =
      kind == 'permission-required' || kind == 'question-required';
  final terminal = kind == 'run-finished' || kind == 'run-failed';
  return AttentionEventView.fromJson(<String, dynamic>{
    'id': id,
    'cursor': cursor,
    'revision': 1,
    'presentationRevision': 1,
    'kind': kind,
    'state': terminal ? 'resolved' : 'active',
    'severity': needsInput ? 'action-required' : 'informational',
    'dedupeKey': 'dedupe-$id',
    'createdAt': 1,
    'updatedAt': 2,
    'agent': _tool,
    'sessionId': _sessionA,
    'sessionTitle': 'Session A',
    'title': 'Event $id',
    'action': {
      'kind': 'open-session',
      'tool': _tool,
      'sessionId': _sessionA,
    },
  });
}

Future<void> _expectConsumedButUnread(
  AttentionRepository repository, {
  required String scope,
  required String eventId,
}) async {
  final states = await repository.loadDeliveryStates(scope);
  final state = states.singleWhere(
    (candidate) => candidate.event.id == eventId,
  );
  expect(state.localPresentedRevision, state.event.presentationRevision);
  expect(state.localReadAt, isNull);
  expect(state.event.dismissedAt, isNull);
}
