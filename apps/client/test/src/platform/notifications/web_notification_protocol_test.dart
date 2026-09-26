import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/notifications/web_notification_protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('webNotificationLaunchFrom', () {
    test('reads the payload and keeps everything else', () {
      const payload = '{"a":"x&y=z#w","title":"déjà vu + more"}';
      // Built the way sw.js builds it (URLSearchParams encodes a space as +).
      final url = Uri.parse(
        'https://broker.example/cosy/?keep=1&attention='
        '${Uri.encodeQueryComponent(payload)}&also=two%20words#/sessions/x',
      );

      final launch = webNotificationLaunchFrom(url);

      expect(launch?.payload, payload);
      expect(launch?.cleanUrl, '/cosy/?keep=1&also=two+words#/sessions/x');
    });

    test('drops the query entirely when nothing else is left', () {
      final launch = webNotificationLaunchFrom(
        Uri.parse('https://broker.example/cosy/?attention=p'),
      );

      expect(launch?.payload, 'p');
      expect(launch?.cleanUrl, '/cosy/');
    });

    test('keeps repeated parameters', () {
      final launch = webNotificationLaunchFrom(
        Uri.parse('https://broker.example/cosy/?tag=a&attention=p&tag=b'),
      );

      expect(launch?.cleanUrl, '/cosy/?tag=a&tag=b');
    });

    test('is null without a payload', () {
      expect(
        webNotificationLaunchFrom(Uri.parse('https://broker.example/cosy/')),
        isNull,
      );
      expect(
        webNotificationLaunchFrom(
          Uri.parse('https://broker.example/cosy/?attention=%20'),
        ),
        isNull,
      );
      expect(
        webNotificationLaunchFrom(
          Uri.parse('https://broker.example/cosy/?notification_id=3'),
        ),
        isNull,
      );
    });
  });

  group('isLegacyPluginWorkerScope', () {
    final base = Uri.parse('https://broker.example/cosy/');

    test('matches the plugin worker under this mount only', () {
      const plugin = 'assets/packages/flutter_local_notifications_web/web/';
      expect(
        isLegacyPluginWorkerScope('https://broker.example/cosy/$plugin', base),
        isTrue,
      );
      for (final scope in [
        // The app's own worker.
        'https://broker.example/cosy/',
        // The same plugin under another app on this origin.
        'https://broker.example/other/$plugin',
        // A second Cosyncing mount.
        'https://broker.example/staging/cosy/$plugin',
        'https://broker.example/cosy/assets/packages/',
      ]) {
        expect(isLegacyPluginWorkerScope(scope, base), isFalse, reason: scope);
      }
    });
  });

  test('webPermissionStatusFor maps the three browser values', () {
    expect(
      webPermissionStatusFor('granted').state,
      NotificationPermissionState.granted,
    );
    expect(
      webPermissionStatusFor('denied').state,
      NotificationPermissionState.denied,
    );
    expect(
      webPermissionStatusFor('default').state,
      NotificationPermissionState.notGranted,
    );
  });

  group('webNotificationClickFrom', () {
    test('accepts a click message', () {
      expect(
        webNotificationClickFrom({
          'type': webNotificationClickMessageType,
          'payload': '{"eventId":"e1"}',
        })?.payload,
        '{"eventId":"e1"}',
      );
    });

    test('an empty payload is a click without a destination', () {
      final click = webNotificationClickFrom({
        'type': webNotificationClickMessageType,
        'payload': '',
      });

      expect(click, isNotNull);
      expect(click?.payload, isNull);
    });

    test('ignores every other message', () {
      for (final message in <Object?>[
        null,
        'cosyncing-notification-click',
        {'type': 'cosyncing-build-identity', 'version': 'x'},
        // The plugin worker's click shape.
        {'id': '3', 'payload': 'p', 'action': '', 'reply': ''},
      ]) {
        expect(webNotificationClickFrom(message), isNull, reason: '$message');
      }
    });
  });
  group('webNotificationData', () {
    test('carries the tap payload and the alert, which read back', () {
      final data = webNotificationData(
        payload: '{"eventId":"e1"}',
        alertKey: 'e1\n2\nimmediate',
      );

      expect(data, {
        'payload': '{"eventId":"e1"}',
        'alertKey': 'e1\n2\nimmediate',
      });
      expect(webNotificationAlertKeyOf(data), 'e1\n2\nimmediate');
    });

    test('without a payload or an alert, neither is invented', () {
      final data = webNotificationData(payload: null, alertKey: null);

      expect(data, {'payload': ''});
      expect(webNotificationAlertKeyOf(data), isNull);
    });

    test('an alert key is read only from a notification data map', () {
      for (final data in <Object?>[
        null,
        'e1',
        {'alertKey': 3},
        {'payload': 'p'},
      ]) {
        expect(webNotificationAlertKeyOf(data), isNull, reason: '$data');
      }
    });
  });
}
