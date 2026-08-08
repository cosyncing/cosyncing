import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftSessionDisplayPreferencesStore store;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    store = DriftSessionDisplayPreferencesStore(database);
  });

  tearDown(() async => database.close());

  test('uses safe Part 3 defaults', () async {
    expect(await store.getToolDisplayMode(), isNull);
    expect(await store.getShowBackgroundSessions(), isFalse);
    expect(await store.getShowVscodeSessions(), isTrue);
  });

  test('persists every device-global display preference', () async {
    await store.setToolDisplayMode('final-messages-only');
    await store.setShowBackgroundSessions(show: true);
    await store.setShowVscodeSessions(show: false);

    expect(await store.getToolDisplayMode(), 'final-messages-only');
    expect(await store.getShowBackgroundSessions(), isTrue);
    expect(await store.getShowVscodeSessions(), isFalse);
  });
}
