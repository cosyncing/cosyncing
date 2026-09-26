import 'package:broker_contract/broker_contract.dart';

/// The browser's push subscription for the app's service worker.
///
/// A browser holds one subscription per worker scope, bound to one server
/// key, so one web app can take Web Push from one Server.
abstract interface class WebPushSubscriber {
  /// Whether this browser can subscribe at all (a service worker and the Push
  /// API, in a secure context).
  bool get supported;

  /// The subscription for [publicKey] (a base64url VAPID key), subscribing if
  /// there is none and replacing one made for a different key. Null when no
  /// worker is active yet or the browser refuses.
  Future<WebPushSubscription?> subscribe(String publicKey);

  /// Drops the subscription. Returns whether there was one.
  Future<bool> unsubscribe();
}
