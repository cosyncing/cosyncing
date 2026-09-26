import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App setting: whether the app stays connected after the user leaves it.
const String androidBackgroundConnectionSettingKey =
    'android_background_connection';

/// Where a foreground service can keep the app running: Android.
bool get androidBackgroundConnectionSupported =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

/// Durable background-connection choice. Missing means off: the service shows
/// a notification for as long as it runs and costs battery, so the user turns
/// it on.
abstract interface class AndroidBackgroundConnectionStore {
  /// Returns the stored choice, or false when none was made.
  Future<bool> get();

  /// Persists the choice.
  Future<void> set({required bool enabled});
}

/// Drift-backed [AndroidBackgroundConnectionStore].
class DriftAndroidBackgroundConnectionStore
    implements AndroidBackgroundConnectionStore {
  /// Creates the store over [database].
  DriftAndroidBackgroundConnectionStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> get() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) =>
                  table.key.equals(androidBackgroundConnectionSettingKey),
            ))
            .getSingleOrNull();
    return row?.value == 'true';
  }

  @override
  Future<void> set({required bool enabled}) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: androidBackgroundConnectionSettingKey,
            value: enabled.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Persisted background-connection store.
final androidBackgroundConnectionStoreProvider =
    Provider<AndroidBackgroundConnectionStore>(
      (ref) =>
          DriftAndroidBackgroundConnectionStore(ref.watch(appDatabaseProvider)),
    );

/// The background-connection choice as Settings shows and changes it.
final androidBackgroundConnectionControllerProvider =
    AsyncNotifierProvider<AndroidBackgroundConnectionController, bool>(
      AndroidBackgroundConnectionController.new,
    );

/// Loads and persists the background-connection choice.
class AndroidBackgroundConnectionController extends AsyncNotifier<bool> {
  @override
  Future<bool> build() =>
      ref.read(androidBackgroundConnectionStoreProvider).get();

  /// Persists [enabled]; the runtime starts or stops the service.
  Future<void> setEnabled({required bool enabled}) async {
    state = AsyncValue.data(enabled);
    await ref
        .read(androidBackgroundConnectionStoreProvider)
        .set(enabled: enabled);
  }
}

/// The Android foreground service that keeps the app's process running.
class AndroidBackgroundConnectionChannel {
  /// Creates the channel wrapper.
  const AndroidBackgroundConnectionChannel();

  static const _channel = MethodChannel(
    'com.cosyncing.client/background_connection',
  );

  /// Starts the service, or updates the text of its notification. Returns
  /// false when Android refused, which it does while the app is in the
  /// background.
  Future<bool> start({
    required String channelName,
    required String groupName,
    required String title,
    required String text,
  }) async {
    final started = await _channel.invokeMethod<bool>('start', {
      'channelName': channelName,
      'groupName': groupName,
      'title': title,
      'text': text,
    });
    return started ?? false;
  }

  /// Stops the service; its notification goes with it.
  Future<void> stop() async {
    await _channel.invokeMethod<void>('stop');
  }
}

/// Native service host, replaceable in tests.
final androidBackgroundConnectionChannelProvider =
    Provider<AndroidBackgroundConnectionChannel>(
      (_) => const AndroidBackgroundConnectionChannel(),
    );

/// Root-app trigger that runs the service while both the choice and the
/// notification master switch are on, and stops it otherwise.
///
/// Android only lets an app start the service while it is in front, so the
/// start is repeated whenever the app returns there: a start the OS refused
/// (the user left during launch) is retried, and a running service only has
/// its notification text refreshed.
final androidBackgroundConnectionRuntimeProvider = Provider<void>((ref) {
  if (!androidBackgroundConnectionSupported) return;
  final enabled = ref
      .watch(androidBackgroundConnectionControllerProvider)
      .valueOrNull;
  final notifications = ref
      .watch(sessionNotificationSettingsControllerProvider)
      .valueOrNull;
  final locale = ref.watch(localeControllerProvider);
  if (enabled == null || notifications == null || !locale.hasValue) return;
  final channel = ref.read(androidBackgroundConnectionChannelProvider);
  if (!enabled || !notifications) {
    unawaited(channel.stop().catchError((Object _) {}));
    return;
  }
  final l10n = resolveAppLocalizations(locale.value);
  void start() {
    unawaited(
      channel
          .start(
            channelName: l10n.androidBackgroundConnectionChannelName,
            groupName: l10n.notificationFamilyServer,
            title: l10n.androidBackgroundConnectionNotificationTitle,
            text: l10n.androidBackgroundConnectionNotificationText,
          )
          .then<void>((_) {}, onError: (Object _) {}),
    );
  }

  start();
  final subscription = ref
      .watch(sessionNotificationLifecycleMonitorProvider)
      .stateChanges
      .listen((state) {
        if (state == BrokerAppLifecycleState.resumed) start();
      });
  ref.onDispose(() => unawaited(subscription.cancel()));
});
