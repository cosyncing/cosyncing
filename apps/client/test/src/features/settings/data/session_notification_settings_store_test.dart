import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionNotificationSettingsStore', () {
    late AppDatabase database;
    late DriftSessionNotificationSettingsStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftSessionNotificationSettingsStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('defaults local notification preference to disabled', () async {
      expect(await store.getLocalNotificationEnabled(), isFalse);
    });

    test('persists and replaces local notification preference', () async {
      await store.setLocalNotificationEnabled(enabled: true);
      expect(await store.getLocalNotificationEnabled(), isTrue);

      await store.setLocalNotificationEnabled(enabled: false);
      expect(await store.getLocalNotificationEnabled(), isFalse);
    });
  });
}
