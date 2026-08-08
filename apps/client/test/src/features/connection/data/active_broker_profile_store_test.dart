import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftActiveBrokerProfileStore', () {
    late AppDatabase database;
    late DriftActiveBrokerProfileStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftActiveBrokerProfileStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('returns null initially', () async {
      expect(await store.getActiveProfileId(), isNull);
    });

    test('persists and replaces the active profile id', () async {
      await store.setActiveProfileId('http://127.0.0.1:7734');
      await store.setActiveProfileId('https://broker.example.com:9443');

      expect(
        await store.getActiveProfileId(),
        'https://broker.example.com:9443',
      );
    });

    test('clears the active profile id', () async {
      await store.setActiveProfileId('http://127.0.0.1:7734');

      await store.clearActiveProfileId();

      expect(await store.getActiveProfileId(), isNull);
    });

    test('setting null clears the active profile id', () async {
      await store.setActiveProfileId('http://127.0.0.1:7734');

      await store.setActiveProfileId(null);

      expect(await store.getActiveProfileId(), isNull);
    });
  });
}
