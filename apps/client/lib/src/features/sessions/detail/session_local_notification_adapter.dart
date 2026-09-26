import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/notifications/web_notification_backend.dart';
import 'package:cosyncing_client/src/platform/notifications/windows_notification_icon.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Notification consent, tap recovery, and single-adapter ownership are
// governed by docs/architecture/attention.md

/// Last explicit local-notification tap payload awaiting app navigation.
final sessionNotificationTapPayloadProvider = StateProvider<String?>(
  (_) => null,
);

/// Tap callback shared by startup initialization and permission requests.
final sessionNotificationTapHandlerProvider =
    Provider<FlutterLocalNotificationTapHandler>((ref) {
      return (payload) {
        // Launch details can arrive synchronously while the bootstrap provider
        // is building, so defer the state mutation to the next microtask.
        Future<void>.microtask(() {
          ref.read(sessionNotificationTapPayloadProvider.notifier).state =
              payload;
        });
      };
    });

/// The single plugin adapter owned by the app.
///
/// Reusing this instance is important: initializing another plugin wrapper can
/// replace the platform tap callback registered during app startup.
final sessionLocalNotificationAdapterProvider =
    Provider<FlutterLocalNotificationSink>(
      (ref) => FlutterLocalNotificationSink(
        // Browsers show through the app's own service worker; elsewhere null
        // selects the flutter_local_notifications backend.
        backend: createWebNotificationBackend(),
        // The dedicated one-color brand silhouette in
        // android/app/src/main/res/drawable-*/ic_notification.png — never the
        // full-color launcher tile (assets/brand/HANDOVER.md).
        androidDefaultIcon: 'ic_notification',
        windowsIconPath: windowsNotificationIconPath(),
        onTap: ref.watch(sessionNotificationTapHandlerProvider),
      ),
    );
