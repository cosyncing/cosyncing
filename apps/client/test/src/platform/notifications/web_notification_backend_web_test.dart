@TestOn('browser')
library;

import 'dart:js_interop';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/notifications/web_notification_backend_web.dart';
import 'package:cosyncing_client/src/platform/notifications/web_notification_protocol.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web/web.dart' as web;

/// The browser half of the web notification backend, in a real Chrome.
void main() {
  late String originalUrl;

  setUp(() {
    originalUrl = web.window.location.href;
  });

  tearDown(() {
    web.window.history.replaceState(web.window.history.state, '', originalUrl);
  });

  test('a secure page with the Notification API is not unsupported', () async {
    expect(web.window.isSecureContext, isTrue);

    final status = await WebNotificationBackend().permissionStatus();

    // Headless Chrome answers default or denied; either way the backend saw
    // the API instead of reporting it missing.
    expect(
      status.state,
      isIn([
        NotificationPermissionState.notGranted,
        NotificationPermissionState.denied,
        NotificationPermissionState.granted,
      ]),
    );
  });

  test(
    'the launch payload is consumed once and the history state kept',
    () async {
      final state = {'serialCount': 3, 'state': 'router'}.jsify();
      final path = Uri.parse(originalUrl).path;
      web.window.history.replaceState(
        state,
        '',
        '$path?keep=1&attention=%7B%22eventId%22%3A%22e1%22%7D#/sessions/x',
      );
      final backend = WebNotificationBackend();

      expect(await backend.getLaunchPayload(), '{"eventId":"e1"}');

      final now = Uri.parse(web.window.location.href);
      expect(now.path, path);
      expect(now.query, 'keep=1');
      expect(now.fragment, '/sessions/x');
      expect(web.window.history.state.dartify(), {
        'serialCount': 3,
        'state': 'router',
      });
      expect(await backend.getLaunchPayload(), isNull);
    },
  );

  test('a worker click message reaches the tap handler once', () async {
    final taps = <String?>[];
    final backend = WebNotificationBackend();
    await backend.initialize(onTap: taps.add);
    // A second initialize must not add a second listener.
    await backend.initialize(onTap: taps.add);

    void post(Object message) {
      web.window.navigator.serviceWorker.dispatchEvent(
        web.MessageEvent(
          'message',
          web.MessageEventInit(data: message.jsify()),
        ),
      );
    }

    post({'type': webNotificationClickMessageType, 'payload': 'p1'});
    post({'type': 'cosyncing-build-identity', 'version': 'x'});
    post({'id': '3', 'payload': 'plugin-shape'});
    post({'type': webNotificationClickMessageType, 'payload': ''});

    expect(taps, ['p1', null]);
  });

  test('the platform owns no channels', () async {
    final backend = WebNotificationBackend();

    expect(backend.systemManagesChannels, isFalse);
    expect(await backend.channelStates(), isEmpty);
  });
}
