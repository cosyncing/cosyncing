import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
  });

  tearDown(() => database.close());

  ProviderContainer container() => ProviderContainer(
    overrides: [appDatabaseProvider.overrideWithValue(database)],
  );

  test('fresh installs request only the last seven days', () async {
    final scope = container();
    addTearDown(scope.dispose);

    expect(
      await scope.read(sessionRosterWindowProvider.future),
      SessionRosterQueryWindow.last7Days,
    );
  });

  test('an explicit Any time choice survives controller restart', () async {
    final first = container();
    await first.read(sessionRosterWindowProvider.future);
    await first
        .read(sessionRosterWindowProvider.notifier)
        .setWindow(SessionRosterQueryWindow.any);
    first.dispose();

    final restarted = container();
    addTearDown(restarted.dispose);
    expect(
      await restarted.read(sessionRosterWindowProvider.future),
      SessionRosterQueryWindow.any,
    );
  });
}
