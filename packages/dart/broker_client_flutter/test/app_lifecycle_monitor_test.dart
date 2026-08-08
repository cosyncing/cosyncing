import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('FlutterBrokerAppLifecycleMonitor', () {
    test('exposes the configured initial state', () {
      final monitor = FlutterBrokerAppLifecycleMonitor(
        initialState: BrokerAppLifecycleState.paused,
      );
      addTearDown(monitor.dispose);

      expect(monitor.currentState, BrokerAppLifecycleState.paused);
    });

    test('maps Flutter lifecycle changes to normalized states', () async {
      final monitor = FlutterBrokerAppLifecycleMonitor(
        initialState: BrokerAppLifecycleState.resumed,
      );
      addTearDown(monitor.dispose);

      final observed = <BrokerAppLifecycleState>[];
      final subscription = monitor.stateChanges.listen(observed.add);
      addTearDown(subscription.cancel);

      monitor.didChangeAppLifecycleState(AppLifecycleState.resumed);
      monitor.didChangeAppLifecycleState(AppLifecycleState.inactive);
      monitor.didChangeAppLifecycleState(AppLifecycleState.hidden);
      monitor.didChangeAppLifecycleState(AppLifecycleState.paused);
      monitor.didChangeAppLifecycleState(AppLifecycleState.detached);

      await Future<void>.delayed(Duration.zero);

      expect(observed, <BrokerAppLifecycleState>[
        BrokerAppLifecycleState.inactive,
        BrokerAppLifecycleState.hidden,
        BrokerAppLifecycleState.paused,
        BrokerAppLifecycleState.detached,
      ]);
    });

    test('suppresses duplicate consecutive transitions', () async {
      final monitor = FlutterBrokerAppLifecycleMonitor(
        initialState: BrokerAppLifecycleState.hidden,
      );
      addTearDown(monitor.dispose);

      final observed = <BrokerAppLifecycleState>[];
      final subscription = monitor.stateChanges.listen(observed.add);
      addTearDown(subscription.cancel);

      monitor.didChangeAppLifecycleState(AppLifecycleState.hidden);
      monitor.didChangeAppLifecycleState(AppLifecycleState.hidden);
      monitor.didChangeAppLifecycleState(AppLifecycleState.paused);
      monitor.didChangeAppLifecycleState(AppLifecycleState.paused);
      monitor.didChangeAppLifecycleState(AppLifecycleState.hidden);
      monitor.didChangeAppLifecycleState(AppLifecycleState.paused);

      await Future<void>.delayed(Duration.zero);

      expect(observed, <BrokerAppLifecycleState>[
        BrokerAppLifecycleState.paused,
        BrokerAppLifecycleState.hidden,
        BrokerAppLifecycleState.paused,
      ]);
    });

    test('updates current state with emitted transitions', () async {
      final monitor = FlutterBrokerAppLifecycleMonitor(
        initialState: BrokerAppLifecycleState.paused,
      );
      addTearDown(monitor.dispose);

      expect(monitor.currentState, BrokerAppLifecycleState.paused);

      monitor.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await Future<void>.delayed(Duration.zero);

      expect(monitor.currentState, BrokerAppLifecycleState.resumed);
    });

    test('closes stream and ignores transitions after disposal', () async {
      final monitor = FlutterBrokerAppLifecycleMonitor(
        initialState: BrokerAppLifecycleState.resumed,
      );
      addTearDown(() async {
        monitor.dispose();
      });

      final observed = <BrokerAppLifecycleState>[];
      final subscription = monitor.stateChanges.listen(observed.add);
      addTearDown(subscription.cancel);

      monitor.didChangeAppLifecycleState(AppLifecycleState.paused);
      await Future<void>.delayed(Duration.zero);
      expect(observed, <BrokerAppLifecycleState>[
        BrokerAppLifecycleState.paused,
      ]);

      final done = expectLater(monitor.stateChanges, emitsDone);
      monitor.dispose();
      await done;

      monitor.didChangeAppLifecycleState(AppLifecycleState.detached);
      await Future<void>.delayed(Duration.zero);
      expect(observed, <BrokerAppLifecycleState>[
        BrokerAppLifecycleState.paused,
      ]);
    });
  });
}
