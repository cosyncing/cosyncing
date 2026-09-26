import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/platform/notifications/web_push_subscriber_contract.dart';
import 'package:web/web.dart' as web;

export 'package:cosyncing_client/src/platform/notifications/web_push_subscriber_contract.dart';

/// The browser's Push API through the app's own `sw.js` registration.
WebPushSubscriber createWebPushSubscriber() => _BrowserWebPushSubscriber();

final class _BrowserWebPushSubscriber implements WebPushSubscriber {
  web.ServiceWorkerContainer? get _workers =>
      web.window.navigator.hasProperty('serviceWorker'.toJS).toDart
      ? web.window.navigator.serviceWorker
      : null;

  @override
  bool get supported =>
      web.window.isSecureContext &&
      _workers != null &&
      web.window.hasProperty('PushManager'.toJS).toDart;

  Future<web.PushManager?> _pushManager() async {
    final workers = _workers;
    if (workers == null) return null;
    final registration = await workers.getRegistration().toDart;
    if (registration == null || registration.active == null) return null;
    return registration.pushManager;
  }

  @override
  Future<WebPushSubscription?> subscribe(String publicKey) async {
    final manager = await _pushManager();
    if (manager == null) return null;
    final key = _decodeBase64Url(publicKey);
    var subscription = await manager.getSubscription().toDart;
    if (subscription != null && !_sameKey(subscription, key)) {
      // A subscription is bound to one server key; the Server's key changed.
      await subscription.unsubscribe().toDart;
      subscription = null;
    }
    subscription ??= await manager
        .subscribe(
          web.PushSubscriptionOptionsInit(
            userVisibleOnly: true,
            applicationServerKey: key.toJS,
          ),
        )
        .toDart;
    final json = subscription.toJSON();
    final keys = json.keys;
    final p256dh = keys.getProperty<JSString?>('p256dh'.toJS)?.toDart;
    final auth = keys.getProperty<JSString?>('auth'.toJS)?.toDart;
    if (p256dh == null || auth == null) return null;
    return WebPushSubscription(
      endpoint: json.endpoint,
      p256dh: p256dh,
      auth: auth,
    );
  }

  @override
  Future<bool> unsubscribe() async {
    final manager = await _pushManager();
    final subscription = await manager?.getSubscription().toDart;
    if (subscription == null) return false;
    await subscription.unsubscribe().toDart;
    return true;
  }

  static bool _sameKey(web.PushSubscription subscription, Uint8List key) {
    final current = subscription.options.applicationServerKey;
    if (current == null) return false;
    final bytes = current.toDart.asUint8List();
    if (bytes.length != key.length) return false;
    for (var index = 0; index < bytes.length; index++) {
      if (bytes[index] != key[index]) return false;
    }
    return true;
  }

  static Uint8List _decodeBase64Url(String value) =>
      base64Url.decode(base64Url.normalize(value.trim()));
}
