import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

final class _InMemoryBrokerCredentialBackend
    implements SecureBrokerCredentialBackend {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> read(String key) async {
    return _values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }
}

void main() {
  group('SecureBrokerCredentialStore', () {
    test('readBrokerToken reads null when no credential is stored', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      final token = await store.readBrokerToken('broker-token:missing');

      expect(token, isNull);
    });

    test('blank credential key is treated as absent', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await store.writeBrokerToken('   ', 'should-not-store');

      expect(await store.readBrokerToken('   '), isNull);
      expect(await backend.read('cosyncing_client.broker_token:'), isNull);
    });

    test('writeBrokerToken stores and reads by namespaced key', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await store.writeBrokerToken('remote-broker', 'stored-token');

      expect(await store.readBrokerToken('remote-broker'), 'stored-token');
      expect(
        await backend.read(
          '${SecureBrokerCredentialStore.brokerTokenStorageKeyPrefix}remote-broker',
        ),
        'stored-token',
      );
    });

    test('readBrokerToken treats blank values as null', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await store.writeBrokerToken('blank-credential', '');

      expect(await store.readBrokerToken('blank-credential'), isNull);
    });

    test('readBrokerToken trims existing backend values', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await backend.write(
        '${SecureBrokerCredentialStore.brokerTokenStorageKeyPrefix}remote-broker',
        '  stored-token  ',
      );

      expect(await store.readBrokerToken('remote-broker'), 'stored-token');
    });

    test(
      'writeBrokerToken treats blank token as clear and removes any existing value',
      () async {
        final backend = _InMemoryBrokerCredentialBackend();
        final store = SecureBrokerCredentialStore(backend: backend);
        const key = 'remote-broker';

        await store.writeBrokerToken(key, 'stored-token');
        await store.writeBrokerToken(key, '   ');

        expect(await store.readBrokerToken(key), isNull);
      },
    );

    test('read/write are key-trim aware', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await store.writeBrokerToken('  remote-broker  ', '  spaced-token  ');

      expect(await store.readBrokerToken('remote-broker'), 'spaced-token');
      expect(
        await backend.read(
          '${SecureBrokerCredentialStore.brokerTokenStorageKeyPrefix}remote-broker',
        ),
        'spaced-token',
      );
    });

    test('deleteBrokerToken removes namespaced credential', () async {
      final backend = _InMemoryBrokerCredentialBackend();
      final store = SecureBrokerCredentialStore(backend: backend);

      await store.writeBrokerToken('remote-broker', 'stored-token');
      await store.deleteBrokerToken('remote-broker');

      expect(await store.readBrokerToken('remote-broker'), isNull);
      expect(
        await backend.read(
          '${SecureBrokerCredentialStore.brokerTokenStorageKeyPrefix}remote-broker',
        ),
        isNull,
      );
    });
  });
}
