import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftAttentionNotificationTypeSettingsStore store;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    store = DriftAttentionNotificationTypeSettingsStore(database);
  });

  tearDown(() => database.close());

  Future<void> writeRaw(String key, String value) => database
      .into(database.appSettingRows)
      .insertOnConflictUpdate(
        AppSettingRowsCompanion.insert(
          key: key,
          value: value,
          updatedAt: DateTime(2026, 9, 23),
        ),
      );

  test('an untouched device uses every type default', () async {
    final settings = await store.load();

    for (final type in AttentionNotificationType.values) {
      expect(
        settings[type],
        AttentionNotificationTypeSetting.defaultsFor(type),
        reason: type.id,
      );
    }
    expect(
      settings[AttentionNotificationType.usageQuota].enabled,
      isFalse,
    );
    expect(
      settings[AttentionNotificationType.turnFinished].showSessionTitle,
      isTrue,
    );
  });

  test('persists one type without touching the others', () async {
    const quietQuestions = AttentionNotificationTypeSetting(
      enabled: true,
      sound: false,
      showSessionTitle: false,
    );

    await store.save(AttentionNotificationType.question, quietQuestions);
    final settings = await store.load();

    expect(settings[AttentionNotificationType.question], quietQuestions);
    expect(
      settings[AttentionNotificationType.permissionRequest],
      AttentionNotificationTypeSetting.defaultsFor(
        AttentionNotificationType.permissionRequest,
      ),
    );
  });

  test('saving again overwrites the earlier choice', () async {
    const off = AttentionNotificationTypeSetting(
      enabled: false,
      sound: false,
      showSessionTitle: true,
    );
    await store.save(AttentionNotificationType.turnFinished, off);
    await store.save(
      AttentionNotificationType.turnFinished,
      off.copyWith(enabled: true),
    );

    expect(
      (await store.load())[AttentionNotificationType.turnFinished].enabled,
      isTrue,
    );
  });

  test(
    'a shorter stored value takes the type default for missing flags',
    () async {
      await writeRaw('notification_type:question', '0');

      final setting = (await store.load())[AttentionNotificationType.question];

      expect(setting.enabled, isFalse);
      expect(setting.sound, AttentionNotificationType.question.defaultSound);
      expect(setting.showSessionTitle, isTrue);
    },
  );

  test('rows for types this client does not know are ignored', () async {
    await writeRaw('notification_type:from_the_future', '1,1,1');

    final settings = await store.load();

    expect(
      settings[AttentionNotificationType.usageQuota],
      AttentionNotificationTypeSetting.defaultsFor(
        AttentionNotificationType.usageQuota,
      ),
    );
  });
}
