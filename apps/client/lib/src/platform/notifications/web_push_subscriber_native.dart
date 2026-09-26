import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/platform/notifications/web_push_subscriber_contract.dart';

export 'package:cosyncing_client/src/platform/notifications/web_push_subscriber_contract.dart';

/// No browser, no Web Push.
WebPushSubscriber createWebPushSubscriber() => const _UnsupportedSubscriber();

final class _UnsupportedSubscriber implements WebPushSubscriber {
  const _UnsupportedSubscriber();

  @override
  bool get supported => false;

  @override
  Future<WebPushSubscription?> subscribe(String publicKey) async => null;

  @override
  Future<bool> unsubscribe() async => false;
}
