import 'dart:async';

import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/secure_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Credential store defaults to secure implementation', () {
    final container = ProviderContainer();

    expect(
      container.read(credentialStoreProvider),
      isA<SecureCredentialStore>(),
    );

    container.dispose();
  });

  test('Broker client is absent without an active profile', () async {
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
      ],
    );

    final client = await container.read(brokerClientProvider.future);
    final repository = await container.read(
      sessionListRepositoryProvider.future,
    );

    expect(client, isNull);
    expect(repository, isA<InMemorySessionListRepository>());

    container.dispose();
  });

  test('Broker client is constructed from active broker profile', () async {
    final container = ProviderContainer(
      overrides: [
        activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
      ],
    );

    container.read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
      id: 'local',
      displayName: 'local',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
      incarnationId: 'local-incarnation',
    );

    final client = await container.read(brokerClientProvider.future);
    final repository = await container.read(
      sessionListRepositoryProvider.future,
    );

    expect(client, isNotNull);
    expect(client?.baseUrl, 'http://127.0.0.1:7734');
    expect(client?.resolver.authHeaders, {
      'x-cosyncing-client-profile': 'local',
      'x-cosyncing-client-incarnation': 'local-incarnation',
    });
    expect(repository, isA<BrokerClientSessionListRepository>());

    container.dispose();
  });

  test('Broker client reads remote token by credential key', () async {
    final store = InMemoryCredentialStore();
    await store.writeBrokerToken('broker-token:remote', 'runtime-token');
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(store),
      ],
    );

    container.read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
      id: 'remote',
      displayName: 'remote',
      baseUri: Uri.parse('https://broker.example.com:9443'),
      createdAt: DateTime(2026),
      incarnationId: 'remote-incarnation',
      credentialKey: 'broker-token:remote',
    );

    final client = await container.read(brokerClientProvider.future);

    expect(client, isNotNull);
    expect(client?.baseUrl, 'https://broker.example.com:9443');
    expect(
      client?.resolver.authHeaders,
      {
        'x-cosyncing-token': 'runtime-token',
        'x-cosyncing-client-profile': 'remote',
        'x-cosyncing-client-incarnation': 'remote-incarnation',
      },
    );

    container.dispose();
  });

  test(
    'Broker client uses paired-device auth from peer credential key',
    () async {
      final store = InMemoryCredentialStore();
      await store.writeBrokerToken(
        'broker-peer-token:https://broker.example.com:9443',
        'paired-runtime-token',
      );
      final container = ProviderContainer(
        overrides: [credentialStoreProvider.overrideWithValue(store)],
      );

      container
          .read(activeBrokerProfileProvider.notifier)
          .state = BrokerProfile(
        id: 'https://broker.example.com:9443',
        displayName: 'paired',
        baseUri: Uri.parse('https://broker.example.com:9443'),
        createdAt: DateTime(2026),
        incarnationId: 'paired-incarnation',
        credentialKey: 'broker-peer-token:https://broker.example.com:9443',
      );

      final client = await container.read(brokerClientProvider.future);

      expect(client?.resolver.authHeaders, {
        'x-cosyncing-peer-token': 'paired-runtime-token',
        'x-cosyncing-client-profile': 'https://broker.example.com:9443',
        'x-cosyncing-client-incarnation': 'paired-incarnation',
      });
      expect(
        client?.resolver.streamEndpoint('codex', 'thread-1'),
        contains('peerToken=paired-runtime-token'),
      );

      container.dispose();
    },
  );

  test('Broker client honors configured credentials on loopback', () async {
    final store = InMemoryCredentialStore();
    await store.writeBrokerToken('broker-token:local', 'local-owner-token');
    final container = ProviderContainer(
      overrides: [credentialStoreProvider.overrideWithValue(store)],
    );

    container.read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
      id: 'local',
      displayName: 'local',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
      incarnationId: 'local-incarnation',
      credentialKey: 'broker-token:local',
    );

    final client = await container.read(brokerClientProvider.future);

    expect(client?.resolver.authHeaders, {
      'x-cosyncing-token': 'local-owner-token',
      'x-cosyncing-client-profile': 'local',
      'x-cosyncing-client-incarnation': 'local-incarnation',
    });
    container.dispose();
  });

  test(
    'Broker client fails closed for a stale loopback credential key',
    () async {
      final container = ProviderContainer(
        overrides: [
          credentialStoreProvider.overrideWithValue(InMemoryCredentialStore()),
        ],
      );

      container
          .read(activeBrokerProfileProvider.notifier)
          .state = BrokerProfile(
        id: 'local-stale',
        displayName: 'local stale',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
        credentialKey: 'broker-token:local-stale',
      );

      await expectLater(
        container.read(brokerClientProvider.future),
        throwsA(isA<BrokerCredentialUnavailableException>()),
      );

      container.dispose();
    },
  );

  test(
    'Broker client fails closed when configured credential is missing',
    () async {
      final container = ProviderContainer(
        overrides: [
          credentialStoreProvider.overrideWithValue(InMemoryCredentialStore()),
        ],
      );

      container
          .read(activeBrokerProfileProvider.notifier)
          .state = BrokerProfile(
        id: 'remote',
        displayName: 'remote',
        baseUri: Uri.parse('https://broker.example.com:9443'),
        createdAt: DateTime(2026),
        credentialKey: 'broker-token:missing',
      );

      await expectLater(
        container.read(brokerClientProvider.future),
        throwsA(isA<BrokerCredentialUnavailableException>()),
      );

      container.dispose();
    },
  );

  test(
    'a profile switch during the client build neither throws nor leaks',
    () async {
      final gate = Completer<void>();
      final store = _GatedCredentialStore(gate);
      await store.inner.writeBrokerToken('broker-token:a', 'token-a');
      await store.inner.writeBrokerToken('broker-token:b', 'token-b');
      final container = ProviderContainer(
        overrides: [credentialStoreProvider.overrideWithValue(store)],
      );
      addTearDown(container.dispose);
      BrokerProfile profile(String id) => BrokerProfile(
        id: id,
        displayName: id,
        baseUri: Uri.parse('https://$id.example.com:9443'),
        createdAt: DateTime(2026),
        credentialKey: 'broker-token:$id',
      );

      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'a',
      );
      final sub = container.listen(brokerClientProvider.future, (_, _) {});
      final first = container.read(brokerClientProvider.future);

      // The last listener drops while the build still awaits the credential
      // store, so the auto-dispose provider is FULLY disposed mid-build.
      // Un-hardened, the resuming build then crashed with "Cannot call
      // onDispose after a provider was disposed" once the gate released it.
      sub.close();
      await Future<void>.delayed(Duration.zero);
      gate.complete();

      // The stale build must settle cleanly — not surface that StateError —
      // and must resolve null: this future is still delivered to callers,
      // and a closed client would pass their `!= null` checks only to fail
      // later on a closed Dio.
      await expectLater(first, completion(isNull));

      // And the provider still works for the next profile afterwards.
      container.read(activeBrokerProfileProvider.notifier).state = profile(
        'b',
      );
      final second = await container.read(brokerClientProvider.future);
      expect(second?.baseUrl, 'https://b.example.com:9443');
    },
  );
}

class _GatedCredentialStore implements CredentialStore {
  _GatedCredentialStore(this.gate);

  final Completer<void> gate;
  final InMemoryCredentialStore inner = InMemoryCredentialStore();

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    await gate.future;
    return inner.readBrokerToken(credentialKey);
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) =>
      inner.writeBrokerToken(credentialKey, token);

  @override
  Future<void> deleteBrokerToken(String credentialKey) =>
      inner.deleteBrokerToken(credentialKey);
}
