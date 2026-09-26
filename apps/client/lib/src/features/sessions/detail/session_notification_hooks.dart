import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_presentation_coordinator.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_local_notification_adapter.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/platform/lifecycle/app_lifecycle_monitor.dart';
import 'package:cosyncing_client/src/platform/notifications/presentation_coordinator.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:cosyncing_client/src/features/sessions/detail/session_local_notification_adapter.dart';

/// Initializes notification tap handling at app startup.
///
/// Platform/plugin absence is non-fatal (notably web and unsupported desktop
/// builds); resident feed polling remains the authoritative recovery path.
final sessionNotificationLaunchBootstrapProvider = FutureProvider<void>((
  ref,
) async {
  try {
    await ref.watch(sessionLocalNotificationAdapterProvider).initialize();
  } on Object {
    // A missing platform adapter must not block application startup.
  }
});

/// Provides a broker-independent lifecycle monitor for session notifications.
final Provider<BrokerAppLifecycleMonitor>
sessionNotificationLifecycleMonitorProvider =
    Provider<BrokerAppLifecycleMonitor>((ref) {
      // In a browser the document's own visibility and focus, not Flutter's
      // web engine, which starts every tab as resumed.
      final monitor = createAppLifecycleMonitor();
      ref.onDispose(monitor.dispose);
      return monitor;
    });

/// Keeps this device's app windows (browser tabs) from presenting one
/// attention event twice.
final attentionPresentationCoordinatorProvider =
    Provider<AttentionPresentationCoordinator>((ref) {
      final coordinator = createPresentationCoordinator(
        ref.watch(sessionNotificationLifecycleMonitorProvider),
      );
      ref.onDispose(coordinator.dispose);
      return coordinator;
    });

/// The sink that presents attention notifications.
///
/// It is the no-op sink while the master "System notifications" switch is off,
/// so presentation reports `blocked` and never reaches the OS.
final sessionNotificationSinkProvider = Provider<BrokerNotificationSink>(
  (ref) {
    final isEnabled = ref
        .watch(
          sessionNotificationSettingsControllerProvider,
        )
        .valueOrNull;
    if (isEnabled != true) {
      return const NoopBrokerNotificationSink();
    }

    return ref.watch(sessionLocalNotificationSinkProvider);
  },
);

/// The concrete plugin-backed sink, regardless of the master switch.
///
/// Clearing always goes through this one: a notification shown before the
/// switch was turned off must still disappear when its event is read.
final Provider<BrokerNotificationSink> sessionLocalNotificationSinkProvider =
    Provider<BrokerNotificationSink>(
      (ref) => ref.watch(sessionLocalNotificationAdapterProvider),
    );
