import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/desktop/desktop_keep_running.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// OS notification permission as the app presents it.
///
/// Android and Darwin only say "not enabled"; once this device has shown the
/// prompt, that reads as [NotificationPermissionState.denied] because asking
/// again shows nothing.
final notificationPermissionControllerProvider =
    AsyncNotifierProvider<
      NotificationPermissionController,
      NotificationPermissionStatus
    >(NotificationPermissionController.new);

/// Reads, refreshes (on every resume), and requests OS permission.
class NotificationPermissionController
    extends AsyncNotifier<NotificationPermissionStatus> {
  @override
  Future<NotificationPermissionStatus> build() async {
    final subscription = ref
        .watch(sessionNotificationLifecycleMonitorProvider)
        .stateChanges
        .listen((state) {
          // The user may have changed it in system settings meanwhile.
          if (state == BrokerAppLifecycleState.resumed) unawaited(refresh());
        });
    ref.onDispose(subscription.cancel);
    return _read();
  }

  /// Re-reads the OS state without prompting.
  Future<void> refresh() async {
    state = AsyncValue.data(await _read());
  }

  /// Shows the OS prompt. Call it straight from the user's tap: browsers only
  /// prompt inside a user gesture, so nothing is awaited before the request.
  Future<NotificationPermissionStatus> request() async {
    final prompt = ref
        .read(sessionLocalNotificationAdapterProvider)
        .requestPermission();
    final result = await prompt;
    await ref
        .read(sessionNotificationSettingsStoreProvider)
        .setPermissionPrompted();
    final next = result.isGranted ? result : await _read();
    state = AsyncValue.data(next);
    return next;
  }

  Future<NotificationPermissionStatus> _read() async {
    final status = await ref
        .read(sessionLocalNotificationAdapterProvider)
        .permissionStatus();
    if (status.state != NotificationPermissionState.notGranted) return status;
    final prompted = await ref
        .read(sessionNotificationSettingsStoreProvider)
        .getPermissionPrompted();
    return prompted
        ? const NotificationPermissionStatus(NotificationPermissionState.denied)
        : status;
  }
}

/// This device's per-type choices.
final attentionNotificationTypeSettingsControllerProvider =
    AsyncNotifierProvider<
      AttentionNotificationTypeSettingsController,
      AttentionNotificationTypeSettings
    >(AttentionNotificationTypeSettingsController.new);

/// Loads and persists per-type notification choices.
class AttentionNotificationTypeSettingsController
    extends AsyncNotifier<AttentionNotificationTypeSettings> {
  @override
  Future<AttentionNotificationTypeSettings> build() =>
      ref.read(attentionNotificationTypeSettingsStoreProvider).load();

  /// Persists one type's setting.
  Future<void> set(
    AttentionNotificationType type,
    AttentionNotificationTypeSetting setting,
  ) async {
    final current =
        state.valueOrNull ?? AttentionNotificationTypeSettings.defaults();
    state = AsyncValue.data(current.withSetting(type, setting));
    await ref
        .read(attentionNotificationTypeSettingsStoreProvider)
        .save(type, setting);
  }
}

/// Android channel state by channel id, re-read on every resume (the user
/// changes it in system settings). Empty on platforms without channels.
final attentionNotificationChannelStatesProvider =
    AsyncNotifierProvider<
      AttentionNotificationChannelStatesController,
      Map<String, NotificationChannelState>
    >(AttentionNotificationChannelStatesController.new);

/// Reads Android channel state.
class AttentionNotificationChannelStatesController
    extends AsyncNotifier<Map<String, NotificationChannelState>> {
  @override
  Future<Map<String, NotificationChannelState>> build() async {
    final subscription = ref
        .watch(sessionNotificationLifecycleMonitorProvider)
        .stateChanges
        .listen((state) {
          if (state == BrokerAppLifecycleState.resumed) unawaited(refresh());
        });
    ref.onDispose(subscription.cancel);
    await ref.watch(attentionNotificationChannelConfigurationProvider.future);
    return ref.read(sessionLocalNotificationAdapterProvider).channelStates();
  }

  /// Re-reads channel state.
  Future<void> refresh() async {
    state = AsyncValue.data(
      await ref.read(sessionLocalNotificationAdapterProvider).channelStates(),
    );
  }
}

/// Declares every notification type to the platform, localized, and deletes
/// the pre-per-type Android channels. Re-runs when the app language changes
/// so Android settings show current names.
final attentionNotificationChannelConfigurationProvider = FutureProvider<void>((
  ref,
) async {
  final locale = await ref.watch(localeControllerProvider.future);
  final l10n = resolveAppLocalizations(locale);
  await ref
      .read(sessionLocalNotificationAdapterProvider)
      .configureChannels(
        groups: attentionNotificationChannelGroups(l10n),
        channels: [
          for (final type in AttentionNotificationType.values)
            attentionNotificationChannel(type, l10n),
        ],
        obsoleteChannelIds: legacyAttentionNotificationChannelIds,
      );
});

/// The effective per-type setting used when presenting: the app's own
/// choice, with Android's channel switch and sound taking precedence there.
final attentionNotificationSettingResolverProvider =
    Provider<
      Future<AttentionNotificationTypeSetting> Function(
        AttentionNotificationType,
      )
    >((ref) {
      return (type) async {
        final settings = await ref.read(
          attentionNotificationTypeSettingsControllerProvider.future,
        );
        final setting = settings[type];
        final adapter = ref.read(sessionLocalNotificationAdapterProvider);
        if (!adapter.systemManagesChannels) return setting;
        final channel = (await adapter.channelStates())[type.channelId];
        return setting.copyWith(
          enabled: channel?.enabled ?? type.defaultEnabled,
          sound: channel?.sound ?? type.defaultSound,
        );
      };
    });

/// App-settings key recording that group-less Windows toasts were cleared.
const windowsToastGroupMigrationSettingKey =
    'notification_windows_toast_group_migrated';

/// Clears, once per Windows device, the toasts an older client delivered.
///
/// They carry no toast group, and an unpackaged app can remove a single toast
/// only by tag and group, so nothing could ever clear them individually.
/// `clearAll` (`History.Clear(aumid)`) is the one call that reaches them.
final windowsToastGroupMigrationProvider = FutureProvider<void>((ref) async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.windows) return;
  final database = ref.read(appDatabaseProvider);
  final done =
      await (database.select(database.appSettingRows)..where(
            (row) => row.key.equals(windowsToastGroupMigrationSettingKey),
          ))
          .getSingleOrNull();
  if (done != null) return;
  try {
    await ref.read(sessionLocalNotificationAdapterProvider).clearAll();
  } on Object {
    return; // Retried on the next start.
  }
  await database
      .into(database.appSettingRows)
      .insertOnConflictUpdate(
        AppSettingRowsCompanion.insert(
          key: windowsToastGroupMigrationSettingKey,
          value: 'true',
          updatedAt: DateTime.now(),
        ),
      );
});

/// One recorded presentation attempt.
@immutable
final class AttentionNotificationDeliveryRecord {
  /// Creates a record.
  const AttentionNotificationDeliveryRecord({
    required this.type,
    required this.result,
    required this.at,
  });

  /// The type presented, or null for the test notification.
  final AttentionNotificationType? type;

  /// What the platform did.
  final BrokerNotificationDeliveryResult result;

  /// When.
  final DateTime at;
}

/// The last presentation attempt, for Settings diagnostics.
final lastAttentionNotificationDeliveryProvider =
    StateProvider<AttentionNotificationDeliveryRecord?>((_) => null);

/// Records each presentation attempt for Settings diagnostics.
final attentionNotificationDeliveryRecorderProvider =
    Provider<
      void Function(
        AttentionNotificationType type,
        BrokerNotificationDeliveryResult result,
      )
    >(
      (ref) => (type, result) {
        ref
            .read(lastAttentionNotificationDeliveryProvider.notifier)
            .state = AttentionNotificationDeliveryRecord(
          type: type,
          result: result,
          at: DateTime.now(),
        );
      },
    );

/// Sends one test notification through the real platform path (even while
/// the master switch is off, since it tests the OS side) and records it.
Future<BrokerNotificationDeliveryResult> sendAttentionTestNotification(
  ProviderContainer container,
  AppLocalizations l10n,
) async {
  const type = AttentionNotificationType.turnFinished;
  final result = await container
      .read(sessionLocalNotificationAdapterProvider)
      .show(
        BrokerNotificationRequest(
          id: 'cosyncing-test-notification',
          title: l10n.notificationTestTitle,
          body: l10n.notificationTestBody,
          channel: attentionNotificationChannel(type, l10n),
          playSound: false,
          payload: const {},
          createdAt: DateTime.now(),
        ),
      );
  container
      .read(lastAttentionNotificationDeliveryProvider.notifier)
      .state = AttentionNotificationDeliveryRecord(
    type: null,
    result: result,
    at: DateTime.now(),
  );
  return result;
}

/// Brings the desktop window to the front after a notification tap. Windows
/// delivers a toast activation to the running process without raising it, and
/// macOS activates the app without reopening a window the user closed.
Future<void> raiseAppWindowForNotificationTap() async {
  if (!desktopKeepRunningSupported) return;
  try {
    await const DesktopWindowChannel().raise();
  } on Object {
    // Best effort: the tap still opens its target.
  }
}

/// Opens the OS page where the user changes notification permission.
final notificationSystemSettingsLauncherProvider =
    Provider<NotificationSystemSettingsLauncher>(
      (_) => const NotificationSystemSettingsLauncher(),
    );

/// Deep links into OS notification settings.
class NotificationSystemSettingsLauncher {
  /// Creates a launcher.
  const NotificationSystemSettingsLauncher();

  static const _android = MethodChannel('com.cosyncing.client/notifications');

  /// Whether this platform has a page to open.
  bool get isSupported =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.macOS ||
          defaultTargetPlatform == TargetPlatform.windows);

  /// Opens the app's notification page, or one Android channel's page.
  Future<bool> open({String? channelId}) async {
    if (!isSupported) return false;
    try {
      switch (defaultTargetPlatform) {
        case TargetPlatform.android:
          return await _android.invokeMethod<bool>('openSettings', {
                'channelId': ?channelId,
              }) ??
              false;
        case TargetPlatform.macOS:
          return await launchUrl(
            Uri.parse(
              'x-apple.systempreferences:'
              'com.apple.Notifications-Settings.extension'
              '?id=com.cosyncing.client',
            ),
          );
        case TargetPlatform.windows:
          return await launchUrl(Uri.parse('ms-settings:notifications'));
        case _:
          return false;
      }
    } on Object {
      return false;
    }
  }
}
