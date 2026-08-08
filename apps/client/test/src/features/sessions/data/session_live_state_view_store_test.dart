import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionLiveStateViewStore', () {
    late AppDatabase database;
    late DriftSessionLiveStateViewStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftSessionLiveStateViewStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('defaults to no archived live-state items', () async {
      const key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

      expect(await store.loadArchived(key), isEmpty);
    });

    test('persists fingerprints per session and replaces snapshots', () async {
      const first = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
      const second = SessionDetailKey(tool: 'claude', sessionId: 'session-2');

      await store.saveArchived(first, const {'goal:current': 'paused|Ship'});
      await store.saveArchived(second, const {'task-list:plan': 'done|2'});
      expect(
        await store.loadArchived(first),
        const {'goal:current': 'paused|Ship'},
      );
      expect(
        await store.loadArchived(second),
        const {'task-list:plan': 'done|2'},
      );

      await store.saveArchived(first, const {'goal:new': 'blocked|Review'});
      expect(
        await store.loadArchived(first),
        const {'goal:new': 'blocked|Review'},
      );
    });
  });
}
