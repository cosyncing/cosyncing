import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('filters agents by authoritative create capability', () async {
    final fake = _FakeBrokerClient(
      agents: [
        _agent('codex', canCreate: true),
        _agent('watch', canCreate: false),
      ],
    );
    final container = _container(fake);
    addTearDown(container.dispose);

    await container.read(newSessionControllerProvider.notifier).loadAgents();

    expect(
      container
          .read(newSessionControllerProvider)
          .agents
          .map((agent) => agent.id),
      ['codex'],
    );
  });

  test('pre-session catalog retention is explicitly bounded', () async {
    final fake = _FakeBrokerClient(
      agents: [_agent('codex', canCreate: true)],
      models: List.generate(
        newSessionModelCatalogMaxOptions + 10,
        (index) => ModelOption(
          providerID: 'provider',
          modelID: 'model-$index',
          label: 'Model $index',
        ),
      ),
    );
    final container = _container(fake);
    addTearDown(container.dispose);

    final controller = container.read(newSessionControllerProvider.notifier);
    await controller.loadAgents();
    await controller.loadModels('codex');

    final state = container.read(newSessionControllerProvider);
    expect(state.models, hasLength(newSessionModelCatalogMaxOptions));
    expect(state.models.last.modelID, 'model-2047');
  });

  test(
    'adapter without a pre-session catalog stays unavailable and is not called',
    () async {
      final fake = _FakeBrokerClient(
        agents: [
          _agent(
            'legacy',
            canCreate: true,
            canSelectModelAtCreation: false,
          ),
        ],
      );
      final container = _container(fake);
      addTearDown(container.dispose);
      final controller = container.read(
        newSessionControllerProvider.notifier,
      );

      await controller.loadAgents();
      await controller.loadModels('legacy');

      final state = container.read(newSessionControllerProvider);
      expect(
        state.modelCatalogPhase,
        NewSessionModelCatalogPhase.unavailable,
      );
      expect(state.modelTool, 'legacy');
      expect(state.models, isEmpty);
      expect(fake.listModelCalls, 0);
    },
  );

  for (final lateFailure in [false, true]) {
    test(
      'Tool A held, Tool B finishes, then Tool A late '
      '${lateFailure ? 'failure' : 'success'} is ignored',
      () async {
        final codex = Completer<ModelCatalogResponse>();
        final claude = Completer<ModelCatalogResponse>();
        final fake = _HeldBrokerClient(
          agents: [
            _agent('codex', canCreate: true),
            _agent('claude', canCreate: true),
          ],
          catalogGates: {'codex': codex, 'claude': claude},
        );
        final container = _container(fake);
        addTearDown(container.dispose);
        final controller = container.read(
          newSessionControllerProvider.notifier,
        );
        await controller.loadAgents();

        final heldA = controller.loadModels('codex');
        await Future<void>.delayed(Duration.zero);
        final finishedB = controller.loadModels('claude');
        claude.complete(
          _catalog('claude', 'anthropic', 'sonnet'),
        );
        await finishedB;
        if (lateFailure) {
          codex.completeError(StateError('late Codex catalog failure'));
        } else {
          codex.complete(_catalog('codex', 'openai', 'gpt-late'));
        }
        await heldA;

        final state = container.read(newSessionControllerProvider);
        expect(state.modelTool, 'claude');
        expect(state.models.single.modelID, 'sonnet');
        expect(state.modelCatalogPhase, NewSessionModelCatalogPhase.ready);
        expect(state.modelError, isNull);
      },
    );
  }

  for (final lateFailure in [false, true]) {
    test(
      'Broker A agent request held, switch to B, then A late '
      '${lateFailure ? 'failure' : 'success'} is ignored',
      () async {
        final agentsA = Completer<List<AgentInfo>>();
        final agentsB = Completer<List<AgentInfo>>();
        final clientA = _HeldBrokerClient(agentsGate: agentsA);
        final clientB = _HeldBrokerClient(agentsGate: agentsB);
        final container = _sourceSwitchContainer(clientA, clientB);
        addTearDown(container.dispose);
        final controller = container.read(
          newSessionControllerProvider.notifier,
        );

        final heldA = controller.loadAgents();
        await Future<void>.delayed(Duration.zero);
        container.read(activeBrokerProfileProvider.notifier).state = _profile(
          'p2',
        );
        await Future<void>.delayed(Duration.zero);
        final controllerB = container.read(
          newSessionControllerProvider.notifier,
        );
        final finishedB = controllerB.loadAgents();
        agentsB.complete([_agent('claude', canCreate: true)]);
        await finishedB;
        if (lateFailure) {
          agentsA.completeError(StateError('late broker A agents failure'));
        } else {
          agentsA.complete([_agent('codex', canCreate: true)]);
        }
        await heldA;

        final state = container.read(newSessionControllerProvider);
        expect(state.agents.map((agent) => agent.id), ['claude']);
        expect(state.error, isNull);
      },
    );
  }

  for (final lateFailure in [false, true]) {
    test(
      'Broker A catalog request held, switch to B, then A late '
      '${lateFailure ? 'failure' : 'success'} is ignored',
      () async {
        final catalogA = Completer<ModelCatalogResponse>();
        final catalogB = Completer<ModelCatalogResponse>();
        final clientA = _HeldBrokerClient(
          agents: [_agent('codex', canCreate: true)],
          catalogGates: {'codex': catalogA},
        );
        final clientB = _HeldBrokerClient(
          agents: [_agent('claude', canCreate: true)],
          catalogGates: {'claude': catalogB},
        );
        final container = _sourceSwitchContainer(clientA, clientB);
        addTearDown(container.dispose);
        final controller = container.read(
          newSessionControllerProvider.notifier,
        );
        await controller.loadAgents();

        final heldA = controller.loadModels('codex');
        await Future<void>.delayed(Duration.zero);
        container.read(activeBrokerProfileProvider.notifier).state = _profile(
          'p2',
        );
        await Future<void>.delayed(Duration.zero);
        final controllerB = container.read(
          newSessionControllerProvider.notifier,
        );
        await controllerB.loadAgents();
        final finishedB = controllerB.loadModels('claude');
        catalogB.complete(_catalog('claude', 'anthropic', 'opus'));
        await finishedB;
        if (lateFailure) {
          catalogA.completeError(StateError('late broker A catalog failure'));
        } else {
          catalogA.complete(_catalog('codex', 'openai', 'gpt-late'));
        }
        await heldA;

        final state = container.read(newSessionControllerProvider);
        expect(state.modelTool, 'claude');
        expect(state.models.single.modelID, 'opus');
        expect(state.modelCatalogPhase, NewSessionModelCatalogPhase.ready);
        expect(state.modelError, isNull);
      },
    );
  }

  test(
    'submits edited directory and broker resume intent exactly once',
    () async {
      final fake = _FakeBrokerClient(
        agents: [_agent('codex', canCreate: true)],
      );
      final driveStore = _RecordingDriveIntentStore();
      final container = _container(fake, driveStore: driveStore);
      addTearDown(container.dispose);
      final controller = container.read(newSessionControllerProvider.notifier);
      await controller.loadAgents();

      final session = await controller.create(
        tool: 'codex',
        directory: ' /edited/project ',
        title: ' My session ',
      );

      expect(session?.id, 'created');
      expect(fake.lastDirectory, '/edited/project');
      expect(fake.lastTitle, 'My session');
      const key = SessionDetailKey(tool: 'codex', sessionId: 'created');
      final intents = container.read(createdSessionAttachIntentsProvider);
      // The intent is profile-qualified: another broker's identical
      // tool/session id must not consume it.
      expect(intents.takeResume(_scope('other-profile'), key), isFalse);
      expect(intents.takeResume(_scope('local'), key), isTrue);
      expect(intents.takeResume(_scope('local'), key), isFalse);
      expect(driveStore.appCreatedKeys, ['${_scope('local')}/codex/created']);
    },
  );

  test(
    'a profile switch during held client resolution cannot mispair or close '
    "the create operation's client",
    () async {
      final sharedP1 = _FakeBrokerClient(agents: const []);
      final sharedP2 = _FakeBrokerClient(agents: const []);
      final operationP1 = _FakeBrokerClient(agents: const []);
      final operationP2 = _FakeBrokerClient(agents: const []);
      final driveStore = _RecordingDriveIntentStore();
      final clientGate = Completer<void>();
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith((ref) => _profile('p1')),
          // Production-shaped SHARED provider: auto-disposed and closed when
          // a profile switch invalidates its build. The create flow must not
          // depend on this client surviving its awaits.
          brokerClientProvider.overrideWith((ref) async {
            final profile = ref.watch(activeBrokerProfileProvider);
            final client = profile?.id == 'p2' ? sharedP2 : sharedP1;
            ref.onDispose(client.close);
            return client;
          }),
          // Operation-owned factory: resolution is HELD, and the client is
          // built from the profile the operation captured — not from
          // whatever profile is active when the future resolves.
          brokerClientFactoryProvider.overrideWith(
            (ref) => (profile) async {
              await clientGate.future;
              return profile.id == 'p2' ? operationP2 : operationP1;
            },
          ),
          sessionDriveIntentStoreProvider.overrideWithValue(driveStore),
        ],
      );
      addTearDown(container.dispose);
      // Something else in the app holds the shared client, as production does.
      final sharedSub = container.listen(
        brokerClientProvider.future,
        (_, _) {},
      );
      addTearDown(sharedSub.close);
      await container.read(brokerClientProvider.future);
      final service = container.read(newSessionLaunchServiceProvider);

      final pending = service.create(
        const NewSessionLaunchRequest(
          tool: 'codex',
          directory: '',
          title: '',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      // The user switches brokers while the operation's client resolution is
      // still pending. The switch closes the shared p1 client (the delayed
      // hazard) — the operation's own client must be unaffected.
      container.read(activeBrokerProfileProvider.notifier).state = _profile(
        'p2',
      );
      await Future<void>.delayed(Duration.zero);
      expect(sharedP1.closeCalls, 1);
      clientGate.complete();

      // The operation used the client built from its CAPTURED profile p1,
      // never a closed one and never p2's; every profile-qualified record
      // names p1. Because the active broker is p2 by the time creation
      // finishes, the service refuses to open the session there.
      await expectLater(pending, throwsStateError);
      expect(operationP1.createCalls, 1);
      expect(operationP1.createdAfterClose, isFalse);
      expect(operationP1.closeCalls, 1, reason: 'released by the operation');
      expect(operationP2.createCalls, 0);
      expect(sharedP1.createCalls, 0);
      expect(sharedP2.createCalls, 0);
      const key = SessionDetailKey(tool: 'codex', sessionId: 'created');
      final intents = container.read(createdSessionAttachIntentsProvider);
      expect(intents.takeResume(_scope('p2'), key), isFalse);
      expect(intents.takeResume(_scope('p1'), key), isTrue);
      expect(driveStore.appCreatedKeys, ['${_scope('p1')}/codex/created']);
    },
  );

  test(
    'a broker switch while the create request is in flight refuses to open '
    'the session against the newly active broker',
    () async {
      final fake = _FakeBrokerClient(
        agents: [_agent('codex', canCreate: true)],
      )..createGate = Completer<void>();
      final driveStore = _RecordingDriveIntentStore();
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith((ref) => _profile('p1')),
          brokerClientFactoryProvider.overrideWith(
            (ref) =>
                (profile) async => fake,
          ),
          sessionDriveIntentStoreProvider.overrideWithValue(driveStore),
        ],
      );
      addTearDown(container.dispose);
      final service = container.read(newSessionLaunchServiceProvider);

      final pending = service.create(
        const NewSessionLaunchRequest(
          tool: 'codex',
          directory: '',
          title: '',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      container.read(activeBrokerProfileProvider.notifier).state = _profile(
        'p2',
      );
      fake.createGate!.complete();

      // The session exists on p1's broker; opening it against p2 would show
      // the wrong (or a missing) session, so the create surfaces an error.
      await expectLater(pending, throwsStateError);
      expect(fake.createdAfterClose, isFalse);
      expect(fake.closeCalls, 1, reason: 'released by the operation');
      // Its one-shot Drive intent and durable provenance were still recorded
      // under the OWNING profile, so it drives normally once the user
      // returns to that broker.
      const key = SessionDetailKey(tool: 'codex', sessionId: 'created');
      final intents = container.read(createdSessionAttachIntentsProvider);
      expect(intents.takeResume(_scope('p2'), key), isFalse);
      expect(intents.takeResume(_scope('p1'), key), isTrue);
      expect(driveStore.appCreatedKeys, ['${_scope('p1')}/codex/created']);
    },
  );

  test(
    'blank global directory is omitted instead of inheriting a cwd',
    () async {
      final fake = _FakeBrokerClient(
        agents: [_agent('codex', canCreate: true)],
      );
      final container = _container(fake);
      addTearDown(container.dispose);
      final controller = container.read(newSessionControllerProvider.notifier);
      await controller.loadAgents();

      await controller.create(tool: 'codex', directory: '  ', title: '');

      expect(fake.lastDirectory, isNull);
      expect(fake.lastTitle, isNull);
    },
  );
}

ProviderContainer _container(
  BrokerClient fake, {
  _RecordingDriveIntentStore? driveStore,
}) => ProviderContainer(
  overrides: [
    brokerClientProvider.overrideWith((ref) async => fake),
    // The create flow builds an operation-owned client from the captured
    // profile through this factory; loadAgents keeps the shared provider.
    brokerClientFactoryProvider.overrideWith(
      (ref) =>
          (profile) async => fake,
    ),
    activeBrokerProfileProvider.overrideWith((ref) => _profile('local')),
    sessionDriveIntentStoreProvider.overrideWithValue(
      driveStore ?? _RecordingDriveIntentStore(),
    ),
  ],
);

ProviderContainer _sourceSwitchContainer(
  BrokerClient clientA,
  BrokerClient clientB,
) => ProviderContainer(
  overrides: [
    activeBrokerProfileProvider.overrideWith((ref) => _profile('p1')),
    brokerClientProvider.overrideWith((ref) async {
      final profile = ref.watch(activeBrokerProfileProvider);
      return profile?.id == 'p2' ? clientB : clientA;
    }),
    brokerClientFactoryProvider.overrideWith(
      (ref) =>
          (profile) async => profile.id == 'p2' ? clientB : clientA,
    ),
    sessionDriveIntentStoreProvider.overrideWithValue(
      _RecordingDriveIntentStore(),
    ),
  ],
);

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026, 7, 24),
);

/// Broker scope key (`RosterSource.storageKey`) [_profile] resolves to — what
/// intents and provenance are actually recorded under.
String _scope(String id) => RosterSource.ofProfile(_profile(id)).storageKey;

AgentInfo _agent(
  String id, {
  required bool canCreate,
  bool canSelectModelAtCreation = true,
}) => AgentInfo(
  id: id,
  displayName: id.toUpperCase(),
  capabilities: const AgentCapabilities(
    integrationKind: IntegrationKind.jsonrpcStdio,
    attachModes: [AttachMode.resume],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: PermissionGranularity.none,
  ),
  canCreateSession: canCreate,
  canSelectModelAtCreation: canSelectModelAtCreation,
  canRenameNative: false,
  canFork: false,
  canClone: false,
  canTranscriptExport: false,
);

ModelCatalogResponse _catalog(
  String tool,
  String provider,
  String model,
) => ModelCatalogResponse(
  tool: tool,
  models: [
    ModelOption(
      providerID: provider,
      modelID: model,
      label: model,
    ),
  ],
  refreshedAt: 1,
);

final class _HeldBrokerClient extends BrokerClient {
  _HeldBrokerClient({
    this.agents = const [],
    this.agentsGate,
    this.catalogGates = const {},
  }) : super(baseUrl: 'http://held.test');

  final List<AgentInfo> agents;
  final Completer<List<AgentInfo>>? agentsGate;
  final Map<String, Completer<ModelCatalogResponse>> catalogGates;

  @override
  Future<List<AgentInfo>> listAgents() =>
      agentsGate?.future ?? Future.value(agents);

  @override
  Future<ModelCatalogResponse> listAgentModels(String tool) =>
      catalogGates[tool]?.future ??
      Future.value(_catalog(tool, 'provider', '$tool-model'));
}

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient({
    required this.agents,
    this.models = const [],
  }) : super(baseUrl: 'http://test');

  final List<AgentInfo> agents;
  final List<ModelOption> models;
  String? lastDirectory;
  String? lastTitle;
  int createCalls = 0;
  int closeCalls = 0;
  int listModelCalls = 0;

  /// Set when [createSession] runs after [close] — the premature-disposal
  /// failure mode an operation-owned client must never exhibit.
  bool createdAfterClose = false;

  /// When set, [createSession] waits on this before answering — used to model
  /// a broker switch that happens while the create request is in flight.
  Completer<void>? createGate;

  @override
  void close() {
    closeCalls++;
    super.close();
  }

  @override
  Future<List<AgentInfo>> listAgents() async => agents;

  @override
  Future<ModelCatalogResponse> listAgentModels(String tool) async {
    listModelCalls += 1;
    return ModelCatalogResponse(
      tool: tool,
      models: models,
      refreshedAt: 1,
    );
  }

  @override
  Future<CreateSessionResponse> createSession(
    String tool, {
    String? directory,
    String? title,
    SessionCurrentModel? model,
  }) async {
    if (closeCalls > 0) {
      createdAfterClose = true;
    }
    createCalls++;
    lastDirectory = directory;
    lastTitle = title;
    if (createGate case final gate?) {
      await gate.future;
    }
    return CreateSessionResponse(
      session: SessionInfo(
        id: 'created',
        tool: tool,
        title: title ?? '',
        status: SessionStatus.idle,
        attachMode: AttachMode.resume,
      ),
      attachMode: 'resume',
    );
  }
}

final class _RecordingDriveIntentStore implements SessionDriveIntentStore {
  final List<String> appCreatedKeys = [];

  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async => null;

  @override
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    appCreatedKeys.add('$brokerProfileId/$tool/$sessionId');
  }

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}

  @override
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {}
}
