import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/lifecycle/web_lifecycle_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a hidden document is hidden whatever its focus', () {
    for (final focused in [true, false]) {
      expect(
        webLifecycleStateFor(hidden: true, focused: focused),
        BrokerAppLifecycleState.hidden,
      );
    }
  });

  test('a visible document is resumed only while it has focus', () {
    expect(
      webLifecycleStateFor(hidden: false, focused: true),
      BrokerAppLifecycleState.resumed,
    );
    expect(
      webLifecycleStateFor(hidden: false, focused: false),
      BrokerAppLifecycleState.inactive,
    );
  });
}
