import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('InMemoryCredentialStore', () {
    test('readBrokerToken returns null for missing credentials', () async {
      final store = InMemoryCredentialStore();

      expect(await store.readBrokerToken('broker-token:missing'), isNull);
    });

    test('writeBrokerToken persists token by credential key', () async {
      final store = InMemoryCredentialStore();

      await store.writeBrokerToken('broker-token:remote', 'secret-token');

      expect(
        await store.readBrokerToken('broker-token:remote'),
        'secret-token',
      );
    });

    test('deleteBrokerToken removes token by credential key', () async {
      final store = InMemoryCredentialStore();
      await store.writeBrokerToken('broker-token:remote', 'secret-token');

      await store.deleteBrokerToken('broker-token:remote');

      expect(await store.readBrokerToken('broker-token:remote'), isNull);
    });

    test(
      'writeBrokerToken with blank token removes existing and trims input',
      () async {
        final store = InMemoryCredentialStore();

        await store.writeBrokerToken('  broker-token:remote  ', 'secret-token');
        await store.writeBrokerToken('broker-token:remote', '   ');

        expect(await store.readBrokerToken('broker-token:remote'), isNull);
        expect(await store.readBrokerToken('  broker-token:remote  '), isNull);
      },
    );

    test('blank key is treated as absent in read/write/delete', () async {
      final store = InMemoryCredentialStore();

      await store.writeBrokerToken('   ', 'secret-token');

      expect(await store.readBrokerToken('   '), isNull);
      await store.deleteBrokerToken('   ');

      expect(await store.readBrokerToken('broker-token:remote'), isNull);
    });
  });
}
