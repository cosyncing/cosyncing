import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_local_notification_adapter.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
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
      final monitor = FlutterBrokerAppLifecycleMonitor();
      ref.onDispose(monitor.dispose);
      return monitor;
    });

/// Provides the notification sink for session notification hooks.
///
/// Default sink is no-op until local notifications are explicitly enabled.
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

/// Provides a concrete plugin-backed sink for opt-in feature wiring.
///
/// J19 ships a concrete adapter, but notification delivery remains opt-in until
/// a settings/permission UX routes users to enable it.
final Provider<BrokerNotificationSink> sessionLocalNotificationSinkProvider =
    Provider<BrokerNotificationSink>(
      (ref) => ref.watch(sessionLocalNotificationAdapterProvider),
    );

/// Provides a stable policy object for deriving session notifications.
final Provider<BrokerSessionNotificationPolicy>
sessionNotificationPolicyProvider = Provider<BrokerSessionNotificationPolicy>((
  ref,
) {
  return DefaultBrokerSessionNotificationPolicy(
    lifecycleMonitor: ref.watch(
      sessionNotificationLifecycleMonitorProvider,
    ),
    sink: ref.watch(sessionNotificationSinkProvider),
  );
});
