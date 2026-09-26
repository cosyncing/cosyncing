import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Persistent master switch for system notifications on this device.
///
/// See `docs/architecture/attention.md` for the user-facing
/// behavior and caveats.
final sessionNotificationSettingsControllerProvider =
    AsyncNotifierProvider<SessionNotificationSettingsController, bool>(
      SessionNotificationSettingsController.new,
    );

/// The explicit master-switch choice, or null when the user has never chosen.
/// The first-run card is offered exactly while this is null.
final sessionNotificationPreferenceProvider = FutureProvider<bool?>((ref) {
  ref.watch(sessionNotificationSettingsControllerProvider);
  return ref
      .read(sessionNotificationSettingsStoreProvider)
      .getLocalNotificationPreference();
});

/// Notifier for the durable master switch.
class SessionNotificationSettingsController extends AsyncNotifier<bool> {
  @override
  Future<bool> build() {
    return ref
        .read(sessionNotificationSettingsStoreProvider)
        .getLocalNotificationEnabled();
  }

  /// Turns system notifications on or off and persists the choice.
  ///
  /// Turning them on asks the OS for permission in the same user gesture, so
  /// one tap is enough; the permission prompt is never shown otherwise.
  Future<void> setEnabled({required bool enabled}) async {
    final permission = enabled
        ? ref.read(notificationPermissionControllerProvider.notifier).request()
        : null;
    state = const AsyncValue<bool>.loading();
    try {
      await ref
          .read(sessionNotificationSettingsStoreProvider)
          .setLocalNotificationEnabled(enabled: enabled);
      state = AsyncValue.data(enabled);
    } on Object catch (error, stack) {
      state = AsyncValue.error(error, stack);
    }
    await permission;
  }

  /// Flips the master switch.
  Future<void> toggle() async {
    final current = state.valueOrNull ?? false;
    await setEnabled(enabled: !current);
  }
}
