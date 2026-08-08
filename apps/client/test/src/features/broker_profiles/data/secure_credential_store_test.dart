import 'package:cosyncing_client/src/features/broker_profiles/data/secure_credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

final class _InMemoryCredentialBackend implements SecureCredentialBackend {
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
  group('SecureCredentialStore', () {
    test('readBrokerToken reads null when no credential is stored', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      final token = await store.readBrokerToken('broker-token:missing');

      expect(token, isNull);
    });

    test('writeBrokerToken stores and reads by namespaced key', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await store.writeBrokerToken('remote-broker', 'stored-token');

      expect(
        await store.readBrokerToken('remote-broker'),
        'stored-token',
      );
      expect(
        await backend.read('cosyncing_client.broker_token:remote-broker'),
        'stored-token',
      );
    });

    test('readBrokerToken treats blank values as null', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await store.writeBrokerToken('blank-credential', '');

      expect(await store.readBrokerToken('blank-credential'), isNull);
    });

    test('readBrokerToken trims existing backend values', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await backend.write(
        'cosyncing_client.broker_token:remote-broker',
        '  stored-token  ',
      );

      expect(await store.readBrokerToken('remote-broker'), 'stored-token');
    });

    test(
      'writeBrokerToken clears existing token when value is blank',
      () async {
        final backend = _InMemoryCredentialBackend();
        final store = SecureCredentialStore(backend: backend);

        await store.writeBrokerToken('remote-broker', 'stored-token');
        await store.writeBrokerToken('remote-broker', '   ');

        expect(await store.readBrokerToken('remote-broker'), isNull);
      },
    );

    test('read/write are key-trim and token-trim aware', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await store.writeBrokerToken('  remote-broker  ', '  spaced-token  ');

      expect(await store.readBrokerToken('remote-broker'), 'spaced-token');
      expect(await store.readBrokerToken('  remote-broker  '), 'spaced-token');
      expect(
        await backend.read('cosyncing_client.broker_token:remote-broker'),
        'spaced-token',
      );
    });

    test('blank credential key is ignored', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await store.writeBrokerToken('   ', 'should-not-store');

      expect(await store.readBrokerToken('   '), isNull);
      expect(await backend.read('cosyncing_client.broker_token:'), isNull);
    });

    test('deleteBrokerToken removes namespaced credential', () async {
      final backend = _InMemoryCredentialBackend();
      final store = SecureCredentialStore(backend: backend);

      await store.writeBrokerToken('remote-broker', 'stored-token');
      await store.deleteBrokerToken('remote-broker');

      expect(await store.readBrokerToken('remote-broker'), isNull);
      expect(
        await backend.read('cosyncing_client.broker_token:remote-broker'),
        isNull,
      );
    });
  });
}
