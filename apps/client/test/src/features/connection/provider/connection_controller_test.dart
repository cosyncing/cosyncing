import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/model/connection_state.dart';
import 'package:cosyncing_client/src/features/connection/model/fake_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/real_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late FakeBrokerHealthProbe fakeProbe;
  late ProviderContainer container;
  late _InMemoryBrokerProfileRepository brokerProfileRepository;
  late _InMemoryActiveBrokerProfileStore activeBrokerProfileStore;

  setUp(() {
    fakeProbe = FakeBrokerHealthProbe(delay: Duration.zero);
    brokerProfileRepository = _InMemoryBrokerProfileRepository();
    activeBrokerProfileStore = _InMemoryActiveBrokerProfileStore();
    container = ProviderContainer(
      overrides: [
        brokerHealthProbeProvider.overrideWithValue(fakeProbe),
        brokerProfileRepositoryProvider.overrideWithValue(
          brokerProfileRepository,
        ),
        activeBrokerProfileStoreProvider.overrideWithValue(
          activeBrokerProfileStore,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('ConnectionController', () {
    test('initial state is idle', () {
      final state = container.read(connectionControllerProvider);
      expect(state.status, ConnectionStatus.idle);
      expect(state.brokerUrl, isNull);
      expect(state.machine, isNull);
      expect(state.failureKind, isNull);
    });

    test('transitions to validating then success on valid URL', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      // Capture state changes.
      final states = <ConnectionStateModel>[];
      container.listen(
        connectionControllerProvider,
        (previous, next) => states.add(next),
      );

      await controller.connect('http://127.0.0.1:7734');

      // Should have gone through validating → success.
      expect(states, hasLength(2));
      expect(states[0].status, ConnectionStatus.validating);
      expect(states[1].status, ConnectionStatus.success);
      expect(states[1].machine, 'dev-machine');
      expect(states[1].brokerUrl, Uri.parse('http://127.0.0.1:7734'));
    });

    test('transitions to validating then failure on probe failure', () async {
      fakeProbe.shouldSucceed = false;

      final controller = container.read(connectionControllerProvider.notifier);

      final states = <ConnectionStateModel>[];
      container.listen(
        connectionControllerProvider,
        (previous, next) => states.add(next),
      );

      await controller.connect('http://127.0.0.1:7734');

      expect(states, hasLength(2));
      expect(states[0].status, ConnectionStatus.validating);
      expect(states[1].status, ConnectionStatus.failure);
      expect(states[1].failureKind, ConnectionFailureKind.unreachable);
      expect(states[1].technicalDetail, isNotNull);
    });

    test('goes to failure on invalid URL format', () async {
      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('');

      final state = container.read(connectionControllerProvider);
      expect(state.status, ConnectionStatus.failure);
      expect(state.failureKind, ConnectionFailureKind.invalidAddress);
      expect(state.technicalDetail, contains('empty'));
    });

    test('normalizes host:port input', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('192.168.1.10:8080');

      final state = container.read(connectionControllerProvider);
      expect(state.status, ConnectionStatus.success);
      expect(state.brokerUrl?.host, '192.168.1.10');
      expect(state.brokerUrl?.port, 8080);
    });

    test('normalizes bare host input', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('192.168.1.10');

      final state = container.read(connectionControllerProvider);
      expect(state.status, ConnectionStatus.success);
      expect(state.brokerUrl?.host, '192.168.1.10');
      expect(state.brokerUrl?.port, 7734);
    });

    test('reset returns to idle', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('http://127.0.0.1:7734');
      expect(
        container.read(connectionControllerProvider).status,
        ConnectionStatus.success,
      );

      await controller.reset();
      expect(
        container.read(connectionControllerProvider).status,
        ConnectionStatus.idle,
      );
    });

    test('probe is called with normalized URL', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('localhost');

      expect(fakeProbe.probeCount, 1);
      final state = container.read(connectionControllerProvider);
      expect(state.brokerUrl, Uri.parse('http://127.0.0.1:7734'));
    });

    test('successful connect sets active broker profile', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('http://127.0.0.1:7734');

      final profile = container.read(activeBrokerProfileProvider);
      expect(profile, isNotNull);
      expect(profile?.baseUri, Uri.parse('http://127.0.0.1:7734'));
      expect(profile?.displayName, '127.0.0.1');
    });

    test(
      'successful connect saves profile and persists active profile id',
      () async {
        fakeProbe.shouldSucceed = true;

        final controller = container.read(
          connectionControllerProvider.notifier,
        );

        await controller.connect('http://127.0.0.1:7734');

        final savedProfile = await brokerProfileRepository.getById(
          'http://127.0.0.1:7734',
        );
        expect(savedProfile, isNotNull);
        expect(savedProfile?.displayName, '127.0.0.1');
        expect(
          await activeBrokerProfileStore.getActiveProfileId(),
          equals('http://127.0.0.1:7734'),
        );
      },
    );

    test(
      'preserves existing profile metadata and updates timestamps on connect',
      () async {
        fakeProbe.shouldSucceed = true;
        await brokerProfileRepository.save(
          BrokerProfile(
            id: 'http://127.0.0.1:7734',
            displayName: 'Local Broker',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026, 6, 25),
            updatedAt: DateTime(2026, 6, 25, 12),
            lastUsedAt: DateTime(2026, 6, 25, 12),
            credentialKey: 'broker-token:local',
          ),
        );

        final controller = container.read(
          connectionControllerProvider.notifier,
        );

        await controller.connect('http://127.0.0.1:7734');

        final persisted = await brokerProfileRepository.getById(
          'http://127.0.0.1:7734',
        );
        expect(persisted, isNotNull);
        expect(persisted?.createdAt, DateTime(2026, 6, 25));
        expect(persisted?.credentialKey, 'broker-token:local');
        expect(persisted?.displayName, 'Local Broker');
        expect(persisted?.updatedAt, isNotNull);
        expect(persisted?.lastUsedAt, isNotNull);
      },
    );

    test('reset clears active broker profile', () async {
      fakeProbe.shouldSucceed = true;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('http://127.0.0.1:7734');
      await controller.reset();

      expect(container.read(activeBrokerProfileProvider), isNull);
      expect(
        container.read(connectionControllerProvider).status,
        ConnectionStatus.idle,
      );
    });

    test(
      'reset clears persisted active id but keeps broker profile saved',
      () async {
        fakeProbe.shouldSucceed = true;

        final controller = container.read(
          connectionControllerProvider.notifier,
        );

        await controller.connect('http://127.0.0.1:7734');
        await brokerProfileRepository.getById('http://127.0.0.1:7734');

        expect(await activeBrokerProfileStore.getActiveProfileId(), isNotNull);
        await controller.reset();

        expect(await activeBrokerProfileStore.getActiveProfileId(), isNull);
        expect(
          await brokerProfileRepository.getById('http://127.0.0.1:7734'),
          isNotNull,
        );
      },
    );

    test('hydration restores active profile by persisted id', () async {
      fakeProbe.shouldSucceed = true;

      await brokerProfileRepository.save(
        BrokerProfile(
          id: 'http://127.0.0.1:7734',
          displayName: 'Persisted Broker',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 6, 25),
          credentialKey: 'broker-token:local',
        ),
      );
      await activeBrokerProfileStore.setActiveProfileId(
        'http://127.0.0.1:7734',
      );

      await container.read(activeBrokerProfileHydrationProvider.future);

      final hydrated = container.read(activeBrokerProfileProvider);
      expect(hydrated, isNotNull);
      expect(hydrated?.id, 'http://127.0.0.1:7734');
      expect(hydrated?.displayName, 'Persisted Broker');
      expect(hydrated?.credentialKey, 'broker-token:local');
    });

    test('hydration clears stale active id when profile is missing', () async {
      await activeBrokerProfileStore.setActiveProfileId(
        'http://127.0.0.1:7734',
      );

      await container.read(activeBrokerProfileHydrationProvider.future);

      expect(container.read(activeBrokerProfileProvider), isNull);
      expect(await activeBrokerProfileStore.getActiveProfileId(), isNull);
    });

    test('failure does not update active broker profile', () async {
      fakeProbe.shouldSucceed = false;

      final controller = container.read(connectionControllerProvider.notifier);

      await controller.connect('http://127.0.0.1:7734');

      expect(container.read(activeBrokerProfileProvider), isNull);
    });
  });

  test('default broker health provider uses RealBrokerHealthProbe', () {
    final container = ProviderContainer();
    expect(
      container.read(brokerHealthProbeProvider),
      isA<RealBrokerHealthProbe>(),
    );
    container.dispose();
  });
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = {};

  @override
  Future<List<BrokerProfile>> getAll() async {
    return List<BrokerProfile>.from(_profiles.values);
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    return _profiles[id];
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    return _profiles.remove(id) != null;
  }
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? _activeProfileId;

  @override
  Future<String?> getActiveProfileId() async {
    return _activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    _activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    _activeProfileId = null;
  }
}
