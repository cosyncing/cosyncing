import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('read-aloud rate survives a store reconstruction', () async {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    final first = DriftReadAloudPreferencesStore(database);
    await first.setRate(1.25);

    final reopened = DriftReadAloudPreferencesStore(database);
    expect(await reopened.getRate(), '1.25');
  });
}
