import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_local_notification_adapter.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Persistent preference state for enabling local session notifications.
///
/// See `docs/architecture/client-ui.md` for the user-facing
/// behavior and caveats.
final sessionNotificationSettingsControllerProvider =
    AsyncNotifierProvider<SessionNotificationSettingsController, bool>(
      SessionNotificationSettingsController.new,
    );

/// Exposes a concrete permission requester function for explicit OS permission
/// onboarding.
final sessionNotificationPermissionRequesterProvider =
    Provider<FlutterLocalNotificationPermissionRequester>(
      (ref) {
        return ref
            .watch(sessionLocalNotificationAdapterProvider)
            .requestPermission;
      },
    );

/// User-visible status from the last explicit permission request.
final sessionNotificationPermissionRequestControllerProvider =
    AsyncNotifierProvider<
      SessionNotificationPermissionRequestController,
      FlutterLocalNotificationPermissionRequestResult?
    >(SessionNotificationPermissionRequestController.new);

/// Notifier for durable local notification preference.
class SessionNotificationSettingsController extends AsyncNotifier<bool> {
  @override
  Future<bool> build() {
    return ref
        .read(sessionNotificationSettingsStoreProvider)
        .getLocalNotificationEnabled();
  }

  /// Enables or disables local session notifications and persists the value.
  Future<void> setEnabled({required bool enabled}) async {
    state = const AsyncValue<bool>.loading();
    try {
      await ref
          .read(sessionNotificationSettingsStoreProvider)
          .setLocalNotificationEnabled(enabled: enabled);
      state = AsyncValue.data(enabled);
    } on Object catch (error, stack) {
      state = AsyncValue.error(error, stack);
    }
  }

  /// Flips local notification opt-in.
  Future<void> toggle() async {
    final current = state.valueOrNull ?? false;
    await setEnabled(enabled: !current);
  }
}

/// Controller for explicit OS permission request action in Settings.
class SessionNotificationPermissionRequestController
    extends AsyncNotifier<FlutterLocalNotificationPermissionRequestResult?> {
  @override
  Future<FlutterLocalNotificationPermissionRequestResult?> build() async {
    return null;
  }

  /// Requests OS permission for local notification display.
  Future<void> requestPermission() async {
    state =
        const AsyncValue<
          FlutterLocalNotificationPermissionRequestResult?
        >.loading();
    try {
      final requester = ref.read(
        sessionNotificationPermissionRequesterProvider,
      );
      final result = await requester();
      state = AsyncValue.data(result);
    } on Object catch (_) {
      state = const AsyncValue.data(
        FlutterLocalNotificationPermissionRequestResult(
          outcome: FlutterLocalNotificationPermissionRequestOutcome.failed,
        ),
      );
    }
  }
}
