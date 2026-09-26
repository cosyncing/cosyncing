import 'package:broker_client_flutter/broker_client_flutter.dart';

/// A browser tab's lifecycle state, by the rules Flutter's web engine applies
/// to its events: a hidden document is hidden, a visible one is resumed while
/// it has focus and inactive otherwise.
BrokerAppLifecycleState webLifecycleStateFor({
  required bool hidden,
  required bool focused,
}) {
  if (hidden) return BrokerAppLifecycleState.hidden;
  return focused
      ? BrokerAppLifecycleState.resumed
      : BrokerAppLifecycleState.inactive;
}
