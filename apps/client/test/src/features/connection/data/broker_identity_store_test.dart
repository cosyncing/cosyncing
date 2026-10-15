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
  });
}
