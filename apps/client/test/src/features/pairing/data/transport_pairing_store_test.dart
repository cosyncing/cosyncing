import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SecureTransportPairingStore', () {
    test(
      'stores credentials under the dedicated transport namespace',
      () async {
        final backend = _MemorySecureBackend();
        final store = SecureTransportPairingStore(backend: backend);
        final credentials = TransportPairingCredentials(
          id: 'broker-a:client-a',
          brokerId: 'broker-a',
          brokerUrl: Uri.parse('http://broker:7734'),
          localPeerId: 'client-a',
          localPeerToken: 'client-token',
          identityPublicKey: 'identity-public',
          identityPrivateKey: 'identity-private',
          exchangePublicKey: 'exchange-public',
          exchangePrivateKey: 'exchange-private',
          brokerPeerId: 'broker-peer',
          brokerPeerToken: 'broker-token',
          brokerIdentityPublicKey: 'broker-identity-public',
          dataKey: 'data-key',
          createdAt: DateTime.utc(2026, 7, 9, 12),
        );

        await store.write(credentials);

        expect(
          backend.values.keys.single,
          '${transportPairingStorageKeyPrefix}broker-a:client-a',
        );
        final read = await store.read('broker-a:client-a');
        expect(read?.brokerId, 'broker-a');
        expect(read?.localPeerToken, 'client-token');
        expect(read?.brokerPeerToken, 'broker-token');
        expect(read?.dataKey, 'data-key');
      },
    );

    test('delete removes only the requested transport credential', () async {
      final backend = _MemorySecureBackend();
      final store = SecureTransportPairingStore(backend: backend);

      await store.write(_credentials('one'));
      await store.write(_credentials('two'));

      await store.delete('one');

      expect(await store.read('one'), isNull);
      expect(await store.read('two'), isNotNull);
    });
  });
}

TransportPairingCredentials _credentials(String id) {
  return TransportPairingCredentials(
    id: id,
    brokerId: 'broker-$id',
    brokerUrl: Uri.parse('http://broker-$id:7734'),
    localPeerId: 'client-$id',
    localPeerToken: 'client-token-$id',
    identityPublicKey: 'identity-public-$id',
    identityPrivateKey: 'identity-private-$id',
    exchangePublicKey: 'exchange-public-$id',
    exchangePrivateKey: 'exchange-private-$id',
    brokerPeerId: 'broker-peer-$id',
    brokerPeerToken: 'broker-token-$id',
    brokerIdentityPublicKey: 'broker-identity-public-$id',
    dataKey: 'data-key-$id',
    createdAt: DateTime.utc(2026, 7, 9, 12),
  );
}

class _MemorySecureBackend implements SecureBrokerCredentialBackend {
  final Map<String, String> values = <String, String>{};

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }

  @override
  Future<String?> read(String key) async {
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}
