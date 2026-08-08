import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftAttentionFeedSettingsStore', () {
    late AppDatabase database;
    late DriftAttentionFeedSettingsStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      store = DriftAttentionFeedSettingsStore(database);
    });

    tearDown(() async {
      await database.close();
    });

    test(
      'defaults per-profile attention feed preference to enabled',
      () async {
        expect(await store.isFeedEnabled('profile-1'), isTrue);
      },
    );

    test('stores and replaces per-profile feed preference', () async {
      await store.setFeedEnabled(brokerProfileId: 'profile-1', enabled: false);
      expect(await store.isFeedEnabled('profile-1'), isFalse);

      await store.setFeedEnabled(brokerProfileId: 'profile-1', enabled: true);
      expect(await store.isFeedEnabled('profile-1'), isTrue);
    });

    test('lists only explicitly disabled profile ids', () async {
      await store.setFeedEnabled(brokerProfileId: 'profile:one', enabled: true);
      await store.setFeedEnabled(
        brokerProfileId: 'profile-two',
        enabled: false,
      );
      await store.setFeedEnabled(brokerProfileId: 'profile-3', enabled: false);

      final ids = await store.listDisabledProfileIds();

      expect(
        ids,
        unorderedEquals(['profile-two', 'profile-3']),
      );
    });

    test('stores arbitrary profile ids safely in setting keys', () async {
      await store.setFeedEnabled(
        brokerProfileId: 'profile/with:special|chars',
        enabled: true,
      );
      expect(await store.isFeedEnabled('profile/with:special|chars'), isTrue);
    });
  });
}
