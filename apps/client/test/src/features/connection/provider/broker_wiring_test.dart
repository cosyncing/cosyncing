import 'dart:async';

import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
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
