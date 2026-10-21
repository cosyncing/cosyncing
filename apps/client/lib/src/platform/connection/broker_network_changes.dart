import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Platform interface-change hints, without DNS requests or connectivity polls.
/// A hint invalidates route observations; it never establishes broker
/// readiness.
final brokerNetworkChangesProvider = Provider<Stream<void>>((ref) async* {
  final connectivity = Connectivity();
  // Subscribe before the one-time snapshot so a change during initialization
  // remains queued. Some platforms do not emit an initial subscription event.
  final events = StreamController<List<ConnectivityResult>>();
  final subscription = connectivity.onConnectivityChanged.listen(
    events.add,
    onError: events.addError,
    onDone: events.close,
  );
  try {
    var previous = (await connectivity.checkConnectivity()).toSet();
    await for (final value in events.stream) {
      final current = value.toSet();
      if (previous.length == current.length && previous.containsAll(current)) {
        continue;
      }
      previous = current;
      yield null;
    }
  } finally {
    await subscription.cancel();
    unawaited(events.close());
  }
});
