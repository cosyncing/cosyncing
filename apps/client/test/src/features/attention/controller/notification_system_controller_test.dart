import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations_en.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/attention/view/notification_onboarding_banner.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_ui_preferences_store.dart';
import '../../../../support/notification_test_support.dart';

void main() {
  late FakeNotificationBackend backend;
  late InMemoryNotificationTypeSettingsStore typeStore;
  late InMemoryNotificationPreferenceStore preferenceStore;
  late InMemoryUiPreferencesStore uiPreferences;
  late List<BrokerProfile> profiles;

  setUp(() {
    backend = FakeNotificationBackend();
    typeStore = InMemoryNotificationTypeSettingsStore();
    preferenceStore = InMemoryNotificationPreferenceStore();
    uiPreferences = InMemoryUiPreferencesStore();
    profiles = [];
  });

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [
        sessionLocalNotificationAdapterProvider.overrideWithValue(
          FlutterLocalNotificationSink(backend: backend),
        ),
        attentionNotificationTypeSettingsStoreProvider.overrideWithValue(
          typeStore,
        ),
        sessionNotificationSettingsStoreProvider.overrideWithValue(
          preferenceStore,
        ),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          ControllableLifecycleMonitor(),
        ),
        uiPreferencesStoreProvider.overrideWithValue(uiPreferences),
        brokerProfileListProvider.overrideWith(
          () => _FixedProfileList(profiles),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('channel configuration', () {
    test(
      'declares every type in its family, localized, and deletes the old '
      'channels',
      () async {
        backend.managesChannels = true;
        uiPreferences.values[uiLocaleSettingKey] = 'zh';
        final container = makeContainer();

        await container.read(
          attentionNotificationChannelConfigurationProvider.future,
        );

        expect(
          backend.configuredChannels.map((channel) => channel.id),
          AttentionNotificationType.values.map((type) => type.channelId),
        );
        expect(backend.configuredGroups.map((group) => group.id), [
          'cosy.v2.sessions',
          'cosy.v2.security',
          'cosy.v2.server',
        ]);
        expect(
          backend.configuredChannels
              .singleWhere(
                (channel) =>
                    channel.id ==
                    AttentionNotificationType.turnFinished.channelId,
              )
              .groupId,
          'cosy.v2.sessions',
        );
        // Android settings show the app's language.
        expect(backend.configuredGroups.first.name, isNot('Sessions'));
        expect(
          backend.deletedChannelIds,
          legacyAttentionNotificationChannelIds,
        );
      },
    );
  });

  group('attentionNotificationSettingResolverProvider', () {
    test('uses the app setting where the app owns per-type settings', () async {
      typeStore.values[AttentionNotificationType.question] =
          const AttentionNotificationTypeSetting(
            enabled: false,
            sound: false,
            showSessionTitle: false,
          );
      final container = makeContainer();

      final resolve = container.read(
        attentionNotificationSettingResolverProvider,
      );
      final question = await resolve(AttentionNotificationType.question);
      final turn = await resolve(AttentionNotificationType.turnFinished);

      expect(question.enabled, isFalse);
      expect(question.showSessionTitle, isFalse);
      expect(
        turn,
        AttentionNotificationTypeSetting.defaultsFor(
          AttentionNotificationType.turnFinished,
        ),
      );
    });

    test(
      'Android takes on/off and sound from the channel, the title choice from '
      'the app',
      () async {
        backend
          ..managesChannels = true
          ..channels = {
            AttentionNotificationType.turnFinished.channelId:
                const NotificationChannelState(enabled: false, sound: true),
          };
        typeStore.values[AttentionNotificationType.turnFinished] =
            const AttentionNotificationTypeSetting(
              enabled: true,
              sound: false,
              showSessionTitle: false,
            );
        final container = makeContainer();

        final setting = await container.read(
          attentionNotificationSettingResolverProvider,
        )(AttentionNotificationType.turnFinished);

        expect(setting.enabled, isFalse);
        expect(setting.sound, isTrue);
        expect(setting.showSessionTitle, isFalse);
      },
    );

    test(
      'a channel Android has not created yet uses the type default',
      () async {
        backend.managesChannels = true;
        final container = makeContainer();

        final setting = await container.read(
          attentionNotificationSettingResolverProvider,
        )(AttentionNotificationType.usageQuota);

        expect(setting.enabled, isFalse);
      },
    );
  });

  group('AttentionNotificationTypeSettingsController', () {
    test('persists a type change and updates at once', () async {
      final container = makeContainer();
      await container.read(
        attentionNotificationTypeSettingsControllerProvider.future,
      );
      const loud = AttentionNotificationTypeSetting(
        enabled: true,
        sound: true,
        showSessionTitle: true,
      );

      await container
          .read(attentionNotificationTypeSettingsControllerProvider.notifier)
          .set(AttentionNotificationType.turnFinished, loud);

      expect(typeStore.values[AttentionNotificationType.turnFinished], loud);
      expect(
        container
            .read(attentionNotificationTypeSettingsControllerProvider)
            .value?[AttentionNotificationType.turnFinished],
        loud,
      );
    });
  });

  group('notificationOnboardingVisibleProvider', () {
    final profile = BrokerProfile(
      id: 'p1',
      displayName: 'Workstation',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026, 9, 23),
    );

    Future<bool> visible(ProviderContainer container) async {
      container.listen(notificationOnboardingVisibleProvider, (_, _) {});
      await container.read(brokerProfileListProvider.future);
      await container.read(notificationPermissionControllerProvider.future);
      await pumpEventQueue();
      return container.read(notificationOnboardingVisibleProvider);
    }

    test('offers the choice once a Server is paired', () async {
      profiles = [profile];

      expect(await visible(makeContainer()), isTrue);
    });

    test('stays away before any Server is paired', () async {
      expect(await visible(makeContainer()), isFalse);
    });

    test('never returns after an explicit choice', () async {
      profiles = [profile];
      preferenceStore.preference = false;

      expect(await visible(makeContainer()), isFalse);
    });

    test('is not offered where turning on cannot work', () async {
      profiles = [profile];
      for (final state in [
        NotificationPermissionState.denied,
        NotificationPermissionState.unsupported,
        NotificationPermissionState.error,
      ]) {
        backend.permission = NotificationPermissionStatus(state);
        expect(await visible(makeContainer()), isFalse, reason: '$state');
      }
    });

    test('is offered when the OS already allows notifications', () async {
      profiles = [profile];
      backend.permission = NotificationPermissionStatus.granted;

      expect(await visible(makeContainer()), isTrue);
    });
  });

  group('windowsToastGroupMigrationProvider', () {
    test('clears legacy toasts once per Windows device', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);

      Future<void> start() async {
        final container = ProviderContainer(
          overrides: [
            appDatabaseProvider.overrideWithValue(database),
            sessionLocalNotificationAdapterProvider.overrideWithValue(
              FlutterLocalNotificationSink(backend: backend),
            ),
          ],
        );
        addTearDown(container.dispose);
        await container.read(windowsToastGroupMigrationProvider.future);
      }

      await start();
      await start();

      expect(backend.clearAllCount, 1);
    });

    test('never clears on other platforms', () async {
      final container = makeContainer();

      await container.read(windowsToastGroupMigrationProvider.future);

      expect(backend.clearAllCount, 0);
    });
  });

  group('sendAttentionTestNotification', () {
    test('reports blocked until permission is granted', () async {
      final container = makeContainer();
      final l10n = AppLocalizationsEn();

      final blocked = await sendAttentionTestNotification(container, l10n);
      backend.permission = NotificationPermissionStatus.granted;
      final shown = await sendAttentionTestNotification(container, l10n);

      expect(blocked.outcome, BrokerNotificationDeliveryOutcome.blocked);
      expect(shown.outcome, BrokerNotificationDeliveryOutcome.shown);
      expect(backend.shown.single.title, l10n.notificationTestTitle);
      expect(
        container.read(lastAttentionNotificationDeliveryProvider)?.result,
        same(shown),
      );
    });
  });
}

final class _FixedProfileList extends BrokerProfileListNotifier {
  _FixedProfileList(this.profiles);

  final List<BrokerProfile> profiles;

  @override
  Future<List<BrokerProfile>> build() async => profiles;
}
