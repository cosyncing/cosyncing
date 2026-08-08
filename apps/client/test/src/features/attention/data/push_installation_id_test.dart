import 'package:cosyncing_client/src/features/attention/data/push_installation_id.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
  });

  tearDown(() async {
    await database.close();
  });

  test('generates and persists one installation id once', () async {
    final store = DriftPushInstallationIdStore(
      database: database,
      idGenerator: () => 'installation-id',
    );

    final first = await store.readOrCreateInstallationId();
    final second = await store.readOrCreateInstallationId();

    expect(first, equals('installation-id'));
    expect(second, equals('installation-id'));

    final rows = await database.select(database.appSettingRows).get();
    expect(rows, hasLength(1));
    expect(rows.single.key, 'attention_push_installation_id');
    expect(rows.single.value, 'installation-id');
  });

  test('concurrent callers receive the same durable id', () async {
    var counter = 0;
    final store = DriftPushInstallationIdStore(
      database: database,
      idGenerator: () {
        counter += 1;
        return 'id-$counter';
      },
    );

    final ids = await Future.wait([
      store.readOrCreateInstallationId(),
      store.readOrCreateInstallationId(),
    ]);

    expect(ids, ['id-1', 'id-1']);
    expect(counter, 1);
  });

  test('default generator produces broker-safe ASCII id', () async {
    final id = await DriftPushInstallationIdStore(
      database: database,
    ).readOrCreateInstallationId();

    expect(id, matches(RegExp(r'^dev_[A-Za-z0-9_-]{20,}$')));
  });
}
