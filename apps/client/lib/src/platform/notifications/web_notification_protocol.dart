import 'package:broker_client_flutter/broker_client_flutter.dart';

/// The page side of the notification contract with `web/sw.js`.
///
/// Kept free of browser APIs so the VM test suite covers it; the worker's
/// half is driven by `scripts/client/tests/test-web-notification-click.ts`.

/// Message type `sw.js` posts to an open app window for a notification click.
/// Mirrors `NOTIFICATION_CLICK_MESSAGE` in `sw.js`.
const webNotificationClickMessageType = 'cosyncing-notification-click';

/// Query parameter `sw.js` opens the app with when no app window is open.
/// Mirrors `NOTIFICATION_LAUNCH_PARAMETER` in `sw.js`.
const webNotificationLaunchParameter = 'attention';

/// The `data` of a notification the app shows: its tap [payload], and the
/// alert it raises. `sw.js` reads both, and writes the same shape for a push.
Map<String, Object?> webNotificationData({
  required String? payload,
  required String? alertKey,
}) => {'payload': payload ?? '', 'alertKey': ?alertKey};

/// The alert a shown notification's `data` names, or null.
String? webNotificationAlertKeyOf(Object? data) {
  if (data is! Map) return null;
  final key = data['alertKey'];
  return key is String ? key : null;
}

/// Where `flutter_local_notifications_web` registered its own worker,
/// relative to the app's base URL. Earlier clients showed through it.
const legacyPluginWorkerScopePath =
    'assets/packages/flutter_local_notifications_web/web/';

/// A notification-click launch read from the page URL.
final class WebNotificationLaunch {
  /// Creates a launch.
  const WebNotificationLaunch({required this.payload, required this.cleanUrl});

  /// The payload the notification carried.
  final String payload;

  /// The same address without the launch parameter, as a path, query, and
  /// fragment, for `history.replaceState`.
  final String cleanUrl;
}

/// Reads the launch payload `sw.js` put on [url], and the address to leave in
/// the address bar once it is consumed. Null when [url] carries none.
WebNotificationLaunch? webNotificationLaunchFrom(Uri url) {
  final payload = url.queryParameters[webNotificationLaunchParameter];
  if (payload == null || payload.trim().isEmpty) return null;
  final kept = [
    for (final entry in url.queryParametersAll.entries)
      if (entry.key != webNotificationLaunchParameter)
        for (final value in entry.value)
          [entry.key, value].map(Uri.encodeQueryComponent).join('='),
  ];
  final buffer = StringBuffer(url.path.isEmpty ? '/' : url.path);
  if (kept.isNotEmpty) buffer.write('?${kept.join('&')}');
  if (url.hasFragment) buffer.write('#${url.fragment}');
  return WebNotificationLaunch(payload: payload, cleanUrl: buffer.toString());
}

/// Whether [scope] is the plugin worker registered under this app's
/// [baseUrl]. Another app, or another Cosyncing mount on the same origin, keeps
/// its own.
bool isLegacyPluginWorkerScope(String scope, Uri baseUrl) =>
    scope == baseUrl.resolve(legacyPluginWorkerScopePath).toString();

/// The browser's `Notification.permission` as a permission status.
NotificationPermissionStatus webPermissionStatusFor(String permission) =>
    switch (permission) {
      'granted' => NotificationPermissionStatus.granted,
      'denied' => const NotificationPermissionStatus(
        NotificationPermissionState.denied,
      ),
      _ => const NotificationPermissionStatus(
        NotificationPermissionState.notGranted,
      ),
    };

/// The payload of a `sw.js` click message, or null for any other message.
/// An empty payload still counts as a click.
({String? payload})? webNotificationClickFrom(Object? message) {
  if (message is! Map || message['type'] != webNotificationClickMessageType) {
    return null;
  }
  final payload = message['payload'];
  return (
    payload: payload is String && payload.trim().isNotEmpty ? payload : null,
  );
}
