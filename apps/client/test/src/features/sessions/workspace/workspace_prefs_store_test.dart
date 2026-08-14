import 'package:cosyncing_client/src/features/sessions/workspace/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftWorkspacePrefsStore', () {
    late AppDatabase database;
    late DriftWorkspacePrefsStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftWorkspacePrefsStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    // Null is load-bearing: it is how the workspace tells a first run (open
    // collapsed) apart from a user who has since chosen a width.
    test('returns null until a split has been saved', () async {
      expect(await store.loadRoster(), isNull);
    });

    test('round-trips width and collapsed flag', () async {
      await store.saveRoster(
        const WorkspaceRosterPrefs(width: 412, collapsed: false),
      );

      expect(
        await store.loadRoster(),
        const WorkspaceRosterPrefs(width: 412, collapsed: false),
      );
    });

    test('round-trips a collapsed roster and its reopen width', () async {
      await store.saveRoster(
        const WorkspaceRosterPrefs(width: 260, collapsed: true),
      );

      final restored = await store.loadRoster();
      expect(restored, isNotNull);
      expect(restored!.width, 260);
      expect(restored.collapsed, isTrue);
    });

    test('replaces a previously saved split', () async {
      await store.saveRoster(
        const WorkspaceRosterPrefs(width: 200, collapsed: true),
      );
      await store.saveRoster(
        const WorkspaceRosterPrefs(width: 340, collapsed: false),
      );

      expect(
        await store.loadRoster(),
        const WorkspaceRosterPrefs(width: 340, collapsed: false),
      );
    });

    // A half-written record must not wedge the workspace: a collapsed flag with
    // no width still restores, falling back to the default reopen width.
    test(
      'falls back to the default width when only the flag is stored',
      () async {
        await database
            .into(database.appSettingRows)
            .insertOnConflictUpdate(
              AppSettingRowsCompanion.insert(
                key: workspaceRosterCollapsedKey,
                value: 'true',
                updatedAt: DateTime.now(),
              ),
            );

        final restored = await store.loadRoster();
        expect(restored, isNotNull);
        expect(restored!.width, workspaceDefaultRosterWidth);
        expect(restored.collapsed, isTrue);
      },
    );
  });
}
