import 'package:cosyncing_client/src/features/sessions/data/session_control_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionControlPreferencesStore', () {
    late AppDatabase database;
    late DriftSessionControlPreferencesStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftSessionControlPreferencesStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('defaults routine takeover confirmation to not suppressed', () async {
      expect(await store.isRoutineTakeoverWarningSuppressed(), isFalse);
    });

    test('persists and replaces routine confirmation suppression', () async {
      await store.setRoutineTakeoverWarningSuppressed(suppressed: true);
      expect(await store.isRoutineTakeoverWarningSuppressed(), isTrue);

      await store.setRoutineTakeoverWarningSuppressed(suppressed: false);
      expect(await store.isRoutineTakeoverWarningSuppressed(), isFalse);
    });
  });
}
