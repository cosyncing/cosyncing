import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftBrokerIdentityStore', () {
    late AppDatabase database;
    late DriftBrokerIdentityStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftBrokerIdentityStore(database);
    });

    tearDown(() => database.close());

    test('persists version and contract per broker profile', () async {
      const health = HealthResponse(
        ok: true,
        product: 'cosyncing',
        version: '1.2.3',
        contract: BrokerContractIdentity(
          revision: 2,
          minimumClientRevision: 1,
          surfaceHash: 'fnv1a32:12345678',
        ),
      );

      await store.write('profile-a', health);

      final restored = await store.read('profile-a');
      expect(restored?.version, '1.2.3');
      expect(restored?.contract?.revision, 2);
      expect(await store.read('profile-b'), isNull);
    });

    test('treats malformed local state as absent', () async {
      await database
          .into(database.appSettingRows)
          .insert(
            AppSettingRowsCompanion.insert(
              key: 'broker_identity:profile-a',
              value: 'not-json',
              updatedAt: DateTime(2026, 7, 18),
            ),
          );

      expect(await store.read('profile-a'), isNull);
    });

    test('persists negotiated hello compatibility per profile', () async {
      const broker = BrokerContractIdentity(
        revision: 2,
        minimumClientRevision: 1,
        surfaceHash: 'fnv1a32:12345678',
      );
      const hello = HelloWireEvent(
        brokerVersion: '1.2.3',
        brokerContract: broker,
        clientVersion: '1.1.0',
        compatibility: BrokerClientCompatibility(
          status: BrokerClientCompatibilityStatus.clientBehind,
          readOnly: false,
          reason: 'client is one revision behind',
          broker: broker,
          client: ClientContractIdentity(
            revision: 1,
            minimumBrokerRevision: 1,
          ),
        ),
      );

      await store.writeHello('profile-a', hello);

      final restored = await store.readHello('profile-a');
      expect(restored?.brokerVersion, '1.2.3');
      expect(
        restored?.compatibility.status,
        BrokerClientCompatibilityStatus.clientBehind,
      );
      expect(restored?.compatibility.readOnly, isFalse);
      expect(await store.readHello('profile-b'), isNull);
    });
  });
}
